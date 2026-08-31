/**
 * The dispatch-to-pane bridge, per spec 4.7.
 *
 * It subscribes to the five dispatch lifecycle channels (`src/core/bus-events.ts:56-60`)
 * plus the interactive status channel, folds each run into a small display
 * record, and projects those records onto the pane layer on a trailing-edge
 * throttle. Everything it does is best effort: the `MuxContract` never throws
 * and never blocks, so a dead pane host costs a log line and nothing else.
 *
 * Three decisions are load-bearing enough to state here.
 *
 * **Why a throttle and not a call per event.** herdr answers one request per
 * connection (`socket-client.ts` header, verified live in phase 1), so every
 * mux call pays a connect. A chatty run emits progress events far faster than
 * a pane is worth repainting, and reporting state on each one would open a
 * socket per event. Events fold into a per-run record and one trailing flush
 * drains all dirty runs together, which also coalesces a burst into a single
 * pane update.
 *
 * **Why the open decision is made at flush time, not at start time.** The
 * `auto` policy opens panes for runs the operator loses sight of: detached
 * batches and dispatches moved to the background. Both become visible through
 * the durable detached-batch record, and that record is written *after* the
 * runs are already live (`dispatch-runner.ts:221`, and again on the
 * attach-to-background conversion at `:337`). Deciding at start time would race
 * the register. Deciding at flush time does not, and it is also what lets a
 * backgrounded run acquire a pane in the middle of its life.
 *
 * **Why a terminal run never gets a fresh pane.** A viewer pane hosts a process
 * following the run's journal. Opening one for a run that already finished is a
 * post-mortem nobody asked for, and `clio-coder fleet view <runId>` is the
 * surface for that. `panes.keepFailed` therefore governs whether an existing
 * pane survives its run, not whether a new one appears after the fact.
 */

import { type AgentStatusChangedPayload, BusChannels, type DispatchRunIdentity } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { MuxAdoptableRun, MuxContract, MuxLog, MuxPaneRecord, MuxRunOutcome } from "../domains/mux/index.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";

/** Trailing-edge window. Spec 4.7 calls ~250ms fine, and it matches `WAIT_POLL_MS`. */
export const MUX_BRIDGE_THROTTLE_MS = 250;

/**
 * A success worth a sound. Below it a finished run is one of many and a chime
 * per run is noise; above it the operator has moved on and wants telling.
 */
const LONG_RUN_MS = 60_000;

/** How much dispatched task text may reach a pane label, per `bus-events.ts:524`. */
const LABEL_MAX_CHARS = 48;

export type PanesAgentsPolicy = "auto" | "all" | "off";
export type PanesNotificationsPolicy = "failures" | "all" | "off";

/** The half of `settings.panes` the bridge reads, resolved fresh on every flush. */
export interface MuxBridgePanesSettings {
	agents: PanesAgentsPolicy;
	keepFailed: boolean;
	notifications: PanesNotificationsPolicy;
}

export interface MuxBridgeDeps {
	bus: SafeEventBus;
	mux: MuxContract;
	/** Read live so a `/settings` change takes effect on the next flush. */
	getPanesSettings: () => MuxBridgePanesSettings;
	/**
	 * Whether this run belongs to a durable detached batch, which is true for
	 * both a detached dispatch and an attached one the operator backgrounded.
	 * Absent means no batch surface is wired, in which case `auto` opens nothing
	 * and `all` still works.
	 */
	isDetached?: (runId: string) => boolean;
	/**
	 * Still-running runs a resumed session should re-adopt panes for. Called once
	 * at construction; absent skips reconciliation.
	 */
	resumableRuns?: () => ReadonlyArray<MuxAdoptableRun>;
	/** Persistent transcript notice; unlike a herdr toast, this remains auditable in the TUI. */
	notice?: (level: "error", text: string) => void;
	log?: MuxLog;
	now?: () => number;
	throttleMs?: number;
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
}

export interface MuxBridge {
	/** Drain every pending update now. Tests await it; production never calls it. */
	flush(): Promise<void>;
	/** Resume reconciliation, awaited by tests. Construction already kicked it off. */
	readonly adoption: Promise<void>;
	dispose(): void;
}

type RunPhase = "queued" | "running" | "blocked" | "done";

interface RunRecord {
	runId: string;
	agentId: string;
	role: string;
	label: string;
	model: string | null;
	phase: RunPhase;
	outcome: MuxRunOutcome | null;
	/** Terminal detail worth putting in a toast body, already sanitized. */
	detail: string | null;
	startedAt: number;
	durationMs: number | null;
	/** Outstanding approval escalations. A run with any of them is blocked. */
	pendingApprovals: Set<string>;
	/** True once `openRunPane` returned a pane for this run, or one was adopted. */
	opened: boolean;
	/** True once the pane went away without Clio closing it. Never reopened. */
	paneGone: boolean;
	/** True once the terminal report, toast, and close policy have all run. */
	settled: boolean;
	dirty: boolean;
}

/** Terminal outcomes that read as failure for the notification and close policies. */
function isFailure(outcome: MuxRunOutcome | null): boolean {
	return outcome === "failed" || outcome === "timed_out";
}

function notificationsQualify(record: RunRecord, settings: MuxBridgePanesSettings): boolean {
	return settings.notifications === "all" || (settings.notifications === "failures" && isFailure(record.outcome));
}

function persistentFailureNotice(record: RunRecord, settings: MuxBridgePanesSettings, deps: MuxBridgeDeps): void {
	if (!isFailure(record.outcome) || !notificationsQualify(record, settings)) return;
	const detail = record.detail ? `: ${record.detail}` : "";
	deps.notice?.("error", `${record.agentId} ${record.outcome ?? "failed"} (${record.runId})${detail}`);
}

/**
 * Bounded, sanitized pane label. `DispatchRunIdentity.task` is exact dispatched
 * text and `bus-events.ts:524` requires every UI projection to sanitize and
 * bound it before rendering; a pane label is a UI projection that also becomes
 * a herdr metadata value.
 */
export function runPaneLabel(identity: { agentId: string; task?: string | undefined }): string {
	const task = typeof identity.task === "string" ? sanitizeCallTargetText(identity.task).trim() : "";
	if (task.length === 0) return identity.agentId;
	const bounded = task.length > LABEL_MAX_CHARS ? `${task.slice(0, LABEL_MAX_CHARS - 1)}…` : task;
	return `${identity.agentId}: ${bounded}`;
}

/**
 * Sidebar labels a terminal pane carries. A finished run reported as `idle`
 * is indistinguishable from an untouched shell without one.
 */
function outcomeLabel(outcome: MuxRunOutcome | null): string {
	if (outcome === null) return "finished";
	return outcome === "succeeded"
		? "review ready"
		: outcome === "failed"
			? "failed, review"
			: outcome === "timed_out"
				? "timed out, review"
				: "canceled";
}

interface RolePresentation {
	token: string;
	display: string;
	working: string;
	blocked: string;
}

/** Stable role vocabulary for sidebar tokens and every semantic state. */
function rolePresentation(role: string): RolePresentation {
	const normalized = role.trim().toLowerCase();
	if (normalized === "candidate" || normalized === "builder") {
		return { token: normalized, display: normalized, working: "building", blocked: "build blocked" };
	}
	if (normalized === "reviewer" || normalized === "judge" || normalized === "synthesis") {
		return { token: normalized, display: normalized, working: "reviewing", blocked: "review blocked" };
	}
	if (normalized === "member") {
		return { token: normalized, display: "council member", working: "deliberating", blocked: "member blocked" };
	}
	if (/test|verif|qa/u.test(normalized)) {
		return { token: normalized, display: normalized, working: "verifying", blocked: "verification blocked" };
	}
	if (/scout|research|explor/u.test(normalized)) {
		return { token: normalized, display: normalized, working: "researching", blocked: "research blocked" };
	}
	if (/fix|debug|repair/u.test(normalized)) {
		return { token: normalized, display: normalized, working: "repairing", blocked: "repair blocked" };
	}
	return { token: normalized || "agent", display: normalized || "agent", working: "running", blocked: "needs input" };
}

function runStateLabels(role: RolePresentation, outcome: MuxRunOutcome | null): Record<string, string> {
	return { working: role.working, blocked: role.blocked, idle: outcomeLabel(outcome) };
}

/** Which semantic agent state herdr should paint for a run's current phase. */
function agentStateFor(phase: RunPhase): "working" | "blocked" | "idle" {
	if (phase === "blocked") return "blocked";
	return phase === "done" ? "idle" : "working";
}

/** Clio's own pane state (SA-3), mapped from the interactive status machine. */
function selfStateFor(phase: AgentStatusChangedPayload["phase"]): "working" | "blocked" | "idle" {
	if (phase === "tool_blocked") return "blocked";
	// `ended` is the settle step on the way back to idle, so both read idle.
	return phase === "idle" || phase === "ended" ? "idle" : "working";
}

export function createMuxBridge(deps: MuxBridgeDeps): MuxBridge {
	const log = deps.log ?? ((): void => undefined);
	const now = deps.now ?? Date.now;
	const throttleMs = deps.throttleMs ?? MUX_BRIDGE_THROTTLE_MS;
	const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
	const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;

	const runs = new Map<string, RunRecord>();
	let disposed = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	/** Serializes flushes: a flush awaits mux calls and must not interleave with the next. */
	let draining: Promise<void> = Promise.resolve();
	/** Pending self-report state, or null when nothing changed since the last flush. */
	let pendingSelf: "working" | "blocked" | "idle" | null = null;
	/** The last state actually reported, so a repeated phase costs no wire call. */
	let reportedSelf: "working" | "blocked" | "idle" | null = null;

	const schedule = (): void => {
		if (disposed || timer !== null) return;
		timer = setTimeoutFn(() => {
			timer = null;
			void drain();
		}, throttleMs);
		timer.unref?.();
	};

	const touch = (identity: DispatchRunIdentity, patch: Partial<RunRecord> = {}): RunRecord => {
		const existing = runs.get(identity.runId);
		const record: RunRecord = existing ?? {
			runId: identity.runId,
			agentId: identity.agentId,
			role: identity.gate?.role ?? identity.agentId,
			label: runPaneLabel(identity),
			model: identity.wireModelId ?? null,
			phase: "queued",
			outcome: null,
			detail: null,
			startedAt: now(),
			durationMs: null,
			pendingApprovals: new Set<string>(),
			opened: false,
			paneGone: false,
			settled: false,
			dirty: true,
		};
		Object.assign(record, patch, { dirty: true });
		runs.set(record.runId, record);
		schedule();
		return record;
	};

	/**
	 * Does this run deserve a viewer pane under the current policy? `auto` is the
	 * spec's "runs you lose sight of": detached batches and attach-to-background
	 * conversions, both of which surface as a durable detached-batch record.
	 */
	const qualifies = (record: RunRecord, policy: PanesAgentsPolicy): boolean => {
		if (policy === "off") return false;
		if (policy === "all") return true;
		return deps.isDetached?.(record.runId) === true;
	};

	const settle = async (record: RunRecord, settings: MuxBridgePanesSettings): Promise<void> => {
		const failure = isFailure(record.outcome);
		if (notificationsQualify(record, settings)) {
			const long = record.durationMs !== null && record.durationMs >= LONG_RUN_MS;
			await deps.mux.notify({
				title: `${record.agentId} ${record.outcome ?? "finished"}`,
				...(record.detail ? { body: record.detail } : {}),
				// A failure interrupts; a long success announces. A short success in
				// `all` mode gets the toast without the chime.
				sound: failure ? "request" : long ? "done" : "none",
			});
		}
		persistentFailureNotice(record, settings, deps);
		if (record.opened && !record.paneGone) {
			await deps.mux.closeRunPane(record.runId, { keepOnFailure: settings.keepFailed });
		}
		record.settled = true;
	};

	const project = async (record: RunRecord, settings: MuxBridgePanesSettings): Promise<void> => {
		const terminal = record.phase === "done";
		if (!record.opened && !record.paneGone && !terminal && qualifies(record, settings.agents)) {
			const ref = await deps.mux.openRunPane({
				runId: record.runId,
				agentId: record.agentId,
				label: record.label,
			});
			record.opened = ref !== null;
		}
		if (record.opened && !record.paneGone) {
			const role = rolePresentation(record.role);
			await deps.mux.reportRunState(record.runId, {
				phase: record.phase,
				agentState: agentStateFor(record.phase),
				...(record.model ? { model: record.model } : {}),
				...(record.outcome ? { outcome: record.outcome } : {}),
				displayAgent: record.agentId,
				tokens: { role: role.token, role_display: role.display, agent: record.agentId },
				stateLabels: runStateLabels(role, record.outcome),
			});
		}
		if (terminal) {
			await settle(record, settings);
			runs.delete(record.runId);
		}
	};

	const drain = (): Promise<void> => {
		draining = draining.then(async () => {
			if (disposed) return;
			const self = pendingSelf;
			pendingSelf = null;
			const dirty = [...runs.values()].filter((record) => record.dirty);
			for (const record of dirty) record.dirty = false;
			if (self !== null && self !== reportedSelf) {
				reportedSelf = self;
				await deps.mux.reportSelf({ state: self }).catch(() => false);
			}
			if (dirty.length === 0) return;
			// `available()` is checked once per flush rather than per call: the
			// contract already degrades every method, and asking per run would let a
			// mid-flush degradation split one burst across two behaviors.
			if (!deps.mux.available()) {
				const settings = deps.getPanesSettings();
				for (const record of dirty) {
					if (record.phase === "done") {
						persistentFailureNotice(record, settings, deps);
						runs.delete(record.runId);
					}
				}
				return;
			}
			const settings = deps.getPanesSettings();
			for (const record of dirty) {
				if (record.settled) continue;
				try {
					await project(record, settings);
				} catch (error) {
					// The contract swallows its own failures, so anything arriving here
					// is a bug rather than a dead socket. It must still not kill the loop.
					log("debug", `mux bridge failed on ${record.runId}: ${error instanceof Error ? error.message : String(error)}`);
					runs.delete(record.runId);
				}
			}
		});
		return draining;
	};

	const onTerminal = (
		identity: DispatchRunIdentity,
		outcome: MuxRunOutcome,
		fields: { durationMs?: number | undefined; detail?: string | null | undefined },
	): void => {
		const existing = runs.get(identity.runId);
		// A terminal event for a run this bridge never saw start is not worth a
		// pane; there is nothing live to view.
		if (!existing) return;
		const detail = typeof fields.detail === "string" && fields.detail.length > 0 ? fields.detail : null;
		touch(identity, {
			phase: "done",
			outcome,
			durationMs: typeof fields.durationMs === "number" ? fields.durationMs : now() - existing.startedAt,
			detail: detail === null ? null : sanitizeCallTargetText(detail).slice(0, LABEL_MAX_CHARS * 2),
		});
	};

	const unsubscribers = [
		deps.bus.on(BusChannels.DispatchEnqueued, (payload) => {
			touch(payload, { phase: "queued" });
		}),
		deps.bus.on(BusChannels.DispatchStarted, (payload) => {
			touch(payload, { phase: "running", startedAt: now() });
		}),
		deps.bus.on(BusChannels.DispatchProgress, (payload) => {
			const record = runs.get(payload.runId);
			if (!record) return;
			// The progress stream crosses a process boundary, so its shape is
			// validated here rather than trusted. An escalated permission ask is the
			// live "waiting on a gate/approval" signal spec 4.7 maps to `blocked`;
			// the matching resolution is what releases it.
			const event = payload.event as { type?: unknown; payload?: { requestId?: unknown } } | null | undefined;
			const kind = typeof event?.type === "string" ? event.type : null;
			const requestId = typeof event?.payload?.requestId === "string" ? event.payload.requestId : null;
			if (kind === "clio_permission_escalated" && requestId !== null) {
				record.pendingApprovals.add(requestId);
			} else if (kind === "clio_permission_resolved" && requestId !== null) {
				record.pendingApprovals.delete(requestId);
			} else if (record.phase !== "queued") {
				// Ordinary progress does not change the phase, so it is not worth a
				// flush of its own; the pane already reads `working`.
				return;
			}
			const phase: RunPhase = record.pendingApprovals.size > 0 ? "blocked" : "running";
			if (phase === record.phase) return;
			touch({ runId: payload.runId, agentId: payload.agentId } as DispatchRunIdentity, { phase });
		}),
		deps.bus.on(BusChannels.DispatchCompleted, (payload) => {
			onTerminal(payload, terminalOutcome(payload.outcome), {
				durationMs: payload.durationMs,
				detail: payload.outcomeDetail,
			});
		}),
		deps.bus.on(BusChannels.DispatchFailed, (payload) => {
			onTerminal(payload, terminalOutcome(payload.reason), {
				durationMs: payload.durationMs,
				detail: payload.outcomeDetail,
			});
		}),
		// SA-3. The interactive status machine is the one surface that already
		// knows when a turn starts, when it ends, and when a tool call is parked
		// on an approval, so the self-report rides its transitions rather than
		// growing a second turn-lifecycle listener.
		deps.bus.on(BusChannels.AgentStatusChanged, (payload) => {
			const state = selfStateFor(payload.phase);
			if (state === reportedSelf && pendingSelf === null) return;
			pendingSelf = state;
			schedule();
		}),
		deps.mux.onPaneGone((record: MuxPaneRecord) => {
			if (record.runId === null) return;
			const run = runs.get(record.runId);
			if (!run) return;
			// The operator closed the viewer deliberately. Record it and never
			// reopen; the run keeps going and the native surfaces keep showing it.
			run.paneGone = true;
			log("debug", `mux bridge: viewer pane for ${record.runId} was closed; not reopening`);
		}),
	];

	const adoption = (async (): Promise<void> => {
		const resumable = deps.resumableRuns?.() ?? [];
		if (resumable.length === 0 || !deps.mux.available()) return;
		const adopted = await deps.mux.adoptRunPanes(resumable);
		for (const runId of adopted) {
			const run = resumable.find((candidate) => candidate.runId === runId);
			if (!run) continue;
			runs.set(runId, {
				runId,
				agentId: run.agentId,
				role: run.agentId,
				label: run.label,
				model: null,
				phase: "running",
				outcome: null,
				detail: null,
				startedAt: now(),
				durationMs: null,
				pendingApprovals: new Set<string>(),
				opened: true,
				paneGone: false,
				settled: false,
				dirty: false,
			});
		}
	})().catch((error) => {
		log("debug", `mux bridge resume adoption failed: ${error instanceof Error ? error.message : String(error)}`);
	});

	return {
		adoption,
		flush(): Promise<void> {
			if (timer !== null) {
				clearTimeoutFn(timer);
				timer = null;
			}
			return drain();
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			if (timer !== null) clearTimeoutFn(timer);
			timer = null;
			for (const unsubscribe of unsubscribers) unsubscribe();
			runs.clear();
		},
	};
}

/**
 * Clio's seven-member run outcome taxonomy narrowed to the four states a pane
 * records. `stalled`, `denied_by_policy`, `spawn_failed`, and the synthetic
 * `retry_denied` all read as failure, which is the safe direction: an
 * unrecognized terminal state must not silently close a pane `keepFailed` would
 * have kept open for the post-mortem.
 */
function terminalOutcome(outcome: string): MuxRunOutcome {
	if (outcome === "succeeded") return "succeeded";
	if (outcome === "canceled") return "canceled";
	if (outcome === "timed_out") return "timed_out";
	return "failed";
}
