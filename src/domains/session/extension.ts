import {
	BusChannels,
	type SessionParkReason as ParkReason,
	type SessionResumeVia as ResumeVia,
} from "../../core/bus-events.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { performCheckpoint } from "./checkpoint.js";
import type { DeleteSessionOptions, SessionContract, SessionEntryInput, SessionMeta, TurnInput } from "./contract.js";
import type { LabelEntry, SessionEntry } from "./entries.js";
import { listSessionsForCwd } from "./history.js";
import {
	appendEntry,
	appendTurn,
	newTurnId,
	persistSessionMeta,
	replaceEntries,
	resumeSessionState,
	type SessionManagerState,
	startSession,
} from "./manager.js";
import { forkFromState } from "./tree/fork.js";
import { appendEntryToSessionFile, readTreeBundle, removeSessionDirectory, tombstoneSession } from "./tree/manager.js";
import { buildTreeSnapshot, computeLeafId, type TreeInputNode, type TreeSnapshot } from "./tree/navigator.js";
import { buildTurnPreview } from "./tree/preview.js";
import { probeWorkspace } from "./workspace/index.js";

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
	let currentTurnId: string | null = null;

	function emitPark(sessionId: string, reason: ParkReason): void {
		context.bus.emit(BusChannels.SessionParked, { sessionId, reason, at: Date.now() });
	}

	function emitResume(sessionId: string, via: ResumeVia): void {
		context.bus.emit(BusChannels.SessionResumed, { sessionId, via, at: Date.now() });
	}

	function emitTurnSwitched(sessionId: string, turnId: string): void {
		context.bus.emit(BusChannels.SessionTurnSwitched, { sessionId, turnId, at: Date.now() });
	}

	/**
	 * The leaf to resume onto: the persisted `/tree` pin when it still names a
	 * real turn in this session's tree, otherwise the inferred newest-node leaf.
	 * A pin surviving here is what makes a `/tree` switch made without a
	 * follow-up message survive quit + resume instead of silently reverting to
	 * the abandoned tip (issue #94).
	 */
	function resolveLeafOnOpen(resumed: {
		state: SessionManagerState;
		nodes: ReadonlyArray<TreeInputNode>;
	}): string | null {
		const pinned = resumed.state.meta.pinnedLeafTurnId;
		if (pinned && resumed.nodes.some((node) => node.id === pinned)) return pinned;
		return computeLeafId(resumed.nodes);
	}

	async function closeCurrent(reason: ParkReason = "close"): Promise<void> {
		if (!state) return;
		const s = state;
		emitPark(s.meta.id, reason);
		state = null;
		currentTurnId = null;
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

	/**
	 * Structural nodes the turn tree cannot hold. `tree.json` records message
	 * turns; a compaction and a returned-from branch are ledger entries with
	 * their own turn ids and parent pointers, and /tree showed neither, so a
	 * session that had been compacted looked exactly like one that had not.
	 * Their previews carry the facts already on the entry.
	 */
	function structuralTreeNodes(entries: ReadonlyArray<SessionEntry>, previews: Map<string, string>): TreeInputNode[] {
		const nodes: TreeInputNode[] = [];
		for (const entry of entries) {
			if (entry.kind === "compactionSummary") {
				nodes.push({ id: entry.turnId, parentId: entry.parentTurnId, at: entry.timestamp, kind: "compaction" });
				const summarized = entry.messagesSummarized === undefined ? "history" : `${entry.messagesSummarized} entries`;
				const after = entry.tokensAfter === undefined ? "" : ` -> ~${entry.tokensAfter}`;
				previews.set(entry.turnId, `${summarized} summarized, ~${entry.tokensBefore}${after} tokens`);
				continue;
			}
			if (entry.kind === "branchSummary") {
				nodes.push({ id: entry.turnId, parentId: entry.parentTurnId, at: entry.timestamp, kind: "branch" });
				const text = entry.summary.split("\n", 1)[0] ?? "";
				previews.set(
					entry.turnId,
					text.length > 0 ? `returned from ${entry.fromTurnId}: ${text}` : `returned from ${entry.fromTurnId}`,
				);
			}
		}
		return nodes;
	}

	function snapshotFor(sessionId: string): TreeSnapshot {
		const bundle = readTreeBundle(sessionId);
		// Prefer the live in-memory meta when we are looking at the current
		// session so checkpoint/fork pointers are fresh; otherwise fall back
		// to the on-disk read.
		const meta: SessionMeta = state?.meta.id === sessionId ? state.meta : bundle.meta;
		// Build a turnId → preview map so /tree rows show distinguishing
		// payload slices. Reading turns is cheap (single jsonl scan) and
		// happens only when the overlay opens.
		const previews = new Map<string, string>();
		let structural: TreeInputNode[] = [];
		try {
			for (const entry of bundle.entries) {
				if (entry.kind !== "message") continue;
				const text = buildTurnPreview({ kind: entry.role, payload: entry.payload });
				if (text.length > 0) previews.set(entry.turnId, text);
			}
			structural = structuralTreeNodes(bundle.entries, previews);
		} catch {
			// Best-effort: if the on-disk transcript cannot be read, fall back
			// to a previewless snapshot. The overlay handles missing previews
			// gracefully via its kind-label fallback.
		}
		return buildTreeSnapshot({
			meta,
			nodes: [...bundle.nodes, ...structural],
			labels: bundle.labels,
			previews,
			// The leaf is the next append point, so it is computed over turn nodes
			// only: a structural node marks a moment in the timeline, never a place
			// the session continues from.
			leafId: state?.meta.id === sessionId ? currentTurnId : computeLeafId(bundle.nodes),
		});
	}

	const contract: SessionContract = {
		current: () => state?.meta ?? null,
		create(input) {
			const cwd = input?.cwd ?? process.cwd();
			const startInput: { cwd: string; model?: string | null; target?: string | null } = { cwd };
			if (input?.model !== undefined) startInput.model = input.model;
			if (input?.target !== undefined) startInput.target = input.target;
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
			persistSessionMeta(next);
			state = next;
			currentTurnId = null;
			return next.meta;
		},
		append(turn: TurnInput) {
			if (!state) throw new Error("session.append: no current session");
			// Invariant: a turn can only extend this session's own current leaf.
			// The interactive layer tracks its own copy of "the last turn id"
			// (turn-persistence.ts) and normally keeps it in lockstep with
			// currentTurnId via chat.resetForSession after every switch; when a
			// failed resume/fork/switchBranch left that copy pointing at a turn
			// from a session that was never actually opened here, this is the
			// one place that catches it before a foreign parent id reaches disk.
			if (turn.parentId !== currentTurnId) {
				throw new Error(
					`session.append: turn parentId ${turn.parentId ?? "null"} is not this session's current leaf (expected ${currentTurnId ?? "null"}); refusing to parent a turn onto another session's turn`,
				);
			}
			const record = appendTurn(state, turn);
			currentTurnId = record.id;
			// A fresh append moves the leaf past whatever /tree pinned earlier
			// (or this append could not have been made: see the invariant above),
			// so the persisted pin is stale and must not outlive it. Once cleared,
			// resolveLeafOnOpen's timestamp inference is trustworthy again.
			if (state.meta.pinnedLeafTurnId !== undefined && state.meta.pinnedLeafTurnId !== null) {
				state.meta.pinnedLeafTurnId = null;
				persistSessionMeta(state);
			}
			return record;
		},
		appendEntry(entry: SessionEntryInput) {
			if (!state) throw new Error("session.appendEntry: no current session");
			return appendEntry(state, entry);
		},
		replaceEntries(entries) {
			if (!state) throw new Error("session.replaceEntries: no current session");
			replaceEntries(state, entries);
		},
		recordSkillActivation(activation) {
			if (!state) throw new Error("session.recordSkillActivation: no current session");
			appendEntry(state, {
				kind: "skillActivation",
				parentTurnId: activation.turnId ?? null,
				activation,
			});
			const existing = state.meta.skillActivations ?? [];
			state.meta.skillActivations = [...existing, activation];
			persistSessionMeta(state);
			return activation;
		},
		async checkpoint(reason) {
			if (!state) throw new Error("session.checkpoint: no current session");
			await performCheckpoint(state, reason);
		},
		flushAppends() {
			if (!state) throw new Error("session.flushAppends: no current session");
			state.writer.flushAppends();
		},
		resume(sessionId) {
			if (state && state.meta.id === sessionId) return state.meta;
			// Open the target before touching the current session: resumeSessionState
			// reads and migrates the target's meta.json and can throw (unsupported
			// format version, unreadable entries, missing files). Closing or nulling
			// the prior session ahead of that risk is how a failed switch used to
			// orphan the operator with no current session (issue #93); on success,
			// the prior is parked and closed only now that the successor is known good.
			const resumed = resumeSessionState(sessionId);
			if (state) {
				const prior = state;
				emitPark(prior.meta.id, "resume_other");
				void prior.writer.close();
			}
			state = resumed.state;
			currentTurnId = resolveLeafOnOpen(resumed);
			emitResume(resumed.state.meta.id, "resume");
			return resumed.state.meta;
		},
		fork(parentTurnId, input) {
			if (!state) throw new Error("session.fork: no current session to fork from");
			const prior = state;
			// forkFromState reads and validates the parent's own ancestry chain
			// and can throw (unknown or broken parent turn) before it ever creates
			// the child session; it closes `prior.writer` itself, and only once the
			// child is known good (see tree/fork.ts). Do not null or park `state`
			// until forkFromState returns, for the same reason as resume() above.
			const { next, nodes } = forkFromState({
				from: prior,
				parentTurnId,
				...(input?.cwd !== undefined ? { cwd: input.cwd } : {}),
			});
			emitPark(prior.meta.id, "fork");
			state = next;
			currentTurnId = computeLeafId(nodes);
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
			// chat-loop rewiring without changing resume's semantics. Same
			// open-before-close ordering as resume() above and for the same reason.
			if (state?.meta.id === sessionId) return state.meta;
			const resumed = resumeSessionState(sessionId);
			if (state) {
				const prior = state;
				emitPark(prior.meta.id, "switch_branch");
				void prior.writer.close();
			}
			state = resumed.state;
			currentTurnId = resolveLeafOnOpen(resumed);
			emitResume(resumed.state.meta.id, "switch_branch");
			return resumed.state.meta;
		},
		switchTurn(turnId) {
			if (!state) throw new Error("session.switchTurn: no current session");
			void flushIfCurrent(state.meta.id);
			const nodes = readTreeBundle(state.meta.id).nodes;
			if (!nodes.some((node) => node.id === turnId)) {
				throw new Error(`session.switchTurn: turn not found: ${turnId}`);
			}
			currentTurnId = turnId;
			// Persist the pin immediately, not just in memory: without this, a
			// switch made without a follow-up message was silently lost on quit
			// because resume() had nothing but timestamp inference to fall back
			// on and always landed back on the abandoned tip (issue #94).
			state.meta.pinnedLeafTurnId = turnId;
			persistSessionMeta(state);
			emitTurnSwitched(state.meta.id, turnId);
			return state.meta;
		},
		editLabel(turnId, label, sessionId) {
			const targetId = sessionId ?? state?.meta.id;
			if (!targetId) throw new Error("session.editLabel: no sessionId provided and no current session");
			// Label entries are side-car metadata; they do not project into
			// tree.json (engine `appendEntry` path leaves non-message entries
			// off the tree), so parentTurnId is left null.
			if (state && state.meta.id === targetId) {
				appendEntry(state, {
					kind: "label",
					parentTurnId: null,
					targetTurnId: turnId,
					label,
				} as SessionEntryInput);
				return;
			}
			const entry: LabelEntry = {
				kind: "label",
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
