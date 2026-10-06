import type { ContextActivityPayload } from "../../../core/bus-events.js";
import { CONTEXT_OPERATION_CUSTOM_TYPE, createContextOperation } from "../../../core/context-operation.js";
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

import type { ContextRecalledPayload } from "../../../core/bus-events.js";
import type { SessionEntryInput } from "../../session/contract.js";
import type { SessionEntry } from "../../session/entries.js";
import type { EvictedState } from "./contract.js";
import { foldWorkingSet } from "./fold.js";
import { buildRecallFields, recallErrorMessage, recallParentTurnId, resolveRecall } from "./recall.js";

/** Ledger access the command needs, mirroring the context tool's `ContextSessionDeps`. */
export interface OperatorRecallDeps {
	getSessionId?: () => string | null;
	onActivity?: (event: ContextActivityPayload) => void;
	cwd?: string;
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
	if (state === undefined) parts.push("summarized");
	parts.push(`${formatTokens(tokens)} tokens`);
	if (offloadPath !== undefined) parts.push(`offload: ${offloadPath}`);
	return `[/context recall] ${parts.join(" · ")}`;
}

function recall(ref: string, deps: OperatorRecallDeps): OperatorRecallOutcome {
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
	// A ref that resolves to nothing is usually a typo or a stale marker; the
	// shared message ends with the refs the operator could have typed instead.
	if (!resolved.ok)
		return { ok: false, message: `[/context recall] ${recallErrorMessage(resolved.error, entries, view, leaf)}` };
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

export function runOperatorRecall(ref: string, deps: OperatorRecallDeps): OperatorRecallOutcome {
	const sessionId = deps.getSessionId?.() ?? null;
	const operation = createContextOperation(
		{
			kind: "context-recall",
			sessionId,
			cwd: deps.cwd ?? process.cwd(),
			origin: "operator",
			reason: "operator recall; body shown to operator only",
		},
		(event) => deps.onActivity?.(event),
	);
	operation.start("state", "Reading retained observation");
	try {
		const result = recall(ref, deps);
		const conclusion = operation.finish(
			result.ok ? "completed" : "failed",
			result.ok ? "Observation recalled" : result.message,
			result.ok ? { facts: [{ kind: "recalled", unit: "observations", count: 1 }] } : {},
		);
		if (sessionId && deps.getSessionId?.() === sessionId) {
			try {
				deps.appendEntry({
					kind: "custom",
					customType: CONTEXT_OPERATION_CUSTOM_TYPE,
					parentTurnId: deps.activeLeafTurnId() ?? null,
					data: conclusion,
				});
			} catch {
				/* Recall's own ledger is authoritative if the result-card append fails. */
			}
		}
		return result;
	} catch (error) {
		operation.finish("failed", error instanceof Error ? error.message : String(error));
		throw error;
	}
}
