/**
 * The `/handoff` lifecycle every surface shares: admit a goal, extract the
 * session's working state with one repair round, render the review document,
 * then seed a successor session with the document the operator accepted.
 *
 * The rules a handoff document obeys live in `handoff.ts`. This module owns
 * the order of the session writes and the refusals around them, so the
 * terminal and ACP hosts cannot drift apart on either. Review, editing and
 * redrawing the transcript stay with the host that has a person in front of
 * it; nothing here renders, prompts or opens an editor.
 *
 * A handoff is a session operation. Nothing here writes a memory promotion
 * candidate or touches the memory domain, and nothing is written at all until
 * {@link commitHandoff} receives the reviewed document.
 */

import type { SessionContract } from "./contract.js";
import type { DecisionLedgerEntry, SessionEntry } from "./entries.js";
import {
	buildHandoffReadLedger,
	HANDOFF_NOTE_CUSTOM_TYPE,
	HANDOFF_SEED_CUSTOM_TYPE,
	type HandoffNoteData,
	type HandoffParseResult,
	type HandoffSeedData,
	mergeHandoffDecisions,
	parseHandoffExtraction,
	renderHandoffDocument,
	validateHandoffFiles,
	validateHandoffGoal,
} from "./handoff.js";

/** How one out-of-turn extraction round ended; the chat loop's side-question outcome, structurally. */
export type HandoffExtractionRound =
	| { status: "answered"; text: string }
	| { status: "aborted"; text?: string }
	| { status: "refused"; reason: string }
	| { status: "failed"; reason: string };

export interface HandoffRepairRequest {
	complaint: string;
	previous: string;
}

export interface HandoffServiceDeps {
	session?: SessionContract;
	/** One model round. The second call carries the repair request. */
	extract(goal: string, options?: { repair?: HandoffRepairRequest }): Promise<HandoffExtractionRound>;
	readEntries(sessionId: string): ReadonlyArray<SessionEntry>;
	isTurnInFlight(): boolean;
	/** The host's one session-creation path, the same hook `/new` uses. */
	createSession?: () => void;
	/** The settled decision board, which wins over extracted decisions. */
	getDecisionBoard?: () => ReadonlyArray<DecisionLedgerEntry>;
}

/**
 * Why a handoff stopped. `code` lets a host keep its own wording for the few
 * refusals it has always surfaced differently; `reason` is the operator text.
 */
export interface HandoffRefusal {
	ok: false;
	level: "warn" | "error";
	code:
		| "goal"
		| "unavailable"
		| "turn_in_flight"
		| "no_session"
		| "extraction"
		| "provider"
		| "empty"
		| "stale"
		| "seed_failed";
	reason: string;
}

/** A document awaiting review. Nothing has been written when a host holds one. */
export interface HandoffDraft {
	goal: string;
	fromSessionId: string;
	document: string;
}

export interface HandoffCommitted {
	ok: true;
	fromSessionId: string;
	toSessionId: string;
	/**
	 * Steps after the seed that failed without undoing it: the old session's
	 * note, or the switch back to the successor. The successor is seeded either
	 * way and is where the operator continues.
	 */
	warnings: string[];
}

function refuse(level: HandoffRefusal["level"], code: HandoffRefusal["code"], reason: string): HandoffRefusal {
	return { ok: false, level, code, reason };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The gate, in the order the terminal has always applied it: the goal first,
 * because a bad goal is the operator's to fix whatever else is wrong, then the
 * wiring, then the session's own state.
 */
export function admitHandoff(
	deps: HandoffServiceDeps,
	rawGoal: string,
): { ok: true; goal: string; fromSessionId: string; session: SessionContract } | HandoffRefusal {
	const verdict = validateHandoffGoal(rawGoal);
	if (!verdict.ok) return refuse("warn", "goal", verdict.reason);
	if (!deps.session) return refuse("error", "unavailable", "session contract unavailable");
	if (!deps.createSession) return refuse("error", "unavailable", "no session-creation path is wired in this session");
	// Refused, never queued. The document describes a session that has stopped;
	// a turn still in flight is about to change what it would say.
	if (deps.isTurnInFlight()) {
		return refuse(
			"warn",
			"turn_in_flight",
			"a turn is in flight; /handoff cannot summarize a session that is still moving",
		);
	}
	const fromSessionId = deps.session.current()?.id ?? null;
	if (fromSessionId === null) {
		return refuse("warn", "no_session", "no current session to hand off; start one with /new or /resume");
	}
	return { ok: true, goal: verdict.goal, fromSessionId, session: deps.session };
}

/** Characters of the second round's answer quoted in the terminal refusal. */
const HANDOFF_REFUSAL_QUOTE_CHARS = 200;

/**
 * A refusal that says what was asked for and what came back, not only that no
 * JSON object arrived. Both rounds are named, so an operator reading it knows
 * two model calls were spent and on what.
 */
function terminalHandoffRefusal(firstReason: string, secondReason: string, secondText: string): string {
	const answered = secondText.replace(/\s+/g, " ").trim().slice(0, HANDOFF_REFUSAL_QUOTE_CHARS);
	return [
		"the extraction round could not produce a handoff record after one repair attempt.",
		`Asked for: one JSON object with decisions, facts, files, commands, and openQuestions.`,
		`Round 1: ${firstReason}.`,
		`Round 2: ${secondReason}.`,
		`Round 2 returned: ${answered.length > 0 ? answered : "(nothing)"}`,
	].join(" ");
}

/**
 * Extract, then repair once.
 *
 * A local model that answers with prose around the object, or with nothing
 * parseable, used to end `/handoff` outright: every downstream behavior was
 * unreachable and the operator had paid for the round either way (issue
 * #223). Exactly one repair round follows, quoting what came back and what
 * the parser objected to.
 */
async function extractHandoffWithRepair(
	deps: Pick<HandoffServiceDeps, "extract">,
	goal: string,
): Promise<{ ok: true; parsed: HandoffParseResult } | HandoffRefusal> {
	const first = await deps.extract(goal);
	if (first.status !== "answered") {
		// A failed round carries the provider's own words, which a wire host keeps off the wire.
		return refuse(
			first.status === "failed" ? "error" : "warn",
			first.status === "failed" ? "provider" : "extraction",
			first.status === "aborted" ? "the extraction round was cancelled" : first.reason,
		);
	}
	const parsedFirst = parseHandoffExtraction(first.text);
	if (parsedFirst.ok) return { ok: true, parsed: parsedFirst.result };

	const second = await deps.extract(goal, { repair: { complaint: parsedFirst.reason, previous: first.text } });
	if (second.status !== "answered") {
		return refuse(
			second.status === "failed" ? "error" : "warn",
			second.status === "failed" ? "provider" : "extraction",
			second.status === "aborted"
				? "the repair round was cancelled"
				: `round 1 could not be read (${parsedFirst.reason}); the repair round then failed: ${second.reason}`,
		);
	}
	const parsedSecond = parseHandoffExtraction(second.text);
	if (parsedSecond.ok) return { ok: true, parsed: parsedSecond.result };
	return refuse("error", "extraction", terminalHandoffRefusal(parsedFirst.reason, parsedSecond.reason, second.text));
}

/**
 * Admit, extract and render. The draft is the document a person reviews;
 * producing it writes nothing to either session.
 */
export async function prepareHandoff(
	deps: HandoffServiceDeps,
	rawGoal: string,
): Promise<{ ok: true; draft: HandoffDraft } | HandoffRefusal> {
	const admitted = admitHandoff(deps, rawGoal);
	if (!admitted.ok) return admitted;
	const { goal, fromSessionId, session } = admitted;
	const extraction = await extractHandoffWithRepair(deps, goal);
	if (!extraction.ok) return extraction;
	const parsed = extraction.parsed;
	const meta = session.current();
	const cwd = typeof meta?.cwd === "string" && meta.cwd.length > 0 ? meta.cwd : null;
	const entries = deps.readEntries(fromSessionId);
	// The ledger is what this session's own tool calls touched, folded through
	// the active path so an abandoned `/tree` branch is not evidence.
	const ledger = buildHandoffReadLedger(entries, { cwd, leafTurnId: meta?.pinnedLeafTurnId ?? null });
	const files = validateHandoffFiles(parsed.extraction.files, ledger, cwd);
	const decisions = mergeHandoffDecisions(parsed.extraction.decisions, deps.getDecisionBoard?.() ?? []);
	const document = renderHandoffDocument({
		goal,
		fromSessionId,
		decisions,
		facts: parsed.extraction.facts,
		files: files.kept,
		droppedFiles: files.dropped,
		commands: parsed.extraction.commands,
		openQuestions: parsed.extraction.openQuestions,
		truncations: parsed.truncations,
	});
	return { ok: true, draft: { goal, fromSessionId, document } };
}

/**
 * Mint the successor session and seed it with the reviewed document.
 *
 * Order matters. The new session is minted through the one creation path the
 * host owns, the document goes in as bounded data labelled by its origin, and
 * the old session's skill activations are replayed so loaded skills carry
 * forward. The old session's note names the target, so it is written only
 * once the target exists: appends land in the current session, so the old
 * session is made current for exactly one append and then handed back. A
 * failure there costs the note and nothing else.
 */
export function commitHandoff(
	deps: HandoffServiceDeps,
	draft: HandoffDraft,
	reviewedDocument: string,
): HandoffCommitted | HandoffRefusal {
	const document = reviewedDocument.trim();
	if (document.length === 0) return refuse("warn", "empty", "the reviewed document was empty; nothing was written");
	const session = deps.session;
	if (!session || !deps.createSession) return refuse("error", "unavailable", "session contract unavailable");
	// A document describes the session it was drawn from. Anything that moved
	// the conversation since then makes it describe a session that is gone.
	if (deps.isTurnInFlight()) {
		return refuse("warn", "turn_in_flight", "a turn is in flight; nothing was written");
	}
	if (session.current()?.id !== draft.fromSessionId) {
		return refuse("warn", "stale", "the conversation changed since this document was drawn; nothing was written");
	}
	const { fromSessionId, goal } = draft;
	const activations = session.current()?.skillActivations ?? [];
	let toSessionId: string;
	try {
		deps.createSession();
		const minted = session.current()?.id ?? null;
		if (minted === null || minted === fromSessionId) throw new Error("the new session was not created");
		toSessionId = minted;
		session.appendEntry({
			kind: "custom",
			parentTurnId: null,
			customType: HANDOFF_SEED_CUSTOM_TYPE,
			display: true,
			data: { fromSessionId, goal, document } satisfies HandoffSeedData,
		});
		for (const activation of activations) session.recordSkillActivation(activation);
	} catch (error) {
		return refuse("error", "seed_failed", `could not seed the new session: ${errorText(error)}`);
	}
	const warnings: string[] = [];
	try {
		session.switchBranch(fromSessionId);
		session.appendEntry({
			kind: "custom",
			parentTurnId: null,
			customType: HANDOFF_NOTE_CUSTOM_TYPE,
			display: true,
			data: { toSessionId, goal } satisfies HandoffNoteData,
		});
	} catch (error) {
		warnings.push(`handoff note failed: ${errorText(error)}`);
	} finally {
		try {
			session.switchBranch(toSessionId);
		} catch (error) {
			warnings.push(`could not return to the new session: ${errorText(error)}`);
		}
	}
	return { ok: true, fromSessionId, toSessionId, warnings };
}
