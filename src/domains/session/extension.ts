import { BusChannels } from "../../core/bus-events.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { openSession } from "../../engine/session.js";
import { performCheckpoint } from "./checkpoint.js";
import type { DeleteSessionOptions, SessionContract, SessionEntryInput, SessionMeta, TurnInput } from "./contract.js";
import type { SessionInfoEntry } from "./entries.js";
import { listSessionsForCwd } from "./history.js";
import {
	appendEntry,
	appendTurn,
	newTurnId,
	resumeSessionState,
	type SessionManagerState,
	startSession,
} from "./manager.js";
import { forkFromState } from "./tree/fork.js";
import { probeWorkspace } from "./workspace/index.js";
import { appendEntryToSessionFile, readTreeBundle, removeSessionDirectory, tombstoneSession } from "./tree/manager.js";
import { buildTreeSnapshot, type TreeSnapshot } from "./tree/navigator.js";

type ParkReason = "create_new" | "resume_other" | "fork" | "switch_branch" | "close" | "shutdown";
type ResumeVia = "resume" | "switch_branch";

/**
 * Session domain wire-up. Owns a single current SessionManagerState and
 * funnels create/append/checkpoint/resume/fork/close through the engine
 * session writer. The CLI drives lifecycle; the extension only enforces the
 * shutdown contract (final checkpoint + close) on domain stop.
 *
 * Lifecycle transitions fan onto the shared bus so the safety audit
 * subscriber can persist `session_park` and `session_resume` rows without
 * pulling in the session contract directly. Park fires whenever the current
 * session is replaced or closed; resume fires when an existing session is
 * reopened via resume() or switchBranch().
 */
export function createSessionBundle(context: DomainContext): DomainBundle<SessionContract> {
	let state: SessionManagerState | null = null;

	function emitPark(sessionId: string, reason: ParkReason): void {
		context.bus.emit(BusChannels.SessionParked, { sessionId, reason, at: Date.now() });
	}

	function emitResume(sessionId: string, via: ResumeVia): void {
		context.bus.emit(BusChannels.SessionResumed, { sessionId, via, at: Date.now() });
	}

	async function closeCurrent(reason: ParkReason = "close"): Promise<void> {
		if (!state) return;
		const s = state;
		emitPark(s.meta.id, reason);
		state = null;
		await s.writer.close();
	}

	async function flushIfCurrent(sessionId: string): Promise<void> {
		if (state?.meta.id === sessionId) {
			// tree.json lives on disk; the writer holds the canonical in-memory
			// copy. Flush before a tree() read so the domain-level navigator
			// observes every append since the last checkpoint.
			await state.writer.persistTree();
		}
	}

	function snapshotFor(sessionId: string): TreeSnapshot {
		const bundle = readTreeBundle(sessionId);
		// Prefer the live in-memory meta when we are looking at the current
		// session so checkpoint/fork pointers are fresh; otherwise fall back
		// to the on-disk read.
		const meta: SessionMeta = state?.meta.id === sessionId ? state.meta : (openSession(sessionId).meta() as SessionMeta);
		return buildTreeSnapshot({ meta, nodes: bundle.nodes, labels: bundle.labels });
	}

	const contract: SessionContract = {
		current: () => state?.meta ?? null,
		create(input) {
			const cwd = input?.cwd ?? process.cwd();
			const startInput: { cwd: string; model?: string | null; endpoint?: string | null } = { cwd };
			if (input?.model !== undefined) startInput.model = input.model;
			if (input?.endpoint !== undefined) startInput.endpoint = input.endpoint;
			// Close any prior writer first so tree.json + meta.json get the
			// endedAt + final-tree flush. Without this, the old session leaks
			// its in-memory tree to disk and /tree on a resume would miss
			// every append since the last checkpoint.
			if (state) {
				const prior = state;
				emitPark(prior.meta.id, "create_new");
				state = null;
				void prior.writer.close();
			}
			const next = startSession(startInput);
			next.meta.workspace = probeWorkspace(cwd);
			state = next;
			return next.meta;
		},
		append(turn: TurnInput) {
			if (!state) throw new Error("session.append: no current session");
			return appendTurn(state, turn);
		},
		appendEntry(entry: SessionEntryInput) {
			if (!state) throw new Error("session.appendEntry: no current session");
			return appendEntry(state, entry);
		},
		async checkpoint(reason) {
			if (!state) throw new Error("session.checkpoint: no current session");
			await performCheckpoint(state, reason);
		},
		resume(sessionId) {
			if (state && state.meta.id === sessionId) return state.meta;
			if (state) {
				// best-effort close of prior session before switching
				const prior = state;
				emitPark(prior.meta.id, "resume_other");
				state = null;
				void prior.writer.close();
			}
			const next = resumeSessionState(sessionId);
			state = next;
			emitResume(next.meta.id, "resume");
			return next.meta;
		},
		fork(parentTurnId, input) {
			if (!state) throw new Error("session.fork: no current session to fork from");
			const prior = state;
			emitPark(prior.meta.id, "fork");
			state = null;
			const { next } = forkFromState({
				from: prior,
				parentTurnId,
				...(input?.cwd !== undefined ? { cwd: input.cwd } : {}),
			});
			state = next;
			return next.meta;
		},
		tree(sessionId) {
			const id = sessionId ?? state?.meta.id;
			if (!id) throw new Error("session.tree: no sessionId provided and no current session");
			// Current-session reads must see every append the in-memory writer
			// has absorbed since the last checkpoint. persistTree runs
			// atomicWrite synchronously in-body before yielding its Promise,
			// so the file on disk is up to date by the time snapshotFor opens
			// it below. The void-discarded Promise is settled on the next
			// microtask and carries no return value we care about.
			if (state?.meta.id === id) void flushIfCurrent(id);
			return snapshotFor(id);
		},
		switchBranch(sessionId) {
			// /tree-driven branch switch currently delegates to resume. Kept as a
			// distinct contract method so later slices can layer telemetry or
			// chat-loop rewiring without changing resume's semantics.
			if (state?.meta.id === sessionId) return state.meta;
			if (state) {
				const prior = state;
				emitPark(prior.meta.id, "switch_branch");
				state = null;
				void prior.writer.close();
			}
			const next = resumeSessionState(sessionId);
			state = next;
			emitResume(next.meta.id, "switch_branch");
			return next.meta;
		},
		editLabel(turnId, label, sessionId) {
			const targetId = sessionId ?? state?.meta.id;
			if (!targetId) throw new Error("session.editLabel: no sessionId provided and no current session");
			// Label entries are side-car metadata; they do not project into
			// tree.json (engine `appendEntry` path leaves non-message entries
			// off the tree), so parentTurnId is left null.
			if (state && state.meta.id === targetId) {
				appendEntry(state, {
					kind: "sessionInfo",
					parentTurnId: null,
					targetTurnId: turnId,
					label,
				} as SessionEntryInput);
				return;
			}
			const entry: SessionInfoEntry = {
				kind: "sessionInfo",
				turnId: newTurnId(),
				parentTurnId: null,
				timestamp: new Date().toISOString(),
				targetTurnId: turnId,
				label,
			};
			appendEntryToSessionFile(targetId, entry);
		},
		deleteSession(id, opts) {
			if (state?.meta.id === id) {
				throw new Error("session.deleteSession: refusing to delete the currently open session; close() first");
			}
			const options: DeleteSessionOptions = opts ?? {};
			if (options.keepFiles) {
				tombstoneSession(id);
			} else {
				removeSessionDirectory(id);
			}
		},
		history(): ReadonlyArray<SessionMeta> {
			const cwd = state?.meta.cwd ?? process.cwd();
			return listSessionsForCwd(cwd);
		},
		async close() {
			await closeCurrent();
		},
	};

	const extension: DomainExtension = {
		async start() {
			// Sessions are created lazily by the CLI; nothing to do on boot.
		},
		async stop() {
			if (!state) return;
			try {
				await performCheckpoint(state, "shutdown");
			} catch (err) {
				process.stderr.write(
					`[clio:session] shutdown checkpoint failed: ${err instanceof Error ? err.message : String(err)}\n`,
				);
			}
			await closeCurrent("shutdown");
		},
	};

	return { extension, contract };
}
