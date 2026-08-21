/**
 * `/context recall <ref>`: the operator's half of working-set recall.
 *
 * The model recalls through `context(scope="recall", ref=...)`, which puts the
 * body back in front of the model at the tail of the working set. This command
 * answers a different question, asked by a person: what was in the result the
 * marker replaced. So the body goes to the transcript and nowhere else. It is
 * never submitted as a turn, never replayed, and never counted against the
 * context window, which is why an operator can read a 40k-line build log back
 * without paying for it.
 *
 * Everything else is identical to the tool path, deliberately: the same
 * `resolveRecall` over the same fold at the same live leaf, the same
 * `contextRecall` ledger entry (with `trigger: "operator"`), and the same
 * `BusChannels.ContextRecalled` publication. A recall is a churn signal
 * whoever asked for it, and a policy that keeps evicting something a human
 * keeps reading back is a policy worth changing.
 */

import type { ContextRecalledPayload } from "../core/bus-events.js";
import type { EvictedState } from "../domains/context/working-set/contract.js";
import { foldWorkingSet } from "../domains/context/working-set/fold.js";
import {
	buildRecallFields,
	recallErrorMessage,
	recallParentTurnId,
	resolveRecall,
} from "../domains/context/working-set/recall.js";
import type { SessionEntryInput } from "../domains/session/contract.js";
import type { SessionEntry } from "../domains/session/entries.js";

/** Ledger access the command needs, mirroring the context tool's `ContextSessionDeps`. */
export interface OperatorRecallDeps {
	hasSession(): boolean;
	readEntries(): ReadonlyArray<SessionEntry>;
	/** The live append point (`/tree` pin or tree leaf); undefined lets the fold infer it. */
	activeLeafTurnId(): string | undefined;
	appendEntry(entry: SessionEntryInput): SessionEntry;
	/** Publisher for `BusChannels.ContextRecalled`; the runtime supplies the bus. */
	onRecalled?: (payload: ContextRecalledPayload) => void;
	now?: () => number;
}

export type OperatorRecallOutcome =
	| {
			ok: true;
			/** One-line summary for the notice bar. */
			headline: string;
			/** The original body, byte-exact, for the transcript. */
			body: string;
	  }
	| { ok: false; message: string };

const MAX_LISTED_REFS = 8;

function formatTokens(tokens: number): string {
	return tokens.toLocaleString("en-US");
}

/**
 * Ref, why it left, what it costs to read, and where the full artifact lives
 * when the original result was offloaded. Nothing else: the body is on the next
 * line and the operator is already looking at it.
 */
function headlineFor(ref: string, tokens: number, state: EvictedState | undefined, offloadPath?: string): string {
	const parts = [ref];
	if (state !== undefined) {
		parts.push(state.by === undefined ? `evicted: ${state.reason}` : `evicted: ${state.reason} by ${state.by}`);
	}
	parts.push(`${formatTokens(tokens)} tokens`);
	if (offloadPath !== undefined) parts.push(`offload: ${offloadPath}`);
	return `[/context recall] ${parts.join(" · ")}`;
}

/**
 * A ref that resolved to nothing is usually a typo or a stale marker, so the
 * failure names what the operator could have typed instead: the nearest evicted
 * ref when the error carries one, and otherwise the refs that are actually out.
 */
function failureMessage(message: string, evictedRefs: ReadonlyArray<string>, hasNearest: boolean): string {
	if (hasNearest || evictedRefs.length === 0) return `[/context recall] ${message}`;
	const shown = evictedRefs.slice(0, MAX_LISTED_REFS).join(", ");
	const more = evictedRefs.length > MAX_LISTED_REFS ? ", …" : "";
	return `[/context recall] ${message} Evicted refs on the active path: ${shown}${more}.`;
}

export function runOperatorRecall(ref: string, deps: OperatorRecallDeps): OperatorRecallOutcome {
	if (!deps.hasSession()) {
		return { ok: false, message: "[/context recall] no active session; start one with /new or /resume first" };
	}
	const trimmed = ref.trim();
	if (trimmed.length === 0) {
		return { ok: false, message: "[/context recall] needs a ref: the turnId named in an [evicted ...] marker" };
	}
	const entries = deps.readEntries();
	const leaf = deps.activeLeafTurnId();
	const view = foldWorkingSet(entries, leaf);
	const resolved = resolveRecall(entries, view, trimmed, leaf);
	if (!resolved.ok) {
		const hasNearest = "nearest" in resolved.error && resolved.error.nearest !== null;
		return {
			ok: false,
			message: failureMessage(recallErrorMessage(resolved.error, entries), [...view.evicted.keys()], hasNearest),
		};
	}
	const { result } = resolved;
	const fields = buildRecallFields(result, { trigger: "operator" });
	try {
		deps.appendEntry({ ...fields, parentTurnId: recallParentTurnId(entries, leaf) });
	} catch (err) {
		return {
			ok: false,
			message: `[/context recall] recall of ${result.ref.entry} could not be recorded: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	deps.onRecalled?.({
		ref: result.ref.entry,
		trigger: "operator",
		tokensReadmitted: result.tokens,
		at: deps.now?.() ?? Date.now(),
	});
	return {
		ok: true,
		headline: headlineFor(result.ref.entry, result.tokens, view.evicted.get(result.ref.entry), result.offloadPath),
		body: result.body,
	};
}
