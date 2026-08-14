/**
 * Observability domain wire-up. Listens to dispatch + safety bus channels and
 * folds payloads into telemetry/cost trackers. Emits nothing; other domains
 * read the snapshot through the contract.
 */

import { BusChannels, type DispatchCompletedPayload } from "../../core/bus-events.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { clioDataDir, clioStateDir } from "../../core/xdg.js";
import { buildEvidence, type EvidenceBuildResult } from "../evidence/index.js";
import { readAccountabilitySummary } from "./accountability.js";
import type { ObservabilityContract, ObservabilityRunEvidence, TokenThroughputSnapshot } from "./contract.js";
import { createCostTracker } from "./cost.js";
import { type EvidenceIndexRow, writeEvidenceIndexRowQueued } from "./evidence-index.js";
import { aggregateMetrics } from "./metrics.js";
import { createObservabilityProjection } from "./projection.js";
import { createTelemetry } from "./telemetry.js";
import { createDispatchTraceMirror, type DispatchTraceMirror, traceDatabasePath } from "./trace-store.js";

/**
 * Callbacks the auto-build path uses to report evidence readiness back to the
 * projection without coupling the pure build helper to it. `onReady` fires once
 * the sidecar index row lands; `onFailed` fires when the build or write throws.
 */
interface EvidenceBuildHooks {
	onReady(runId: string, evidence: ObservabilityRunEvidence): void;
	onFailed(runId: string, message: string): void;
}

/**
 * Terminal dispatch payload with every field optional. Partial<> alone does
 * not admit DispatchFailedPayload under exactOptionalPropertyTypes, and this
 * subscriber treats completed/failed identically for cost purposes.
 */
type DispatchTerminalLike = {
	[K in keyof DispatchCompletedPayload]?: DispatchCompletedPayload[K] | undefined;
};

function recordDispatchCost(
	telemetry: ReturnType<typeof createTelemetry>,
	cost: ReturnType<typeof createCostTracker>,
	payload: DispatchTerminalLike,
): void {
	if (!payload.targetId || !payload.wireModelId || typeof payload.tokenCount !== "number") {
		return;
	}
	telemetry.record("counter", "tokens.total", payload.tokenCount);
	// Dispatch terminal payloads carry the same full split as receipts. Preserve
	// it so /cost and the footer agree with the fleet board instead of showing
	// zero input/output/cache for worker-only sessions.
	cost.accumulate(
		payload.targetId,
		payload.wireModelId,
		payload.tokenCount,
		payload.costUsd,
		{
			input: payload.inputTokenCount ?? 0,
			output: payload.outputTokenCount ?? 0,
			cacheRead: payload.cacheReadTokenCount ?? 0,
			cacheWrite: payload.cacheWriteTokenCount ?? 0,
			reasoningTokens: payload.reasoningTokenCount ?? 0,
			totalTokens: payload.tokenCount,
		},
		payload.costProvenance,
	);
}

/**
 * Build the forensic evidence bundle for a finalized run and record a compact
 * sidecar index row. Best-effort: every failure (build throws, write throws) is
 * logged to stderr and swallowed so a run completes normally regardless.
 *
 * `succeeded` distinguishes the DispatchCompleted channel (terminal success)
 * from DispatchFailed; only a succeeded run is eligible for firstPassSuccess.
 * `attempt` is the dispatch lineage attempt (0 = first try, increments per
 * retry). A retry, a non-success outcome, or a bundle that shows no validation
 * evidence all force firstPassSuccess to false. See section 7 of the spec.
 */
async function buildAndIndexEvidence(
	runId: string,
	succeeded: boolean,
	attempt: number | undefined,
	hooks: EvidenceBuildHooks,
): Promise<void> {
	try {
		const dataDir = clioDataDir();
		const stateDir = clioStateDir();
		const result = await buildEvidence({ dataDir, stateDir, runId });
		const row = evidenceIndexRow(runId, result, succeeded, attempt);
		await writeEvidenceIndexRowQueued(stateDir, row);
		hooks.onReady(runId, {
			evidenceId: row.evidenceId,
			firstPassSuccess: row.firstPassSuccess,
			findingCount: row.findingCount,
			tags: row.tags,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`[clio:evidence] auto-build failed for run ${runId}: ${message}\n`);
		hooks.onFailed(runId, message);
	}
}

/**
 * firstPassSuccess is TRUE only when the terminal outcome succeeded, the run
 * had zero dispatch retries (lineage attempt 0), and the built bundle carries
 * validation evidence. We read validation evidence negatively: a bundle whose
 * overview or findings tags include `no-validation` means the run produced no
 * validation, so it cannot first-pass-succeed.
 */
function evidenceIndexRow(
	runId: string,
	result: EvidenceBuildResult,
	succeeded: boolean,
	attempt: number | undefined,
): EvidenceIndexRow {
	const tags = result.overview.tags;
	const hasNoValidationTag =
		tags.includes("no-validation") || result.findings.some((finding) => finding.tag === "no-validation");
	const firstPassSuccess = succeeded && attempt === 0 && !hasNoValidationTag;
	return {
		runId,
		evidenceId: result.evidenceId,
		tags: [...tags],
		firstPassSuccess,
		findingCount: result.findings.length,
		generatedAt: new Date().toISOString(),
	};
}

export interface ObservabilityBundleOptions {
	/** Disable the SQLite dispatch mirror for short-lived internal generators. */
	dispatchTrace?: boolean;
}

export function createObservabilityBundle(
	context: DomainContext,
	options: ObservabilityBundleOptions = {},
): DomainBundle<ObservabilityContract> {
	const telemetry = createTelemetry();
	const cost = createCostTracker();
	const trace: DispatchTraceMirror =
		options.dispatchTrace === false
			? { enqueue: () => {}, enqueueSessionTurn: () => {}, flush: async () => {}, close: async () => {} }
			: createDispatchTraceMirror(traceDatabasePath(clioStateDir()));
	const unsubscribes: Array<() => void> = [];
	let latestThroughput: TokenThroughputSnapshot | null = null;

	// The product-facing projection folds the bus channels plus the session
	// cost/telemetry trackers into a single bounded snapshot. It reads these
	// accessors at snapshot-build time, so it always observes the latest state
	// regardless of bus-handler ordering.
	const projection = createObservabilityProjection(context.bus, {
		metrics: () => aggregateMetrics(telemetry.snapshot()),
		sessionCost: () => cost.sessionTotal(),
		sessionCostSummary: () => cost.sessionCost(),
		sessionTokens: () => cost.sessionTokens(),
		latestThroughput: () => latestThroughput,
		readAccountability: () => readAccountabilitySummary(clioStateDir()),
	});

	// In-flight forensic builds. The terminal event is emitted after the receipt
	// and ledger are persisted (dispatch finalizers persist before emit), so a
	// build that starts here reads durable state. We keep the bus handler
	// non-blocking by not awaiting the build inline, but a headless one-shot
	// `clio run` tears the process down right after the run, which would abandon
	// the build mid-flight. Tracking the promises lets stop() flush them so the
	// bundle and index row reliably land on every path, not just long-lived
	// interactive sessions.
	const pendingBuilds = new Set<Promise<void>>();
	const trackBuild = (runId: string, succeeded: boolean, attempt: number | undefined): void => {
		projection.evidenceBuildStarted(runId);
		const build = buildAndIndexEvidence(runId, succeeded, attempt, {
			onReady: (id, evidence) => projection.evidenceBuildSucceeded(id, evidence),
			onFailed: (id, message) => projection.evidenceBuildFailed(id, message),
		});
		pendingBuilds.add(build);
		void build.finally(() => pendingBuilds.delete(build));
	};

	const extension: DomainExtension = {
		async start() {
			for (const channel of [
				BusChannels.DispatchEnqueued,
				BusChannels.DispatchStarted,
				BusChannels.DispatchProgress,
				BusChannels.DispatchCompleted,
				BusChannels.DispatchFailed,
			] as const) {
				unsubscribes.push(context.bus.on(channel, (payload) => trace.enqueue(channel, payload)));
			}
			unsubscribes.push(
				context.bus.on(BusChannels.DispatchCompleted, (raw) => {
					const payload: DispatchTerminalLike = raw ?? {};
					telemetry.record("counter", "dispatch.completed", 1);
					if (typeof payload.durationMs === "number") {
						telemetry.record("histogram", "dispatch.duration_ms", payload.durationMs);
					}
					recordDispatchCost(telemetry, cost, payload);
					// Kick off the heavy forensic build without blocking the bus.
					// buildAndIndexEvidence swallows all failures; stop() flushes it.
					if (typeof payload.runId === "string" && payload.runId.length > 0) {
						trackBuild(payload.runId, true, payload.lineage?.attempt);
					}
				}),
			);
			unsubscribes.push(
				context.bus.on(BusChannels.DispatchFailed, (raw) => {
					const payload: DispatchTerminalLike = raw ?? {};
					telemetry.record("counter", "dispatch.failed", 1);
					if (typeof payload.durationMs === "number") {
						telemetry.record("histogram", "dispatch.duration_ms", payload.durationMs);
					}
					recordDispatchCost(telemetry, cost, payload);
					// A failed run is never a first-pass success; still build the
					// bundle so its failure-cause tags exist for the index.
					if (typeof payload.runId === "string" && payload.runId.length > 0) {
						trackBuild(payload.runId, false, payload.lineage?.attempt);
					}
				}),
			);
			unsubscribes.push(
				context.bus.on(BusChannels.SafetyClassified, () => {
					telemetry.record("counter", "safety.classified", 1);
					// The projection reads metrics off telemetry; nudge it so the
					// safety-classification counter reaches the snapshot.
					projection.refresh();
				}),
			);
		},
		async stop() {
			for (const off of unsubscribes) off();
			unsubscribes.length = 0;
			projection.stop();
			// Terminal trace facts are the live operator contract. Flush them before
			// potentially slower evidence builds consume the remaining hook budget.
			await trace.close();
			// Flush any in-flight forensic builds so a headless run that shuts down
			// immediately after dispatch still persists its bundle and index row.
			// Best-effort and bounded by the shutdown hook budget; each build
			// already swallows its own failures.
			if (pendingBuilds.size > 0) {
				await Promise.allSettled([...pendingBuilds]);
			}
		},
	};

	const contract: ObservabilityContract = {
		telemetry: () => telemetry.snapshot(),
		metrics: () => aggregateMetrics(telemetry.snapshot()),
		sessionCost: () => cost.sessionTotal(),
		sessionCostSummary: () => cost.sessionCost(),
		sessionTokens: () => cost.sessionTokens(),
		costEntries: () => cost.entries(),
		accountability: () => readAccountabilitySummary(clioStateDir()),
		latestTokenThroughput: () => latestThroughput,
		resetSession() {
			cost.reset();
			latestThroughput = null;
			projection.refresh();
		},
		recordTokens(providerId, modelId, tokens, costUsd, breakdown, costProvenance) {
			telemetry.record("counter", "tokens.total", tokens);
			cost.accumulate(providerId, modelId, tokens, costUsd, breakdown, costProvenance);
			projection.refresh();
		},
		recordSessionTurn(sessionTurn) {
			trace.enqueueSessionTurn(sessionTurn);
		},
		recordTokenThroughput(snapshot) {
			latestThroughput = snapshot;
			telemetry.record("histogram", "tokens.output_per_second", snapshot.tokensPerSecond);
			telemetry.record("histogram", "tokens.ttft_ms", snapshot.ttftMs ?? 0);
			projection.refresh();
		},
		snapshot: () => projection.snapshot(),
		subscribe: (listener) => projection.subscribe(listener),
	};

	return { extension, contract };
}
