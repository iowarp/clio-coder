/**
 * What restricted sources the current session's context has absorbed.
 *
 * Provenance is not tracked per token: once a restricted read lands in the
 * transcript, every later request from that session carries its restriction,
 * through summaries, compaction, resume and branch switches alike. The ledger
 * is one durable union per session, persisted as `custom` session entries of
 * type `clio_coder_flow_restriction` and rebuilt from the ledger whenever the
 * current session changes, so the model cannot erase it and a session read
 * successfully without entries carries nothing rather than an invented
 * history.
 *
 * The ledger never downgrades on failure. A session whose ledger cannot be
 * read while source rules or carried labels require provenance, or a restriction
 * that could not be persisted, leaves the ledger `unavailable`. Session reads
 * are retried on a session switch; persistence is retried on every later call.
 */

import type { MemoryCommitScope } from "../domains/memory/commit-state.js";
import type { CompletedLessonSource } from "../domains/memory/history-review.js";
import { completedLessonSource } from "../domains/memory/index.js";
import type { FlowRestrictionSet } from "../domains/safety/index.js";
import { isFlowRestrictionSet, mergeFlowRestrictions } from "../domains/safety/index.js";
import type { SessionContract } from "../domains/session/index.js";
import { parseSessionEntries } from "../domains/session/index.js";
import { filterEntriesToActivePath } from "../domains/session/tree/active-path.js";

export const FLOW_RESTRICTION_ENTRY_TYPE = "clio_coder_flow_restriction";

export interface FlowLedger {
	/** The union carried by the current session, or null when nothing restricted has entered it. */
	current(): FlowRestrictionSet | null;
	/**
	 * Why provenance cannot be vouched for right now, or null. Non-null means
	 * the session's ledger could not be read or a restriction could not be
	 * persisted; an outbound transfer must be refused with this reason.
	 */
	refusal(): string | null;
	/** Record restrictions that just entered the session. Persists before returning when it can. */
	absorb(set: FlowRestrictionSet, origin: { tool?: string; toolCallId?: string }): void;
	/** What any session's ledger carries, current or not. Throws when that ledger cannot be read. */
	restrictionsOf(sessionId: string): FlowRestrictionSet | null;
	/** Whether a session carries a restriction. An unreadable ledger answers true, since the ledger never downgrades on failure. */
	isRestricted(sessionId: string): boolean;
}

/** The union of every flow-restriction entry in a session's ledger. */
function flowRestrictionsFromEntries(entries: ReadonlyArray<unknown>): FlowRestrictionSet | null {
	const sets: FlowRestrictionSet[] = [];
	for (const raw of entries) {
		if (typeof raw !== "object" || raw === null) continue;
		const entry = raw as { kind?: unknown; customType?: unknown; data?: unknown };
		if (entry.kind !== "custom" || entry.customType !== FLOW_RESTRICTION_ENTRY_TYPE) continue;
		const data = (entry.data as { set?: unknown } | undefined)?.set;
		if (isFlowRestrictionSet(data)) sets.push(data);
	}
	return mergeFlowRestrictions(...sets);
}

/**
 * The completed task a closed session's ledger offers for lesson review, or null. The label check reads the whole
 * ledger, not the active path: the session's restriction is one union, so a label on an abandoned branch still restricts
 * it, as `isRestricted` answers for a live session.
 */
export function closedSessionLessonSource(
	ledgerText: string,
	ledgerPath: string,
	sessionId: string,
	root: string,
): { scope: MemoryCommitScope; source: CompletedLessonSource } | null {
	const read = parseSessionEntries(ledgerText, ledgerPath);
	if (
		read.errors.length > 0 ||
		read.entries.some((entry) => entry.kind === "custom" && entry.customType === FLOW_RESTRICTION_ENTRY_TYPE)
	)
		return null;
	const active = filterEntriesToActivePath(read.entries, undefined);
	const source = completedLessonSource(active, root);
	return source ? { scope: { sessionId, branchAnchorTurnId: active.at(-1)?.turnId ?? null }, source } : null;
}

export function createFlowLedger(deps: {
	session: SessionContract | null;
	readEntries: (sessionId: string) => ReadonlyArray<unknown>;
	/** A configured source policy requires provenance even before a label has been recovered. */
	hasSourceRules?: () => boolean;
}): FlowLedger {
	let loadedFor: string | null = null;
	let carried: FlowRestrictionSet | null = null;
	let readFailure: string | null = null;
	const known = new Map<string, FlowRestrictionSet>();
	/** Unpersisted sets; the null key holds reads awaiting their first session (R5). */
	const pending = new Map<
		string | null,
		Array<{ set: FlowRestrictionSet; origin: { tool?: string; toolCallId?: string } }>
	>();
	let writeFailure: string | null = null;

	const sync = (): void => {
		const meta = deps.session?.current() ?? null;
		const id = meta?.id ?? null;
		if (id === loadedFor) return;
		if (id !== null) {
			const unassigned = pending.get(null);
			if (unassigned !== undefined) {
				pending.set(id, [...(pending.get(id) ?? []), ...unassigned]);
				pending.delete(null);
			}
		}
		if (id !== loadedFor) {
			// A different session: its ledger is the only authority for what it
			// carries. Entries still pending for the old session stay queued under
			// its id and are written when it is current again.
			writeFailure = null;
			carried = mergeFlowRestrictions(
				id === null ? null : known.get(id),
				...(pending.get(id) ?? []).map((item) => item.set),
			);
		}
		loadedFor = id;
		if (id === null) {
			readFailure = null;
			return;
		}
		try {
			carried = mergeFlowRestrictions(
				flowRestrictionsFromEntries(deps.readEntries(id)),
				carried,
				...(pending.get(id) ?? []).map((item) => item.set),
			);
			if (carried !== null) known.set(id, carried);
			readFailure = null;
		} catch (error) {
			// Retry on a session switch, rather than parsing the full file on every admission.
			readFailure = `information-flow provenance for session ${id} could not be read (${error instanceof Error ? error.message : String(error)}); restore the session ledger and reopen the session before transferring restricted context`;
		}
	};

	const flush = (): void => {
		const session = deps.session;
		const meta = session?.current();
		if (!session || !meta) {
			writeFailure = pending.size > 0 ? "information-flow restriction could not be persisted: no current session" : null;
			return;
		}
		const queue = pending.get(meta.id);
		if (queue === undefined || queue.length === 0) {
			writeFailure = null;
			return;
		}
		while (queue.length > 0) {
			const next = queue[0];
			if (next === undefined) break;
			try {
				session.appendEntry({
					kind: "custom",
					customType: FLOW_RESTRICTION_ENTRY_TYPE,
					// A fact about the session's provenance, never a model message.
					display: false,
					parentTurnId: session.tree(meta.id).leafId ?? null,
					data: {
						set: next.set,
						...(next.origin.tool !== undefined ? { tool: next.origin.tool } : {}),
						...(next.origin.toolCallId !== undefined ? { toolCallId: next.origin.toolCallId } : {}),
					},
				});
				queue.shift();
				writeFailure = null;
			} catch (error) {
				writeFailure = `information-flow restriction could not be persisted to session ${meta.id} (${error instanceof Error ? error.message : String(error)}); outbound transfer is refused until it is`;
				return;
			}
		}
	};

	const restrictionsOf = (sessionId: string): FlowRestrictionSet | null => {
		// A label absorbed before the session existed belongs to it from here on, and nothing else has to have asked first.
		sync();
		return mergeFlowRestrictions(
			flowRestrictionsFromEntries(deps.readEntries(sessionId)),
			known.get(sessionId),
			...(pending.get(sessionId) ?? []).map((item) => item.set),
		);
	};

	return {
		current() {
			sync();
			flush();
			return carried;
		},
		refusal() {
			sync();
			flush();
			return (
				((carried?.restrictions.length ?? 0) > 0 || deps.hasSourceRules?.() === true ? readFailure : null) ?? writeFailure
			);
		},
		absorb(set, origin) {
			sync();
			const merged = mergeFlowRestrictions(carried, set);
			const before = carried?.restrictions.length ?? 0;
			carried = merged;
			if (loadedFor !== null && carried !== null) known.set(loadedFor, carried);
			if (merged !== null && merged.restrictions.length > before) {
				const queue = pending.get(loadedFor) ?? [];
				queue.push({ set, origin });
				pending.set(loadedFor, queue);
			}
			flush();
		},
		restrictionsOf,
		isRestricted(sessionId) {
			try {
				return (restrictionsOf(sessionId)?.restrictions.length ?? 0) > 0;
			} catch {
				return true;
			}
		},
	};
}

export interface HandoffSeedFlowDeps {
	ledger: Pick<FlowLedger, "absorb" | "refusal" | "restrictionsOf">;
	/** A session to hold the labels. A pending label would land on whichever session opens next, seeded or not. */
	ensureSession: () => void;
	hasSourceRules: () => boolean;
}

/**
 * What a task-memory seed needs before its first entry reaches the bank. A snapshot is what a restricted session knew,
 * written where any later session can load it, and each session's ledger is the only authority for what it carries.
 */
export function admitHandoffSeedFlow(
	deps: HandoffSeedFlowDeps,
	sourceSessionId: string | null,
): { refusal: string } | { ruleIds: ReadonlyArray<string> } {
	let labels: FlowRestrictionSet | null;
	try {
		if (sourceSessionId === null) throw new Error("the snapshot names no source session");
		labels = deps.ledger.restrictionsOf(sourceSessionId);
	} catch (error) {
		if (!deps.hasSourceRules()) return { ruleIds: [] };
		const why = error instanceof Error ? error.message : String(error);
		return {
			refusal: `its source's information-flow provenance cannot be read (${why}), and this project declares source rules`,
		};
	}
	if (labels === null || labels.restrictions.length === 0) return { ruleIds: [] };
	try {
		deps.ensureSession();
	} catch (error) {
		return {
			refusal: `no session could hold its information-flow restrictions (${error instanceof Error ? error.message : String(error)})`,
		};
	}
	deps.ledger.absorb(labels, { tool: "memory-seed" });
	const refusal = deps.ledger.refusal();
	return refusal !== null ? { refusal } : { ruleIds: [...new Set(labels.restrictions.map((entry) => entry.ruleId))] };
}
