import type { TokenSplit } from "../../core/token-split.js";
import type { WorkflowDecision } from "./decide.js";

export interface TurnOutcomeRecord {
	readonly version: 1;
	readonly turnId: string; // the user turn id that started the turn
	readonly turnIndex: number; // operator turns before this one in the session
	readonly control: {
		producer: "decision-site" | "main-model" | null;
		decision: WorkflowDecision["kind"];
		decisionHash: string | null;
		executed: boolean;
	} | null;
	readonly coordinator: {
		readonly toolCalls: number;
		readonly byTool: Readonly<Record<string, number>>;
		readonly readOnlyCallsBeforeFirstDispatch: number;
		readonly dispatches: ReadonlyArray<{ mode: string; agentIds: ReadonlyArray<string>; runIds: ReadonlyArray<string> }>;
		readonly duplicateDispatch: boolean;
	};
	readonly harness: { readonly runIds: ReadonlyArray<string>; readonly reads: number };
	readonly conversation: {
		readonly endedWithQuestion: boolean;
		readonly offeredOptions: boolean;
		readonly taskEstablished: boolean;
		readonly clarificationStreak: number;
	};
	readonly completion: {
		readonly decision: "ok" | "engage" | "not-assessed";
		readonly mutatedPaths: number;
		readonly evidenceKinds: ReadonlyArray<string>;
	};
	readonly operator: { readonly canceled: boolean };
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
	readonly toolNames: ReadonlyArray<string>;
	readonly readOnlyCallsBeforeFirstDispatch: number;
	readonly dispatches: TurnOutcomeRecord["coordinator"]["dispatches"];
	readonly duplicateDispatch: boolean;
	readonly harness: TurnOutcomeRecord["harness"];
	readonly finalAssistantText: string;
	readonly taskEstablished: boolean;
	readonly previousClarificationStreak: number;
	readonly completion: TurnOutcomeRecord["completion"];
	readonly canceled: boolean;
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

export function nextClarificationStreak(
	previous: number,
	turn: { toolCalls: number; endedWithQuestion: boolean; offeredOptions: boolean },
): number {
	return turn.toolCalls === 0 && (turn.endedWithQuestion || turn.offeredOptions) ? previous + 1 : 0;
}

export function reduceTurnOutcome(input: TurnOutcomeInput): TurnOutcomeRecord {
	const byTool: Record<string, number> = Object.create(null);
	for (const tool of input.toolNames) byTool[tool] = (byTool[tool] ?? 0) + 1;
	const shape = conversationShape(input.finalAssistantText);
	return {
		version: 1,
		turnId: input.turnId,
		turnIndex: input.turnIndex,
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
			taskEstablished: input.taskEstablished,
			clarificationStreak: nextClarificationStreak(input.previousClarificationStreak, {
				toolCalls: input.toolNames.length,
				...shape,
			}),
		},
		completion: { ...input.completion, evidenceKinds: [...input.completion.evidenceKinds] },
		operator: { canceled: input.canceled },
		tokens: {
			coordinator: { ...input.tokens.coordinator },
			decisionModel: { ...input.tokens.decisionModel },
			workers: { ...input.tokens.workers },
		},
		stopReason: input.stopReason,
		durationMs: input.durationMs,
	};
}
