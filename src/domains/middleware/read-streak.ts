import { ToolNames } from "../../core/tool-names.js";
import { effectiveToolCall } from "../../tools/surface.js";
import type { MiddlewareHookEvaluationContext, MiddlewareHookRegistration } from "./runtime.js";
import { type MiddlewareEffect, type MiddlewareHookInput, metadataNumber, turnCanCallTool } from "./types.js";

/**
 * No-progress read streak (exploration design 3.1-3.3, X2).
 *
 * Between the loop guard's identical-call rule and the autonomy cap nothing
 * watched a main agent that keeps reading different things without deciding.
 * This rule counts read-class calls since the last progress event: a workspace
 * change, a plan update, a question, a started delegation or a declaration.
 * At {@link FIRST_NOTE} reads it asks, on the read that crossed the line, for
 * a one-line state of knowledge and a decision; at {@link SECOND_NOTE} and
 * {@link LAST_NOTE} it asks for the smallest defensible edit, a plan or a
 * plain stop. A turn that cannot write gets one answer-worded note at
 * {@link SECOND_NOTE}, since reading is the product there.
 *
 * A second counter follows serial rounds: rounds whose whole batch is one
 * read-class call. At {@link SERIAL_ROUNDS} in a row one note asks for
 * batched reads, once per streak; when a ladder note fires during such a run
 * the batching sentence rides on it instead.
 *
 * Typed signals only: tool names, the read classifier the loop guard uses,
 * the finish gate's tree-change reading for bash, result kind, batch size,
 * turn origin and the turn's tools and mode. The steps of one gateway chain
 * are one round as wide as the chain. The streak is kept
 * per session, so a continuation or a budget roll neither resets nor double
 * counts it; an operator's own turn and a session change reset it. Both
 * classifiers are passed in, so this domain imports no engine module.
 */

export const READ_STREAK_REGISTRATION_ID = "nudge.read-streak";

const FIRST_NOTE = 25;
const SECOND_NOTE = 40;
const LAST_NOTE = 60;
const SERIAL_ROUNDS = 4;
const STREAK_EVIDENCE = "count:read-class-calls@no-progress-streak";
const SERIAL_EVIDENCE = "count:single-read-rounds@no-progress-streak";
const BATCH_SENTENCE = "Send the reads and searches you already know you need together in one round.";
/** Compaction stages that may remove tool results from the request; a recall restores them instead. */
const NON_FOLD_STAGES: ReadonlySet<string> = new Set(["working_set_recall"]);
/**
 * Tools whose successful call is progress, judged as the capability a gateway call runs: a plan, a question, a
 * declaration or a recorded decision, a delivered artifact, or a script run.
 */
const PROGRESS_TOOLS: ReadonlySet<string> = new Set([
	ToolNames.Tasks,
	ToolNames.AskUser,
	ToolNames.Finish,
	ToolNames.Limitation,
	ToolNames.Decide,
	ToolNames.Artifact,
	ToolNames.RunScript,
]);
const NONE: ReadonlyArray<MiddlewareEffect> = [];

/** The two classifiers the rule reads, supplied by the composition that owns them. */
export interface ReadStreakClassifiers {
	/** The loop guard's read class (`callRepeatsAsRead`): builtin reads, typed git inspection, read-only bash. */
	repeatsAsRead(
		toolName: string,
		args: unknown,
		declared: (tool: string) => { readOnly?: boolean; idempotent?: boolean } | undefined,
	): boolean;
	/** The finish gate's reading of whether a bash call changed the workspace (`callChangesTree`). */
	changesTree(toolName: string, args: Record<string, unknown> | undefined, cwd: string): boolean;
}

interface TurnSurface {
	canWrite: boolean;
	canPlan: boolean;
	canAsk: boolean;
}

interface StreakState {
	sessionId: string | undefined;
	reads: number;
	serial: number;
	serialNoted: boolean;
	folded: boolean;
	surface: TurnSurface;
	/** The gateway chain running now: its steps reach after_tool one by one, each with the outer call's batch size. */
	chain: { id: string | undefined; steps: number } | null;
}

const WRITER: TurnSurface = { canWrite: true, canPlan: true, canAsk: true };

function joinChoices(items: ReadonlyArray<string>, serialComma: boolean): string {
	if (items.length <= 1) return items[0] ?? "";
	const head = items.slice(0, -1).join(", ");
	return `${head}${serialComma && items.length > 2 ? "," : ""} or ${items[items.length - 1]}`;
}

function progressNouns(surface: TurnSurface): string {
	return joinChoices(
		["edit", ...(surface.canPlan ? ["plan update"] : []), ...(surface.canAsk ? ["question"] : [])],
		false,
	);
}

function firstNote(count: number, surface: TurnSurface): string {
	const actions = [
		"make the edit",
		...(surface.canPlan ? ["record the plan with tasks"] : []),
		...(surface.canAsk ? ["ask the one question that blocks you"] : []),
	];
	return (
		`[CLIO Coder] ${count} read-only calls in a row with no ${progressNouns(surface)}. ` +
		"Write one line: what you now know, and what is still unknown. " +
		`Then act on it: ${joinChoices(actions, true)}. ` +
		"Read further only if you can name the decision the next read settles."
	);
}

function secondNote(count: number, surface: TurnSurface, folded: boolean): string {
	const actions = [
		"Make the smallest edit you can defend now",
		...(surface.canPlan ? ["record the plan with tasks"] : []),
		"state plainly what blocks you and stop",
	];
	return (
		`[CLIO Coder] ${count} read-only calls in a row and still no ${progressNouns(surface)}. ` +
		// After a fold the earlier results may be gone from the request, so the note does not point back at them.
		(folded ? "" : "The earlier reads are still in this conversation; reading them again adds nothing. ") +
		`${joinChoices(actions, true)}.`
	);
}

function answerNote(count: number): string {
	return `[CLIO Coder] ${count} read-only calls in a row. Answer from what you have now, or name the one question the next reads settle.`;
}

function serialNote(rounds: number): string {
	return `[CLIO Coder] The last ${rounds} rounds each made a single read. Every round resends the whole conversation. ${BATCH_SENTENCE}`;
}

/** What the turn that starts can do, from the host's turn_start report; a host that reports nothing reads as a writer. */
function turnSurface(input: MiddlewareHookInput): TurnSurface {
	const mode = input.metadata?.turnMode;
	const scopedAway = input.metadata?.turnReadOnly === true || mode === "answer" || mode === "proposal";
	return {
		canWrite: !scopedAway && (turnCanCallTool(input, ToolNames.Edit) || turnCanCallTool(input, ToolNames.Write)),
		canPlan: turnCanCallTool(input, ToolNames.Tasks),
		canAsk: turnCanCallTool(input, ToolNames.AskUser),
	};
}

/** An operator's own new turn; a continuation, a resumed request or a job keeps the streak. */
function operatorTurnStart(input: MiddlewareHookInput): boolean {
	if (input.metadata?.requestContinuation === true) return false;
	const origin = input.metadata?.turnOrigin;
	return origin === undefined || origin === "operator";
}

/** The model's own gateway chain call, not one a gateway call nests or the harness makes. */
function outerChain(input: MiddlewareHookInput): boolean {
	return (
		input.toolName === ToolNames.Gateway &&
		input.toolArgs?.op === "chain" &&
		input.metadata?.nested !== true &&
		input.metadata?.origin !== "harness"
	);
}

type CallEffect = "read" | "progress" | "other";

export function createReadStreakRegistration(deps: {
	classifiers: ReadStreakClassifiers;
	workspaceRoot?: () => string;
}): MiddlewareHookRegistration {
	const state: StreakState = {
		sessionId: undefined,
		reads: 0,
		serial: 0,
		serialNoted: false,
		folded: false,
		surface: WRITER,
		chain: null,
	};
	const reset = (): void => {
		state.reads = 0;
		state.serial = 0;
		state.serialNoted = false;
		state.folded = false;
	};
	const followSession = (sessionId: string | undefined): void => {
		if (sessionId === undefined || sessionId === state.sessionId) return;
		if (state.sessionId !== undefined) reset();
		state.sessionId = sessionId;
	};

	const classify = (input: MiddlewareHookInput): CallEffect => {
		const name = input.toolName ?? "";
		const call = effectiveToolCall(name, input.toolArgs);
		if (PROGRESS_TOOLS.has(call.toolName)) {
			// Listing the board reads it; any other action records the plan.
			return call.toolName === ToolNames.Tasks && call.args?.action === "list" ? "other" : "progress";
		}
		if (call.toolName === ToolNames.Dispatch) return call.args?.list === true ? "other" : "progress";
		if (call.toolName === ToolNames.Edit || call.toolName === ToolNames.Write)
			return input.toolResultDetails?.unchanged === true ? "other" : "progress";
		// Only a declared read-only extension tool is a read here; an idempotent one may still write.
		const readOnly = input.metadata?.toolReadOnly;
		const declared = typeof readOnly === "boolean" ? { readOnly } : {};
		if (deps.classifiers.repeatsAsRead(name, input.toolArgs, () => declared)) return "read";
		// Typed git reads as a read only for its inspection ops, so any other op that succeeded (add, commit) is progress.
		if (call.toolName === ToolNames.Git) return "progress";
		if (call.toolName === ToolNames.Bash) {
			const root = deps.workspaceRoot?.() ?? process.cwd();
			if (deps.classifiers.changesTree(call.toolName, call.args, root)) return "progress";
		}
		return "other";
	};

	const afterRead = (
		input: MiddlewareHookInput,
		context?: MiddlewareHookEvaluationContext,
	): ReadonlyArray<MiddlewareEffect> => {
		state.reads += 1;
		// A chain step carries the outer call's batch size; the chain is one round as wide as its steps.
		const reported = metadataNumber(input, "batchSize");
		const batch = state.chain === null ? reported : Math.max(reported ?? 0, state.chain.steps);
		if (batch === 1) state.serial += 1;
		else if (batch !== null && batch > 1) state.serial = 0;
		const surface = state.surface;
		const serialRun = state.serial >= SERIAL_ROUNDS;
		let message: string | null = null;
		if (surface.canWrite) {
			if (state.reads === FIRST_NOTE) message = firstNote(state.reads, surface);
			else if (state.reads === SECOND_NOTE || state.reads === LAST_NOTE)
				message = secondNote(state.reads, surface, state.folded);
		} else if (state.reads === SECOND_NOTE) message = answerNote(state.reads);
		if (message !== null) {
			// The batching sentence rides once per streak, on a writer's note, in place of the standalone serial note.
			if (surface.canWrite && serialRun && !state.serialNoted) {
				message = `${message} ${BATCH_SENTENCE}`;
				state.serialNoted = true;
			}
			context?.evidence?.(STREAK_EVIDENCE);
			return [{ kind: "annotate_tool_result", message, severity: "info" }];
		}
		if (surface.canWrite && state.serial === SERIAL_ROUNDS && !state.serialNoted) {
			state.serialNoted = true;
			context?.evidence?.(SERIAL_EVIDENCE);
			return [{ kind: "annotate_tool_result", message: serialNote(state.serial), severity: "info" }];
		}
		return NONE;
	};

	return {
		id: READ_STREAK_REGISTRATION_ID,
		description: "ask for a decision after a long run of read-only calls with no edit, plan or question",
		hooks: ["turn_start", "before_tool", "after_tool", "on_compaction"],
		evidence: STREAK_EVIDENCE,
		evaluate(input, context): ReadonlyArray<MiddlewareEffect> {
			followSession(input.sessionId);
			if (input.hook === "turn_start") {
				state.chain = null;
				if (operatorTurnStart(input)) reset();
				state.surface = turnSurface(input);
				return NONE;
			}
			if (input.hook === "on_compaction") {
				const stage = input.metadata?.stage;
				if (typeof stage !== "string" || !NON_FOLD_STAGES.has(stage)) state.folded = true;
				return NONE;
			}
			if (input.hook === "before_tool") {
				if (outerChain(input)) {
					const steps = input.toolArgs?.steps;
					state.chain = { id: input.toolCallId, steps: Array.isArray(steps) ? Math.max(steps.length, 1) : 1 };
				}
				return NONE;
			}
			if (input.hook !== "after_tool" || input.toolName === undefined) return NONE;
			// The chain's own result closes its round; its steps were already judged one by one.
			if (outerChain(input) && (state.chain === null || state.chain.id === input.toolCallId)) {
				state.chain = null;
				return NONE;
			}
			// A gateway call is judged once, as the capability it runs; harness calls are not the model's.
			if (input.metadata?.nested === true || input.metadata?.origin === "harness") return NONE;
			if (input.metadata?.resultKind !== "ok") return NONE;
			const effect = classify(input);
			if (effect === "progress") {
				reset();
				return NONE;
			}
			if (effect === "other") {
				state.serial = 0;
				return NONE;
			}
			return afterRead(input, context);
		},
	};
}
