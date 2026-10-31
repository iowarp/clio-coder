import { writeDiagnostic } from "../../core/diagnostics.js";

/**
 * Telemetry domain wire-up. Listens to the dispatch bus channels and folds
 * their payloads into the projection, and answers spend from the read model.
 * Other domains read the snapshot through the contract; the one thing it emits
 * is `evidence.assessed`, once per run whose evidence bundle landed.
 */

import { join } from "node:path";
import type { ClioSettings } from "../../core/config.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { TelemetryCapture, TelemetrySettings } from "../../core/telemetry/capture.js";
import { effectiveTelemetryCapture, STANDARD_CAPTURE } from "../../core/telemetry/capture.js";
import type { TelemetryContext } from "../../core/telemetry/context.js";
import { factRef, type Quantity } from "../../core/telemetry/dto.js";
import type { EventPayload } from "../../core/telemetry/events.js";
import type { Fact, FactSum } from "../../core/telemetry/fact.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import type {
	ConfigChangePayload,
	ConfigSessionChangePayload,
	DispatchCompletedPayload,
} from "../../core/telemetry/live-events.js";
import {
	enqueueReopenedTelemetry,
	registerTelemetryReopener,
	telemetryCaptures,
} from "../../core/telemetry/producer.js";
import { settingsFingerprintCommitment } from "../../core/telemetry/schemas.js";
import { clioDataDir, clioStateDir } from "../../core/xdg.js";
import type { ConfigContract } from "../config/index.js";
import { computeSettingsFingerprint } from "../dispatch/settings-fingerprint.js";
import { buildEvidence, type EvidenceBuildResult } from "../evidence/index.js";
import { openCallJournalHealth } from "./call-journal.js";
import { createConsentView } from "./consent.js";
import type {
	SessionSpend,
	TelemetryContract,
	TelemetryRunEvidence,
	TelemetryView,
	TokenThroughputSnapshot,
} from "./contract.js";
import { type EvidenceIndexRow, writeEvidenceIndexRowQueued } from "./evidence-index.js";
import { foldFacts } from "./folds.js";
import { createHealthWindows } from "./health-window.js";
import { storeTelemetryObject } from "./objects.js";
import { telemetrySessionDirectory } from "./paths.js";
import type { ProcessJournal } from "./process-journal.js";
import { createProcessJournal } from "./process-journal.js";
import { createTelemetryProjection } from "./projection.js";
import type { SessionCapture, TelemetrySessionOrigin } from "./session-journals.js";
import { createSessionJournals } from "./session-journals.js";
import { createLiveTelemetryModel } from "./telemetry-live.js";

/**
 * Callbacks the auto-build path uses to report evidence readiness back to the
 * projection without coupling the pure build helper to it. `onReady` fires once
 * the sidecar index row lands; `onFailed` fires when the build or write throws.
 */
interface EvidenceBuildHooks {
	onReady(runId: string, evidence: TelemetryRunEvidence): void;
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

function factSumOf(fact: Fact<number> | FactSum | undefined): FactSum | null {
	return fact === undefined ? null : "unknownCount" in fact ? fact : foldFacts([fact]);
}

const NOTHING_SPENT: SessionSpend = { usd: 0, estimated: false, unpriced: false, ref: null };

function spendOfQuantity(quantity: Quantity | null | undefined): SessionSpend {
	const sum = factSumOf(quantity?.fact);
	if (!quantity || !sum) return NOTHING_SPENT;
	return {
		usd: sum.measured + sum.estimated,
		estimated: sum.estimated > 0 || sum.coverage.estimated > 0,
		unpriced: sum.unknownCount > 0,
		ref: quantity.ref,
	};
}

export function createTelemetryBundle(context: DomainContext): DomainBundle<TelemetryContract> {
	// Writers ask before every record and batch, so the capture is answered from memory: consent per session
	// refreshes on the cold path before each lease, and the result is reused until settings or consent change (#434).
	const consent = createConsentView(clioStateDir());
	const consented = new Map<string, boolean>();
	const captures = new Map<string, { settings: TelemetrySettings; consent: boolean; capture: TelemetryCapture }>();
	const preparing = new Set<string>();
	const sessionCapture: SessionCapture = {
		async prepare(origin) {
			const settings = context.getContract<ConfigContract>("config")?.get().telemetry;
			// The workspace comes from the session's own meta.json, a path built from its cwd hash (#434).
			if (settings?.mode !== "research" || !settings.research.content || !/^[a-zA-Z0-9_-]+$/.test(origin.cwdHash)) {
				consented.set(origin.id, false);
				return;
			}
			await consent.refresh();
			const store = join(clioStateDir(), "sessions", origin.cwdHash, origin.id);
			consented.set(origin.id, consent.covers(await consent.sessionWorkspace(store)));
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
	// Records still on their way to a writer: lifecycle, settings changes and reopened ambient facts. Shutdown waits for
	// them before closing writers (#434).
	const pendingRecords = new Set<Promise<void>>();
	/**
	 * A session's lifecycle as journal records: opened, resumed and closed. A writer opens for each, so a session
	 * idle past its writer's close still records them; shutdown waits for them before closing writers (#434).
	 */
	const recordLifecycle = <K extends "session.opened" | "session.resumed" | "session.closed">(
		origin: TelemetrySessionOrigin,
		kind: K,
		data: EventPayload<K>,
	): void => {
		const write = journals
			.acquire(origin, "main")
			.then(async (lease) => {
				try {
					// A session seals at every close; a resume continues the chain past the seal (#434).
					if (lease.journaled && telemetryHub().emit(kind, data, lease.context) && kind === "session.closed")
						await lease.seal?.();
				} finally {
					await lease.release();
				}
			})
			.catch(() => {
				// The writer reports its own failure; meta.json keeps endedAt for readers either way.
			})
			.finally(() => pendingRecords.delete(write));
		pendingRecords.add(write);
	};
	// The session the lifecycle records left open. Shutdown stops this domain before the session domain parks it,
	// so stop() journals its close while the writers still accept records (#434).
	let liveSession: TelemetrySessionOrigin | null = null;
	// Once stopping, no record reopens a writer that closeAll is shutting (#434).
	let stopping = false;
	/**
	 * An edit that moved only the current session's effective settings belongs to that session's journal alone. A
	 * writer opens for it, so a session idle past its writer's close still records it (#434).
	 */
	const recordSessionSettingsChange = (payload: ConfigSessionChangePayload): void => {
		const origin = liveSession;
		if (!origin || origin.id !== payload.sessionId) return;
		const write: Promise<void> = journals
			.acquire(origin, "main")
			.then(async (lease) => {
				try {
					if (!lease.journaled) return;
					const sessionDirectory = telemetrySessionDirectory(clioStateDir(), origin.id);
					const [before, after] = await Promise.all([
						storeTelemetryObject(sessionDirectory, "config", payload.previous),
						storeTelemetryObject(sessionDirectory, "config", payload.settings),
					]);
					telemetryHub().emit("config.changed", { ...settingsChangeData(payload), before, after }, lease.context);
				} finally {
					await lease.release();
				}
			})
			.catch(settingsUnavailable)
			.finally(() => pendingRecords.delete(write));
		pendingRecords.add(write);
	};
	// Writers still storing the settings they opened under. A change arriving meanwhile is journaled after that
	// snapshot, so the session neither loses the change nor reads it before the settings it changed (#434).
	const openingSnapshots = new Map<
		string,
		{ origin: TelemetrySessionOrigin; sessionDirectory: string; stored: Promise<void> }
	>();
	// Health is the process's: one window per process into its own journal, never one per session (#434).
	const healthWindows = createHealthWindows({
		active: () => journals.openSessions().length > 0,
		writers: () => openCallJournalHealth().map(({ health }) => health),
		record: (data) => telemetryHub().emit("health.sampled", data),
		recordSamples: (data) => telemetryHub().emit("health.samples_captured", data),
		samplesWanted: () => telemetryCaptures("health.samples_captured"),
	});
	const journals = createSessionJournals(
		clioStateDir(),
		() => writeDiagnostic("[clio-coder:telemetry] call journal unavailable; coverage is incomplete\n"),
		sessionCapture,
		// Each writer opens with the settings it records under, so its records never read against unknown settings.
		async (origin, sessionDirectory) => {
			healthWindows.start();
			let settings: Readonly<ClioSettings> | undefined;
			try {
				settings = config()?.get();
			} catch {
				// A writer that opens before the config domain starts has no settings to record yet.
			}
			if (!settings) return;
			const stored = storeTelemetryObject(sessionDirectory, "config", settings).then((ref) => {
				telemetryHub().emit(
					"config.snapshotted",
					{ settings: ref, settingsFingerprint: settingsFingerprintCommitment(computeSettingsFingerprint(settings)) },
					sessionContext(origin.id),
				);
			});
			openingSnapshots.set(origin.id, { origin, sessionDirectory, stored });
			try {
				await stored;
			} finally {
				openingSnapshots.delete(origin.id);
			}
		},
	);
	const telemetry = createLiveTelemetryModel({ stateDir: clioStateDir, process: () => processJournal });
	// Every host that boots this domain (TUI, ACP, headless run, fleet) owns one process journal, opened lazily (#434).
	let processJournal: ProcessJournal | undefined;
	// A change touching several effect kinds reaches each listener with one payload; it is one change (#434).
	const recordedChanges = new WeakSet<object>();
	const settingsChangeData = (
		payload: ConfigChangePayload,
	): Omit<EventPayload<"config.changed">, "before" | "after"> => ({
		source: payload.source,
		...(payload.scope ? { scope: payload.scope } : {}),
		paths: {
			hotReload: [...payload.diff.hotReload],
			nextTurn: [...payload.diff.nextTurn],
			restartRequired: [...payload.diff.restartRequired],
		},
		settingsFingerprint: settingsFingerprintCommitment(computeSettingsFingerprint(payload.settings)),
	});
	const recordSettingsChange = (payload: ConfigChangePayload): void => {
		const previous = payload.previous;
		if (!previous || recordedChanges.has(payload)) return;
		recordedChanges.add(payload);
		const data = settingsChangeData(payload);
		const targets: Array<{ origin: TelemetrySessionOrigin; sessionDirectory: string; stored?: Promise<void> }> = [
			...journals.openSessions(),
			...openingSnapshots.values(),
		];
		for (const { origin, sessionDirectory, stored } of targets) {
			const store = () =>
				Promise.all([
					storeTelemetryObject(sessionDirectory, "config", previous),
					storeTelemetryObject(sessionDirectory, "config", payload.settings),
				]);
			// A snapshot that failed to store still leaves the change worth recording; its own failure was reported.
			const write: Promise<void> = (stored ? stored.then(store, store) : store())
				.then(([before, after]) => {
					telemetryHub().emit("config.changed", { ...data, before, after }, sessionContext(origin.id));
				})
				.catch(settingsUnavailable)
				.finally(() => pendingRecords.delete(write));
			pendingRecords.add(write);
		}
	};
	let sessionId: string | null | undefined;
	/** With no session bound, this process's own calls are the spend; refreshed off the read path as its journal grows. */
	let processSpend: SessionSpend = NOTHING_SPENT;
	/**
	 * Runs this process dispatched with no session, such as a standalone fleet run's steps. The process owns them, so
	 * once each finishes its run journal counts in the process's spend; until then its meter does (#434).
	 */
	const processRuns = new Set<string>();
	/** Each owned run's journaled spend as the last refresh read it, the same fold the process spend sums. */
	const processRunUsd = new Map<string, number>();
	const refreshProcessSpend = async (): Promise<SessionSpend> => {
		const parts = [spendOfQuantity(await telemetry.processQuantity?.("usd"))];
		for (const runId of processRuns) {
			const run = spendOfQuantity((await telemetry.run(runId)).row.usd);
			processRunUsd.set(runId, run.usd);
			parts.push(run);
		}
		processSpend = {
			usd: parts.reduce((sum, part) => sum + part.usd, 0),
			estimated: parts.some((part) => part.estimated),
			unpriced: parts.some((part) => part.unpriced),
			ref: parts[0]?.ref ?? null,
		};
		return processSpend;
	};
	/** A run that ended while no session was bound, and that names none, is this process's own (#434). */
	const adoptRun = (payload: DispatchTerminalLike): void => {
		// A dispatch refused before admission never opened a run journal; there is nothing of it to fold.
		if (sessionId || payload.sessionId || !dispatchHasEvidenceLedger(payload)) return;
		if (typeof payload.runId !== "string" || payload.runId.length === 0) return;
		processRuns.add(payload.runId);
	};
	/** The budget gate's spend: the read model's whole-session fold, estimated parts and unpriced calls flagged (#434). */
	const spendOf = (view: TelemetryView | null): SessionSpend => {
		if (!sessionId) return processSpend;
		if (!view || view.sessionId !== sessionId) return NOTHING_SPENT;
		return spendOfQuantity(view.quantity(factRef({ scope: "session", owner: view.sessionId, metric: "usd" })));
	};
	const unsubscribes: Array<() => void> = [];
	let latestThroughput: TokenThroughputSnapshot | null = null;

	// The product-facing projection folds the bus channels into a single bounded snapshot. It reads the throughput
	// at snapshot-build time, so it always observes the latest state regardless of bus-handler ordering.
	const projection = createTelemetryProjection(context.bus, {
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
				context.bus.emit("evidence.assessed", { runId: id, ...evidence });
			},
			onFailed: (id, message) => projection.evidenceBuildFailed(id, message),
		});
		pendingBuilds.add(build);
		void build.finally(() => pendingBuilds.delete(build));
	};

	// The status the host named before stopping its domains; every host that exits through them names one (#434).
	let exitStatus: number | undefined;
	const processExitStatus = (): number => exitStatus ?? (typeof process.exitCode === "number" ? process.exitCode : 0);

	const extension: DomainExtension = {
		async start() {
			try {
				processJournal ??= createProcessJournal(
					clioStateDir(),
					() => writeDiagnostic("[clio-coder:telemetry] process journal unavailable; coverage is incomplete\n"),
					() => {
						const telemetry = config()?.get().telemetry;
						return telemetry ? effectiveTelemetryCapture(telemetry, false) : STANDARD_CAPTURE;
					},
				);
			} catch {
				// Another bundle in this process already owns the process journal; one per process (#434).
			}
			const settings = config();
			if (settings) {
				for (const kind of ["hotReload", "nextTurn", "restartRequired"] as const)
					unsubscribes.push(settings.onChange(kind, recordSettingsChange));
			}
			unsubscribes.push(
				// A session fact whose context names a session this process has written reopens that session's writer
				// after its idle close. Shutdown waits for these writes with the lifecycle records (#434).
				registerTelemetryReopener((record) => {
					const id = record.ctx.sessionId;
					const origin = id === null || stopping ? undefined : journals.knownOrigin(id);
					if (!origin) return false;
					const write = journals
						.acquire(origin, "main")
						.then(async (lease) => {
							try {
								if (lease.journaled) enqueueReopenedTelemetry(record);
							} finally {
								await lease.release();
							}
						})
						.catch(() => {
							// The writer reports its own failure.
						})
						.finally(() => pendingRecords.delete(write));
					pendingRecords.add(write);
					return true;
				}),
				context.bus.subscribe("config.session_changed", recordSessionSettingsChange),
				context.bus.subscribe("session.created", ({ sessionId, cwdHash }) => {
					liveSession = { id: sessionId, cwdHash };
					recordLifecycle(liveSession, "session.opened", {});
				}),
				context.bus.subscribe("session.reattached", ({ sessionId, cwdHash, via }) => {
					liveSession = cwdHash === undefined ? null : { id: sessionId, cwdHash };
					if (liveSession) recordLifecycle(liveSession, "session.resumed", { via });
				}),
				// A park is the session's close; its reason says what replaced or ended it (#434).
				context.bus.subscribe("session.parked", ({ sessionId, cwdHash, reason }) => {
					if (liveSession?.id === sessionId) liveSession = null;
					if (cwdHash !== undefined) recordLifecycle({ id: sessionId, cwdHash }, "session.closed", { reason });
				}),
			);
			unsubscribes.push(
				context.bus.subscribe("run.completed", (raw) => {
					const payload: DispatchTerminalLike = raw ?? {};
					adoptRun(payload);
					// Kick off the heavy forensic build without blocking the bus.
					// buildAndIndexEvidence swallows all failures; stop() flushes it.
					if (typeof payload.runId === "string" && payload.runId.length > 0) {
						trackBuild(payload.runId, true, payload.lineage?.attempt);
					}
				}),
			);
			unsubscribes.push(
				context.bus.subscribe("run.failed", (raw) => {
					const payload: DispatchTerminalLike = raw ?? {};
					adoptRun(payload);
					// A failed run is never a first-pass success; still build the
					// bundle so its failure-cause tags exist for the index.
					if (typeof payload.runId === "string" && payload.runId.length > 0 && dispatchHasEvidenceLedger(payload)) {
						trackBuild(payload.runId, false, payload.lineage?.attempt);
					}
				}),
			);
		},
		async stop() {
			stopping = true;
			healthWindows.stop();
			if (liveSession) recordLifecycle(liveSession, "session.closed", { reason: "shutdown" });
			liveSession = null;
			await Promise.all(pendingRecords);
			await journals.closeAll();
			// A process that recorded nothing process-scoped never opened a journal, and closing it writes nothing.
			await processJournal?.close(processExitStatus());
			processJournal = undefined;
			telemetry.stop();
			for (const off of unsubscribes) off();
			unsubscribes.length = 0;
			projection.stop();
			// Flush any in-flight forensic builds so a headless run that shuts down
			// immediately after dispatch still persists its bundle and index row.
			// Best-effort and bounded by the shutdown hook budget; each build
			// already swallows its own failures.
			if (pendingBuilds.size > 0) {
				await Promise.allSettled([...pendingBuilds]);
			}
		},
	};

	const contract: TelemetryContract = {
		acquireTelemetrySession: journals.acquire,
		telemetryCapture(origin) {
			// Recorders outside a call ask between leases; the first ask starts the consent read (#434).
			if (!consented.has(origin.id) && !preparing.has(origin.id)) {
				preparing.add(origin.id);
				void sessionCapture
					.prepare?.(origin)
					.catch(() => {
						// No consent is granted by a failed read; the next lease asks again (#434).
					})
					.finally(() => preparing.delete(origin.id));
			}
			return sessionCapture.current(origin);
		},
		read: telemetry,
		setExitStatus(code) {
			exitStatus = code;
		},
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
						telemetryHub().emitContent(kind, owned.data, owned.preimage, lease.context);
					} finally {
						await lease.release();
					}
				})
				.catch(() => {
					// The journal reports its own unavailability; a trace never fails the work it describes (#434).
				});
		},
		sessionSpend: () => spendOf(telemetry.live()),
		async settledSessionSpend() {
			// Every queued settlement is written, and so published to the live model, before the fold is read (#434).
			await journals.flush();
			if (!sessionId) return refreshProcessSpend();
			return spendOf(await telemetry.settled());
		},
		journaledRunUsd(runId) {
			// With no session, an owned run counts by the journal the last process refresh folded; any other run by none.
			if (!sessionId) return processRunUsd.get(runId) ?? 0;
			// A run this session does not reference resolves to no quantity, so nothing of it is journaled here.
			const sum = factSumOf(telemetry.live()?.quantity(factRef({ scope: "run", owner: runId, metric: "usd" }))?.fact);
			return sum ? sum.measured + sum.estimated : 0;
		},
		resetSession(nextSessionId) {
			sessionId = nextSessionId;
			telemetry.bind(nextSessionId ?? null);
			latestThroughput = null;
			if (!nextSessionId)
				void refreshProcessSpend().catch(() => {
					// An unreadable process journal leaves the last known spend; the next admission reads it again (#434).
				});
			projection.refresh();
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
