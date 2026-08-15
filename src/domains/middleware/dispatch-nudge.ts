import { ToolNames } from "../../core/tool-names.js";
import type { DispatchContract } from "../dispatch/contract.js";
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
 * onward with a `request_continuation` plus a paired reminder naming the
 * ready batches. Collecting a batch (monitor mode="collect") marks it in the
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

const SCOUT_AGENT_ID = "scout";

const EXPLORATION_TOOL_NAMES = new Set<string>([
	ToolNames.Read,
	ToolNames.Grep,
	ToolNames.Find,
	ToolNames.Ls,
	ToolNames.CodeNav,
	ToolNames.Context,
	ToolNames.Git,
]);
const EXPLORATION_NUDGE_TURN_LIMIT = 32;
const NO_TURN = "no-turn";
const READ_ONLY_SHELL_COMMAND_PATTERN = /^\s*(?:awk|cat|fd|find|git|grep|head|jq|ls|rg|sed|tail|tree|wc)\b/;

interface ExplorationTurnState {
	readOnlyCalls: number;
	scoutSucceeded: boolean;
	/** The advisory already reached the operator for this user turn. */
	advised: boolean;
}

export function buildReadOnlyExplorationMessage(): string {
	return `[Clio Coder] This turn used ${READ_ONLY_EXPLORATION_NUDGE_CALL_THRESHOLD}+ read-only exploration calls without a successful Scout dispatch; delegate broad repository reconnaissance to Scout.`;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: null;
}

/**
 * Resolve the effective agents for an ordinary dispatch using the same weak-
 * model task normalization and agent aliases as the live dispatch parser.
 * Keep this small mirror local: middleware must not depend on the tool layer.
 */
function ordinaryDispatchAgents(args: MiddlewareHookInput["toolArgs"]): ReadonlyArray<string> | null {
	if (
		!args ||
		args.list === true ||
		args.apply_winner !== undefined ||
		(args.review !== undefined && args.review !== false) ||
		args.mode === "compete"
	) {
		return null;
	}

	let tasks: unknown = args.tasks;
	if (typeof tasks === "string") {
		const raw = tasks.trim();
		if (raw.startsWith("[") || raw.startsWith("{")) {
			try {
				tasks = JSON.parse(raw) as unknown;
			} catch {
				// Leave malformed JSON in its original shape, as the tool does.
			}
		}
	}
	if (recordValue(tasks) !== null || typeof tasks === "string") tasks = [tasks];
	if (tasks === undefined && typeof args.task === "string") tasks = [{ task: args.task }];
	if (!Array.isArray(tasks) || tasks.length === 0) return null;

	const sharedAgent = stringValue(args.agent) ?? stringValue(args.agent_id) ?? "coder";
	const agents: string[] = [];
	for (const task of tasks) {
		if (typeof task === "string") {
			if (stringValue(task) === null) return null;
			agents.push(sharedAgent);
			continue;
		}
		const record = recordValue(task);
		if (!record || stringValue(record.task) === null) return null;
		// Task-local agent/agent_id overrides the shared default. `agentId` is
		// intentionally ignored because the production parser does not accept it.
		agents.push(stringValue(record.agent) ?? stringValue(record.agent_id) ?? sharedAgent);
	}
	return agents;
}

function dispatchTargetsScout(args: MiddlewareHookInput["toolArgs"]): boolean {
	return ordinaryDispatchAgents(args)?.some((agent) => agent.toLowerCase() === SCOUT_AGENT_ID) === true;
}

function isNonRepositoryContextCall(input: MiddlewareHookInput): boolean {
	if (input.toolName !== ToolNames.Context) return false;
	const scope = stringValue(input.toolArgs?.scope)?.toLowerCase();
	return scope !== null && scope !== "workspace";
}

function isReadOnlyExplorationCall(input: MiddlewareHookInput): boolean {
	if (isNonRepositoryContextCall(input)) return false;
	if (input.toolName && EXPLORATION_TOOL_NAMES.has(input.toolName)) return true;
	if (input.toolName !== ToolNames.Bash) return false;
	const command = input.toolArgs?.command;
	return typeof command === "string" && READ_ONLY_SHELL_COMMAND_PATTERN.test(command);
}

function hasActiveTool(input: MiddlewareHookInput, toolName: string): boolean {
	const activeToolNames = input.metadata?.activeToolNames;
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
 * The advisory is a notice, never a `request_continuation`. Reading is the work
 * the operator asked for, so the finding is worth one line in the transcript
 * and the next request's reminder block, not a forced extra model round that
 * spends a full context window to be told the reads were intended. One
 * advisory per user turn: a later model round of the same turn re-counts its
 * own calls but stays silent once the operator has been told.
 */
export function createReadOnlyExplorationNudgeRegistration(): MiddlewareHookRegistration {
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
		byTurn.set(key, newExplorationTurnState(bound.advised));
		return bound;
	};
	const markAdvised = (key: string): void => {
		const carried = byTurn.get(key);
		if (carried) carried.advised = true;
	};
	return {
		id: READ_ONLY_EXPLORATION_NUDGE_REGISTRATION_ID,
		description: "advise Scout delegation after prolonged read-only repository exploration",
		hooks: ["before_tool", "after_tool", "turn_end"],
		evaluate(input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> {
			const key = turnKey(input);
			if (input.hook === "before_tool" || input.hook === "after_tool") {
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
			return [{ kind: "inject_reminder", message: buildReadOnlyExplorationMessage(), severity: "info" }];
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
 * claim, so only a claim of results trips it.
 */
const WORKER_NOUN = "(?:scouts?|shadow (?:agent|worker)s?|sub-?agents?|workers?)";
const RESULT_VERB =
	"(?:found|reported|returned|investigated|explored|concluded|confirmed|discovered|surfaced|completed|is complete|came back)";

const WORKER_CLAIM_PATTERNS: ReadonlyArray<RegExp> = [
	// "the scout found ...", "the scout investigation is complete", "workers came back ..."
	new RegExp(`\\b${WORKER_NOUN}\\b[^.\\n]{0,40}?\\b${RESULT_VERB}\\b`, "i"),
	// "... reported by the scout"
	new RegExp(`\\b${RESULT_VERB}\\b[^.\\n]{0,24}\\bby\\s+(?:the\\s+|a\\s+|our\\s+)?${WORKER_NOUN}\\b`, "i"),
	// A titled worker deliverable: "Scout Shadow Report", "Worker findings".
	/\b(?:scout|shadow|worker)\b[^\n]{0,20}\b(?:report|findings|summary)\b/i,
];

export function claimsWorkerResults(text: string | undefined): boolean {
	if (typeof text !== "string" || text.trim().length === 0) return false;
	return WORKER_CLAIM_PATTERNS.some((pattern) => pattern.test(text));
}

export function buildUnbackedWorkerClaimMessage(): string {
	return "[Clio Coder] no dispatch ran this turn; worker results named above are not backed by a receipt. Dispatch the work or state plainly that you did it inline.";
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
 * Open (uncollected) detached batches with terminal-run progress, computed
 * from the durable batch store and the run ledger. A ledger row pruned from
 * the bounded ring counts as terminal: it can never complete, so the batch
 * must stay collectible instead of pending forever.
 */
export function openDetachedBatchViews(
	dispatch: Pick<DispatchContract, "detached" | "getRun">,
): DetachedBatchNudgeView[] {
	const detached = dispatch.detached;
	if (!detached) return [];
	let records: ReturnType<typeof detached.list>;
	try {
		records = detached.list();
	} catch {
		return [];
	}
	return records.map((record) => {
		let terminal = 0;
		const terminalOutcomes: DetachedTerminalOutcomeCounts = {};
		for (const run of record.runs) {
			const row = dispatch.getRun(run.runId);
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
		description: "carry the turn onward when detached dispatch results are ready to collect",
		hooks: ["turn_end"],
		evaluate(input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> {
			if (input.hook !== "turn_end") return [];
			// Only settled stop turns are candidates; aborted and errored turns
			// already carry their own recovery path. Absent stopReason is "stop",
			// mirroring the finish contract.
			const stopReason = input.metadata?.stopReason;
			if (stopReason !== undefined && stopReason !== "stop") return [];
			// A surface without the monitor tool can never collect a batch, so
			// nudging it would loop against a wall.
			const activeToolNames = input.metadata?.activeToolNames;
			if (typeof activeToolNames === "string" && !activeToolNames.split(",").includes(ToolNames.Monitor)) return [];
			let views: ReadonlyArray<DetachedBatchNudgeView>;
			try {
				views = options.getOpenBatches();
			} catch {
				return [];
			}
			const ready = views.filter((view) => view.total > 0 && view.terminal >= view.total);
			if (ready.length === 0) return [];
			const running = views.filter((view) => view.total > 0 && view.terminal < view.total);
			const message = buildDetachedBatchesMessage(ready, running);
			return [
				{ kind: "request_continuation", message },
				{ kind: "inject_reminder", message, severity: "warn" },
			];
		},
	};
}
