import type { QueryClient } from "@tanstack/react-query";
import type { SessionControl } from "../../contracts/control.js";
import type { Event } from "../../contracts/events.js";
import type { Operation } from "../../contracts/operations.js";
import { SessionDeltaKinds as SessionDeltas } from "../../contracts/runtime.js";
import type { SessionDelta, SessionSnapshot } from "../../contracts/sessions.js";
import type { QueueSnapshot } from "../../contracts/steering.js";
import { applyControl, lostControlNotice } from "../chat/control-model.js";
import { telemetryInvalidations, telemetryRefresh } from "../telemetry/live-model.js";
import { onTokenRejected, tokenRejected } from "./auth-state.js";
import type { Client } from "./client.js";
import { clock } from "./clock.js";
import { FrameEventBuffer } from "./frame-buffer.js";
import { advanceSessionReadScope, resetSessionBuffers, SESSION_CACHES, sessionBuffer } from "./sessions.js";

type OperationEntry = { resource: string; revision: number; operation?: Operation };
export type ConnectionState = "Connecting…" | "Connected" | "Reconnecting…" | "Not connected";
/** A launch older than this was meant for a moment that has passed, such as one replayed after a reconnect. */
const LAUNCH_FRESH_MS = 10_000;

/** The monotonic clock and the one-shot timer behind the telemetry refresh throttle. */
interface RefreshTimers {
	now(): number;
	/** Runs `run` once after `ms`; the returned function cancels it. */
	schedule(run: () => void, ms: number): () => void;
}
const liveTimers: RefreshTimers = {
	now: () => performance.now(),
	schedule: (run, ms) => {
		const handle = setTimeout(run, ms);
		return () => clearTimeout(handle);
	},
};

export function subscribe(
	client: Client,
	queries: QueryClient,
	connection: (state: ConnectionState) => void,
	/** A launch found this app open and named a page for the window it focused. */
	launch: (path: string) => void = () => {},
	/** Another window took control of a session this one held. */
	controlLost: (notice: { title: string; detail: string }) => void = () => {},
	timers: RefreshTimers = liveTimers,
) {
	let stream: EventSource | null = null;
	let cursor: string | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let retryMs = 1_000;
	let disposed = false;
	let epoch: string | undefined;
	let disconnected = false;
	const contextSnapshots = new WeakMap<ReturnType<typeof sessionBuffer>, { context: unknown }>();
	const projectContext = (snapshot: SessionSnapshot) => {
		const held = sessionBuffer(snapshot.id);
		const accepted = held.snapshot(snapshot);
		if (!accepted) return;
		const context = accepted.telemetry?.usage?.context;
		const previous = contextSnapshots.get(held);
		contextSnapshots.set(held, { context });
		if ((!previous && context === undefined) || previous?.context === context) return;
		// A newer REST snapshot is just as authoritative as pushed context. Retire reads
		// that began before it, while unrelated timeline updates leave accounting alone.
		queries.setQueryData<number>(["session-context-push", snapshot.id], (revision = 0) => revision + 1);
	};
	const refreshAutonomy = (id?: string) => {
		const queryKey = id === undefined ? ["session-autonomy"] : ["session-autonomy", id];
		// Cancellation also retires query functions that do not forward an AbortSignal (GUI-03).
		void queries.cancelQueries({ queryKey });
		void queries.invalidateQueries({ queryKey });
	};
	const projectAutonomy = (snapshot: SessionSnapshot) => {
		const accepted = sessionBuffer(snapshot.id).snapshot(snapshot);
		const autonomy = accepted?.telemetry?.autonomy;
		if (!autonomy) return;
		const queryKey = ["session-autonomy", snapshot.id];
		void queries.cancelQueries({ queryKey, exact: true });
		const current = queries.getQueryData<typeof autonomy>(queryKey);
		if (current?.level === autonomy.level && current.source === autonomy.source) return;
		queries.setQueryData(queryKey, autonomy);
	};
	// REST snapshots and SSE deltas both pass through the session revision buffer before seeding mode (GUI-03).
	const stopSnapshots = queries.getQueryCache().subscribe((event) => {
		if (event.type !== "updated" || event.action.type !== "success" || event.query.queryKey[0] !== "session") return;
		const snapshot = event.query.state.data as SessionSnapshot | undefined;
		if (snapshot) projectContext(snapshot);
		if (snapshot && (!event.action.manual || queries.getQueryData(["session-autonomy", snapshot.id]) === undefined))
			projectAutonomy(snapshot);
	});
	for (const [, snapshot] of queries.getQueriesData<SessionSnapshot>({ queryKey: ["session"] }))
		if (snapshot) {
			projectContext(snapshot);
			projectAutonomy(snapshot);
		}

	// Pushed telemetry re-reads its session at most once per interval; later pushes wait in one trailing refresh.
	const telemetryRefreshed = new Map<string, number>();
	const telemetryPending = new Map<string, Set<string>>();
	const telemetryTimers = new Map<string, () => void>();
	/** Invalidates the keys given and any held for the session; true when the operator window moved too. */
	const refreshTelemetry = (id: string, keys: ReadonlySet<string>) => {
		telemetryTimers.get(id)?.();
		telemetryTimers.delete(id);
		const due = new Set([...(telemetryPending.get(id) ?? []), ...keys]);
		telemetryPending.delete(id);
		if (due.size === 0) return false;
		telemetryRefreshed.set(id, timers.now());
		// No cancel first: restarting an in-flight read on every push turned ten pushes into ten reads of a busy agent.
		for (const key of due) void queries.invalidateQueries({ queryKey: [key, id] });
		return due.has("telemetry");
	};
	const deferTelemetry = (id: string, keys: ReadonlySet<string>, delayMs: number) => {
		const pending = telemetryPending.get(id) ?? new Set<string>();
		for (const key of keys) pending.add(key);
		telemetryPending.set(id, pending);
		if (telemetryTimers.has(id)) return;
		telemetryTimers.set(
			id,
			timers.schedule(() => {
				telemetryTimers.delete(id);
				if (!disposed && refreshTelemetry(id, new Set()))
					void queries.invalidateQueries({ queryKey: ["operator-metrics"] });
			}, delayMs),
		);
	};
	const stopTelemetry = () => {
		for (const cancel of telemetryTimers.values()) cancel();
		telemetryTimers.clear();
		telemetryPending.clear();
		telemetryRefreshed.clear();
	};

	// One commit per session per display frame, however many chunks landed in it.
	const buffer = new FrameEventBuffer((events) => {
		const snapshots = new Map<string, SessionSnapshot>(),
			gaps = new Set<string>(),
			resumed = new Set<string>(),
			reset = new Set<string>(),
			configured = new Set<string>(),
			refreshReads = new Map<string, Set<string>>(),
			telemetry = new Map<string, Set<string>>(),
			finished = new Set<string>(),
			contextPushes = new Map<string, number>(),
			autonomyChanged = new Set<string>(),
			invalidate = new Set<string>(),
			operations: OperationEntry[] = [];
		let resynced = false;
		let launched: string | null = null;
		for (const event of events) {
			client.adoptEpoch(event.epoch);
			if ((epoch && epoch !== event.epoch) || event.type === "resync") {
				// Everything collected so far is stale, and so is the rest of the batch.
				resynced = true;
				snapshots.clear();
				gaps.clear();
				resumed.clear();
				reset.clear();
				configured.clear();
				refreshReads.clear();
				telemetry.clear();
				finished.clear();
				contextPushes.clear();
				autonomyChanged.clear();
				invalidate.clear();
				operations.length = 0;
				launched = null;
				epoch = event.epoch;
				continue;
			}
			epoch = event.epoch;
			if (Object.hasOwn(SessionDeltas, event.type)) {
				const delta = event as SessionDelta,
					held = sessionBuffer(delta.payload.resource),
					hadGap = held.hasGap,
					previousRevision = held.value?.revision ?? -1,
					previousAutonomy = held.value?.telemetry?.autonomy,
					parked = held.value?.state === "parked",
					state = held.event(delta);
				if (state) snapshots.set(state.id, state);
				if (
					delta.type === "session.telemetry" &&
					delta.payload.telemetry.usage !== undefined &&
					delta.payload.revision > previousRevision &&
					state &&
					state.revision >= delta.payload.revision
				)
					contextPushes.set(delta.payload.resource, delta.payload.revision);
				if (state?.telemetry?.autonomy && state.telemetry.autonomy !== previousAutonomy) autonomyChanged.add(state.id);
				// A resumed task answers from a new agent process, so what the old one reported is stale.
				if (parked && state?.state === "open") resumed.add(state.id);
				if (delta.type === "session.reset") reset.add(delta.payload.resource);
				if (delta.type === "turn.finished") finished.add(delta.payload.resource);
				if (held.hasGap) gaps.add(delta.payload.resource);
				if (delta.type === "session.configured" || (!hadGap && held.hasGap)) configured.add(delta.payload.resource);
				if (
					delta.type === "session.telemetry" &&
					delta.payload.telemetry.autonomy &&
					delta.payload.revision > previousRevision
				)
					void queries.cancelQueries({ queryKey: ["session-autonomy", delta.payload.resource], exact: true });
				if (
					delta.type === "context.activity" ||
					delta.type === "context.status" ||
					delta.type === "session.changed" ||
					delta.type === "session.labelled" ||
					delta.type === "session.configured" ||
					delta.type === "session.reset" ||
					delta.type === "turn.started" ||
					delta.type === "turn.admitted" ||
					delta.type === "turn.finished" ||
					delta.type === "permission.requested" ||
					delta.type === "permission.resolved" ||
					delta.type === "permission.expired"
				) {
					invalidate.add("sessions");
				}
				// The saved-task list costs the server an agent process per read. Open and parked tasks are drawn from
				// the overview, so only a label or a task leaving the held set changes what the list shows.
				if (
					delta.type === "session.labelled" ||
					(delta.type === "session.changed" &&
						(delta.payload.state === "closed" || delta.payload.state === "unknown" || delta.payload.recoveredOrphan))
				) {
					invalidate.add("session-history");
				}
				// Completed context work changes accounting and the session's durable projections.
				if (delta.type === "context.activity" && delta.payload.activity.operation?.outcome !== undefined) {
					for (const key of [
						"session-context",
						"session-context-work",
						"session-usage",
						"session-artifacts",
						"session-tree",
						"session-board",
					]) {
						const keys = refreshReads.get(delta.payload.resource) ?? new Set<string>();
						keys.add(key);
						refreshReads.set(delta.payload.resource, keys);
					}
				}
				// A sealed evidence bundle changes what the evidence and record reads return.
				if (delta.type === "evidence.ready")
					for (const key of ["evidence", "evidence-detail", "fleet-run-record"]) invalidate.add(key);
			}
			if (event.type === "hello") {
				if (disconnected) {
					if (!resynced) {
						// A failed REST refresh can leave a conversation showing an error even
						// after the event stream catches up. Heal the visible read on reconnect.
						void queries.invalidateQueries({ queryKey: ["session"] });
						void queries.invalidateQueries({ queryKey: ["sessions"] });
						void queries.invalidateQueries({ queryKey: ["session-interview"] });
						void queries.invalidateQueries({ queryKey: ["meta"] });
						refreshAutonomy();
					}
					disconnected = false;
				}
				connection("Connected");
			}
			if (event.type === "operation.finished") {
				operations.push({ ...event.payload });
				invalidate.add("tools");
				if (event.payload.kind.startsWith("evidence."))
					for (const key of ["evidence", "evidence-detail", "fleet-run-record"]) invalidate.add(key);
				if (event.payload.kind.startsWith("targets."))
					for (const key of ["targets", "routing", "workspace-settings", "config-graph", "settings-controls"])
						invalidate.add(key);
			}
			if (event.type === "operation.progress") operations.push({ ...event.payload });
			if (event.type === "interview.changed") {
				invalidate.add("session-overview");
				void queries.cancelQueries({ queryKey: ["session-interview", event.payload.resource], exact: true });
				queries.setQueryData(["session-interview", event.payload.resource], event.payload.round);
			}
			if (event.type === "queue.changed") {
				invalidate.add("session-overview");
				const { resource, entries } = event.payload;
				void queries.cancelQueries({ queryKey: ["session-queue", resource], exact: true });
				queries.setQueryData<QueueSnapshot>(["session-queue", resource], {
					steer: entries.filter((entry) => entry.kind === "steer").map((entry) => entry.text),
					followUp: entries.filter((entry) => entry.kind === "follow-up").map((entry) => entry.text),
					entries,
				});
			}
			if (event.type === "toolchain.changed") invalidate.add("tools");
			// A coalesced telemetry_update re-reads the moved topics for its session; nothing is folded here (#434).
			if (event.type === "telemetry.updated") {
				const keys = telemetry.get(event.payload.resource) ?? new Set<string>();
				for (const key of telemetryInvalidations(event.payload.update)) keys.add(key);
				telemetry.set(event.payload.resource, keys);
			}
			if (event.type === "machine.attach") invalidate.add("machine-attachments");
			if (event.type === "session.control") {
				const { resource, controller } = event.payload;
				const key = ["session-control", resource];
				const you =
					queries.getQueryData<SessionControl>(key)?.you.clientId ??
					(client.prefix === "" ? client.credentials.clientId() : null);
				const notice = lostControlNotice(event.payload, you);
				if (notice) controlLost(notice);
				queries.setQueryData<SessionControl | undefined>(key, (control) => applyControl(control, controller));
			}
			if (event.type === "app.launch" && clock.now() - Date.parse(event.at) < LAUNCH_FRESH_MS)
				launched = event.payload.path;
		}
		if (resynced) {
			stopTelemetry();
			void queries.cancelQueries();
			queries.removeQueries({ queryKey: ["session-autonomy"] });
			queries.removeQueries({ queryKey: ["operation"] });
			resetSessionBuffers();
			void queries.resetQueries({ queryKey: ["session"] });
			for (const key of SESSION_CACHES) void queries.resetQueries({ queryKey: [key] });
			void queries.invalidateQueries();
			return;
		}
		for (const id of new Set([...resumed, ...reset])) advanceSessionReadScope(id);
		for (const [id, state] of snapshots) queries.setQueryData<SessionSnapshot>(["session", id], state);
		// Equal-valued telemetry still supersedes an older in-flight read.
		for (const id of contextPushes.keys())
			queries.setQueryData<number>(["session-context-push", id], (revision = 0) => revision + 1);
		for (const id of autonomyChanged) {
			const state = snapshots.get(id);
			if (state) projectAutonomy(state);
		}
		for (const id of gaps) void queries.invalidateQueries({ queryKey: ["session", id] });
		for (const id of new Set([...resumed, ...reset]))
			for (const key of SESSION_CACHES) {
				// A branch switch runs inside the same agent process, so what that process announced still holds. Dropping it
				// unmounted every surface it gates until the re-read landed, the branch panel and its focused heading too.
				if (key === "session-capabilities" && !resumed.has(id)) continue;
				void queries.cancelQueries({ queryKey: [key, id] });
				// A replacement runtime or branch cannot inherit the previous read's successful data.
				void queries.resetQueries({ queryKey: [key, id] });
			}
		for (const [id, keys] of refreshReads)
			for (const key of keys) {
				void queries.cancelQueries({ queryKey: [key, id] });
				void queries.invalidateQueries({ queryKey: [key, id] });
			}
		let operatorMetrics = false;
		for (const id of new Set([...telemetry.keys(), ...finished])) {
			const keys = telemetry.get(id) ?? new Set<string>();
			// A key refreshed above already reads the newest state.
			for (const key of refreshReads.get(id) ?? []) keys.delete(key);
			// The turn's last numbers land now, not a throttle interval later.
			const decision = finished.has(id)
				? ({ refresh: "now" } as const)
				: telemetryRefresh(timers.now(), telemetryRefreshed.get(id));
			if (decision.refresh === "now") operatorMetrics = refreshTelemetry(id, keys) || operatorMetrics;
			else deferTelemetry(id, keys, decision.delayMs);
		}
		if (operatorMetrics) invalidate.add("operator-metrics");
		for (const id of configured) {
			const held = sessionBuffer(id);
			if (!resumed.has(id) && (held.hasGap || !held.value?.telemetry?.autonomy)) refreshAutonomy(id);
			for (const key of ["session-settings", "session-targets", "session-context"]) {
				void queries.cancelQueries({ queryKey: [key, id] });
				void queries.invalidateQueries({ queryKey: [key, id] });
			}
		}
		for (const entry of operations) {
			if (entry.operation)
				queries.setQueryData<Operation>(["operation", entry.resource], (current) =>
					current && current.revision > entry.revision ? current : entry.operation,
				);
			else void queries.invalidateQueries({ queryKey: ["operation", entry.resource] });
		}
		if (
			invalidate.has("sessions") ||
			events.some(
				(event) =>
					event.type === "fleet.enqueued" ||
					event.type === "fleet.started" ||
					event.type === "fleet.completed" ||
					event.type === "fleet.failed" ||
					event.type === "job.changed" ||
					event.type === "job.listed" ||
					event.type === "hello",
			)
		)
			invalidate.add("session-overview");
		// Invalidation alone reuses a pending first read, which may have captured an older attention state.
		if (invalidate.has("session-overview")) void queries.cancelQueries({ queryKey: ["session-overview"] });
		for (const key of invalidate) void queries.invalidateQueries({ queryKey: [key] });
		if (launched !== null) launch(launched);
	});

	const retry = () => {
		connection(tokenRejected() ? "Not connected" : "Reconnecting…");
		if (tokenRejected()) return;
		retryTimer = setTimeout(() => {
			retryTimer = null;
			void connect();
		}, retryMs);
		retryMs = Math.min(retryMs * 2, 30_000);
	};
	let attempt = 0;
	const connect = async () => {
		if (disposed || tokenRejected()) return;
		const current = ++attempt;
		let url: string;
		try {
			// A single-use ticket from this app; the credential stays out of the URL.
			url = await client.eventsUrl(cursor);
		} catch {
			// A refused launch link is learned by the exchange itself; anything else retries.
			if (!disposed && current === attempt) retry();
			return;
		}
		if (disposed || current !== attempt || tokenRejected()) return;
		const source = new EventSource(url);
		stream = source;
		const receive = (message: MessageEvent<string>) => {
			if (disposed || stream !== source) return;
			let event: Event;
			try {
				event = JSON.parse(message.data) as Event;
			} catch {
				// The cursor stays put so a reconnect resumes before this frame; the payload is not logged.
				console.error(
					`CLIO Coder skipped a malformed ${message.type || "event"} frame${message.lastEventId ? ` (${message.lastEventId})` : ""}.`,
				);
				return;
			}
			cursor = `${event.epoch}:${event.seq}`;
			if (event.type === "hello") retryMs = 1_000;
			buffer.push(event);
		};
		for (const type of [
			"hello",
			"resync",
			"operation.progress",
			"operation.finished",
			"toolchain.changed",
			"machine.attach",
			"interview.changed",
			"queue.changed",
			"telemetry.updated",
			"app.launch",
			"session.control",
			...Object.keys(SessionDeltas),
		])
			source.addEventListener(type, receive as EventListener);
		source.onerror = () => {
			if (disposed || stream !== source) return;
			disconnected = true;
			// Paint every received event before reporting a connection loss.
			buffer.flush();
			// The browser's own retry would present the same ticket, which the server has already
			// spent, so every loss reconnects here with a fresh one. Minting it is an ordinary request,
			// whose 401 handling also learns of a refused launch link.
			source.close();
			stream = null;
			retry();
		};
	};
	void connect();
	// The refusal can also be learned after the last stream error, from an ordinary request.
	const stopWatching = onTokenRejected(() => {
		if (retryTimer !== null) clearTimeout(retryTimer);
		retryTimer = null;
		stream?.close();
		stream = null;
		connection("Not connected");
	});
	const onVisibility = () => {
		if (document.visibilityState === "visible") buffer.flush();
	};
	document.addEventListener("visibilitychange", onVisibility);
	return () => {
		disposed = true;
		stopSnapshots();
		stopTelemetry();
		document.removeEventListener("visibilitychange", onVisibility);
		stopWatching();
		if (retryTimer !== null) clearTimeout(retryTimer);
		// Closing the buffer first stops a scheduled frame landing in a torn-down tree.
		buffer.close();
		stream?.close();
	};
}
