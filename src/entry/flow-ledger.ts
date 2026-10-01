/**
 * What restricted sources the current session's context has absorbed.
 *
 * Provenance is not tracked per token: once a restricted read lands in the
 * transcript, every later request from that session carries its restriction,
 * through summaries, compaction, resume and branch switches alike. The ledger
 * is one durable union per session, persisted as `custom` session entries of
 * type `flowRestriction` and rebuilt from the ledger whenever the current
 * session changes, so the model cannot erase it and an old session without
 * entries carries nothing rather than an invented history.
 */

import type { FlowRestrictionSet } from "../domains/safety/index.js";
import { isFlowRestrictionSet, mergeFlowRestrictions } from "../domains/safety/index.js";
import type { SessionContract, SessionEntry } from "../domains/session/index.js";

export const FLOW_RESTRICTION_ENTRY_TYPE = "flowRestriction";

export interface FlowLedger {
	/** The union carried by the current session, or null when nothing restricted has entered it. */
	current(): FlowRestrictionSet | null;
	/** Record restrictions that just entered the session. Idempotent for an already-carried set. */
	absorb(set: FlowRestrictionSet, origin: { tool?: string; toolCallId?: string }): void;
}

/** The union of every flow-restriction entry in a session's ledger. */
export function flowRestrictionsFromEntries(entries: ReadonlyArray<SessionEntry>): FlowRestrictionSet | null {
	const sets: FlowRestrictionSet[] = [];
	for (const entry of entries) {
		if (entry.kind !== "custom" || entry.customType !== FLOW_RESTRICTION_ENTRY_TYPE) continue;
		const data = (entry.data as { set?: unknown } | undefined)?.set;
		if (isFlowRestrictionSet(data)) sets.push(data);
	}
	return mergeFlowRestrictions(...sets);
}

export function createFlowLedger(deps: {
	session: SessionContract | null;
	readEntries: (sessionId: string) => ReadonlyArray<SessionEntry>;
}): FlowLedger {
	let loadedFor: string | null = null;
	let carried: FlowRestrictionSet | null = null;

	const sync = (): void => {
		const meta = deps.session?.current() ?? null;
		const id = meta?.id ?? null;
		if (id === loadedFor) return;
		loadedFor = id;
		if (id === null) {
			carried = null;
			return;
		}
		try {
			carried = flowRestrictionsFromEntries(deps.readEntries(id));
		} catch {
			// An unreadable ledger carries nothing; it also cannot vouch, and a
			// later successful read of the same session replaces this.
			carried = null;
			loadedFor = null;
		}
	};

	return {
		current() {
			sync();
			return carried;
		},
		absorb(set, origin) {
			sync();
			const merged = mergeFlowRestrictions(carried, set);
			if (merged === null) return;
			const before = carried?.restrictions.length ?? 0;
			carried = merged;
			if (merged.restrictions.length === before) return;
			const meta = deps.session?.current();
			if (!meta || !deps.session) return;
			try {
				deps.session.appendEntry({
					kind: "custom",
					customType: FLOW_RESTRICTION_ENTRY_TYPE,
					// A fact about the session's provenance, never a model message.
					display: false,
					parentTurnId: deps.session.tree(meta.id).leafId ?? null,
					data: { set, ...(origin.tool !== undefined ? { tool: origin.tool } : {}), ...(origin.toolCallId !== undefined ? { toolCallId: origin.toolCallId } : {}) },
				});
			} catch {
				// The in-memory union still governs this process; persistence is
				// retried by the next absorb of a new restriction.
			}
		},
	};
}
