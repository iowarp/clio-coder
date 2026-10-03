import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { aggregateCostEntries } from "../domains/observability/cost-rows.js";
import type { CostRow } from "../domains/observability/cost-rows.js";
import type { CostAggregate, ObservabilityContract } from "../domains/observability/index.js";
import { mutatingReceipts } from "../domains/safety/finish-contract.js";
import type { SessionContract } from "../domains/session/contract.js";
import { effectiveToolCall } from "../tools/surface.js";
import type { ChatLoopEvent } from "./chat-loop.js";
import type { WorkerReceiptFacts } from "./worker-stream.js";

export interface ExitSummarySnapshot {
	sessionId: string;
	sessionName: string | null;
	wallMs: number;
	modelMs: number;
	modelTimeIncomplete: boolean;
	turns: number;
	models: ReadonlyArray<{ target: string; model: string }>;
	usage: ReadonlyArray<CostRow>;
	cost: CostAggregate;
	tools: ReadonlyArray<{ tool: string; count: number }>;
	files: ReadonlyArray<string>;
	workers: ReadonlyArray<{ runId: string; agent: string; outcome: string }>;
	compactions: number;
}

interface CollectorDeps {
	bus: SafeEventBus;
	observability: ObservabilityContract;
	dispatch: Pick<DispatchContract, "observedRunWrites">;
	session?: Pick<SessionContract, "current">;
	getTurns: () => number | null;
	getToolCounts: () => ReadonlyMap<string, number>;
	getModel: () => { target: string; model: string } | null;
	now?: () => number;
}

/** This visit's account. All ledger folds and receipt reads happen while events arrive. */
export function createExitSummaryCollector(deps: CollectorDeps) {
	const now = deps.now ?? (() => performance.now());
	let startedAt = now();
	let baseTurns = deps.getTurns() ?? 0;
	let priorTurns = 0;
	let hasModelTurn = deps.session?.current()?.hasModelTurn === true;
	let modelMs = 0;
	let timedCalls = 0;
	let compactions = 0;
	let usage = aggregateCostEntries(deps.observability.costEntries());
	let cost = deps.observability.sessionCostSummary();
	const models = new Map<string, { target: string; model: string }>();
	const files = new Set<string>();
	const calls = new Map<string, { entry: unknown; cwd: string }>();
	const workers = new Map<string, { runId: string; agent: string; outcome: string }>();
	const workerTools = new Map<string, ReadonlyArray<{ tool: string; count: number }>>();
	const workerStarted = new Map<string, number>();
	const noteModel = (target: string, model: string): void => {
		if (target && model) models.set(`${target}\0${model}`, { target, model });
	};
	const refreshUsage = (): void => {
		usage = aggregateCostEntries(deps.observability.costEntries());
		cost = deps.observability.sessionCostSummary();
	};
	const noteFiles = (paths: ReadonlyArray<string>, cwd = process.cwd()): void => {
		for (const path of paths) {
			const expanded = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
			const abs = resolve(cwd, expanded);
			const local = relative(process.cwd(), abs);
			files.add(local.startsWith("..") || isAbsolute(local) ? abs : local || ".");
		}
	};
	const reset = (): void => {
		startedAt = now();
		baseTurns = deps.getTurns() ?? 0;
		priorTurns = 0;
		hasModelTurn = deps.session?.current()?.hasModelTurn === true;
		modelMs = 0;
		timedCalls = 0;
		compactions = 0;
		models.clear();
		files.clear();
		calls.clear();
		workers.clear();
		workerTools.clear();
		workerStarted.clear();
		refreshUsage();
	};
	const settled = (run: { runId: string; agentId: string; outcome: string }): void => {
		if (!workers.has(run.runId)) return;
		workers.set(run.runId, { runId: run.runId, agent: run.agentId, outcome: run.outcome });
		noteFiles(deps.dispatch.observedRunWrites?.(run.runId) ?? []);
		workerStarted.delete(run.runId);
		refreshUsage();
	};
	const unsubscribers = [
		deps.observability.subscribe(refreshUsage),
		deps.bus.on(BusChannels.SessionResumed, () => {
			baseTurns = deps.getTurns() ?? 0;
			hasModelTurn ||= deps.session?.current()?.hasModelTurn === true;
		}),
		deps.bus.on(BusChannels.SessionParked, () => {
			priorTurns += Math.max(0, (deps.getTurns() ?? 0) - baseTurns);
			baseTurns = deps.getTurns() ?? 0;
		}),
		deps.bus.on(BusChannels.ContextPruned, () => {
			compactions += 1;
		}),
		deps.bus.on(BusChannels.DispatchStarted, (run) => {
			hasModelTurn = true;
			workers.set(run.runId, { runId: run.runId, agent: run.agentId, outcome: "running" });
			noteModel(run.targetId, run.wireModelId);
		}),
		deps.bus.on(BusChannels.DispatchProgress, ({ runId, event }) => {
			if (!workers.has(runId) || !event || typeof event !== "object") return;
			const frame = event as { type?: string; message?: { role?: string } };
			if (frame.type === "message_start" && frame.message?.role === "assistant") workerStarted.set(runId, now());
			if (frame.type === "message_end" && frame.message?.role === "assistant") {
				const start = workerStarted.get(runId);
				if (start !== undefined) {
					modelMs += Math.max(0, now() - start);
					timedCalls += 1;
					workerStarted.delete(runId);
				}
			}
		}),
		deps.bus.on(BusChannels.DispatchCompleted, settled),
		deps.bus.on(BusChannels.DispatchFailed, settled),
	];
	return {
		reset,
		observeChat(event: ChatLoopEvent): void {
			if (event.type === "agent_start") {
				const model = deps.getModel();
				if (model) noteModel(model.target, model.model);
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				hasModelTurn = true;
				if (event.modelTimeMs !== undefined) {
					modelMs += event.modelTimeMs;
					timedCalls += 1;
				}
			}
			if (event.type === "tool_execution_start") {
				hasModelTurn = true;
				const args = event.args as Record<string, unknown> | undefined;
				const effective = effectiveToolCall(event.toolName, args);
				calls.set(event.toolCallId, {
					entry: {
						kind: "message",
						role: "tool_call",
						payload: { name: event.toolName, args, toolCallId: event.toolCallId },
					},
					cwd: typeof effective.args?.cwd === "string" ? resolve(process.cwd(), effective.args.cwd) : process.cwd(),
				});
			}
			if (event.type === "tool_execution_end") {
				const call = calls.get(event.toolCallId);
				if (call) {
					const payload = { ...event };
					noteFiles(mutatingReceipts([call.entry, { kind: "message", role: "tool_result", payload }]).paths, call.cwd);
					calls.delete(event.toolCallId);
				}
			}
			if (event.type === "agent_end") refreshUsage();
		},
		observeReceipt(runId: string, receipt: WorkerReceiptFacts | null): void {
			if (!workers.has(runId) || receipt === null) return;
			if (receipt.toolCounts) workerTools.set(runId, receipt.toolCounts);
			noteFiles(receipt.changedPaths ?? []);
		},
		observeLocalEntry(entry: unknown): void {
			noteFiles(mutatingReceipts([entry]).paths);
		},
		snapshot(): ExitSummarySnapshot | null {
			const session = deps.session?.current();
			if (!session || !hasModelTurn) return null;
			const tools = new Map(deps.getToolCounts());
			for (const stats of workerTools.values()) {
				for (const { tool, count } of stats) tools.set(tool, (tools.get(tool) ?? 0) + count);
			}
			return {
				sessionId: session.id,
				sessionName: session.name ?? null,
				wallMs: Math.max(0, now() - startedAt),
				modelMs,
				modelTimeIncomplete: usage.reduce((sum, row) => sum + row.apiCalls, 0) > timedCalls,
				turns: priorTurns + Math.max(0, (deps.getTurns() ?? 0) - baseTurns),
				models: [...models.values()],
				usage,
				cost,
				tools: [...tools].map(([tool, count]) => ({ tool, count })).sort((a, b) => a.tool.localeCompare(b.tool)),
				files: [...files].sort(),
				workers: [...workers.values()],
				compactions,
			};
		},
		dispose(): void {
			for (const unsubscribe of unsubscribers) unsubscribe();
		},
	};
}
