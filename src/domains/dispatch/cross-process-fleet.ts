/**
 * Cross-process fleet state (fleet design principle 8, M11): a second Clio process on the same state directory sees
 * this process's live workers and can answer their held asks, and this process sees and answers the other's.
 *
 * Two halves, both over the run-directory records (run-directory-records.ts) and the run feed (run-feed.ts):
 *
 * - Owner side, in every process that dispatches. A run that starts here gets its owner record. An operator-visible
 *   worker ask raised here gets a grant record, and while any is pending a poll takes answers other processes wrote
 *   and applies each through `resolve`, the same path this process's own permission card uses. The resolution the
 *   card receives is written back, so the asking process sees the ask leave.
 * - Viewer side, only where a person can answer (`follow`). Runs the ledger shows live that another process owns, in
 *   this project, are followed: the owner record gives the row its identity, the feed is the progress source, and the
 *   run's grant records become cards. They reach this process's surfaces on two live-only topics,
 *   `run.foreign_observed` and `approval.foreign_changed`, never on the topics this process's own runs use, so no
 *   foreign run is journaled, recorded in this session or written to a feed a second time.
 *
 * A record whose owner died is no live run and no ask: `ownerState` probes the pid and birth token the way the
 * capacity lease does, and a followed run whose owner is gone ends `dead` with its asks withdrawn.
 */

import { closeSync, constants, openSync, readSync, statSync } from "node:fs";
import {
	type OwnerIdentity,
	ownerIdentity,
	ownerIsThisProcess,
	ownerState,
	type RecordedOwner,
} from "../../core/process-identity.js";
import type { TelemetryHub } from "../../core/telemetry/hub.js";
import type {
	DispatchStartedPayload,
	ForeignApprovalChangedPayload,
	ForeignRunObservedPayload,
	PermissionRequestedPayload,
	PermissionResolvedPayload,
} from "../../core/telemetry/live-events.js";
import { clioStateDir } from "../../core/xdg.js";
import {
	type GrantRecordBinding,
	type GrantRequestRecord,
	readGrantRequestRecords,
	readRunOwnerRecord,
	resolveGrantRequestRecord,
	takeGrantAnswer,
	writeGrantAnswerRecord,
	writeGrantRequestRecord,
	writeRunOwnerRecord,
} from "./run-directory-records.js";
import { RUN_FEED_READ_TAIL_BYTES, type RunFeedLine, readRunFeedLine, runFeedPath } from "./run-feed.js";
import { type LedgerSnapshot, readLedgerSnapshot } from "./state.js";
import { HOST_VERIFICATION_EVENT } from "./verification-slot.js";

/** How often a pending ask is checked for an answer, and the ledger and feeds of foreign runs are read. */
export const CROSS_PROCESS_POLL_MS = 500;
/** Bytes one poll folds from one foreign feed, so a backlog cannot stall a frame. */
const FEED_READ_MAX_BYTES = 256 * 1024;

export interface CrossProcessFleetDeps {
	bus: Pick<TelemetryHub, "emit" | "subscribe">;
	stateDir?: () => string;
	cwd?: string;
	/** Runs this process drives; their rows and asks reach this process's surfaces directly. */
	isLocalRun(runId: string): boolean;
	/** The grant broker's binding for an ask it holds, null for one it does not. */
	grantBinding(requestId: string): { attempt: number; argDigest: string } | null;
	/** Apply an answer from another process through this process's own answer path. Throws when it is refused. */
	resolve(runId: string, requestId: string, decision: "approve" | "deny"): void;
	/** Follow other processes' runs and asks; set where a person can answer. */
	follow: boolean;
	/** Tests drive `poll` themselves. */
	timers?: boolean;
	owner?: (owner: RecordedOwner) => "alive" | "gone" | "unknown";
	/** The identity this process writes into its records; a test stands in for a second process with it. */
	self?: OwnerIdentity;
}

export interface CrossProcessFleet {
	/** Answer an ask another process holds. False when no live foreign ask has that id. */
	answerForeign(runId: string, requestId: string, decision: "approve" | "deny"): boolean;
	/** Whether a live ask with this id is held by another process. */
	isForeignAsk(requestId: string): boolean;
	poll(): void;
	dispose(): void;
}

/** A feed row as the worker event the progress fold reads; null for rows that carry nothing a live row shows. */
function foreignFeedEvent(line: RunFeedLine): Record<string, unknown> | null {
	if (line.kind !== "event") return null;
	const detail = line.detail;
	switch (line.type) {
		case "text":
			return detail !== undefined && detail.length > 0 ? { type: "text_delta", delta: detail } : null;
		case "thinking":
			return { type: "thinking_delta" };
		case "clio_coder_tool_start":
		case "clio_coder_tool_finish": {
			if (line.tool === undefined) return null;
			return {
				type: line.type,
				payload: {
					tool: line.tool,
					...(line.callId !== undefined ? { toolCallId: line.callId } : {}),
					...(line.outcome !== undefined ? { outcome: line.outcome } : {}),
					...(line.verb !== undefined
						? { action: { verb: line.verb, ...(detail !== undefined && detail.length > 0 ? { object: detail } : {}) } }
						: {}),
				},
			};
		}
		case "agent_start":
		case "agent_end":
		case "clio_coder_permission_escalated":
		case "clio_coder_permission_resolved":
			return { type: line.type };
		case HOST_VERIFICATION_EVENT:
			return { type: line.type, ...(detail !== undefined ? { message: detail } : {}) };
		default:
			return null;
	}
}

interface FollowedRun {
	runId: string;
	agentId: string;
	owner: RecordedOwner;
	offset: number;
	asks: Map<string, GrantRequestRecord>;
}

export function createCrossProcessFleet(deps: CrossProcessFleetDeps): CrossProcessFleet {
	const stateDir = deps.stateDir ?? clioStateDir;
	const cwd = deps.cwd ?? process.cwd();
	const probe = deps.owner ?? ownerState;
	const self = (): OwnerIdentity => deps.self ?? ownerIdentity();
	const unsubscribes: Array<() => void> = [];
	let timer: ReturnType<typeof setInterval> | null = null;
	let disposed = false;

	// ---------------------------------------------------------------- owner side
	/** This process's recorded asks that are still pending, by request id. */
	const ownAsks = new Map<string, GrantRequestRecord>();

	const ensureTimer = (): void => {
		if (deps.timers === false || disposed || timer !== null) return;
		if (!deps.follow && ownAsks.size === 0) return;
		timer = setInterval(() => poll(), CROSS_PROCESS_POLL_MS);
		timer.unref?.();
	};
	const stopTimerWhenIdle = (): void => {
		if (timer === null || deps.follow || ownAsks.size > 0) return;
		clearInterval(timer);
		timer = null;
	};

	const takeAnswers = (): void => {
		for (const record of [...ownAsks.values()]) {
			const decision = takeGrantAnswer(stateDir(), record);
			if (decision === null) continue;
			try {
				deps.resolve(record.runId, record.requestId, decision);
			} catch {
				// Refused (expired, run ended, session changed): its own resolution, if any, settles the record.
			}
		}
	};

	unsubscribes.push(
		deps.bus.subscribe("run.started", (payload: DispatchStartedPayload) => {
			if (typeof payload?.runId === "string") writeRunOwnerRecord(stateDir(), payload, cwd, self());
		}),
		deps.bus.subscribe("approval.requested", (payload: PermissionRequestedPayload) => {
			if (payload?.escalation !== true || typeof payload.requestId !== "string") return;
			if (typeof payload.origin !== "string" || !payload.origin.startsWith("worker:")) return;
			const runId = payload.requestedBy ?? payload.origin.slice("worker:".length);
			if (!deps.isLocalRun(runId)) return;
			const binding = deps.grantBinding(payload.requestId);
			const record = writeGrantRequestRecord(
				stateDir(),
				{
					request: payload,
					runId,
					attempt: binding?.attempt ?? null,
					argDigest: binding?.argDigest ?? null,
				},
				self(),
			);
			if (record === null) return;
			ownAsks.set(record.requestId, record);
			ensureTimer();
		}),
		deps.bus.subscribe("approval.resolved", (payload: PermissionResolvedPayload) => {
			const record = typeof payload?.requestId === "string" ? ownAsks.get(payload.requestId) : undefined;
			if (record === undefined) return;
			ownAsks.delete(record.requestId);
			resolveGrantRequestRecord(stateDir(), record, payload);
			stopTimerWhenIdle();
		}),
		...(["run.completed", "run.failed"] as const).map((topic) =>
			deps.bus.subscribe(topic, (payload: { runId?: unknown }) => {
				// A run that ended with an ask still recorded pending withdrew it; the record says so for any viewer.
				for (const record of [...ownAsks.values()]) {
					if (record.runId !== payload?.runId) continue;
					ownAsks.delete(record.requestId);
					resolveGrantRequestRecord(stateDir(), record, {
						status: "denied",
						requestId: record.requestId,
						requestedBy: record.runId,
						origin: `worker:${record.runId}`,
						decidedBy: "revoked",
					});
				}
				stopTimerWhenIdle();
			}),
		),
	);

	// --------------------------------------------------------------- viewer side
	const followed = new Map<string, FollowedRun>();
	/** Runs judged not followable for good: this process's own, another project's, or ended. */
	const settled = new Set<string>();
	/** Live foreign asks by request id, to bind an answer this process's card gives. */
	const foreignAsks = new Map<string, GrantRequestRecord>();
	let ledger: LedgerSnapshot | null = null;

	const emitRun = (payload: ForeignRunObservedPayload): void => {
		deps.bus.emit("run.foreign_observed", payload);
	};
	const emitAsk = (payload: ForeignApprovalChangedPayload): void => {
		deps.bus.emit("approval.foreign_changed", payload);
	};

	const withdrawAsk = (record: GrantRequestRecord, resolved: PermissionResolvedPayload): void => {
		foreignAsks.delete(record.requestId);
		emitAsk({ kind: "resolved", resolved });
	};

	const endRun = (run: FollowedRun, outcome: string, detail: string | null): void => {
		followed.delete(run.runId);
		settled.add(run.runId);
		for (const record of run.asks.values()) {
			if (!foreignAsks.has(record.requestId)) continue;
			withdrawAsk(record, {
				status: "denied",
				requestId: record.requestId,
				requestedBy: record.runId,
				origin: `worker:${record.runId}`,
				decidedBy: "revoked",
				...(record.request.tool !== undefined ? { tool: record.request.tool } : {}),
			});
		}
		emitRun({ kind: "ended", runId: run.runId, agentId: run.agentId, outcome, outcomeDetail: detail });
	};

	/** Fold what the run's feed gained since the last poll; true when its terminal row was read. */
	const readFeed = (run: FollowedRun): boolean => {
		const path = runFeedPath(run.runId, stateDir());
		let handle: number;
		try {
			handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch {
			return false;
		}
		let text = "";
		try {
			const size = statSync(path).size;
			if (size < run.offset) run.offset = 0;
			const length = Math.min(FEED_READ_MAX_BYTES, size - run.offset);
			if (length <= 0) return false;
			const chunk = Buffer.alloc(length);
			const count = readSync(handle, chunk, 0, length, run.offset);
			const bytes = chunk.subarray(0, count);
			// Only whole lines are consumed; a partial one is the writer mid-append and is read again next poll.
			const end = bytes.lastIndexOf(0x0a);
			if (end < 0) return false;
			text = bytes.subarray(0, end + 1).toString("utf8");
			run.offset += end + 1;
		} catch {
			return false;
		} finally {
			closeSync(handle);
		}
		for (const raw of text.split("\n")) {
			const line = readRunFeedLine(raw);
			if (line === null) continue;
			if (line.kind === "terminal") {
				endRun(run, line.outcome, line.detail ?? null);
				return true;
			}
			const event = foreignFeedEvent(line);
			if (event !== null) emitRun({ kind: "progressed", runId: run.runId, agentId: run.agentId, event });
		}
		return false;
	};

	const readAsks = (run: FollowedRun): void => {
		for (const record of readGrantRequestRecords(stateDir(), run.runId)) {
			const known = run.asks.get(record.requestId);
			run.asks.set(record.requestId, record);
			if (record.state === "pending") {
				if (known !== undefined) continue;
				foreignAsks.set(record.requestId, record);
				emitAsk({ kind: "requested", request: record.request });
				continue;
			}
			if (foreignAsks.has(record.requestId)) {
				withdrawAsk(record, record.resolved ?? { status: "denied", requestId: record.requestId, decidedBy: "revoked" });
			}
		}
	};

	const follow = (): void => {
		ledger = readLedgerSnapshot(ledger, stateDir());
		const live = new Set<string>();
		for (const row of ledger.runs) {
			if (row.status !== "running" && row.status !== "stale") continue;
			live.add(row.id);
			if (settled.has(row.id) || followed.has(row.id) || deps.isLocalRun(row.id)) continue;
			const record = readRunOwnerRecord(stateDir(), row.id);
			// No owner record yet: the owner has not published its start, or predates this record.
			if (record === null) continue;
			if (ownerIsThisProcess(record.owner) || record.owner.pid === deps.self?.pid || record.cwd !== cwd) {
				settled.add(row.id);
				continue;
			}
			if (probe(record.owner) === "gone") {
				settled.add(row.id);
				continue;
			}
			// A new viewer starts at the feed's tail, as `fleet view` does, so a long run does not replay megabytes.
			let size = 0;
			try {
				size = statSync(runFeedPath(row.id, stateDir())).size;
			} catch {
				// No feed yet; the run's first rows will start it.
			}
			const run: FollowedRun = {
				runId: row.id,
				agentId: record.started.agentId,
				owner: record.owner,
				offset: Math.max(0, size - RUN_FEED_READ_TAIL_BYTES),
				asks: new Map(),
			};
			if (run.offset > 0) skipPartialLine(run, size);
			followed.set(row.id, run);
			emitRun({ kind: "started", run: record.started });
		}
		for (const run of [...followed.values()]) {
			if (probe(run.owner) === "gone") {
				endRun(run, "dead", "the Clio process that owned this run exited");
				continue;
			}
			if (readFeed(run)) continue;
			readAsks(run);
			// The ledger settled it and the feed held no terminal row: the ledger's word ends it.
			if (!live.has(run.runId)) {
				const row = ledger.runs.find((candidate) => candidate.id === run.runId);
				endRun(run, row?.outcome ?? (row?.status === "completed" ? "succeeded" : "failed"), null);
			}
		}
	};

	const skipPartialLine = (run: FollowedRun, size: number): void => {
		try {
			const handle = openSync(runFeedPath(run.runId, stateDir()), constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const chunk = Buffer.alloc(Math.min(64 * 1024, size - run.offset));
				const count = readSync(handle, chunk, 0, chunk.length, run.offset);
				const newline = chunk.subarray(0, count).indexOf(0x0a);
				run.offset = newline < 0 ? size : run.offset + newline + 1;
			} finally {
				closeSync(handle);
			}
		} catch {
			run.offset = size;
		}
	};

	const poll = (): void => {
		if (disposed) return;
		try {
			takeAnswers();
			if (deps.follow) follow();
		} catch {
			// Cross-process state is a view; a failed poll is retried on the next one.
		}
	};

	ensureTimer();

	return {
		answerForeign(runId, requestId, decision) {
			const record = foreignAsks.get(requestId);
			if (record === undefined || record.runId !== runId) return false;
			const binding: GrantRecordBinding = {
				requestId: record.requestId,
				runId: record.runId,
				attempt: record.attempt,
				argDigest: record.argDigest,
				nonce: record.nonce,
			};
			if (!writeGrantAnswerRecord(stateDir(), binding, decision, self())) {
				throw new Error(`could not record the answer for run '${runId}' in its run directory`);
			}
			return true;
		},
		isForeignAsk: (requestId) => foreignAsks.has(requestId),
		poll,
		dispose() {
			disposed = true;
			if (timer !== null) clearInterval(timer);
			timer = null;
			for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
		},
	};
}
