import { writeDiagnostic } from "../../core/diagnostics.js";

/**
 * Observability domain wire-up. Listens to the dispatch bus channels and folds
 * their payloads into the session cost tracker, the projection and the trace
 * mirror. Other domains read the snapshot through the contract; the one thing
 * it emits is `accountability.evidenceReady`, once per run whose evidence
 * bundle landed.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BusChannels, type DispatchCompletedPayload } from "../../core/bus-events.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { clioDataDir, clioStateDir } from "../../core/xdg.js";
import type { RunReceipt } from "../dispatch/types.js";
import { buildEvidence, type EvidenceBuildResult } from "../evidence/index.js";
import type { ObservabilityContract, ObservabilityRunEvidence, TokenThroughputSnapshot } from "./contract.js";
import { createCostTracker } from "./cost.js";
import { type EvidenceIndexRow, writeEvidenceIndexRowQueued } from "./evidence-index.js";
import { readOutOfTurnUsageRows } from "./out-of-turn-usage.js";
import { createObservabilityProjection } from "./projection.js";
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

/** Pre-admission failures have an announced run id but never create a run ledger. */
export function dispatchHasEvidenceLedger(payload: DispatchTerminalLike): boolean {
	return payload.lineage !== undefined;
}

function recordDispatchCost(cost: ReturnType<typeof createCostTracker>, payload: DispatchTerminalLike): void {
	if (!payload.targetId || !payload.wireModelId || typeof payload.tokenCount !== "number") {
		return;
	}
	// Dispatch terminal payloads carry the same full split as receipts. Preserve
	// it so /usage and the footer agree with the fleet board instead of showing
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
			...(payload.cacheWrite1hTokenCount === undefined ? {} : { cacheWrite1h: payload.cacheWrite1hTokenCount }),
			reasoningTokens: payload.reasoningTokenCount ?? 0,
			totalTokens: payload.tokenCount,
			apiCalls: payload.apiCalls ?? 1,
			missingTokenCalls: payload.missingTokenCalls ?? (payload.tokenCount === 0 ? 1 : 0),
		},
		payload.costProvenance,
		undefined,
		"worker",
		payload.costSummary,
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
		writeDiagnostic(`[clio-coder:evidence] auto-build failed for run ${runId}: ${message}\n`);
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
		succeeded,
		completionEvidenceWarning: result.findings.some(
			(finding) => finding.tag === "completion-evidence" && finding.severity === "warn",
		),
		ungroundedClaims: result.ungroundedClaims,
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
	const cost = createCostTracker();
	let sessionId: string | null | undefined;
	const recordedRuns = new Set<string>();
	const recordRun = (payload: DispatchTerminalLike): void => {
		if (sessionId !== undefined && payload.sessionId !== undefined && payload.sessionId !== sessionId) return;
		if (payload.runId && recordedRuns.has(payload.runId)) return;
		if (!payload.lineage) return;
		if (payload.runId) recordedRuns.add(payload.runId);
		recordDispatchCost(cost, payload);
	};
	const trace: DispatchTraceMirror =
		options.dispatchTrace === false
			? { enqueue: () => {}, enqueueSessionTurn: () => {}, flush: async () => {}, close: async () => {} }
			: createDispatchTraceMirror(traceDatabasePath(clioStateDir()));
	const unsubscribes: Array<() => void> = [];
	let latestThroughput: TokenThroughputSnapshot | null = null;

	// The product-facing projection folds the bus channels plus the session cost
	// tracker into a single bounded snapshot. It reads these accessors at
	// snapshot-build time, so it always observes the latest state regardless of
	// bus-handler ordering.
	const projection = createObservabilityProjection(context.bus, {
		sessionCostSummary: () => cost.sessionCost(),
		sessionTokens: () => cost.sessionTokens(),
		latestThroughput: () => latestThroughput,
	});

	// In-flight forensic builds. The terminal event is emitted after the receipt
	// and ledger are persisted (dispatch finalizers persist before emit), so a
	// build that starts here reads durable state. We keep the bus handler
	// non-blocking by not awaiting the build inline, but a headless one-shot
	// `clio-coder run` tears the process down right after the run, which would abandon
	// the build mid-flight. Tracking the promises lets stop() flush them so the
	// bundle and index row reliably land on every path, not just long-lived
	// interactive sessions.
	const pendingBuilds = new Set<Promise<void>>();
	const trackBuild = (runId: string, succeeded: boolean, attempt: number | undefined): void => {
		projection.evidenceBuildStarted(runId);
		const build = buildAndIndexEvidence(runId, succeeded, attempt, {
			onReady: (id, evidence) => {
				// The projection and ACP consume the same evidence-ready event.
				context.bus.emit(BusChannels.AccountabilityEvidenceReady, { runId: id, ...evidence });
			},
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
					recordRun(payload);
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
					recordRun(payload);
					// A failed run is never a first-pass success; still build the
					// bundle so its failure-cause tags exist for the index.
					if (typeof payload.runId === "string" && payload.runId.length > 0 && dispatchHasEvidenceLedger(payload)) {
						trackBuild(payload.runId, false, payload.lineage?.attempt);
					}
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
		sessionCost: () => cost.sessionTotal(),
		sessionCostSummary: () => cost.sessionCost(),
		costEntries: () => cost.entries(),
		resetSession(nextSessionId) {
			sessionId = nextSessionId;
			cost.reset();
			recordedRuns.clear();
			if (sessionId) {
				for (const row of readOutOfTurnUsageRows(clioStateDir()).rows) {
					if (row.sessionId !== sessionId) continue;
					cost.accumulate(
						row.target,
						row.attributedModelId,
						row.usage.totalTokens ?? 0,
						row.usage.costUsd ?? 0,
						{
							input: row.usage.input ?? 0,
							output: row.usage.output ?? 0,
							cacheRead: row.usage.cacheRead ?? 0,
							cacheWrite: row.usage.cacheWrite ?? 0,
							...(row.usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: row.usage.cacheWrite1h ?? 0 }),
							reasoningTokens: row.usage.reasoning ?? 0,
							missingTokenCalls: row.usage.totalTokens === null ? 1 : 0,
						},
						row.usage.costProvenance,
						undefined,
						row.label,
					);
				}
				const receiptsDir = join(clioStateDir(), "receipts");
				for (const name of existsSync(receiptsDir) ? readdirSync(receiptsDir) : []) {
					if (!name.endsWith(".json")) continue;
					let run: RunReceipt;
					try {
						run = JSON.parse(readFileSync(join(receiptsDir, name), "utf8")) as RunReceipt;
					} catch (error) {
						writeDiagnostic(`[clio-coder:usage] cannot read receipt ${name}: ${String(error)}\n`);
						continue;
					}
					if (!run || run.sessionId !== sessionId || run.agentId === "main-agent") continue;
					const unverifiedTokens = run.externalTelemetry && run.externalTelemetry.tokenUsage !== "provider-reported";
					recordRun({
						runId: run.runId,
						sessionId: run.sessionId,
						lineage: run.lineage,
						targetId: run.targetId,
						wireModelId: run.wireModelId,
						tokenCount: unverifiedTokens ? 0 : run.tokenCount,
						inputTokenCount: unverifiedTokens ? 0 : run.inputTokenCount,
						outputTokenCount: unverifiedTokens ? 0 : run.outputTokenCount,
						cacheReadTokenCount: unverifiedTokens ? 0 : run.cacheReadTokenCount,
						cacheWriteTokenCount: unverifiedTokens ? 0 : run.cacheWriteTokenCount,
						cacheWrite1hTokenCount: unverifiedTokens ? 0 : run.cacheWrite1hTokenCount,
						reasoningTokenCount: unverifiedTokens ? 0 : run.reasoningTokenCount,
						apiCalls: run.apiCalls,
						missingTokenCalls: unverifiedTokens ? Math.max(1, run.missingTokenCalls ?? 0) : run.missingTokenCalls,
						costUsd: run.costUsd,
						costProvenance: run.costProvenance,
						costSummary: run.costSummary,
					});
				}
			}
			latestThroughput = null;
			projection.refresh();
		},
		recordTokens(
			providerId,
			attributedModelId,
			tokens,
			costUsd,
			breakdown,
			costProvenance,
			modelIdFacts,
			label,
			costSummary,
		) {
			cost.accumulate(
				providerId,
				attributedModelId,
				tokens,
				costUsd,
				breakdown,
				costProvenance,
				modelIdFacts,
				label,
				costSummary,
			);
			projection.refresh();
		},
		recordSessionTurn(sessionTurn) {
			trace.enqueueSessionTurn(sessionTurn);
		},
		recordPackageActivity(activity) {
			trace.enqueuePackageActivity?.(activity);
		},
		recordTokenThroughput(snapshot) {
			latestThroughput = snapshot;
			projection.refresh();
		},
		bindRunReaders: (readers) => projection.bindRunReaders(readers),
		reconcileRuns: () => projection.reconcileRuns(),
		setFleetPhase: (runId, phase) => projection.setFleetPhase(runId, phase),
		snapshot: () => projection.snapshot(),
		subscribe: (listener) => projection.subscribe(listener),
	};

	return { extension, contract };
}
