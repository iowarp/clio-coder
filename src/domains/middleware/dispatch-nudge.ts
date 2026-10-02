import { dispatchTargetsScout, isReadOnlyCall } from "../../core/read-only-calls.js";
import { ToolNames } from "../../core/tool-names.js";
import type { DispatchContract } from "../dispatch/contract.js";
import { dispatchOwnerOf, dispatchOwnership } from "../dispatch/ownership.js";
import { isTerminalRunEnvelope, type RunOutcome } from "../dispatch/types.js";
import type { MiddlewareHookRegistration } from "./runtime.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "./types.js";

/**
 * Detached-dispatch collection nudge, packaged as a turn_end hook
 * registration (same shape as the open-tasks nudge in task-nudge.ts).
 *
 * A detached batch returns before its runs finish, so nothing in the turn
 * forces the model back to the results. When a settled turn ends while at
 * least one uncollected batch has every run terminal, the turn is carried
 * onward with a `request_continuation`. The turn controller collects the
 * ready batches before the next model call and supplies their results. Collection marks the batch in the
 * durable store, which removes it from the open list and silences the nudge,
 * including across session resume.
 *
 * Deliberate non-triggers: batches with runs still in flight (there is
 * nothing to collect yet; the dispatch board shows live progress), aborted or
 * errored turns, and surfaces without the monitor tool (nudging them would
 * loop against a wall).
 */

export const DETACHED_DISPATCH_NUDGE_REGISTRATION_ID = "nudge.detached-dispatch";
export const READ_ONLY_EXPLORATION_NUDGE_REGISTRATION_ID = "nudge.read-only-exploration";
export const READ_ONLY_EXPLORATION_NUDGE_CALL_THRESHOLD = 9;
export const UNBACKED_WORKER_CLAIM_REGISTRATION_ID = "rail.unbacked-worker-claim";

const EXPLORATION_NUDGE_TURN_LIMIT = 32;
const NO_TURN = "no-turn";

interface ExplorationTurnState {
	readOnlyCalls: number;
	scoutSucceeded: boolean;
	/** The advisory was already issued for this user turn. */
	advised: boolean;
}

export function buildReadOnlyExplorationMessage(): string {
	return `[Clio Coder] This turn used ${READ_ONLY_EXPLORATION_NUDGE_CALL_THRESHOLD}+ read-only exploration calls without a successful Scout dispatch; delegate broad repository reconnaissance to Scout when more exploration is needed. If Scout already failed, confirm its useful leads with focused reads and synthesize; do not repeat its entire search.`;
}

function isNonRepositoryContextCall(input: MiddlewareHookInput): boolean {
	if (input.toolName !== ToolNames.Context) return false;
	const scope = typeof input.toolArgs?.scope === "string" ? input.toolArgs.scope.trim().toLowerCase() : null;
	return scope !== null && scope !== "workspace";
}

function isReadOnlyExplorationCall(input: MiddlewareHookInput): boolean {
	if (isNonRepositoryContextCall(input)) return false;
	return isReadOnlyCall(input.toolName ?? "", input.toolArgs);
}

function hasActiveTool(input: MiddlewareHookInput, toolName: string): boolean {
	const activeToolNames = input.metadata?.activeCapabilityNames ?? input.metadata?.activeToolNames;
	return (
		typeof activeToolNames === "string" &&
		activeToolNames
			.split(",")
			.map((name) => name.trim())
			.includes(toolName)
	);
}

function newExplorationTurnState(advised = false): ExplorationTurnState {
	return {
		readOnlyCalls: 0,
		scoutSucceeded: false,
		advised,
	};
}

function markScoutSuccess(state: ExplorationTurnState): void {
	state.scoutSucceeded = true;
}

/**
 * Advises the main agent to use Scout after a long read-only exploration turn.
 * Only a successful Scout dispatch suppresses the advisory for that turn.
 *
 * The advisory is a reminder, never a `request_continuation`. Reading is the
 * work the operator asked for, so the finding rides the next request's
 * reminder block, not a forced extra model round that spends a full context
 * window to be told the reads were intended. It is advice to the model about
 * how to work, so it is model-only: shown to the operator after a finished
 * answer, it read as an alarm about a turn that had gone fine. One advisory
 * per user turn: a later model round of the same turn re-counts its own calls
 * but stays silent once the advisory is spent.
 */
export function createReadOnlyExplorationNudgeRegistration(): {
	registration: MiddlewareHookRegistration;
	rememberHarnessScout(turnId: string): void;
} {
	const byTurn = new Map<string, ExplorationTurnState>();
	const turnKey = (input: MiddlewareHookInput): string => {
		const userTurnId = input.hook === "turn_end" ? input.metadata?.userTurnId : undefined;
		return (
			(typeof userTurnId === "string" && userTurnId.length > 0 ? userTurnId : input.turnId) ?? input.runId ?? NO_TURN
		);
	};
	const remember = (key: string, state: ExplorationTurnState): ExplorationTurnState => {
		if (byTurn.size >= EXPLORATION_NUDGE_TURN_LIMIT && !byTurn.has(key)) {
			const oldest = byTurn.keys().next().value;
			if (oldest !== undefined) byTurn.delete(oldest);
		}
		byTurn.set(key, state);
		return state;
	};
	const stateForTool = (key: string): ExplorationTurnState =>
		byTurn.get(key) ?? remember(key, newExplorationTurnState());
	// Counts restart for the next model round of the same user turn; whether the
	// advisory is already spent carries across those rounds.
	const takeTurnEndState = (key: string): ExplorationTurnState | null => {
		const bound = byTurn.get(key);
		if (bound === undefined) return null;
		const carried = newExplorationTurnState(bound.advised);
		carried.scoutSucceeded = bound.scoutSucceeded;
		byTurn.set(key, carried);
		return bound;
	};
	const markAdvised = (key: string): void => {
		const carried = byTurn.get(key);
		if (carried) carried.advised = true;
	};
	return {
		rememberHarnessScout(turnId) {
			markScoutSuccess(stateForTool(turnId));
		},
		registration: {
			id: READ_ONLY_EXPLORATION_NUDGE_REGISTRATION_ID,
			description: "advise Scout delegation after prolonged read-only repository exploration",
			hooks: ["before_tool", "after_tool", "turn_end"],
			evaluate(input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> {
				const key = turnKey(input);
				if (input.hook === "before_tool" || input.hook === "after_tool") {
					if (input.metadata?.origin === "harness") return [];
					const state = stateForTool(key);
					if (input.toolName === ToolNames.Dispatch) {
						if (input.hook === "after_tool" && dispatchTargetsScout(input.toolArgs)) {
							if (input.metadata?.resultKind === "ok") markScoutSuccess(state);
						}
						return [];
					}
					if (input.hook === "after_tool" || !isReadOnlyExplorationCall(input)) return [];
					state.readOnlyCalls += 1;
					return [];
				}
				if (input.hook !== "turn_end") return [];
				const state = takeTurnEndState(key);
				const stopReason = input.metadata?.stopReason;
				if (stopReason !== undefined && stopReason !== "stop") return [];
				if (!hasActiveTool(input, ToolNames.Dispatch)) return [];
				if (
					!state ||
					state.advised ||
					state.scoutSucceeded ||
					state.readOnlyCalls < READ_ONLY_EXPLORATION_NUDGE_CALL_THRESHOLD
				) {
					return [];
				}
				markAdvised(key);
				return [
					{ kind: "inject_reminder", message: buildReadOnlyExplorationMessage(), severity: "info", audience: "model" },
				];
			},
		},
	};
}

/**
 * Honesty rail for fabricated worker results.
 *
 * A model under context pressure can narrate a worker it never dispatched:
 * "the scout investigation is complete" after twelve inline greps, headed
 * "Scout Shadow Report". Nothing in the turn contradicts it, and the operator
 * has no receipt id to check against.
 *
 * The check is per-turn and mechanical, never an LLM judge: the final
 * assistant text matched against worker-result claim shapes, and whether any
 * dispatch call ran in the same turn. When a claim is made and no dispatch
 * ran, the turn ends with one advisory transcript line. Detection is
 * deliberately conservative: an intention ("let me dispatch a scout") is not a
 * claim, so only a claim of results trips it. A turn the operator handed a
 * shared `[worker result]` note (turn_end metadata `sharedWorkerNote`) is
 * exempt: the result it relays is the operator's, backed by a receipt.
 */
const WORKER_NOUN = "(?:scouts?|shadow (?:agent|worker)s?|sub-?agents?|workers?)";
const RESULT_VERB =
	"(?:found|reported|returned|investigated|explored|concluded|confirmed|discovered|surfaced|completed|is complete|came back)";
// Prose that explains how dispatch works ("when the worker has completed, the
// coordinator reads the receipt") shares nouns and verbs with a fabricated
// result. A claim is a definite, specific worker plus a result verb with no
// conditional or modal word between them.
const DEFINITE = "(?<!\\b(?:if|when|whenever|once|until|unless|whether)\\s)(?:the|this|that|our|my|each|both)";
const NOT_HYPOTHETICAL =
	"(?:(?!\\b(?:if|when|whenever|once|until|unless|whether|can|could|may|might|will|would|should|must|shall)\\b)[^.\\n])";

const WORKER_CLAIM_PATTERNS: ReadonlyArray<RegExp> = [
	// "the scout found ...", "the scout investigation is complete", "both workers came back ..."
	new RegExp(
		`\\b${DEFINITE}\\s+(?:[\\w-]+\\s+){0,2}?${WORKER_NOUN}\\b${NOT_HYPOTHETICAL}{0,40}?\\b${RESULT_VERB}\\b`,
		"i",
	),
	// "... reported by the scout"
	new RegExp(`\\b${RESULT_VERB}\\b${NOT_HYPOTHETICAL}{0,24}\\bby\\s+${DEFINITE}\\s+${WORKER_NOUN}\\b`, "i"),
	// A titled worker deliverable, only as a heading or bold title: "## Scout Shadow Report",
	// "**Worker findings**". A mid-sentence "worker summary" is architecture prose.
	/^[ \t]*(?:#{1,6}[ \t]+|\*\*|__)(?:the\s+)?(?:scout|shadow|worker)\b[^\n]{0,20}\b(?:report|findings|summary)\b/im,
];

export function claimsWorkerResults(text: string | undefined): boolean {
	if (typeof text !== "string" || text.trim().length === 0) return false;
	return WORKER_CLAIM_PATTERNS.some((pattern) => pattern.test(text));
}

export function buildUnbackedWorkerClaimMessage(): string {
	return "[Clio Coder] No dispatch ran this turn; worker results named above are not backed by a receipt. Dispatch the work or state plainly that you did it inline.";
}

/**
 * Contradicts a worker claim that no dispatch call backs. One advisory line,
 * no continuation: the turn is already over and the operator, not another
 * model round, decides what to do about it.
 */
export function createUnbackedWorkerClaimRegistration(): MiddlewareHookRegistration {
	const dispatchedTurns = new Set<string>();
	const turnKey = (input: MiddlewareHookInput): string => {
		const userTurnId = input.hook === "turn_end" ? input.metadata?.userTurnId : undefined;
		return (
			(typeof userTurnId === "string" && userTurnId.length > 0 ? userTurnId : input.turnId) ?? input.runId ?? NO_TURN
		);
	};
	const remember = (key: string): void => {
		if (dispatchedTurns.size >= EXPLORATION_NUDGE_TURN_LIMIT && !dispatchedTurns.has(key)) {
			const oldest = dispatchedTurns.values().next().value;
			if (oldest !== undefined) dispatchedTurns.delete(oldest);
		}
		dispatchedTurns.add(key);
	};
	return {
		id: UNBACKED_WORKER_CLAIM_REGISTRATION_ID,
		description: "contradict a worker/scout result claim that no dispatch call in the turn backs",
		hooks: ["after_tool", "turn_end"],
		evaluate(input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> {
			const key = turnKey(input);
			if (input.hook === "after_tool") {
				// Any completed dispatch counts, succeeded or not: a run that failed is
				// still visible in the transcript and honestly reportable. Only a turn
				// with no dispatch call at all can fabricate one.
				if (input.toolName === ToolNames.Dispatch) remember(key);
				return [];
			}
			if (input.hook !== "turn_end") return [];
			const dispatched = dispatchedTurns.delete(key);
			const stopReason = input.metadata?.stopReason;
			if (stopReason !== undefined && stopReason !== "stop") return [];
			// A surface without the dispatch tool cannot have dispatched, so a worker
			// mention there is discussion, not a fabricated result.
			if (!hasActiveTool(input, ToolNames.Dispatch)) return [];
			// A `[worker result]` note the operator shared this turn is a receipt-backed
			// worker result that entered by the operator's hand, not by a dispatch
			// call. A turn that only relays it has nothing to fabricate (#73).
			if (input.metadata?.sharedWorkerNote === true) return [];
			if (dispatched || !claimsWorkerResults(input.text)) return [];
			return [{ kind: "inject_reminder", message: buildUnbackedWorkerClaimMessage(), severity: "warn" }];
		},
	};
}

type DetachedTerminalOutcome = RunOutcome | "missing" | "unknown";
type DetachedTerminalOutcomeCounts = Partial<Record<DetachedTerminalOutcome, number>>;

export interface DetachedBatchNudgeView {
	id: string;
	total: number;
	terminal: number;
	terminalOutcomes?: Readonly<DetachedTerminalOutcomeCounts>;
}

const TERMINAL_OUTCOME_ORDER: ReadonlyArray<DetachedTerminalOutcome> = [
	"succeeded",
	"canceled",
	"failed",
	"timed_out",
	"stalled",
	"denied_by_policy",
	"spawn_failed",
	"missing",
	"unknown",
];

function terminalOutcomeLabel(outcome: DetachedTerminalOutcome): string {
	switch (outcome) {
		case "timed_out":
			return "timed out";
		case "denied_by_policy":
			return "denied by policy";
		case "spawn_failed":
			return "spawn failed";
		case "missing":
			return "ledger row missing";
		case "unknown":
			return "outcome unknown";
		default:
			return outcome;
	}
}

function incrementTerminalOutcome(counts: DetachedTerminalOutcomeCounts, outcome: DetachedTerminalOutcome): void {
	counts[outcome] = (counts[outcome] ?? 0) + 1;
}

/**
 * Open (uncollected) detached batches this session owns, with terminal-run
 * progress, computed from the durable batch store and the run ledger. A ledger
 * row pruned from the bounded ring counts as terminal: it can never complete,
 * so the batch must stay collectible instead of pending forever.
 *
 * The batch store is machine-wide. Without the ownership filter a batch
 * another project dispatched, or one a crashed session left behind, turned
 * every other session's turn end into a forced continuation telling the model
 * to collect results it knew nothing about.
 */
export function openDetachedBatchViews(
	dispatch: Pick<DispatchContract, "detached" | "getRun" | "owner" | "assignments">,
): DetachedBatchNudgeView[] {
	const detached = dispatch.detached;
	if (!detached) return [];
	let records: ReturnType<typeof detached.list>;
	try {
		records = detached.list();
	} catch {
		return [];
	}
	const ownership = dispatchOwnership(dispatchOwnerOf(dispatch));
	const owned = records.filter((record) => ownership.ownsBatch(record));
	return owned.map((record) => {
		let terminal = 0;
		const terminalOutcomes: DetachedTerminalOutcomeCounts = {};
		for (const run of record.runs) {
			const assignment = dispatch.assignments?.getStored(run.assignmentId) ?? null;
			if (assignment?.status === "running") continue;
			const row = dispatch.getRun(assignment?.terminalRunId ?? run.runId);
			if (row === null) {
				terminal += 1;
				incrementTerminalOutcome(terminalOutcomes, "missing");
			} else if (isTerminalRunEnvelope(row)) {
				terminal += 1;
				incrementTerminalOutcome(terminalOutcomes, row.outcome ?? "unknown");
			}
		}
		return { id: record.id, total: record.runs.length, terminal, terminalOutcomes };
	});
}

export function finishedDetachedBatchIds(
	dispatch: Pick<DispatchContract, "detached" | "getRun" | "owner" | "assignments">,
): ReadonlyArray<string> {
	return openDetachedBatchViews(dispatch)
		.filter((view) => view.total > 0 && view.terminal >= view.total)
		.map((view) => view.id);
}

function detachedBatchProgress(view: DetachedBatchNudgeView): string {
	const terminalOutcomes = view.terminalOutcomes ?? {};
	if (view.terminal === view.total && terminalOutcomes.succeeded === view.total) {
		return `${view.terminal}/${view.total} run(s) done`;
	}
	let accountedFor = 0;
	const breakdown = TERMINAL_OUTCOME_ORDER.flatMap((outcome) => {
		const count = terminalOutcomes[outcome] ?? 0;
		accountedFor += count;
		return count > 0 ? [`${count} ${terminalOutcomeLabel(outcome)}`] : [];
	});
	const unavailable = Math.max(0, view.terminal - accountedFor);
	if (unavailable > 0) breakdown.push(`${unavailable} outcome unknown`);
	return `${view.terminal}/${view.total} run(s) terminal (${breakdown.join(", ")})`;
}

export function buildDetachedBatchesMessage(
	ready: ReadonlyArray<DetachedBatchNudgeView>,
	running: ReadonlyArray<DetachedBatchNudgeView>,
): string {
	const rows = ready.map((view) => `  - batch ${view.id}: ${detachedBatchProgress(view)}`);
	const runningNote =
		running.length > 0 ? `\n${running.length} other detached batch(es) are still running; leave those for later.` : "";
	return (
		`[Clio Coder] ${ready.length} detached dispatch batch(es) finished and are uncollected:\n` +
		`${rows.join("\n")}\n` +
		`Collect each with monitor mode="collect" batch_id=<id> before final synthesis and act on the results. ` +
		`A batch stays open (and keeps nudging) until it is collected.${runningNote}`
	);
}

export interface CreateDetachedDispatchNudgeRegistrationOptions {
	/** Live view of open detached batches; see openDetachedBatchViews. */
	getOpenBatches: () => ReadonlyArray<DetachedBatchNudgeView>;
}

export function createDetachedDispatchNudgeRegistration(
	options: CreateDetachedDispatchNudgeRegistrationOptions,
): MiddlewareHookRegistration {
	return {
		id: DETACHED_DISPATCH_NUDGE_REGISTRATION_ID,
		description:
			"request continuation so the turn controller collects finished detached results before the next model call",
		hooks: ["turn_end"],
		evaluate(input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> {
			if (input.hook !== "turn_end") return [];
			// Only settled stop turns are candidates; aborted and errored turns
			// already carry their own recovery path. Absent stopReason is "stop",
			// mirroring the finish contract.
			const stopReason = input.metadata?.stopReason;
			if (stopReason !== undefined && stopReason !== "stop") return [];
			// A surface without access to monitor can never collect a batch, so
			// nudging it would loop against a wall.
			const activeToolNames = input.metadata?.activeCapabilityNames ?? input.metadata?.activeToolNames;
			if (typeof activeToolNames === "string" && !activeToolNames.split(",").includes(ToolNames.Monitor)) return [];
			let views: ReadonlyArray<DetachedBatchNudgeView>;
			try {
				views = options.getOpenBatches();
			} catch {
				return [];
			}
			const ready = views.filter((view) => view.total > 0 && view.terminal >= view.total);
			if (ready.length === 0) return [];
			return [
				{
					kind: "request_continuation",
					note: "finished detached batches are waiting",
					message: `Clio will collect ${ready.length} finished detached batch(es) before the next model call.`,
				},
			];
		},
	};
}
