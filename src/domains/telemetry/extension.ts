import { writeDiagnostic } from "../../core/diagnostics.js";

/**
 * Telemetry domain wire-up. Listens to the dispatch bus channels and folds
 * their payloads into the projection, and answers spend from the read model.
 * Other domains read the snapshot through the contract. A run's assessment is
 * journaled by its own journal owner before the run seals (`dispatch/run-telemetry.ts`).
 */

import { join } from "node:path";
import type { ClioSettings } from "../../core/config.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { TelemetryCapture, TelemetrySettings } from "../../core/telemetry/capture.js";
import { effectiveTelemetryCapture, STANDARD_CAPTURE } from "../../core/telemetry/capture.js";
import type { TelemetryContext } from "../../core/telemetry/context.js";
import { mainAgent } from "../../core/telemetry/context.js";
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
import { clioStateDir } from "../../core/xdg.js";
import type { ConfigContract } from "../config/index.js";
import { computeSettingsFingerprint } from "../dispatch/settings-fingerprint.js";
import type { CallJournal } from "./call-journal.js";
import { openCallJournalHealth } from "./call-journal.js";
import { createConsentView } from "./consent.js";
import type { SessionSpend, TelemetryContract, TelemetryView } from "./contract.js";
import { foldFacts } from "./folds.js";
import { createHealthWindows } from "./health-window.js";
import type { ProcessJournal } from "./process-journal.js";
import { createProcessJournal } from "./process-journal.js";
import { createTelemetryProjection } from "./projection.js";
import type { SessionCapture, TelemetrySessionOrigin } from "./session-journals.js";
import { createSessionJournals } from "./session-journals.js";
import { createLiveTelemetryModel } from "./telemetry-live.js";

/**
 * Terminal dispatch payload with every field optional. Partial<> alone does
 * not admit DispatchFailedPayload under exactOptionalPropertyTypes, and this
 * subscriber treats completed/failed identically for cost purposes.
 */
type DispatchTerminalLike = {
	[K in keyof DispatchCompletedPayload]?: DispatchCompletedPayload[K] | undefined;
};

/** Pre-admission failures have an announced run id but never create a run ledger. */
export function dispatchHasRunLedger(payload: DispatchTerminalLike): boolean {
	return payload.lineage !== undefined;
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
	const sessionContext = (sessionId: string): TelemetryContext => ({ sessionId, agent: mainAgent(sessionId) });
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
			.acquire(origin, mainAgent(origin.id))
			.then(async (lease) => {
				try {
					// A session seals at every close, once its last lease drains; a resume continues the chain (#434).
					if (lease.journaled && telemetryHub().emit(kind, data, lease.context)) {
						if (kind === "session.closed") lease.requestSeal?.();
						else lease.cancelSeal?.();
					}
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
			.acquire(origin, mainAgent(origin.id))
			.then(async (lease) => {
				try {
					if (!lease.journaled || !lease.storeObject) return;
					const [before, after] = await Promise.all([
						lease.storeObject("config", payload.previous),
						lease.storeObject("config", payload.settings),
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
		{ origin: TelemetrySessionOrigin; journal: CallJournal; stored: Promise<void> }
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
		async (origin, _sessionDirectory, journal) => {
			healthWindows.start();
			let settings: Readonly<ClioSettings> | undefined;
			try {
				settings = config()?.get();
			} catch {
				// A writer that opens before the config domain starts has no settings to record yet.
			}
			if (!settings) return;
			// Objects go through the writer, so none lands behind the session's seal (#434).
			const stored = journal.storeObject("config", settings).then((ref) => {
				telemetryHub().emit(
					"config.snapshotted",
					{ settings: ref, settingsFingerprint: settingsFingerprintCommitment(computeSettingsFingerprint(settings)) },
					sessionContext(origin.id),
				);
			});
			openingSnapshots.set(origin.id, { origin, journal, stored });
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
		const targets: Array<{ origin: TelemetrySessionOrigin; journal: CallJournal; stored?: Promise<void> }> = [
			...journals.openSessions(),
			...openingSnapshots.values(),
		];
		for (const { origin, journal, stored } of targets) {
			const store = () =>
				Promise.all([journal.storeObject("config", previous), journal.storeObject("config", payload.settings)]);
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
		if (sessionId || payload.sessionId || !dispatchHasRunLedger(payload)) return;
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

	// The product-facing projection folds the bus channels into a single bounded snapshot.
	const projection = createTelemetryProjection(context.bus, {});

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
						.acquire(origin, mainAgent(origin.id))
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
				context.bus.subscribe("run.completed", (raw) => adoptRun(raw ?? {})),
				context.bus.subscribe("run.failed", (raw) => adoptRun(raw ?? {})),
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
		recordResearchTrace(origin, agent, kind, data, preimage) {
			// Facts can point at live runtime state; the journal keeps what the event saw (#434).
			let owned: { data: typeof data; preimage: unknown };
			try {
				owned = structuredClone({ data, preimage });
			} catch {
				// A fact that cannot be cloned is not journaled; the step it describes is unaffected (#434).
				return;
			}
			void journals
				.acquire(origin, agent)
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
			if (!nextSessionId)
				void refreshProcessSpend().catch(() => {
					// An unreadable process journal leaves the last known spend; the next admission reads it again (#434).
				});
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
