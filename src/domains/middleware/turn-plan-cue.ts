import { isPlanOnlyRequest } from "../../core/plan-request.js";
import { isReadOnlyCall } from "../../core/read-only-calls.js";
import { requestProse } from "../../core/request-prose.js";
import { ToolNames } from "../../core/tool-names.js";
import { forbidsFileWrites } from "../../core/write-prohibition.js";
import type { MiddlewareHookRegistration } from "./runtime.js";
import {
	type MiddlewareEffect,
	type MiddlewareHookInput,
	metadataNumber,
	metadataString,
	turnCanCallTool,
} from "./types.js";

/**
 * Turn-plan cue, packaged as a turn_start hook of the main session (workers never register it).
 *
 * At the start of an operator's turn, before any tool runs, the model sees at most two host notes in the turn's
 * reminder block:
 *
 * - Parallel parts: the request enumerates two or more substantive parts, none opening as a sequel ("then",
 *   "after that"), and the turn can call `dispatch`. The note counts the parts, never quoting them, and asks for one parallel dispatch
 *   with one task per separate deliverable before the model reads or implements them itself, keeping only dependent
 *   or file-sharing parts local. Independence, not size, is the stated test (maintainer 2026-11-22: Sonnet and Opus
 *   read "few-call parts stay here" as covering every part and never dispatched). Since the files are unread, each
 *   writing task's write roots cover its part's area and tests, from a tree listing, not guessed files a worker would
 *   have to widen. It is advice: no worker is required and no admission changes. When the turn can also keep a task
 *   board, the same note opens with the board plan and closes with its bookkeeping, and the task-board reminder stays
 *   silent for that turn.
 *   The dispatch is named only where such a plan runs (`dispatchRuns`: yolo, or an operator who can approve it);
 *   elsewhere, as at headless default where the writing tasks would be refused, the note keeps the board part only
 *   (lab D, wave 78), as numbered calls: the plan first, then done with a note per part before the turn ends.
 * - Pre-edit priming: once per session, while nothing in the workspace has been read, edited or mapped, on a
 *   substantive request the turn can edit and map (`code_nav` or `context`). The note names the map calls to make
 *   before the first edit.
 *
 * Silent on continuations and host-originated turns, answers, proposals, read-only and step-policy turns, requests
 * that forbid writing files, and turns whose capability list is not reported. A request that rules out delegation
 * gets no parallel note.
 */

export const TURN_PLAN_CUE_REGISTRATION_ID = "nudge.turn-plan";
const TURN_PLAN_PRIMING_MIN_WORDS = 10;
const PART_MIN_WORDS = 3;
const NONE: ReadonlyArray<MiddlewareEffect> = [];

const SEQUEL =
	/^(?:then|next|after(?:wards|\s+that)?|finally|once|using\s+(?:it|that|the\s+result)|with\s+the\s+result)\b/iu;
const NO_DELEGATION =
	/\b(?:(?:do\s+not|don['’]t|never|without)\s+(?:(?:use|using|launch(?:ing)?|spawn(?:ing)?|start(?:ing)?)\s+)?(?:(?:any|a|an)\s+)?(?:delegat\w*|dispatch\w*|workers?|sub-?agents?|scouts?|parallel)|no\s+(?:delegation|dispatch(?:es)?|workers?|sub-?agents?)|(?:do|handle|make|fix|implement)\s+(?:it|this|them|these|all(?:\s+of\s+(?:it|them))?)\s+yourself|by\s+yourself)\b/iu;

/** The capability list the host reported for this turn; null when it reported none. */
function reported(input: MiddlewareHookInput, key: "activeCapabilityNames" | "activeToolNames"): Set<string> | null {
	const names = metadataString(input, key);
	return names === null ? null : new Set(names.split(",").map((name) => name.trim()));
}

function words(text: string): number {
	return text.split(/\s+/u).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/**
 * The parts an operator enumerated: numbered or bulleted lines, else an inline run of `1)`/`(1)` markers that starts
 * at 1 and increments. Prose without markers has no parts.
 */
function enumeratedParts(text: string): string[] {
	const lines = text
		.split(/\r?\n/u)
		.map((line) => /^\s*(?:\(?[1-9]\d?[.)]|[-*•])\s+(\S.*)$/u.exec(line)?.[1])
		.filter((part): part is string => part !== undefined);
	if (lines.length >= 2) return lines;
	const marker = /(?:^|\s)\(?([1-9])\)\s+/gu;
	const hits = [...text.matchAll(marker)];
	const parts: string[] = [];
	let expect = 1;
	for (let index = 0; index < hits.length; index++) {
		const hit = hits[index];
		if (hit === undefined || Number(hit[1]) !== expect) continue;
		const start = (hit.index ?? 0) + hit[0].length;
		const next = hits.slice(index + 1).find((later) => Number(later[1]) === expect + 1);
		parts.push(text.slice(start, next?.index ?? text.length).replace(/[\s;,]+(?:and|or)?\s*$/u, ""));
		expect += 1;
	}
	return parts.length >= 2 ? parts : [];
}

function callForm(capability: string, args: string, attached: Set<string> | null, direct: string): string {
	return attached?.has(capability) === false ? `gateway(op="call", capability="${capability}", args=${args})` : direct;
}

function parallelPartsMessage(
	count: number,
	attached: Set<string> | null,
	board: boolean,
	dispatchRuns: boolean,
	finish: boolean,
): string {
	// One instruction for the turn: the board reminder stays silent when this note fires (`parallelPartsCount`), so
	// the board and the dispatch are steps of one plan and never two notes to choose between (lab L7: with both in
	// one block Sonnet followed the dispatch note and dropped the board, 4/4/4 tasks calls to 0/0/1).
	const plan = callForm(
		ToolNames.Tasks,
		'{action:"plan", title:"<board>", tasks:["<one per part>"]}',
		attached,
		'`tasks` action="plan" with a title and one task per part',
	);
	if (!dispatchRuns) {
		// Only the board calls measured to hold: the plan first and a done per part before the turn ends (lab D: Sonnet
		// at its default thinking planned the board, then fixed every part in one command and finished with each part
		// still open). Start is left to the model; measured runs went from pending straight to done.
		const done = callForm(
			ToolNames.Tasks,
			'{action:"done", id:"<its id>", note:"<what you observed>"}',
			attached,
			'`tasks` action="done" id="<its id>" note="<what you observed>"',
		);
		// Partly done is the host's assessment of a turn declared through finish (min(claimed, facts)), so only there.
		const close = finish
			? `before you call finish: ${done}, failed or unrun checks included. A part still open on the board when ` +
				"you call finish leaves the run assessed as partly done."
			: `before you end the turn: ${done}, failed or unrun checks included.`;
		return (
			`[CLIO Coder] The operator's request lists ${count} parts; keep them on the task board as you work. ` +
			`1. Your first tool call, before any read or command: ${plan}. 2. After checking each part, ${close}`
		);
	}
	const dispatch = callForm(
		ToolNames.Dispatch,
		'{tasks:[{task:"<one part>"}, ...]}',
		attached,
		"`dispatch` with one `tasks` entry per part",
	);
	const first = board ? `First declare the task board: ${plan}. Then the parts` : "Parts";
	const track = board
		? ' Mark a part "start" on the board when its worker or your own work on it begins, and "done" with a note of ' +
			"what was observed, failed or unrun checks included, once you have checked the result."
		: " Check each worker's result before reporting it.";
	return (
		`[CLIO Coder] The operator's request lists ${count} parts. ${first} that are separate deliverables (none needs ` +
		`another's result; no two change the same file) go to workers: start one parallel ${dispatch} before reading or ` +
		"implementing them yourself. Independence is the test, not size: a part that would be quick to do here still " +
		"goes out, because each worker takes its own part, workers can run concurrently where capacity allows, and " +
		"this conversation then carries their results instead of every file. Each task names its part's area and expected " +
		"output, with a read-only recipe for a report and a writing recipe for a change. You have not read the files " +
		"yet, so give each writing task `intent.write_roots` covering its part's whole area (its directory or module, " +
		"and the tests that cover it), with paths taken from one listing of the tree, not guessed single files its " +
		"worker would have to ask to widen. Keep here only a part that needs another part's result or shares an area " +
		`with one.${track}`
	);
}

function primingMessage(capabilities: Set<string>, attached: Set<string> | null): string {
	const maps: string[] = [];
	if (capabilities.has(ToolNames.CodeNav)) {
		const symbol = callForm(
			ToolNames.CodeNav,
			'{mode:"symbol", related:true, query:"<symbol>"}',
			attached,
			"`code_nav` mode=symbol with related=true",
		);
		const dependents = callForm(ToolNames.CodeNav, '{mode:"dependents", query:"<file>"}', attached, "mode=dependents");
		maps.push(
			`${symbol} for a symbol the request names (its file, imports, importers and test importers), or ${dependents} for a file's importers`,
		);
	}
	if (capabilities.has(ToolNames.Context)) {
		maps.push(
			`${callForm(ToolNames.Context, '{scope:"workspace"}', attached, "`context` scope=workspace")} for the branch, whether the tree is dirty and the recent commits`,
		);
	}
	return (
		"[CLIO Coder] Nothing in this workspace has been read or mapped yet this session. Before the first edit, " +
		`map the code this request touches: ${maps.join("; ")}. Then read the files your change can break.`
	);
}

/** A succeeded call that shows the model this workspace: a read-class call outside other context scopes, or a change. */
function orients(
	input: MiddlewareHookInput,
	bashChangesTree: (args: MiddlewareHookInput["toolArgs"]) => boolean,
): boolean {
	if (input.metadata?.resultKind !== "ok") return false;
	const tool = input.toolName ?? "";
	if (tool === ToolNames.Edit || tool === ToolNames.Write || tool === "apply_patch") return true;
	if (tool === ToolNames.Bash && bashChangesTree(input.toolArgs)) return true;
	if (tool === ToolNames.Context) {
		const scope = input.toolArgs?.scope;
		return scope === undefined || scope === "workspace";
	}
	return isReadOnlyCall(tool, input.toolArgs);
}

/** The capability set a turn reports, preferring the capability list over the attached tool list. */
function turnCapabilities(input: MiddlewareHookInput): Set<string> | null {
	return reported(input, "activeCapabilityNames") ?? reported(input, "activeToolNames");
}

/**
 * How many parts the parallel note counts on this turn, or 0 when it stays silent. One predicate for the cue and
 * for the task-board reminder, which yields to the note so a multi-part turn gets one instruction.
 */
export function parallelPartsCount(input: MiddlewareHookInput): number {
	if (input.hook !== "turn_start") return 0;
	const origin = input.metadata?.turnOrigin;
	if (input.metadata?.requestContinuation === true || (origin !== undefined && origin !== "operator")) return 0;
	const mode = input.metadata?.turnMode;
	if (mode === "answer" || mode === "proposal" || input.metadata?.turnReadOnly === true) return 0;
	if (input.metadata?.turnStepPolicy === true) return 0;
	if ((metadataNumber(input, "pendingSkillRequests") ?? 0) > 0) return 0;
	const text = requestProse(input.text ?? "");
	if (isPlanOnlyRequest(text) || forbidsFileWrites(text)) return 0;
	if (turnCapabilities(input)?.has(ToolNames.Dispatch) !== true || NO_DELEGATION.test(text)) return 0;
	const parts = enumeratedParts(text);
	const substantive = parts.filter((part) => words(part) >= PART_MIN_WORDS);
	return substantive.length >= 2 && !parts.slice(1).some((part) => SEQUEL.test(part.trim())) ? substantive.length : 0;
}

/**
 * `dispatchRuns` says whether a parallel writing plan would run on this session: yolo, or an operator who can approve
 * it. Without it the note keeps the board part only. Defaults to true.
 */
export function createTurnPlanCueRegistration(
	bashChangesTree: (args: MiddlewareHookInput["toolArgs"]) => boolean,
	deps: { dispatchRuns?: () => boolean } = {},
): MiddlewareHookRegistration {
	let lastSeenSessionId: string | null | undefined;
	let observedAnyTurn = false;
	let oriented = false;
	let primed = false;
	return {
		id: TURN_PLAN_CUE_REGISTRATION_ID,
		description:
			"at an operator turn's start, names a parallel dispatch for enumerated separate parts and, once per session, the map calls before a first edit",
		hooks: ["turn_start", "after_tool"],
		evidence: "count:enumerated-parts@operator-request",
		evaluate(input): ReadonlyArray<MiddlewareEffect> {
			if (input.hook === "after_tool") {
				if (!oriented && input.metadata?.origin !== "harness" && orients(input, bashChangesTree)) oriented = true;
				return NONE;
			}
			if (input.hook !== "turn_start") return NONE;
			const sessionId = input.sessionId ?? null;
			if (lastSeenSessionId === undefined || (lastSeenSessionId === null && sessionId !== null)) {
				lastSeenSessionId = sessionId;
			} else if (sessionId !== lastSeenSessionId) {
				lastSeenSessionId = sessionId;
				observedAnyTurn = false;
				oriented = false;
				primed = false;
			}
			if (!observedAnyTurn) {
				observedAnyTurn = true;
				// A resumed or forked conversation may already hold the workspace; only a fresh one is unfamiliar.
				const messages = metadataNumber(input, "conversationMessages");
				if (messages === null || messages > 0) oriented = true;
			}
			const origin = input.metadata?.turnOrigin;
			if (input.metadata?.requestContinuation === true || (origin !== undefined && origin !== "operator")) return NONE;
			const mode = input.metadata?.turnMode;
			if (mode === "answer" || mode === "proposal" || input.metadata?.turnReadOnly === true) return NONE;
			if (input.metadata?.turnStepPolicy === true) return NONE;
			if ((metadataNumber(input, "pendingSkillRequests") ?? 0) > 0) return NONE;
			const text = requestProse(input.text ?? "");
			if (isPlanOnlyRequest(text) || forbidsFileWrites(text)) return NONE;
			const capabilities = turnCapabilities(input);
			if (capabilities === null) return NONE;
			const attached = reported(input, "activeToolNames");
			const notes: string[] = [];
			const parallel = parallelPartsCount(input);
			if (parallel > 0) {
				// The board clause names tasks and gateway bookkeeping, so it needs both, as the board reminder does.
				const board = turnCanCallTool(input, ToolNames.Tasks) && turnCanCallTool(input, ToolNames.Gateway);
				const dispatchRuns = deps.dispatchRuns?.() ?? true;
				const finish = turnCanCallTool(input, ToolNames.Finish);
				if (dispatchRuns || board) notes.push(parallelPartsMessage(parallel, attached, board, dispatchRuns, finish));
			}
			const canEdit = capabilities.has(ToolNames.Edit) || capabilities.has(ToolNames.Write);
			const canMap = capabilities.has(ToolNames.CodeNav) || capabilities.has(ToolNames.Context);
			if (!oriented && !primed && canEdit && canMap && words(text) >= TURN_PLAN_PRIMING_MIN_WORDS) {
				primed = true;
				notes.push(primingMessage(capabilities, attached));
			}
			return notes.length === 0
				? NONE
				: [{ kind: "inject_reminder", severity: "info", audience: "model", message: notes.join("\n") }];
		},
	};
}
