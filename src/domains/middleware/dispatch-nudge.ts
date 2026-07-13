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
export const SCOUT_EXPLORATION_FALLBACK_CALL_LIMIT = 0;
export const SCOUT_EXPLORATION_SPOT_CHECK_CALL_LIMIT = 0;

const SCOUT_AGENT_ID = "scout";
const SCOUT_PREVIEW_TASK =
	"Map the repository structure, key entry points, and relevant subsystems; return concise findings with file:line citations.";

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
	explicitBroadRequest: boolean;
	scoutAttemptPending: boolean;
	scoutSucceeded: boolean;
	scoutFailed: boolean;
	fallbackCallsRemaining: number;
	spotCheckCallsRemaining: number;
}

interface PendingExplorationTurn {
	sessionId: string | undefined;
	state: ExplorationTurnState;
}

export interface CreateReadOnlyExplorationNudgeRegistrationOptions {
	/**
	 * Side-effect-free Scout routing probe. Production wires this to
	 * `dispatch.preview`; absence, false, or a throw disables proactive
	 * steering and its guard for the turn.
	 */
	canRouteScout?: (task: string) => boolean;
}

export function buildReadOnlyExplorationMessage(): string {
	return `[Clio Coder] This turn used ${READ_ONLY_EXPLORATION_NUDGE_CALL_THRESHOLD}+ read-only exploration calls without a successful Scout dispatch; delegate broad repository reconnaissance to Scout.`;
}

export function buildProactiveScoutRoutingMessage(): string {
	return (
		"[Clio Coder] Route this explicit broad repository exploration to Scout now: call dispatch with one bounded " +
		'tasks:[{agent:"scout", task:"Map the repository structure and key entry points; return cited findings."}] ' +
		"handoff before direct repo-wide inspection. You remain responsible for choosing the handoff, synthesizing the receipt, and spot-checking cited claims."
	);
}

function buildScoutFirstBlockReason(): string {
	return (
		"broad repository exploration is Scout-first for this request; call dispatch with one bounded " +
		'tasks:[{agent:"scout", task:"..."}] handoff before direct repository inspection'
	);
}

function buildScoutFallbackMessage(): string {
	return "[Clio Coder] Scout did not complete. Do not replace it with a manual repository scan; report the failed handoff and its bounded partial findings or blocker.";
}

function buildScoutSuccessMessage(): string {
	return "[Clio Coder] Scout completed. Synthesize its grounded findings now without calling more tools, and do not repeat items under `Unresolved gaps:` as facts.";
}

function buildScoutReadProgressMessage(remaining: number, scoutSucceeded: boolean): string {
	if (remaining > 0) {
		return `[Clio Coder] ${remaining} live source ${remaining === 1 ? "read remains" : "reads remain"}; read another specific ${
			scoutSucceeded ? "Scout-cited" : "entry-point"
		} file before synthesis.`;
	}
	return "[Clio Coder] The bounded live-read phase is complete. Tool use is now locked; synthesize the Scout receipt and the two source reads in your answer.";
}

const LOCAL_REPOSITORY_SUBJECT_PATTERN = /\b(?:repo(?:sitory)?|codebase|source[ -]tree)\b/i;
const BROAD_REPOSITORY_SUBJECT_PATTERN = /\b(?:repo(?:sitory)?|codebase|source[ -]tree|project)\b/i;
const DIRECT_RECONNAISSANCE_ACTION_PATTERN =
	/\b(?:explor(?:e|ing|ation)|survey|map(?:\s+out)?|orient(?:ation)?|tour|walk(?:through|\s+through)|familiar(?:ize|ise))\b/i;
const GENERAL_RECONNAISSANCE_ACTION_PATTERN =
	/\b(?:explor(?:e|ing|ation)|survey|map(?:\s+out)?|orient(?:ation)?|overview|tour|walk(?:through|\s+through)|understand|familiar(?:ize|ise)|inspect|analy[sz]e)\b/i;
const EXPLICIT_BREADTH_PATTERN =
	/\b(?:all|architecture|broad|components?|end[ -]to[ -]end|entire|full|high[ -]level|key entry points?|modules?|overall|overview|structure|whole)\b/i;
const NARROW_REPOSITORY_TARGET_PATTERN =
	/(?:^|[\s`'"(])(?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|js|json|jsx|md|py|rs|toml|ts|tsx|yaml|yml)\b|\b(?:single|specific|this|one)\s+(?:class|file|function|method|module|symbol)\b|\b(?:call sites?|class|function|method|symbol)\s+[`'"\w$.-]+|\b[\w$.-]+\s+(?:class|config|file|function|loader|method|module|page|symbol)\b|\b(?:bug|configuration|test failure)\b/i;
const EXTERNAL_RESEARCH_PATTERN =
	/https?:\/\/|\b(?:arxiv|literature|research papers?)\b|\bexternal\s+(?:docs?|documentation|papers?|research|sources?|websites?)\b|\b(?:browse|look up|research|search)\s+(?:the\s+)?(?:internet|online|web)\b/i;
const EXPLICIT_NO_TOOLS_PATTERN =
	/\b(?:do not|don't|dont|no|without)\s+(?:(?:call|run|use|using)\s+)?(?:any\s+)?tools?\b|\btool[ -]free\b/i;
const EXPLICIT_NO_DELEGATION_PATTERN =
	/\b(?:do not|don't|dont|no|without)\s+(?:(?:use|using)\s+)?(?:dispatch(?:ing)?|delegat(?:e|ing|ion)|sub-?agents?)\b/i;

/** Pure intent gate for the proactive path; broad local reconnaissance only. */
export function isExplicitBroadRepositoryExplorationRequest(text: string): boolean {
	const normalized = text
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/\s+/g, " ")
		.trim();
	if (normalized.length === 0) return false;
	if (
		EXPLICIT_NO_TOOLS_PATTERN.test(normalized) ||
		EXPLICIT_NO_DELEGATION_PATTERN.test(normalized) ||
		EXTERNAL_RESEARCH_PATTERN.test(normalized)
	) {
		return false;
	}
	const explicitBreadth = EXPLICIT_BREADTH_PATTERN.test(normalized);
	const directLocalReconnaissance =
		LOCAL_REPOSITORY_SUBJECT_PATTERN.test(normalized) && DIRECT_RECONNAISSANCE_ACTION_PATTERN.test(normalized);
	const explicitlyBroadReconnaissance =
		explicitBreadth &&
		BROAD_REPOSITORY_SUBJECT_PATTERN.test(normalized) &&
		GENERAL_RECONNAISSANCE_ACTION_PATTERN.test(normalized);
	if (!directLocalReconnaissance && !explicitlyBroadReconnaissance) return false;
	return explicitBreadth || !NARROW_REPOSITORY_TARGET_PATTERN.test(normalized);
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: null;
}

function dispatchTargetsScout(args: MiddlewareHookInput["toolArgs"]): boolean {
	if (
		!args ||
		args.list === true ||
		args.apply_winner !== undefined ||
		args.review !== undefined ||
		stringValue(args.mode)?.toLowerCase() === "compete"
	) {
		return false;
	}
	const sharedAgent = stringValue(args.agent) ?? stringValue(args.agent_id) ?? stringValue(args.agentId);
	let tasks: unknown = args.tasks;
	if (typeof tasks === "string") {
		const raw = tasks.trim();
		if (raw.startsWith("[") || raw.startsWith("{")) {
			try {
				tasks = JSON.parse(raw) as unknown;
			} catch {
				// The dispatch tool will report malformed JSON; it is not a Scout task.
			}
		}
	}
	if (recordValue(tasks) !== null || typeof tasks === "string") tasks = [tasks];
	if (!Array.isArray(tasks) && stringValue(args.task) !== null) tasks = [{ task: args.task }];
	if (!Array.isArray(tasks) || tasks.length !== 1) return false;
	const task = tasks[0];
	if (typeof task === "string") return task.trim().length > 0 && sharedAgent?.toLowerCase() === SCOUT_AGENT_ID;
	const record = recordValue(task);
	if (!record || stringValue(record.task) === null) return false;
	const agent = stringValue(record.agent) ?? stringValue(record.agent_id) ?? stringValue(record.agentId) ?? sharedAgent;
	return agent?.toLowerCase() === SCOUT_AGENT_ID;
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

function isTargetedSourceRead(input: MiddlewareHookInput): boolean {
	const args = input.toolArgs;
	if (input.toolName !== ToolNames.Read) return false;
	const path = stringValue(args?.path) ?? stringValue(args?.file) ?? stringValue(args?.file_path);
	return path !== null && path !== "." && path !== "./" && !path.endsWith("/");
}

function isExplicitRouteGuardedCall(input: MiddlewareHookInput): boolean {
	// An explicit Scout-first turn never needs the main agent to drop into a
	// shell. Treat every bash shape as guarded, including nested wrappers such
	// as `bash -c 'ls ...'` that cannot be recognized safely with a first-token
	// allowlist.
	if (input.toolName === ToolNames.Bash) return true;
	return isReadOnlyExplorationCall(input);
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

function newExplorationTurnState(explicitBroadRequest = false): ExplorationTurnState {
	return {
		readOnlyCalls: 0,
		explicitBroadRequest,
		scoutAttemptPending: false,
		scoutSucceeded: false,
		scoutFailed: false,
		fallbackCallsRemaining: 0,
		spotCheckCallsRemaining: 0,
	};
}

function markScoutSuccess(state: ExplorationTurnState): void {
	state.scoutAttemptPending = false;
	if (state.scoutSucceeded) return;
	state.scoutSucceeded = true;
	state.scoutFailed = false;
	// Policy today is sealed synthesis: the limit is 0, so no post-Scout
	// spot-check reads are admitted. Raising the constant is the one knob.
	state.spotCheckCallsRemaining = SCOUT_EXPLORATION_SPOT_CHECK_CALL_LIMIT;
}

function markScoutFailure(state: ExplorationTurnState): void {
	state.scoutAttemptPending = false;
	if (state.scoutFailed) return;
	state.scoutFailed = true;
	// Policy today is report-not-replace: the limit is 0, so a failed Scout
	// never opens a manual fallback scan. Raising the constant is the one knob.
	state.fallbackCallsRemaining = SCOUT_EXPLORATION_FALLBACK_CALL_LIMIT;
}

/**
 * Proactively identifies explicit broad repository reconnaissance, reminds
 * the main agent to route it to Scout, and temporarily guards direct scanning.
 * Dispatch remains model-authored and passes through normal safety policy.
 * The legacy threshold nudge remains as a fallback for intent phrasing that
 * did not match at turn_start.
 */
export function createReadOnlyExplorationNudgeRegistration(
	options: CreateReadOnlyExplorationNudgeRegistrationOptions = {},
): MiddlewareHookRegistration {
	const byTurn = new Map<string, ExplorationTurnState>();
	let pendingTurn: PendingExplorationTurn | null = null;
	let continuationTurn: PendingExplorationTurn | null = null;
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
	const pendingMatches = (pending: PendingExplorationTurn, input: MiddlewareHookInput): boolean =>
		pending.sessionId === undefined || input.sessionId === undefined || pending.sessionId === input.sessionId;
	const stateForBeforeTool = (key: string, input: MiddlewareHookInput): ExplorationTurnState => {
		let state = byTurn.get(key);
		if (state) return state;
		if (pendingTurn !== null && pendingMatches(pendingTurn, input)) {
			state = pendingTurn.state;
			pendingTurn = null;
			return remember(key, state);
		}
		return remember(key, newExplorationTurnState());
	};
	const takeTurnEndState = (key: string, input: MiddlewareHookInput): ExplorationTurnState | null => {
		const bound = byTurn.get(key);
		byTurn.delete(key);
		if (bound) return bound;
		if (pendingTurn !== null && pendingMatches(pendingTurn, input)) {
			const state = pendingTurn.state;
			pendingTurn = null;
			return state;
		}
		return null;
	};
	const scoutIsRoutable = (): boolean => {
		if (!options.canRouteScout) return false;
		try {
			return options.canRouteScout(SCOUT_PREVIEW_TASK) === true;
		} catch {
			return false;
		}
	};
	return {
		id: READ_ONLY_EXPLORATION_NUDGE_REGISTRATION_ID,
		description: "route explicit broad repository exploration through Scout before direct scanning",
		hooks: ["turn_start", "before_tool", "after_tool", "turn_end"],
		evaluate(input: MiddlewareHookInput, context): ReadonlyArray<MiddlewareEffect> {
			if (input.hook === "turn_start") {
				pendingTurn = null;
				const requestContinuation = input.metadata?.requestContinuation === true;
				if (requestContinuation && continuationTurn !== null && pendingMatches(continuationTurn, input)) {
					if (hasActiveTool(input, ToolNames.Dispatch) && scoutIsRoutable()) {
						pendingTurn = continuationTurn;
						continuationTurn = null;
						return [{ kind: "require_tool", toolName: ToolNames.Dispatch }];
					}
					continuationTurn = null;
					return [];
				}
				continuationTurn = null;
				if (!hasActiveTool(input, ToolNames.Dispatch)) return [];
				if (!isExplicitBroadRepositoryExplorationRequest(input.text ?? "")) return [];
				if (!scoutIsRoutable()) return [];
				pendingTurn = {
					sessionId: input.sessionId,
					state: newExplorationTurnState(true),
				};
				return [
					{ kind: "inject_reminder", message: buildProactiveScoutRoutingMessage(), severity: "info" },
					{ kind: "require_tool", toolName: ToolNames.Dispatch },
				];
			}
			const key = turnKey(input);
			if (input.hook === "before_tool" || input.hook === "after_tool") {
				const state = stateForBeforeTool(key, input);
				if (input.toolName === ToolNames.Dispatch) {
					const targetsScout = dispatchTargetsScout(input.toolArgs);
					if (input.hook === "before_tool" && targetsScout) {
						const blockedByPriorGuard = context?.priorEffects.some((effect) => effect.kind === "block_tool") === true;
						if (
							blockedByPriorGuard ||
							(input.metadata?.decisionKind !== undefined && input.metadata.decisionKind !== "allow")
						) {
							markScoutFailure(state);
						} else {
							state.scoutAttemptPending = true;
						}
						return [];
					}
					if (input.hook === "after_tool" && targetsScout) {
						state.scoutAttemptPending = false;
						if (input.metadata?.resultKind === "ok") {
							markScoutSuccess(state);
							return state.explicitBroadRequest
								? [{ kind: "annotate_tool_result", message: buildScoutSuccessMessage(), severity: "info" }]
								: [];
						}
						markScoutFailure(state);
						return state.explicitBroadRequest
							? [{ kind: "annotate_tool_result", message: buildScoutFallbackMessage(), severity: "warn" }]
							: [];
					}
					if (input.hook === "after_tool" && state.explicitBroadRequest && !targetsScout) {
						return [
							{
								kind: "annotate_tool_result",
								message: "Listing agents or dispatching a non-Scout agent does not satisfy the Scout-first repository route.",
								severity: "info",
							},
						];
					}
					return [];
				}
				if (input.hook === "after_tool") {
					if (!state.explicitBroadRequest || !isTargetedSourceRead(input)) return [];
					if (!state.scoutSucceeded && !state.scoutFailed) return [];
					const remaining = state.scoutSucceeded ? state.spotCheckCallsRemaining : state.fallbackCallsRemaining;
					const message = buildScoutReadProgressMessage(remaining, state.scoutSucceeded);
					return remaining > 0
						? [
								{ kind: "annotate_tool_result", message, severity: "info" },
								{ kind: "require_tool", toolName: ToolNames.Read },
							]
						: [{ kind: "annotate_tool_result", message, severity: "info" }, { kind: "lock_tools" }];
				}
				if (state.explicitBroadRequest ? !isExplicitRouteGuardedCall(input) : !isReadOnlyExplorationCall(input)) {
					return [];
				}
				state.readOnlyCalls += 1;
				if (!state.explicitBroadRequest) return [];
				if (state.scoutSucceeded) {
					if (state.spotCheckCallsRemaining > 0 && isTargetedSourceRead(input)) {
						state.spotCheckCallsRemaining -= 1;
						return [];
					}
					return [{ kind: "block_tool", reason: buildScoutSuccessMessage(), severity: "hard-block" }];
				}
				if (state.scoutFailed) {
					if (state.fallbackCallsRemaining > 0 && isTargetedSourceRead(input)) {
						state.fallbackCallsRemaining -= 1;
						return [];
					}
					return [{ kind: "block_tool", reason: buildScoutFallbackMessage(), severity: "hard-block" }];
				}
				return [{ kind: "block_tool", reason: buildScoutFirstBlockReason(), severity: "hard-block" }];
			}
			if (input.hook !== "turn_end") return [];
			const state = takeTurnEndState(key, input);
			const stopReason = input.metadata?.stopReason;
			if (stopReason !== undefined && stopReason !== "stop") return [];
			if (!hasActiveTool(input, ToolNames.Dispatch)) return [];
			if (state?.explicitBroadRequest) {
				if (state.scoutSucceeded || state.scoutFailed) return [];
				if (state.scoutAttemptPending) {
					markScoutFailure(state);
					continuationTurn = { sessionId: input.sessionId, state };
					const message = buildScoutFallbackMessage();
					return [
						{ kind: "request_continuation", message },
						{ kind: "inject_reminder", message, severity: "warn" },
					];
				}
				continuationTurn = { sessionId: input.sessionId, state };
				const message = buildProactiveScoutRoutingMessage();
				return [
					{ kind: "request_continuation", message },
					{ kind: "inject_reminder", message, severity: "info" },
				];
			}
			if (
				!state ||
				state.scoutSucceeded ||
				state.scoutFailed ||
				state.readOnlyCalls < READ_ONLY_EXPLORATION_NUDGE_CALL_THRESHOLD
			) {
				return [];
			}
			const message = buildReadOnlyExplorationMessage();
			return [
				{ kind: "request_continuation", message },
				{ kind: "inject_reminder", message, severity: "info" },
			];
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
		`Collect each with monitor mode="collect" batch_id=<id> and act on the results. ` +
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
