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
import { BusChannels, type ConfigChangePayload, type DispatchCompletedPayload } from "../../core/bus-events.js";
import type { ClioSettings } from "../../core/config.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { TelemetryCapture, TelemetrySettings } from "../../core/telemetry/capture.js";
import { effectiveTelemetryCapture, STANDARD_CAPTURE } from "../../core/telemetry/capture.js";
import type { TelemetryContext } from "../../core/telemetry/context.js";
import { recordTelemetry, recordTelemetryContent } from "../../core/telemetry/producer.js";
import type { Payload } from "../../core/telemetry/schemas.js";
import { clioDataDir, clioStateDir } from "../../core/xdg.js";
import type { ConfigContract } from "../config/index.js";
import { computeSettingsFingerprint } from "../dispatch/settings-fingerprint.js";
import type { RunReceipt } from "../dispatch/types.js";
import { buildEvidence, type EvidenceBuildResult } from "../evidence/index.js";
import { createConsentView } from "./consent.js";
import type { ObservabilityContract, ObservabilityRunEvidence, TokenThroughputSnapshot } from "./contract.js";
import { callCoverageForRun, createCostTracker } from "./cost.js";
import { type EvidenceIndexRow, writeEvidenceIndexRowQueued } from "./evidence-index.js";
import { storeTelemetryObject } from "./objects.js";
import { readOutOfTurnUsageRows } from "./out-of-turn-usage.js";
import { createObservabilityProjection } from "./projection.js";
import type { SessionCapture } from "./session-journals.js";
import { createSessionJournals } from "./session-journals.js";
import { createLiveTelemetryModel } from "./telemetry-live.js";
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

function recordDispatchCost(
	cost: ReturnType<typeof createCostTracker>,
	payload: DispatchTerminalLike,
	replayed = false,
): void {
	if (!payload.targetId || !payload.wireModelId || typeof payload.tokenCount !== "number") {
		return;
	}
	// Dispatch terminal payloads carry the same full split as receipts. Preserve
	// it so /usage and the footer agree with the fleet board instead of showing
	// zero input/output/cache for worker-only sessions.
	const accumulate = payload.runId ? cost.replace.bind(cost, `run:${payload.runId}`) : cost.accumulate.bind(cost);
	accumulate(
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
			...callCoverageForRun(payload),
		},
		payload.costProvenance,
		undefined,
		"worker",
		payload.costSummary,
		replayed,
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
	// Writers ask before every record and batch, so the capture is answered from memory: consent per session
	// refreshes on the cold path before each lease, and the result is reused until settings or consent change (#434).
	const consent = createConsentView(clioStateDir());
	const consented = new Map<string, boolean>();
	const captures = new Map<string, { settings: TelemetrySettings; consent: boolean; capture: TelemetryCapture }>();
	const preparing = new Set<string>();
	const sessionCapture: SessionCapture = {
		async prepare(origin, directory) {
			const settings = context.getContract<ConfigContract>("config")?.get().telemetry;
			if (settings?.mode !== "research" || !settings.research.content) {
				consented.set(origin.id, false);
				return;
			}
			await consent.refresh();
			consented.set(origin.id, consent.covers(await consent.sessionWorkspace(directory)));
		},
		current(origin) {
			const settings = context.getContract<ConfigContract>("config")?.get().telemetry;
			if (!settings) return STANDARD_CAPTURE;
			const granted = consented.get(origin.id) ?? false;
			const cached = captures.get(origin.id);
			if (cached?.settings === settings && cached.consent === granted) return cached.capture;
			const capture = effectiveTelemetryCapture(settings, granted);
			captures.set(origin.id, { settings, consent: granted, capture });
			return capture;
		},
	};
	const config = () => context.getContract<ConfigContract>("config");
	const sessionContext = (sessionId: string): TelemetryContext => ({ sessionId, label: "main" });
	const settingsUnavailable = () =>
		writeDiagnostic("[clio-coder:telemetry] settings record unavailable; coverage is incomplete\n");
	// Writes of config.changed still storing their documents; shutdown waits for them before closing writers (#434).
	const pendingSettingsRecords = new Set<Promise<void>>();
	const journals = createSessionJournals(
		clioStateDir(),
		() => writeDiagnostic("[clio-coder:telemetry] call journal unavailable; coverage is incomplete\n"),
		sessionCapture,
		// Each writer opens with the settings it records under, so its records never read against unknown settings.
		async (origin, sessionDirectory) => {
			let settings: Readonly<ClioSettings> | undefined;
			try {
				settings = config()?.get();
			} catch {
				// A writer that opens before the config domain starts has no settings to record yet.
			}
			if (!settings) return;
			const ref = await storeTelemetryObject(sessionDirectory, "config", settings);
			recordTelemetry(
				"config.snapshot",
				{ settings: ref, settingsFingerprint: computeSettingsFingerprint(settings) },
				sessionContext(origin.id),
			);
		},
	);
	const telemetry = createLiveTelemetryModel({ stateDir: clioStateDir });
	// A change touching several effect kinds reaches each listener with one payload; it is one change (#434).
	const recordedChanges = new WeakSet<object>();
	const recordSettingsChange = (payload: ConfigChangePayload): void => {
		const previous = payload.previous;
		if (!previous || recordedChanges.has(payload)) return;
		recordedChanges.add(payload);
		const data: Omit<Payload<"config.changed">, "before" | "after"> = {
			source: payload.source ?? "unattributed",
			paths: {
				hotReload: [...payload.diff.hotReload],
				nextTurn: [...payload.diff.nextTurn],
				restartRequired: [...payload.diff.restartRequired],
			},
			settingsFingerprint: computeSettingsFingerprint(payload.settings),
		};
		for (const { origin, sessionDirectory } of journals.openSessions()) {
			const write: Promise<void> = Promise.all([
				storeTelemetryObject(sessionDirectory, "config", previous),
				storeTelemetryObject(sessionDirectory, "config", payload.settings),
			])
				.then(([before, after]) => {
					recordTelemetry("config.changed", { ...data, before, after }, sessionContext(origin.id));
				})
				.catch(settingsUnavailable)
				.finally(() => pendingSettingsRecords.delete(write));
			pendingSettingsRecords.add(write);
		}
	};
	let sessionId: string | null | undefined;
	const recordedRuns = new Set<string>();
	const recordRun = (payload: DispatchTerminalLike, replayed = false): void => {
		if (sessionId !== undefined && payload.sessionId !== undefined && payload.sessionId !== sessionId) return;
		if (payload.runId && recordedRuns.has(payload.runId)) return;
		if (!payload.lineage) return;
		if (payload.runId) recordedRuns.add(payload.runId);
		recordDispatchCost(cost, payload, replayed);
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
			const settings = config();
			if (settings) {
				for (const kind of ["hotReload", "nextTurn", "restartRequired"] as const)
					unsubscribes.push(settings.onChange(kind, recordSettingsChange));
			}
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
			await Promise.all(pendingSettingsRecords);
			await journals.closeAll();
			telemetry.stop();
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
		recordRunTokens(runId, source, ...args) {
			// A sealed receipt already restored the complete run; its journal may since have been evicted (#434).
			if (source === "unavailable" && recordedRuns.has(runId)) return;
			cost.replace(`run:${runId}`, ...args);
			projection.refresh();
		},
		acquireTelemetrySession: journals.acquire,
		telemetryCapture(origin) {
			// Recorders outside a call ask between leases; the first ask starts the consent read (#434).
			if (!consented.has(origin.id) && !preparing.has(origin.id) && /^[a-zA-Z0-9_-]+$/.test(origin.cwdHash)) {
				preparing.add(origin.id);
				void sessionCapture
					.prepare?.(origin, join(clioStateDir(), "sessions", origin.cwdHash, origin.id))
					.catch(() => {
						// No consent is granted by a failed read; the next lease asks again (#434).
					})
					.finally(() => preparing.delete(origin.id));
			}
			return sessionCapture.current(origin);
		},
		telemetry,
		recordResearchTrace(origin, kind, data, preimage) {
			// Facts can point at live runtime state; the journal keeps what the event saw (#434).
			let owned: { data: typeof data; preimage: unknown };
			try {
				owned = structuredClone({ data, preimage });
			} catch {
				// A fact that cannot be cloned is not journaled; the step it describes is unaffected (#434).
				return;
			}
			void journals
				.acquire(origin, "memory")
				.then(async (lease) => {
					try {
						recordTelemetryContent(kind, owned.data, owned.preimage, lease.context);
					} finally {
						await lease.release();
					}
				})
				.catch(() => {
					// The journal reports its own unavailability; a trace never fails the work it describes (#434).
				});
		},
		sessionCost: () => cost.sessionTotal(),
		sessionCostSummary: () => cost.sessionCost(),
		costEntries: () => cost.entries(),
		resetSession(nextSessionId) {
			sessionId = nextSessionId;
			telemetry.bind(nextSessionId ?? null);
			cost.reset();
			recordedRuns.clear();
			if (sessionId) {
				for (const row of readOutOfTurnUsageRows(clioStateDir()).rows) {
					if (row.sessionId !== sessionId) continue;
					// #430: a never-sent call is evidence, not spend. The live path never
					// recorded it, so a resumed session must not count it as a call either.
					if (row.failure?.invoked === false) continue;
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
						undefined,
						true,
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
					recordRun(
						{
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
							missingTokenCalls: run.missingTokenCalls,
							costUsd: run.costUsd,
							costProvenance: run.costProvenance,
							costSummary: run.costSummary,
						},
						true,
					);
				}
			}
			latestThroughput = null;
			projection.refresh();
		},
		recordNeverSentCalls(count) {
			cost.recordNeverSentCalls(count);
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
			replayed,
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
				replayed,
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
