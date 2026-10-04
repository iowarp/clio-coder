import { isReadOnlyCall } from "../core/read-only-calls.js";
import { ToolNames } from "../core/tool-names.js";
import type { MiddlewareHookInput, MiddlewareHookRegistration } from "../domains/middleware/index.js";
import type { TurnControlRecord, TurnOutcomeRecord } from "../domains/turn-control/index.js";
import { dispatchKeysFromArgs } from "../domains/turn-control/index.js";
import { effectiveToolCall } from "../tools/surface.js";

export interface CollectedTurn {
	readonly control: TurnOutcomeRecord["control"];
	readonly toolNames: ReadonlyArray<string>;
	readonly readOnlyCallsBeforeFirstDispatch: number;
	readonly dispatches: TurnOutcomeRecord["coordinator"]["dispatches"];
	readonly duplicateDispatch: boolean;
	readonly harness: TurnOutcomeRecord["harness"];
	readonly completion: TurnOutcomeRecord["completion"];
	readonly previousClarificationStreak: number;
}

export interface TurnOutcomeCollector extends MiddlewareHookRegistration {
	take(userTurnId: string): CollectedTurn;
	recordCompletion(
		turnId: string | null,
		decision: "ok" | "engage",
		mutatedPaths: number,
		evidenceKinds: ReadonlyArray<string>,
	): void;
	seedClarificationStreak(value: number): void;
	clarificationStreak(): number;
	recordControl(record: TurnControlRecord): void;
}

function emptyTurn(previousClarificationStreak: number): CollectedTurn {
	return {
		control: null,
		toolNames: [],
		readOnlyCallsBeforeFirstDispatch: 0,
		dispatches: [],
		duplicateDispatch: false,
		harness: { runIds: [], reads: 0 },
		completion: { decision: "not-assessed", mutatedPaths: 0, evidenceKinds: [] },
		previousClarificationStreak,
	};
}

function dispatchRuns(details: MiddlewareHookInput["toolResultDetails"]): { agentIds: string[]; runIds: string[] } {
	const runs = Array.isArray(details?.runs) ? details.runs : [];
	return {
		agentIds: runs.flatMap((run: unknown) =>
			run !== null && typeof run === "object" && "agentId" in run && typeof run.agentId === "string" ? [run.agentId] : [],
		),
		runIds: runs.flatMap((run: unknown) =>
			typeof run === "string"
				? [run]
				: run !== null && typeof run === "object" && "runId" in run && typeof run.runId === "string"
					? [run.runId]
					: [],
		),
	};
}

/** `dispatch {list:true}` reads the fleet roster and launches nothing, so it is not a dispatch. */
function isDispatchListing(args: Readonly<Record<string, unknown>> | undefined): boolean {
	return args?.list === true;
}

export function createTurnOutcomeCollector(): TurnOutcomeCollector {
	let previousClarificationStreak = 0;
	let active = emptyTurn(0);
	let userTurnId: string | null = null;
	let assistantTurnId: string | null = null;
	let sessionId: string | undefined;
	let dispatched = false;
	const succeededKeys = new Set<string>();
	const harnessReads = new Map<string, number>();
	return {
		id: "observer.turn-outcome",
		description: "collect host facts for the operator turn without steering it",
		hooks: ["turn_start", "before_tool", "after_tool", "turn_end"],
		clarificationStreak: () => previousClarificationStreak,
		recordControl(record) {
			userTurnId = record.turnId;
			// A refused act may still have started workers (a cancel during orientation
			// aborts a Scout that already spent tokens); those runs belong to the turn.
			const runIds =
				record.executed === null
					? []
					: "runIds" in record.executed
						? record.executed.runIds
						: (record.executed.startedRunIds ?? []);
			active = {
				...active,
				control: {
					producer: record.producer,
					decision: record.decision.kind,
					decisionHash: record.decisionHash,
					executed: record.executed !== null && "runIds" in record.executed,
				},
				harness: {
					...active.harness,
					reads: harnessReads.get(record.turnId) ?? active.harness.reads,
					runIds: [...active.harness.runIds, ...runIds],
				},
			};
			harnessReads.delete(record.turnId);
		},
		seedClarificationStreak(value) {
			previousClarificationStreak = value;
		},
		take(id) {
			const result = userTurnId === null || userTurnId === id ? active : emptyTurn(previousClarificationStreak);
			active = emptyTurn(previousClarificationStreak);
			userTurnId = null;
			assistantTurnId = null;
			dispatched = false;
			return result;
		},
		recordCompletion(id, decision, mutatedPaths, evidenceKinds) {
			if (id !== null && (id === assistantTurnId || id === userTurnId)) {
				active = { ...active, completion: { decision, mutatedPaths, evidenceKinds: [...evidenceKinds] } };
			}
		},
		evaluate(input) {
			if (input.sessionId !== undefined && input.sessionId !== sessionId) {
				succeededKeys.clear();
				harnessReads.clear();
				sessionId = input.sessionId;
			}
			if (input.hook === "turn_start") {
				active = emptyTurn(previousClarificationStreak);
				userTurnId = input.turnId ?? null;
				assistantTurnId = null;
				dispatched = false;
				return [];
			}
			if (input.hook === "turn_end") {
				if (typeof input.metadata?.userTurnId === "string") userTurnId = input.metadata.userTurnId;
				assistantTurnId = input.turnId ?? null;
				return [];
			}
			if (input.metadata?.nested === true) return [];
			if (input.turnId !== undefined) userTurnId = input.turnId;
			const call = effectiveToolCall(input.toolName ?? "", input.toolArgs, input.toolResultDetails);
			const toolName = call.toolName;
			const args = call.args;
			if (input.metadata?.origin === "harness") {
				if (input.hook !== "after_tool") return [];
				if (toolName !== ToolNames.Dispatch && input.turnId !== undefined) {
					// S7: observations precede turn_start; retain them under the reserved user id.
					if (harnessReads.size >= 32 && !harnessReads.has(input.turnId)) {
						const oldest = harnessReads.keys().next().value;
						if (oldest !== undefined) harnessReads.delete(oldest);
					}
					harnessReads.set(input.turnId, (harnessReads.get(input.turnId) ?? 0) + 1);
				}
				active = {
					...active,
					harness:
						toolName === ToolNames.Dispatch
							? { ...active.harness, runIds: [...active.harness.runIds, ...dispatchRuns(input.toolResultDetails).runIds] }
							: { ...active.harness, reads: active.harness.reads + 1 },
				};
				return [];
			}
			if (input.hook === "before_tool") {
				active = { ...active, toolNames: [...active.toolNames, toolName] };
				if (toolName === ToolNames.Dispatch) dispatched ||= !isDispatchListing(args);
				else if (!dispatched && isReadOnlyCall(toolName, args)) {
					active = { ...active, readOnlyCallsBeforeFirstDispatch: active.readOnlyCallsBeforeFirstDispatch + 1 };
				}
			} else if (input.hook === "after_tool" && toolName === ToolNames.Dispatch && !isDispatchListing(args)) {
				// A dispatch whose worker failed or was aborted still launched a run
				// and spent worker tokens; tokens.workers is built from these run ids.
				// Only a successful dispatch can make a later identical one a duplicate.
				const succeeded = input.metadata?.resultKind === "ok";
				const runs = dispatchRuns(input.toolResultDetails);
				if (!succeeded && runs.runIds.length === 0) return [];
				const keys = dispatchKeysFromArgs(args).map((key) => JSON.stringify([key.agentId, key.task]));
				const duplicateDispatch = succeeded && keys.some((key) => succeededKeys.has(key));
				if (succeeded) for (const key of keys) succeededKeys.add(key);
				active = {
					...active,
					duplicateDispatch: active.duplicateDispatch || duplicateDispatch,
					dispatches: [
						...active.dispatches,
						{
							mode:
								typeof input.toolResultDetails?.mode === "string"
									? input.toolResultDetails.mode
									: typeof args?.mode === "string"
										? args.mode
										: "pipeline",
							agentIds: runs.agentIds.length > 0 ? runs.agentIds : dispatchKeysFromArgs(args).map((key) => key.agentId),
							runIds: runs.runIds,
							...(succeeded ? {} : { failed: true as const }),
						},
					],
				};
			}
			return [];
		},
	};
}
