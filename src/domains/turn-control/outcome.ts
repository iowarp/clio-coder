import type { TokenSplit } from "../../core/token-split.js";
import type { WorkflowDecision } from "./decide.js";

export interface TurnOutcomeRecord {
	readonly version: 1;
	readonly turnId: string; // the user turn id that started the turn
	readonly turnIndex: number; // operator turns before this one in the session
	/** True for the automatic follow-up a middleware nudge requested, which is not an operator turn. */
	readonly continuation: boolean;
	readonly control: {
		producer: "system-one" | null;
		decision: WorkflowDecision["kind"];
		decisionHash: string | null;
		executed: boolean;
	} | null;
	readonly coordinator: {
		readonly toolCalls: number;
		readonly byTool: Readonly<Record<string, number>>;
		readonly readOnlyCallsBeforeFirstDispatch: number;
		/** Every dispatch that launched runs; `failed` marks one whose result was an error or an abort. */
		readonly dispatches: ReadonlyArray<{
			mode: string;
			agentIds: ReadonlyArray<string>;
			runIds: ReadonlyArray<string>;
			failed?: true;
		}>;
		readonly duplicateDispatch: boolean;
	};
	readonly harness: { readonly runIds: ReadonlyArray<string>; readonly reads: number };
	readonly conversation: {
		/** Regex facts about the closing text, kept so the dataset can compare them with the site's reading. */
		readonly endedWithQuestion: boolean;
		readonly offeredOptions: boolean;
		/** The turn-end site's reading of whether the message waits on the operator, or null when it did not answer. */
		readonly asksOperator: boolean | null;
		readonly taskEstablished: boolean;
		readonly clarificationStreak: number;
	};
	readonly completion: {
		readonly decision: "ok" | "engage" | "not-assessed";
		readonly mutatedPaths: number;
		readonly evidenceKinds: ReadonlyArray<string>;
	};
	readonly operator: {
		readonly canceled: boolean;
		/** Present with `canceled` when the cancel was a dismissed ask_user interview rather than an aborted stream. */
		readonly interviewDismissed?: true;
	};
	readonly tokens: {
		readonly coordinator: TokenSplit;
		readonly decisionModel: TokenSplit;
		readonly workers: TokenSplit;
	};
	readonly stopReason: string;
	readonly durationMs: number;
}

export interface TurnOutcomeInput {
	readonly control?: TurnOutcomeRecord["control"];
	readonly turnId: string;
	readonly turnIndex: number;
	readonly continuation: boolean;
	readonly toolNames: ReadonlyArray<string>;
	readonly readOnlyCallsBeforeFirstDispatch: number;
	readonly dispatches: TurnOutcomeRecord["coordinator"]["dispatches"];
	readonly duplicateDispatch: boolean;
	readonly harness: TurnOutcomeRecord["harness"];
	readonly finalAssistantText: string;
	/** The turn-end site's verdict on whether the message waits on the operator; null falls back to the regex reading. */
	readonly asksOperator?: boolean | null;
	readonly taskEstablished: boolean;
	readonly previousClarificationStreak: number;
	readonly completion: TurnOutcomeRecord["completion"];
	readonly canceled: boolean;
	/**
	 * The operator dismissed an ask_user interview, which ends the turn on their
	 * say-so. It counts toward the clarification streak and is recorded as an
	 * operator cancel, the same as an Esc that aborts a stream.
	 */
	readonly interviewDismissed?: boolean;
	readonly tokens: TurnOutcomeRecord["tokens"];
	readonly stopReason: string;
	readonly durationMs: number;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function dispatchKeysFromArgs(
	args: Readonly<Record<string, unknown>> | undefined,
): ReadonlyArray<{ agentId: string; task: string }> {
	if (
		!args ||
		args.list === true ||
		args.from_scout !== undefined ||
		args.apply_winner !== undefined ||
		(args.review !== undefined && args.review !== false)
	)
		return [];
	const entries = Array.isArray(args.tasks) ? args.tasks : typeof args.task === "string" ? [{ task: args.task }] : [];
	const sharedAgent =
		typeof args.agent === "string" ? args.agent : typeof args.agent_id === "string" ? args.agent_id : "coder";
	return entries.flatMap((entry: unknown) => {
		const task = typeof entry === "string" ? entry : record(entry) ? entry.task : undefined;
		if (typeof task !== "string" || task.trim().length === 0) return [];
		const agentId =
			record(entry) && typeof entry.agent === "string"
				? entry.agent
				: record(entry) && typeof entry.agent_id === "string"
					? entry.agent_id
					: sharedAgent;
		return [{ agentId, task: task.trim().replace(/\s+/g, " ").toLowerCase() }];
	});
}

export function conversationShape(finalAssistantText: string): { endedWithQuestion: boolean; offeredOptions: boolean } {
	return {
		endedWithQuestion: finalAssistantText.trim().endsWith("?"),
		offeredOptions: finalAssistantText.split(/\r?\n/).filter((line) => /^(?:- |\* |\d+[.)])/.test(line)).length >= 2,
	};
}

/**
 * How many consecutive turns ended waiting on the operator. Two endings count.
 * One is a closing question or option list with no tool call, where `asks` is
 * the caller's reading of the text: the turn-end site's verdict when one
 * answered, otherwise the regex shape. The other is an ask_user interview the
 * operator dismissed. A clarification that goes through ask_user always has a
 * tool call, so the first test can never see it; an interview the operator
 * answered is progress and resets the streak like any other tool turn.
 */
export function nextClarificationStreak(
	previous: number,
	turn: { toolCalls: number; asks: boolean; interviewDismissed?: boolean },
): number {
	if (turn.interviewDismissed === true) return previous + 1;
	return turn.toolCalls === 0 && turn.asks ? previous + 1 : 0;
}

export function reduceTurnOutcome(input: TurnOutcomeInput): TurnOutcomeRecord {
	const byTool: Record<string, number> = Object.create(null);
	for (const tool of input.toolNames) byTool[tool] = (byTool[tool] ?? 0) + 1;
	const shape = conversationShape(input.finalAssistantText);
	const asksOperator = input.asksOperator ?? null;
	const interviewDismissed = input.interviewDismissed === true;
	return {
		version: 1,
		turnId: input.turnId,
		turnIndex: input.turnIndex,
		continuation: input.continuation,
		control: input.control ?? null,
		coordinator: {
			toolCalls: input.toolNames.length,
			byTool: { ...byTool },
			readOnlyCallsBeforeFirstDispatch: input.readOnlyCallsBeforeFirstDispatch,
			dispatches: input.dispatches.map((dispatch) => ({
				...dispatch,
				agentIds: [...dispatch.agentIds],
				runIds: [...dispatch.runIds],
			})),
			duplicateDispatch: input.duplicateDispatch,
		},
		harness: { runIds: [...input.harness.runIds], reads: input.harness.reads },
		conversation: {
			...shape,
			asksOperator,
			taskEstablished: input.taskEstablished,
			clarificationStreak: nextClarificationStreak(input.previousClarificationStreak, {
				toolCalls: input.toolNames.length,
				asks: asksOperator ?? (shape.endedWithQuestion || shape.offeredOptions),
				interviewDismissed,
			}),
		},
		completion: { ...input.completion, evidenceKinds: [...input.completion.evidenceKinds] },
		operator: { canceled: input.canceled || interviewDismissed, ...(interviewDismissed ? { interviewDismissed } : {}) },
		tokens: {
			coordinator: { ...input.tokens.coordinator },
			decisionModel: { ...input.tokens.decisionModel },
			workers: { ...input.tokens.workers },
		},
		stopReason: input.stopReason,
		durationMs: input.durationMs,
	};
}
