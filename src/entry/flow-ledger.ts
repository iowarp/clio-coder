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

import type { FlowRestrictionSet } from "../domains/safety/index.js";
import { isFlowRestrictionSet, mergeFlowRestrictions } from "../domains/safety/index.js";
import type { SessionContract } from "../domains/session/index.js";

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
	/** Sets absorbed in this process whose entry has not yet reached that session's ledger. */
	const pending = new Map<string, Array<{ set: FlowRestrictionSet; origin: { tool?: string; toolCallId?: string } }>>();
	let writeFailure: string | null = null;

	const sync = (): void => {
		const meta = deps.session?.current() ?? null;
		const id = meta?.id ?? null;
		if (id === loadedFor) return;
		if (id !== loadedFor) {
			// A different session: its ledger is the only authority for what it
			// carries. Entries still pending for the old session stay queued under
			// its id and are written when it is current again.
			writeFailure = null;
			carried =
				id === null ? null : mergeFlowRestrictions(known.get(id), ...(pending.get(id) ?? []).map((item) => item.set));
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
			if (merged !== null && merged.restrictions.length > before && loadedFor !== null) {
				const queue = pending.get(loadedFor) ?? [];
				queue.push({ set, origin });
				pending.set(loadedFor, queue);
			}
			flush();
		},
	};
}
