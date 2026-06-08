import { Type } from "typebox";
import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { ToolNames } from "../core/tool-names.js";
import type { DispatchContract, DispatchRequest } from "../domains/dispatch/contract.js";
import type { RunReceipt } from "../domains/dispatch/types.js";
import type { JobThinkingLevel } from "../domains/dispatch/validation.js";
import { isToolProfileName, type ToolProfileName } from "./profiles.js";
import type { ToolResult, ToolResultDetails, ToolSpec } from "./registry.js";
import { truncateUtf8 } from "./truncate-utf8.js";

const DEFAULT_AGENT_ID = "coder";
const DEFAULT_MAX_OUTPUT_BYTES = 20_000;
const TRUNCATION_MARKER = "\n[agent output truncated]";
const VALID_THINKING = new Set<JobThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);

export interface DispatchToolDeps {
	dispatch: DispatchContract;
	bus?: SafeEventBus;
}

interface EventSummary {
	count: number;
	types: string[];
	lastAssistantText: string;
}

interface BatchRunSummary extends EventSummary {
	runId: string;
	agentId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArg(args: Record<string, unknown>, ...names: string[]): string | undefined {
	for (const name of names) {
		const value = args[name];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

function stringArrayArg(args: Record<string, unknown>, ...names: string[]): string[] | undefined {
	for (const name of names) {
		const value = args[name];
		if (!Array.isArray(value)) continue;
		const out = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
		return out.map((item) => item.trim());
	}
	return undefined;
}

function maxOutputBytesArg(args: Record<string, unknown>): number {
	const value = args.max_output_bytes ?? args.maxOutputBytes;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_OUTPUT_BYTES;
}

function timeoutMsArg(args: Record<string, unknown>): number | undefined {
	const value = args.timeout_ms ?? args.timeoutMs;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function dispatchRequestFromArgs(
	args: Record<string, unknown>,
): { ok: true; request: DispatchRequest } | { ok: false; message: string } {
	const task = stringArg(args, "task");
	if (!task) return { ok: false, message: "dispatch: missing task argument" };

	const request: DispatchRequest = {
		agentId: stringArg(args, "agent_id", "agentId", "agent") ?? DEFAULT_AGENT_ID,
		task,
	};

	const endpoint = stringArg(args, "target", "endpoint");
	if (endpoint) request.endpoint = endpoint;
	const model = stringArg(args, "model");
	if (model) request.model = model;
	const workerProfile = stringArg(args, "agent_profile", "agentProfile", "worker_profile", "workerProfile");
	if (workerProfile) request.workerProfile = workerProfile;
	const workerRuntime = stringArg(args, "agent_runtime", "agentRuntime", "worker_runtime", "workerRuntime");
	if (workerRuntime) request.workerRuntime = workerRuntime;
	const delegationAgentId = stringArg(args, "delegation_agent_id", "delegationAgentId", "delegate", "acp_agent_id");
	if (delegationAgentId) request.delegationAgentId = delegationAgentId;
	const cwd = stringArg(args, "cwd");
	if (cwd) request.cwd = cwd;
	const memorySection = stringArg(args, "memory_section", "memorySection");
	if (memorySection) request.memorySection = memorySection;

	const thinkingLevel = stringArg(args, "thinking_level", "thinkingLevel");
	if (thinkingLevel) {
		if (!VALID_THINKING.has(thinkingLevel as JobThinkingLevel)) {
			return { ok: false, message: "dispatch: thinking_level must be one of off|minimal|low|medium|high|xhigh" };
		}
		request.thinkingLevel = thinkingLevel as JobThinkingLevel;
	}

	const toolProfile = stringArg(args, "tool_profile", "toolProfile");
	if (toolProfile) {
		if (!isToolProfileName(toolProfile)) {
			return { ok: false, message: "dispatch: tool_profile must be one of minimal-local|science-local|full-agent" };
		}
		request.toolProfile = toolProfile as ToolProfileName;
	}

	const requiredCapabilities = stringArrayArg(args, "required_capabilities", "requiredCapabilities");
	if (requiredCapabilities && requiredCapabilities.length > 0) request.requiredCapabilities = requiredCapabilities;

	return { ok: true, request };
}

function dispatchBatchRequestsFromArgs(
	args: Record<string, unknown>,
): { ok: true; requests: DispatchRequest[] } | { ok: false; message: string } {
	const tasks = args.tasks;
	if (!Array.isArray(tasks) || tasks.length === 0) {
		return { ok: false, message: "dispatch_batch: tasks must be a non-empty array" };
	}
	const shared = { ...args };
	Reflect.deleteProperty(shared, "tasks");
	const requests: DispatchRequest[] = [];
	for (let index = 0; index < tasks.length; index += 1) {
		const item = tasks[index];
		const itemArgs = isRecord(item) ? { ...shared, ...item } : { ...shared, task: item };
		const parsed = dispatchRequestFromArgs(itemArgs);
		if (!parsed.ok) return { ok: false, message: `dispatch_batch: task ${index + 1}: ${parsed.message}` };
		requests.push(parsed.request);
	}
	return { ok: true, requests };
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (typeof block === "string") return block;
			if (!isRecord(block)) return "";
			const text = block.text;
			return typeof text === "string" ? text : "";
		})
		.join("");
}

function assistantTextFromEvent(event: unknown): string {
	if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message)) return "";
	if (event.message.role !== "assistant") return "";
	return textFromContent(event.message.content).trim();
}

async function consumeDispatchEvents(
	runId: string,
	agentId: string,
	events: AsyncIterableIterator<unknown>,
	bus: SafeEventBus | undefined,
): Promise<EventSummary> {
	const summary: EventSummary = { count: 0, types: [], lastAssistantText: "" };
	for await (const event of events) {
		summary.count += 1;
		const type = isRecord(event) && typeof event.type === "string" ? event.type : "unknown";
		summary.types.push(type);
		const text = assistantTextFromEvent(event);
		if (text.length > 0) summary.lastAssistantText = text;
		if (type !== "heartbeat") {
			bus?.emit(BusChannels.DispatchProgress, { runId, agentId, event });
		}
	}
	return summary;
}

async function consumeDispatchBatchEvents(
	batchId: string,
	events: AsyncIterableIterator<unknown>,
	bus: SafeEventBus | undefined,
): Promise<Map<string, BatchRunSummary>> {
	const summaries = new Map<string, BatchRunSummary>();
	for await (const event of events) {
		if (!isRecord(event) || event.type !== "batch_run_event") continue;
		const runId = typeof event.runId === "string" ? event.runId : batchId;
		const agentId = typeof event.agentId === "string" ? event.agentId : "batch";
		const inner = event.event;
		const summary = summaries.get(runId) ?? { runId, agentId, count: 0, types: [], lastAssistantText: "" };
		summary.count += 1;
		const type = isRecord(inner) && typeof inner.type === "string" ? inner.type : "unknown";
		summary.types.push(type);
		const text = assistantTextFromEvent(inner);
		if (text.length > 0) summary.lastAssistantText = text;
		summaries.set(runId, summary);
		if (type !== "heartbeat") {
			bus?.emit(BusChannels.DispatchProgress, { runId, agentId, event });
		}
	}
	return summaries;
}

function receiptDetails(receipt: RunReceipt, receiptPath: string | null, summary: EventSummary): ToolResultDetails {
	return {
		runId: receipt.runId,
		agentId: receipt.agentId,
		endpointId: receipt.endpointId,
		wireModelId: receipt.wireModelId,
		runtimeId: receipt.runtimeId,
		runtimeKind: receipt.runtimeKind,
		exitCode: receipt.exitCode,
		tokenCount: receipt.tokenCount,
		reasoningTokenCount: receipt.reasoningTokenCount ?? 0,
		costUsd: receipt.costUsd,
		toolCalls: receipt.toolCalls,
		receiptPath,
		eventCount: summary.count,
		eventTypes: summary.types,
	};
}

function formatDispatchOutput(
	receipt: RunReceipt,
	receiptPath: string | null,
	summary: EventSummary,
	maxOutputBytes: number,
): string {
	const reasoning =
		typeof receipt.reasoningTokenCount === "number" && receipt.reasoningTokenCount > 0
			? ` reasoning=${receipt.reasoningTokenCount}`
			: "";
	const failure = receipt.failureMessage ? ` failure=${receipt.failureMessage}` : "";
	const output = summary.lastAssistantText
		? truncateUtf8(summary.lastAssistantText, maxOutputBytes, TRUNCATION_MARKER)
		: "(no assistant text captured)";
	return [
		`dispatch run ${receipt.runId} completed`,
		`agent=${receipt.agentId} target=${receipt.endpointId} model=${receipt.wireModelId} runtime=${receipt.runtimeId}`,
		`exit=${receipt.exitCode} tokens=${receipt.tokenCount}${reasoning} toolCalls=${receipt.toolCalls} receipt=${receiptPath ?? "n/a"}${failure}`,
		"",
		"agent output:",
		output,
	].join("\n");
}

export function createDispatchTool(deps: DispatchToolDeps): ToolSpec {
	return {
		name: ToolNames.Dispatch,
		description:
			"Dispatch a bounded task to a configured Clio agent from the fleet. Defaults to agent_id='coder' and the configured fleet default target/model when target/model are omitted. Use the returned receipt/output as evidence; do not repeat an identical successful dispatch in the same user turn.",
		parameters: Type.Object({
			task: Type.String({ description: "Concrete agent task. Include expected output, constraints, and handoff format." }),
			agent_id: Type.Optional(Type.String({ description: "Agent recipe id from the fleet catalog. Defaults to coder." })),
			target: Type.Optional(Type.String({ description: "Target id, such as dynamo. Omit for the fleet default." })),
			model: Type.Optional(Type.String({ description: "Model override. Omit for the target/profile default." })),
			thinking_level: Type.Optional(
				Type.Union([
					Type.Literal("off"),
					Type.Literal("minimal"),
					Type.Literal("low"),
					Type.Literal("medium"),
					Type.Literal("high"),
					Type.Literal("xhigh"),
				]),
			),
			agent_profile: Type.Optional(
				Type.String({
					description: "Named fleet profile. Legacy settings store these under settings.workers.profiles.",
				}),
			),
			agent_runtime: Type.Optional(
				Type.String({ description: "Runtime selector used when no explicit target is given." }),
			),
			delegation_agent_id: Type.Optional(
				Type.String({ description: "ACP delegation agent id from settings.delegation.agents[]." }),
			),
			tool_profile: Type.Optional(
				Type.Union([Type.Literal("minimal-local"), Type.Literal("science-local"), Type.Literal("full-agent")]),
			),
			required_capabilities: Type.Optional(
				Type.Array(Type.String(), { description: "Capabilities the selected target must advertise." }),
			),
			cwd: Type.Optional(Type.String({ description: "Agent working directory. Defaults to the current process cwd." })),
			memory_section: Type.Optional(
				Type.String({ description: "Extra memory/context text to append to the dispatched agent prompt." }),
			),
			timeout_ms: Type.Optional(Type.Number({ description: "Abort the agent run after this many milliseconds." })),
			max_output_bytes: Type.Optional(
				Type.Number({ description: "Maximum dispatched-agent text bytes returned to the main agent." }),
			),
		}),
		baseActionClass: "dispatch",
		executionMode: "sequential",
		async run(args, options): Promise<ToolResult> {
			const parsed = dispatchRequestFromArgs(args);
			if (!parsed.ok) return { kind: "error", message: parsed.message };
			if (options?.signal?.aborted) return { kind: "error", message: "dispatch: aborted" };

			let handle: Awaited<ReturnType<DispatchContract["dispatch"]>>;
			try {
				handle = await deps.dispatch.dispatch(parsed.request);
			} catch (err) {
				return { kind: "error", message: `dispatch: ${err instanceof Error ? err.message : String(err)}` };
			}

			const abort = (): void => deps.dispatch.abort(handle.runId);
			const timeoutMs = timeoutMsArg(args);
			const timer = timeoutMs !== undefined ? setTimeout(abort, timeoutMs) : null;
			timer?.unref?.();
			options?.signal?.addEventListener("abort", abort, { once: true });

			try {
				const summary = await consumeDispatchEvents(handle.runId, parsed.request.agentId, handle.events, deps.bus);
				const receipt = await handle.finalPromise;
				const receiptPath = deps.dispatch.getRun(receipt.runId)?.receiptPath ?? null;
				const output = formatDispatchOutput(receipt, receiptPath, summary, maxOutputBytesArg(args));
				const details = receiptDetails(receipt, receiptPath, summary);
				if (receipt.exitCode !== 0) return { kind: "error", message: output, details };
				return { kind: "ok", output, details };
			} catch (err) {
				return { kind: "error", message: `dispatch: ${err instanceof Error ? err.message : String(err)}` };
			} finally {
				if (timer) clearTimeout(timer);
				options?.signal?.removeEventListener("abort", abort);
			}
		},
	};
}

function formatBatchOutput(
	batchId: string,
	runIds: ReadonlyArray<string>,
	receipts: ReadonlyArray<RunReceipt>,
	receiptPaths: ReadonlyMap<string, string | null>,
	summaries: ReadonlyMap<string, BatchRunSummary>,
	maxOutputBytes: number,
): string {
	const failed = receipts.filter((receipt) => receipt.exitCode !== 0);
	const perRunOutputBytes = Math.max(1024, Math.floor(maxOutputBytes / Math.max(1, receipts.length)));
	const lines = [
		`dispatch batch ${batchId} completed`,
		`runs=${runIds.join(", ")} total=${receipts.length} failed=${failed.length}`,
		"",
		...receipts.flatMap((receipt) => {
			const summary = summaries.get(receipt.runId);
			const receiptPath = receiptPaths.get(receipt.runId) ?? "n/a";
			const failure = receipt.failureMessage ? ` failure=${receipt.failureMessage}` : "";
			const output =
				summary?.lastAssistantText && summary.lastAssistantText.length > 0
					? truncateUtf8(summary.lastAssistantText, perRunOutputBytes, TRUNCATION_MARKER)
					: "(no assistant text captured)";
			return [
				`- ${receipt.runId} agent=${receipt.agentId} exit=${receipt.exitCode} target=${receipt.endpointId} model=${receipt.wireModelId} tokens=${receipt.tokenCount} receipt=${receiptPath}${failure}`,
				"  agent output:",
				...output.split("\n").map((line) => `  ${line}`),
			];
		}),
	];
	return truncateUtf8(lines.join("\n"), maxOutputBytes, TRUNCATION_MARKER);
}

export function createDispatchBatchTool(deps: DispatchToolDeps): ToolSpec {
	return {
		name: ToolNames.DispatchBatch,
		description:
			"Dispatch multiple bounded tasks to configured Clio fleet agents as one batch. Each item may be a task string or an object with task plus the same targeting fields as dispatch. Returns run ids and receipt summaries.",
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Union([
					Type.String(),
					Type.Object({
						task: Type.String(),
						agent_id: Type.Optional(Type.String()),
						target: Type.Optional(Type.String()),
						model: Type.Optional(Type.String()),
						agent_profile: Type.Optional(Type.String()),
						agent_runtime: Type.Optional(Type.String()),
						delegation_agent_id: Type.Optional(Type.String()),
						tool_profile: Type.Optional(
							Type.Union([Type.Literal("minimal-local"), Type.Literal("science-local"), Type.Literal("full-agent")]),
						),
						thinking_level: Type.Optional(
							Type.Union([
								Type.Literal("off"),
								Type.Literal("minimal"),
								Type.Literal("low"),
								Type.Literal("medium"),
								Type.Literal("high"),
								Type.Literal("xhigh"),
							]),
						),
					}),
				]),
			),
			agent_id: Type.Optional(Type.String({ description: "Default agent recipe for string tasks." })),
			target: Type.Optional(Type.String({ description: "Default target id for every task." })),
			model: Type.Optional(Type.String({ description: "Default model override for every task." })),
			agent_profile: Type.Optional(Type.String({ description: "Default fleet profile." })),
			agent_runtime: Type.Optional(Type.String({ description: "Default worker runtime selector." })),
			delegation_agent_id: Type.Optional(Type.String({ description: "Default ACP delegation agent id." })),
			tool_profile: Type.Optional(
				Type.Union([Type.Literal("minimal-local"), Type.Literal("science-local"), Type.Literal("full-agent")]),
			),
			timeout_ms: Type.Optional(Type.Number({ description: "Abort all active batch runs after this many milliseconds." })),
			max_output_bytes: Type.Optional(Type.Number({ description: "Maximum summary bytes returned to the main agent." })),
		}),
		baseActionClass: "dispatch",
		executionMode: "sequential",
		async run(args, options): Promise<ToolResult> {
			const parsed = dispatchBatchRequestsFromArgs(args);
			if (!parsed.ok) return { kind: "error", message: parsed.message };
			if (options?.signal?.aborted) return { kind: "error", message: "dispatch_batch: aborted" };
			let handle: Awaited<ReturnType<DispatchContract["dispatchBatch"]>>;
			try {
				handle = await deps.dispatch.dispatchBatch(parsed.requests);
			} catch (err) {
				return { kind: "error", message: `dispatch_batch: ${err instanceof Error ? err.message : String(err)}` };
			}
			const abort = (): void => {
				for (const runId of handle.runIds) deps.dispatch.abort(runId);
			};
			const timeoutMs = timeoutMsArg(args);
			const timer = timeoutMs !== undefined ? setTimeout(abort, timeoutMs) : null;
			timer?.unref?.();
			options?.signal?.addEventListener("abort", abort, { once: true });
			try {
				const summaries = await consumeDispatchBatchEvents(handle.batchId, handle.events, deps.bus);
				const receipts = await handle.finalPromise;
				const receiptPaths = new Map<string, string | null>();
				for (const receipt of receipts)
					receiptPaths.set(receipt.runId, deps.dispatch.getRun(receipt.runId)?.receiptPath ?? null);
				const output = formatBatchOutput(
					handle.batchId,
					handle.runIds,
					receipts,
					receiptPaths,
					summaries,
					maxOutputBytesArg(args),
				);
				const failed = receipts.filter((receipt) => receipt.exitCode !== 0);
				const details: ToolResultDetails = {
					batchId: handle.batchId,
					runIds: handle.runIds,
					receiptCount: receipts.length,
					failedCount: failed.length,
					runs: receipts.map((receipt) => ({
						runId: receipt.runId,
						agentId: receipt.agentId,
						exitCode: receipt.exitCode,
						receiptPath: receiptPaths.get(receipt.runId) ?? null,
						eventCount: summaries.get(receipt.runId)?.count ?? 0,
					})),
				};
				if (failed.length > 0) return { kind: "error", message: output, details };
				return { kind: "ok", output, details };
			} catch (err) {
				return { kind: "error", message: `dispatch_batch: ${err instanceof Error ? err.message : String(err)}` };
			} finally {
				if (timer) clearTimeout(timer);
				options?.signal?.removeEventListener("abort", abort);
			}
		},
	};
}
