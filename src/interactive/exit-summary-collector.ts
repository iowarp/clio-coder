import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { summarizeTrustStatus } from "../domains/evidence/trust-projection.js";
import type { CostRow } from "../domains/observability/cost-rows.js";
import { aggregateCostEntries } from "../domains/observability/cost-rows.js";
import type { CostAggregate, ObservabilityContract } from "../domains/observability/index.js";
import { mutatingReceipts } from "../domains/safety/finish-contract.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { ChatLoopEvent } from "../session-control/chat-loop.js";
import type { WorkerReceiptFacts } from "../session-control/worker-stream.js";
import { effectiveToolCall } from "../tools/surface.js";

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
	tools: ReadonlyArray<{ tool: string; count: number; failures: number }>;
	files: ReadonlyArray<string>;
	fileChanges: ReadonlyArray<{ path: string; count: number }>;
	workers: ReadonlyArray<{
		runId: string;
		agent: string;
		target: string;
		model: string;
		outcome: string;
		receipt: string;
	}>;
	permissions: { granted: number; denied: number; expired: number; blocked: number };
	timeline: ReadonlyArray<{ elapsedMs: number; text: string }>;
	timelineOmitted: number;
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
	const files = new Map<string, number>();
	const workerPaths = new Map<string, Set<string>>();
	const failures = new Map<string, number>();
	const timeline: Array<{ elapsedMs: number; text: string }> = [];
	let timelineOmitted = 0;
	const permissions = { granted: 0, denied: 0, expired: 0, blocked: 0 };
	const highlight = (text: string): void => {
		timeline.push({ elapsedMs: Math.max(0, now() - startedAt), text });
		if (timeline.length > 32) {
			timeline.shift();
			timelineOmitted += 1;
		}
	};
	const noteFailure = (tool: string): void => {
		failures.set(tool, (failures.get(tool) ?? 0) + 1);
	};
	const calls = new Map<string, { entry: unknown; cwd: string; tool: string }>();
	const workers = new Map<string, ExitSummarySnapshot["workers"][number]>();
	const workerTools = new Map<string, ReadonlyArray<{ tool: string; count: number }>>();
	const workerStarted = new Map<string, number>();
	const workerCapabilities = new Map<string, string>();
	const noteModel = (target: string, model: string): void => {
		if (target && model) models.set(`${target}\0${model}`, { target, model });
	};
	const refreshUsage = (): void => {
		usage = aggregateCostEntries(deps.observability.costEntries());
		cost = deps.observability.sessionCostSummary();
	};
	const noteFiles = (paths: ReadonlyArray<string>, cwd = process.cwd(), seen?: Set<string>): void => {
		for (const path of paths) {
			const expanded = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
			const abs = resolve(cwd, expanded);
			const local = relative(process.cwd(), abs);
			const name = local.startsWith("..") || isAbsolute(local) ? abs : local || ".";
			if (seen?.has(name)) continue;
			seen?.add(name);
			files.set(name, (files.get(name) ?? 0) + 1);
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
		workerPaths.clear();
		failures.clear();
		timeline.length = 0;
		timelineOmitted = 0;
		permissions.granted = permissions.denied = permissions.expired = permissions.blocked = 0;
		calls.clear();
		workers.clear();
		workerTools.clear();
		workerStarted.clear();
		workerCapabilities.clear();
		refreshUsage();
	};
	const settled = (run: { runId: string; agentId: string; outcome: string }): void => {
		const worker = workers.get(run.runId);
		if (!worker) return;
		workers.set(run.runId, { ...worker, outcome: run.outcome });
		highlight(`${run.agentId} ${run.outcome}`);
		noteFiles(deps.dispatch.observedRunWrites?.(run.runId) ?? [], process.cwd(), workerPaths.get(run.runId));
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
			highlight("Context compacted");
		}),
		deps.bus.on(BusChannels.DispatchStarted, (run) => {
			hasModelTurn = true;
			workers.set(run.runId, {
				runId: run.runId,
				agent: run.agentId,
				target: run.targetId,
				model: run.wireModelId,
				outcome: "running",
				receipt: "not available",
			});
			workerPaths.set(run.runId, new Set());
			highlight(`${run.agentId} started on ${run.targetId}`);
			noteModel(run.targetId, run.wireModelId);
		}),
		deps.bus.on(BusChannels.DispatchProgress, ({ runId, event }) => {
			if (!workers.has(runId) || !event || typeof event !== "object") return;
			const frame = event as {
				type?: string;
				message?: { role?: string };
				toolName?: string;
				toolCallId?: string;
				args?: unknown;
				payload?: { tool?: string; toolCallId?: string; outcome?: string; decision?: string };
			};
			if (
				frame.type === "tool_execution_start" &&
				typeof frame.toolName === "string" &&
				typeof frame.toolCallId === "string"
			) {
				workerCapabilities.set(`${runId}\0${frame.toolCallId}`, effectiveToolCall(frame.toolName, frame.args).toolName);
			}
			if (frame.type === "clio_coder_tool_finish" && typeof frame.payload?.tool === "string") {
				const key = `${runId}\0${frame.payload.toolCallId ?? ""}`;
				const tool = workerCapabilities.get(key) ?? frame.payload.tool;
				workerCapabilities.delete(key);
				const stats = new Map((workerTools.get(runId) ?? []).map((stat) => [stat.tool, stat.count]));
				stats.set(tool, (stats.get(tool) ?? 0) + 1);
				workerTools.set(
					runId,
					[...stats].map(([tool, count]) => ({ tool, count })),
				);
				if (frame.payload.outcome === "error") noteFailure(tool);
				if (frame.payload.outcome === "blocked" || frame.payload.decision === "blocked") {
					permissions.blocked += 1;
					highlight(`Worker safety refusal: ${tool}`);
				}
			}
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
		deps.bus.on(BusChannels.PermissionResolved, (event) => {
			permissions[event.status] += 1;
			highlight(`Permission ${event.status}${event.tool ? `: ${event.tool}` : ""}`);
		}),
		deps.bus.on(BusChannels.SafetyBlocked, (event) => {
			permissions.blocked += 1;
			highlight(`Safety refusal: ${event.tool}`);
		}),
		deps.bus.on(BusChannels.DispatchCompleted, settled),
		deps.bus.on(BusChannels.DispatchFailed, settled),
	];
	return {
		reset,
		observeChat(event: ChatLoopEvent): void {
			if (event.type === "agent_start") {
				const model = deps.getModel();
				if (model) {
					if (!models.has(`${model.target}\0${model.model}`)) highlight(`Model ${model.target} / ${model.model}`);
					noteModel(model.target, model.model);
				}
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
					tool: effective.toolName,
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
				if (event.isError) noteFailure(call?.tool ?? event.toolName);
				if (call) {
					const payload = { ...event };
					noteFiles(mutatingReceipts([call.entry, { kind: "message", role: "tool_result", payload }]).paths, call.cwd);
					calls.delete(event.toolCallId);
				}
			}
			if (event.type === "agent_end") refreshUsage();
		},
		observeReceipt(runId: string, receipt: WorkerReceiptFacts | null): void {
			const worker = workers.get(runId);
			if (!worker || receipt === null) return;
			workers.set(runId, {
				...worker,
				receipt: receipt.trust ? summarizeTrustStatus(receipt.trust).verdict : "unknown",
			});
			if (receipt.toolCounts) workerTools.set(runId, receipt.toolCounts);
			noteFiles(receipt.changedPaths ?? [], process.cwd(), workerPaths.get(runId));
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
				tools: [...new Set([...tools.keys(), ...failures.keys()])]
					.map((tool) => ({ tool, count: tools.get(tool) ?? 0, failures: failures.get(tool) ?? 0 }))
					.sort((a, b) => a.tool.localeCompare(b.tool)),
				files: [...files.keys()].sort(),
				fileChanges: [...files].map(([path, count]) => ({ path, count })).sort((a, b) => a.path.localeCompare(b.path)),
				permissions: { ...permissions },
				timeline: [...timeline],
				timelineOmitted,
				workers: [...workers.values()],
				compactions,
			};
		},
		dispose(): void {
			for (const unsubscribe of unsubscribers) unsubscribe();
		},
	};
}
