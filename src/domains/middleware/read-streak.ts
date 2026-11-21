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
 *
 * Channels (X6). The first note rides the read that crossed the line, as a
 * tool-result note. The second and last notes, the answer note and the
 * standalone serial note are `inject_reminder` effects: the main session
 * delivers one at the tool-batch boundary as a host-framed user message,
 * the channel the weakest models answer.
 *
 * A writer worker (X3) has no turn_start report, so it passes its surface,
 * and it has its own host channel: the second step goes there once, in place
 * of the second and last notes.
 *
 * The decision gate (X7). On a turn that will be continued without an
 * operator, a streak that reaches {@link GATE_READS} with every note its
 * surface gets already delivered refuses read-class calls at before_tool,
 * with that surface's second-step text, until a call that resets the streak
 * succeeds. The second refused round hands the stall to the composition,
 * which ends the unattended run with the typed cause `exploration_stalled`.
 */

export const READ_STREAK_REGISTRATION_ID = "nudge.read-streak";

const FIRST_NOTE = 25;
const SECOND_NOTE = 40;
const LAST_NOTE = 60;
const SERIAL_ROUNDS = 4;
/** Reads at which the decision gate arms on an unattended turn whose notes are spent (X7, Q1). */
const GATE_READS = 80;
/** Refused rounds after which the gate hands the stall to the composition. */
const GATE_STALL_ROUNDS = 2;
/** A turn that cannot write (read-only, answer, proposal) is gated too, with its answer wording (X7, Q3). */
const GATE_TURNS_THAT_CANNOT_WRITE = true;
const STREAK_EVIDENCE = "count:read-class-calls@no-progress-streak";
/** The evidence class of the serial-round note, which settles on round width rather than on progress (3.4). */
export const READ_STREAK_SERIAL_EVIDENCE = "count:single-read-rounds@no-progress-streak";
/** The evidence class of a decision-gate refusal (X7): a block, settled as one, never a ladder note. */
export const READ_STREAK_GATE_EVIDENCE = "count:read-class-calls@decision-gate";
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
	/**
	 * Whether a call changed the workspace (`callChangesTree` in run-effects): the finish gate's reading, with a named
	 * write outside the workspace or in a scratch root changing nothing.
	 */
	changesTree(toolName: string, args: Record<string, unknown> | undefined, cwd: string): boolean;
}

/**
 * What the rule saw, reported to the outcome ledger so it settles the rule's notes and measures the turn from the
 * rule's own reading of each call instead of a second classifier (exploration design 3.4, X4). A `call` is one model
 * call the rule judged, with the streak after it and the rounds it added to a serial run; a `fold` is a compaction
 * that may have removed earlier results; a `handover` is a user message handed to the run mid-turn (a queued steer),
 * which starts a new streak as an operator turn does.
 */
export type ReadStreakStep =
	| {
			kind: "call";
			sessionId?: string;
			toolName: string;
			toolCallId?: string;
			effect: CallEffect;
			reads: number;
			/** Rounds this call added to a serial run: all of them when the run reaches its length, then one each. */
			serialRounds: number;
			/** The note this call carries, if any. */
			note: "ladder" | "serial" | null;
	  }
	| { kind: "fold"; sessionId?: string }
	| { kind: "handover"; sessionId?: string };

export interface ReadStreakObserver {
	observeReadStreak(step: ReadStreakStep): void;
}

interface TurnSurface {
	canWrite: boolean;
	canPlan: boolean;
	canAsk: boolean;
}

interface StreakState {
	sessionId: string | undefined;
	/** The user turn the streak runs under, from turn_start; a tool hook naming another one ran after a handover. */
	userTurnId: string | undefined;
	reads: number;
	serial: number;
	serialNoted: boolean;
	folded: boolean;
	surface: TurnSurface;
	/** The gateway chain running now: its steps reach after_tool one by one, each with the outer call's batch size. */
	chain: { id: string | undefined; steps: number } | null;
	/** Ladder notes delivered in this streak, the worker's second step included. */
	notes: number;
	/** Rounds the gate refused in this streak, and the batch of the latest one. */
	refusedRounds: number;
	refusedBatch: string | undefined;
	/** The stall was handed over; once per streak. */
	stalled: boolean;
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

/** A note for the model alone, delivered at the tool-batch boundary as a host message where the session has one. */
function hostNote(message: string): MiddlewareEffect {
	return { kind: "inject_reminder", message, severity: "info", audience: "model" };
}

type CallEffect = "read" | "progress" | "other";

/** How many ladder notes a surface gets: three for a main writer, two for a worker writer, one answer note otherwise. */
function ladderNotes(surface: TurnSurface, secondStep: boolean): number {
	return !surface.canWrite ? 1 : secondStep ? 2 : 3;
}

export function createReadStreakRegistration(deps: {
	observer?: ReadStreakObserver;
	classifiers: ReadStreakClassifiers;
	workspaceRoot?: () => string;
	/** What a run that reports no turn_start can do; absent reads as a writer that can plan and ask. */
	surface?: TurnSurface;
	/** A host channel of the run's own: it takes the second step, once per streak, and no ladder note follows it. */
	secondStep?: (count: number) => void;
	/** Called whenever the streak starts over, so a host holding the second step can drop it. */
	onReset?: () => void;
	/**
	 * The decision gate's stop (X7): called once per streak when the gate refused its second round. Without it the
	 * gate never arms. `detail` is one clause naming the streak for the run's closing notice.
	 */
	stall?: (detail: string) => void;
	/** The run is never continued by an operator (a worker); otherwise the tool hook's `turnBudgetContinues` decides. */
	unattended?: boolean;
}): MiddlewareHookRegistration & { resetStreak(): void } {
	const state: StreakState = {
		sessionId: undefined,
		userTurnId: undefined,
		reads: 0,
		serial: 0,
		serialNoted: false,
		folded: false,
		surface: deps.surface ?? WRITER,
		chain: null,
		notes: 0,
		refusedRounds: 0,
		refusedBatch: undefined,
		stalled: false,
	};
	const reset = (): void => {
		state.reads = 0;
		state.serial = 0;
		state.serialNoted = false;
		state.folded = false;
		state.notes = 0;
		state.refusedRounds = 0;
		state.refusedBatch = undefined;
		state.stalled = false;
		deps.onReset?.();
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
		const root = deps.workspaceRoot?.() ?? process.cwd();
		// A write outside the workspace or in a scratch root is not the edit the note asks for.
		if (call.toolName === ToolNames.Edit || call.toolName === ToolNames.Write)
			return input.toolResultDetails?.unchanged !== true && deps.classifiers.changesTree(call.toolName, call.args, root)
				? "progress"
				: "other";
		// Only a declared read-only extension tool is a read here; an idempotent one may still write.
		const readOnly = input.metadata?.toolReadOnly;
		const declared = typeof readOnly === "boolean" ? { readOnly } : {};
		if (deps.classifiers.repeatsAsRead(name, input.toolArgs, () => declared)) return "read";
		// Typed git reads as a read only for its inspection ops, so any other op that succeeded (add, commit) is progress.
		if (call.toolName === ToolNames.Git) return "progress";
		if (call.toolName === ToolNames.Bash) {
			if (deps.classifiers.changesTree(call.toolName, call.args, root)) return "progress";
		}
		return "other";
	};

	/** The note the call being judged now carries. */
	let noted: "ladder" | "serial" | null = null;
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
		if (deps.secondStep !== undefined && surface.canWrite && state.reads >= SECOND_NOTE) {
			if (state.reads === SECOND_NOTE) {
				context?.evidence?.(STREAK_EVIDENCE);
				state.notes += 1;
				deps.secondStep(state.reads);
			}
			return NONE;
		}
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
			state.notes += 1;
			noted = "ladder";
			return [
				state.reads === FIRST_NOTE ? { kind: "annotate_tool_result", message, severity: "info" } : hostNote(message),
			];
		}
		if (surface.canWrite && state.serial === SERIAL_ROUNDS && !state.serialNoted) {
			state.serialNoted = true;
			context?.evidence?.(READ_STREAK_SERIAL_EVIDENCE);
			noted = "serial";
			return [hostNote(serialNote(state.serial))];
		}
		return NONE;
	};

	/**
	 * The decision gate at before_tool (X7): a read-class call of an unattended turn whose streak reached the gate with
	 * its surface's notes spent is refused with the second-step text. The second refused round hands over the stall.
	 */
	const gate = (input: MiddlewareHookInput, context?: MiddlewareHookEvaluationContext): MiddlewareEffect | null => {
		const stall = deps.stall;
		if (stall === undefined || state.reads < GATE_READS) return null;
		const surface = state.surface;
		if (!surface.canWrite && !GATE_TURNS_THAT_CANNOT_WRITE) return null;
		if (state.notes < ladderNotes(surface, deps.secondStep !== undefined)) return null;
		if (deps.unattended !== true && input.metadata?.turnBudgetContinues !== true) return null;
		if (input.metadata?.nested === true || input.metadata?.origin === "harness" || outerChain(input)) return null;
		if (classify(input) !== "read") return null;
		const batch = input.correlationId ?? input.toolCallId;
		if (batch === undefined || batch !== state.refusedBatch) {
			state.refusedRounds += 1;
			state.refusedBatch = batch;
		}
		context?.evidence?.(READ_STREAK_GATE_EVIDENCE);
		if (state.refusedRounds >= GATE_STALL_ROUNDS && !state.stalled) {
			state.stalled = true;
			stall(`${state.reads} read-only calls in a row with no edit, plan or question after every note`);
		}
		const reason = surface.canWrite ? secondNote(state.reads, surface, state.folded) : answerNote(state.reads);
		return { kind: "block_tool", reason, severity: "hard-block" };
	};

	return {
		id: READ_STREAK_REGISTRATION_ID,
		// A run with no turn_start report (a worker) starts the streak over here when its operator steers it.
		resetStreak: reset,
		description: "ask for a decision after a long run of read-only calls with no edit, plan or question",
		hooks: ["turn_start", "before_tool", "after_tool", "on_compaction"],
		evidence: STREAK_EVIDENCE,
		settles: true,
		evaluate(input, context): ReadonlyArray<MiddlewareEffect> {
			followSession(input.sessionId);
			if (input.hook === "turn_start") {
				state.chain = null;
				// A turn that starts after a stall got past the halt it raised, so the operator resumed: a fresh streak.
				if (operatorTurnStart(input) || state.stalled) reset();
				state.surface = turnSurface(input);
				const userTurnId = input.metadata?.userTurnId;
				state.userTurnId = typeof userTurnId === "string" ? userTurnId : undefined;
				return NONE;
			}
			if (input.hook === "on_compaction") {
				const stage = input.metadata?.stage;
				if (typeof stage !== "string" || !NON_FOLD_STAGES.has(stage)) {
					state.folded = true;
					deps.observer?.observeReadStreak({
						kind: "fold",
						...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
					});
				}
				return NONE;
			}
			// A user message handed to the run mid-turn files its own user turn with no turn_start: a new streak starts.
			if (
				state.userTurnId !== undefined &&
				input.turnId !== undefined &&
				input.turnId !== state.userTurnId &&
				input.metadata?.origin !== "harness"
			) {
				state.userTurnId = input.turnId;
				reset();
				deps.observer?.observeReadStreak({
					kind: "handover",
					...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
				});
			}
			if (input.hook === "before_tool") {
				if (outerChain(input)) {
					const steps = input.toolArgs?.steps;
					state.chain = { id: input.toolCallId, steps: Array.isArray(steps) ? Math.max(steps.length, 1) : 1 };
				}
				const refusal = gate(input, context);
				return refusal === null ? NONE : [refusal];
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
			let effects = NONE;
			noted = null;
			const serialBefore = state.serial;
			if (effect === "progress") reset();
			else if (effect === "other") state.serial = 0;
			else effects = afterRead(input, context);
			// A single-read round adds to the serial run: all of its rounds when it reaches its length, then one each.
			const serialRounds =
				state.serial !== serialBefore + 1
					? 0
					: state.serial === SERIAL_ROUNDS
						? SERIAL_ROUNDS
						: state.serial > SERIAL_ROUNDS
							? 1
							: 0;
			deps.observer?.observeReadStreak({
				kind: "call",
				...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
				toolName: effectiveToolCall(input.toolName, input.toolArgs).toolName,
				...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
				effect,
				reads: state.reads,
				serialRounds,
				note: noted,
			});
			return effects;
		},
	};
}
