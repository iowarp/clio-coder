import { Type } from "typebox";
import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { ToolNames } from "../core/tool-names.js";
import type { DispatchContract, DispatchRequest } from "../domains/dispatch/contract.js";
import type { RunReceipt } from "../domains/dispatch/types.js";
import type { JobThinkingLevel } from "../domains/dispatch/validation.js";
import { extractRunProvenance, provenanceCompactSuffix } from "../domains/evidence/provenance.js";
import { isToolProfileName, TOOL_PROFILE_NAMES } from "./profiles.js";
import type { ToolResult, ToolResultDetails, ToolSpec } from "./registry.js";
import { stringEnum } from "./string-enum.js";
import { truncateUtf8 } from "./truncate-utf8.js";

const DEFAULT_AGENT_ID = "coder";
const DEFAULT_MAX_OUTPUT_BYTES = 20_000;
const TRUNCATION_MARKER = "\n[agent output truncated]";
const PERSONA_MAX_CHARS = 8_000;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const VALID_THINKING = new Set<JobThinkingLevel>(THINKING_LEVELS);

export interface DispatchToolDeps {
	dispatch: DispatchContract;
	bus?: SafeEventBus;
	/** Renders the agent fleet catalog for the `list: true` action. */
	getAgentCatalog?: () => string;
}

interface EventSummary {
	count: number;
	types: string[];
	lastAssistantText: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// In-process rolling tail of recent worker events, per run. Fed by the
// dispatch tool's event consumption (the same stream the dispatch board
// renders from the bus); read by monitor(mode="peek"). Bounded both per run
// and across runs so long fleets cannot grow memory.
const RUN_TAIL_ENTRY_LIMIT = 100;
const RUN_TAIL_RUN_LIMIT = 64;
const RUN_TAIL_TEXT_LIMIT = 600;

export interface RunTailEntry {
	at: string;
	type: string;
	detail?: string;
}

interface RunTailState {
	agentId: string;
	entries: RunTailEntry[];
	lastSeenAt: number;
}

const runTails = new Map<string, RunTailState>();

function pruneRunTails(): void {
	while (runTails.size > RUN_TAIL_RUN_LIMIT) {
		let oldestKey: string | null = null;
		let oldestSeen = Number.POSITIVE_INFINITY;
		for (const [key, state] of runTails) {
			if (state.lastSeenAt >= oldestSeen) continue;
			oldestKey = key;
			oldestSeen = state.lastSeenAt;
		}
		if (oldestKey === null) break;
		runTails.delete(oldestKey);
	}
}

function eventDetail(event: unknown): string | undefined {
	const text = assistantTextFromEvent(event);
	if (text.length > 0) return truncateUtf8(text, RUN_TAIL_TEXT_LIMIT, "...");
	if (!isRecord(event)) return undefined;
	if (event.type === "clio_tool_finish" && isRecord(event.payload)) {
		const tool = typeof event.payload.tool === "string" ? event.payload.tool : "tool";
		const outcome = typeof event.payload.outcome === "string" ? event.payload.outcome : "";
		return `${tool} ${outcome}`.trim();
	}
	return undefined;
}

function recordRunEvent(runId: string, agentId: string, event: unknown): void {
	const type = isRecord(event) && typeof event.type === "string" ? event.type : "unknown";
	if (type === "heartbeat") return;
	const state = runTails.get(runId) ?? { agentId, entries: [], lastSeenAt: Date.now() };
	state.lastSeenAt = Date.now();
	const entry: RunTailEntry = { at: new Date().toISOString(), type };
	const detail = eventDetail(event);
	if (detail !== undefined) entry.detail = detail;
	state.entries.push(entry);
	if (state.entries.length > RUN_TAIL_ENTRY_LIMIT) state.entries.splice(0, state.entries.length - RUN_TAIL_ENTRY_LIMIT);
	runTails.set(runId, state);
	pruneRunTails();
}

/** Recent event tail for a run buffered in this process, newest last. */
export function runEventTail(runId: string): { agentId: string; entries: ReadonlyArray<RunTailEntry> } | null {
	const state = runTails.get(runId);
	if (!state) return null;
	return { agentId: state.agentId, entries: [...state.entries] };
}

function stringArg(args: Record<string, unknown>, ...names: string[]): string | undefined {
	for (const name of names) {
		const value = args[name];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

function maxOutputBytesArg(args: Record<string, unknown>): number {
	const value = args.max_output_bytes;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_OUTPUT_BYTES;
}

function timeoutMsArg(args: Record<string, unknown>): number | undefined {
	const value = args.timeout_ms;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function dispatchRequestFromArgs(
	args: Record<string, unknown>,
): { ok: true; request: DispatchRequest } | { ok: false; message: string } {
	const task = stringArg(args, "task");
	if (!task) return { ok: false, message: "missing task (pass list:true to see available agents)" };

	const request: DispatchRequest = {
		agentId: stringArg(args, "agent", "agent_id") ?? DEFAULT_AGENT_ID,
		task,
	};

	const target = stringArg(args, "target");
	if (target) request.target = target;
	const model = stringArg(args, "model");
	if (model) request.model = model;
	const node = stringArg(args, "node");
	if (node) request.node = node;
	const cwd = stringArg(args, "cwd");
	if (cwd) request.cwd = cwd;

	if ("persona" in args && args.persona !== undefined) {
		if (typeof args.persona !== "string") return { ok: false, message: "persona must be a string" };
		const persona = args.persona.trim();
		if (persona.length > PERSONA_MAX_CHARS) {
			return { ok: false, message: `persona must be ${PERSONA_MAX_CHARS} characters or fewer` };
		}
		if (persona.length > 0) request.systemPrompt = persona;
	}

	const toolProfile = stringArg(args, "tool_profile");
	if (toolProfile) {
		if (!isToolProfileName(toolProfile)) {
			return { ok: false, message: `tool_profile must be one of ${TOOL_PROFILE_NAMES.join("|")}` };
		}
		request.toolProfile = toolProfile;
	}

	const thinkingLevel = stringArg(args, "thinking_level");
	if (thinkingLevel) {
		if (!VALID_THINKING.has(thinkingLevel as JobThinkingLevel)) {
			return { ok: false, message: "thinking_level must be one of off|minimal|low|medium|high|xhigh" };
		}
		request.thinkingLevel = thinkingLevel as JobThinkingLevel;
	}

	return { ok: true, request };
}

function dispatchRequestsFromArgs(
	args: Record<string, unknown>,
): { ok: true; requests: DispatchRequest[] } | { ok: false; message: string } {
	const tasks = args.tasks;
	if (!Array.isArray(tasks) || tasks.length === 0) {
		return {
			ok: false,
			message: "dispatch: tasks must be a non-empty array of task strings or {agent, task} objects",
		};
	}
	const shared = { ...args };
	Reflect.deleteProperty(shared, "tasks");
	const requests: DispatchRequest[] = [];
	for (let index = 0; index < tasks.length; index += 1) {
		const item = tasks[index];
		const itemArgs: Record<string, unknown> = isRecord(item) ? { ...shared, ...item } : { ...shared, task: item };
		if (isRecord(item)) {
			// The task's own agent identity overrides the shared default. `agent`
			// and its `agent_id` alias both survive the spread, and
			// dispatchRequestFromArgs resolves `agent` first, so a shared `agent`
			// would otherwise beat a task-level `agent_id`. Canonicalize the task's
			// identity into `agent` and drop the now-ambiguous alias.
			const itemAgent = stringArg(item, "agent", "agent_id");
			if (itemAgent !== undefined) {
				itemArgs.agent = itemAgent;
				Reflect.deleteProperty(itemArgs, "agent_id");
			}
		}
		const parsed = dispatchRequestFromArgs(itemArgs);
		if (!parsed.ok) return { ok: false, message: `dispatch: task ${index + 1}: ${parsed.message}` };
		requests.push(parsed.request);
	}
	return { ok: true, requests };
}

/**
 * Normalize the weak-model argument shapes for `tasks`: a JSON-string array
 * is parsed, a single object or bare string is wrapped, and a top-level
 * `task` with no `tasks` becomes a one-element array. Pure and idempotent.
 */
export function prepareDispatchArguments(args: Record<string, unknown>): Record<string, unknown> {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const next: Record<string, unknown> = { ...args };
	if (typeof next.tasks === "string") {
		const raw = next.tasks.trim();
		if (raw.startsWith("[") || raw.startsWith("{")) {
			try {
				next.tasks = JSON.parse(raw) as unknown;
			} catch {
				// Leave the string; run() reports the shape error.
			}
		}
	}
	if (isRecord(next.tasks)) next.tasks = [next.tasks];
	if (typeof next.tasks === "string") next.tasks = [next.tasks];
	if (next.tasks === undefined && typeof next.task === "string") {
		const { task: _task, ...rest } = next;
		return { ...rest, tasks: [{ task: next.task }] };
	}
	return next;
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

/**
 * The worker's answer is the text of the last assistant `message_end` event.
 * Shared with the headless `clio run --agent` path so both surfaces extract
 * the final answer from the same event shape.
 */
export function assistantTextFromEvent(event: unknown): string {
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
		recordRunEvent(runId, agentId, event);
		if (type !== "heartbeat") {
			bus?.emit(BusChannels.DispatchProgress, { runId, agentId, event });
		}
	}
	return summary;
}

async function consumeBatchEvents(
	batchId: string,
	events: AsyncIterableIterator<unknown>,
	bus: SafeEventBus | undefined,
): Promise<Map<string, EventSummary>> {
	const summaries = new Map<string, EventSummary>();
	for await (const event of events) {
		if (!isRecord(event) || event.type !== "batch_run_event") continue;
		const runId = typeof event.runId === "string" ? event.runId : batchId;
		const agentId = typeof event.agentId === "string" ? event.agentId : "batch";
		const inner = event.event;
		const summary = summaries.get(runId) ?? { count: 0, types: [], lastAssistantText: "" };
		summary.count += 1;
		const type = isRecord(inner) && typeof inner.type === "string" ? inner.type : "unknown";
		summary.types.push(type);
		const text = assistantTextFromEvent(inner);
		if (text.length > 0) summary.lastAssistantText = text;
		summaries.set(runId, summary);
		recordRunEvent(runId, agentId, inner);
		if (type !== "heartbeat") {
			bus?.emit(BusChannels.DispatchProgress, { runId, agentId, event });
		}
	}
	return summaries;
}

/**
 * Surfaces a succeeded run's outcomeDetail to the calling model. Today that
 * detail is only set for runs that finished without a successful tool call;
 * the dispatch summary must not flatter such a run as plainly "completed".
 */
function successNote(receipt: RunReceipt): string | null {
	if (receipt.outcome !== undefined && receipt.outcome !== "succeeded") return null;
	if (receipt.exitCode !== 0) return null;
	return receipt.outcomeDetail ?? null;
}

interface CompletedRun {
	receipt: RunReceipt;
	receiptPath: string | null;
	summary: EventSummary;
}

class PipelineHaltError extends Error {
	constructor(
		message: string,
		readonly runs: ReadonlyArray<CompletedRun>,
	) {
		super(message);
		this.name = "PipelineHaltError";
	}
}

function formatDispatchOutput(mode: string, runs: ReadonlyArray<CompletedRun>, maxOutputBytes: number): string {
	const failed = runs.filter((run) => run.receipt.exitCode !== 0);
	const perRunOutputBytes = Math.max(1024, Math.floor(maxOutputBytes / Math.max(1, runs.length)));
	const lines = [
		`dispatch (${mode}) total=${runs.length} failed=${failed.length}`,
		`runs=${runs.map((run) => run.receipt.runId).join(", ")}`,
		"",
		...runs.flatMap(({ receipt, receiptPath, summary }, index) => {
			const note = successNote(receipt);
			const noteSuffix = note !== null ? ` note=${note}` : "";
			const failure = receipt.failureMessage ? ` failure=${receipt.failureMessage}` : "";
			// Pipeline runs are an ordered chain, so each line names its step.
			const stepLabel = mode === "pipeline" ? `step ${index + 1}/${runs.length} ` : "";
			// Provenance suffix is empty for a legacy receipt, so the line format is
			// unchanged when a run carries no pipeline/persona/escalation fields.
			const provenance = provenanceCompactSuffix(extractRunProvenance(receipt));
			const output =
				summary.lastAssistantText.length > 0
					? truncateUtf8(summary.lastAssistantText, perRunOutputBytes, TRUNCATION_MARKER)
					: "(no assistant text captured)";
			return [
				`- ${stepLabel}${receipt.runId} agent=${receipt.agentId} exit=${receipt.exitCode} target=${receipt.targetId} model=${receipt.wireModelId} tokens=${receipt.tokenCount} receipt=${receiptPath ?? "n/a"}${noteSuffix}${failure}${provenance}`,
				"  agent output:",
				...output.split("\n").map((line) => `  ${line}`),
			];
		}),
	];
	return truncateUtf8(lines.join("\n"), maxOutputBytes, TRUNCATION_MARKER);
}

function dispatchDetails(mode: string, runs: ReadonlyArray<CompletedRun>): ToolResultDetails {
	const failed = runs.filter((run) => run.receipt.exitCode !== 0);
	return {
		mode,
		runIds: runs.map((run) => run.receipt.runId),
		receiptCount: runs.length,
		failedCount: failed.length,
		runs: runs.map(({ receipt, receiptPath, summary }) => {
			// Additive provenance keys only; folded in when the receipt carries the
			// field so a legacy run entry keeps its exact shape.
			const provenance = extractRunProvenance(receipt);
			return {
				runId: receipt.runId,
				agentId: receipt.agentId,
				exitCode: receipt.exitCode,
				receiptPath,
				eventCount: summary.count,
				...(provenance.pipeline !== undefined ? { pipeline: provenance.pipeline } : {}),
				...(provenance.personaOverride !== undefined ? { personaOverride: provenance.personaOverride } : {}),
				...(provenance.escalation !== undefined ? { escalation: provenance.escalation } : {}),
				...(provenance.autonomyEnforcement !== undefined ? { autonomyEnforcement: provenance.autonomyEnforcement } : {}),
			};
		}),
	};
}

export function createDispatchTool(deps: DispatchToolDeps): ToolSpec {
	return {
		name: ToolNames.Dispatch,
		description:
			"Dispatch bounded tasks to Clio fleet agents: tasks is an array of task strings or {agent, task} objects, mode=parallel (default), sequential, or pipeline. Task objects may include persona and tool_profile to compose a bounded ad-hoc specialist with narrowed tools. In pipeline mode tasks run one at a time and each step receives the previous step's final output as input data. Call with list:true to see available agents. Use the returned receipts/output as evidence; do not repeat an identical successful dispatch in the same user turn.",
		parameters: Type.Object({
			list: Type.Optional(Type.Boolean({ description: "List available agents instead of dispatching." })),
			tasks: Type.Optional(
				Type.Array(
					Type.Union([
						Type.String(),
						Type.Object({
							task: Type.String({ description: "Concrete agent task with expected output and constraints." }),
							agent: Type.Optional(Type.String({ description: "Agent recipe id (default coder)." })),
							persona: Type.Optional(
								Type.String({
									description:
										"Ad-hoc specialist persona to substitute for the recipe body inside the stable worker shell, max 8000 chars.",
								}),
							),
							tool_profile: Type.Optional(stringEnum(TOOL_PROFILE_NAMES, "Narrow this worker's available tools.")),
							target: Type.Optional(Type.String()),
							model: Type.Optional(Type.String()),
							node: Type.Optional(Type.String({ description: "Fleet node pin: local or a fleet.nodes id." })),
							cwd: Type.Optional(Type.String()),
						}),
					]),
					{ description: "Tasks to dispatch; a single object or string is accepted and wrapped." },
				),
			),
			mode: Type.Optional(
				stringEnum(
					["parallel", "sequential", "pipeline"],
					"Run tasks concurrently (default), one at a time, or as a pipeline where each task receives the previous task's output as input data.",
				),
			),
			agent: Type.Optional(Type.String({ description: "Default agent recipe for string tasks (default coder)." })),
			persona: Type.Optional(
				Type.String({
					description: "Default ad-hoc specialist persona for dispatched tasks, max 8000 chars.",
				}),
			),
			tool_profile: Type.Optional(stringEnum(TOOL_PROFILE_NAMES, "Default worker tool profile.")),
			target: Type.Optional(Type.String({ description: "Default configured target id (omit for fleet default)." })),
			model: Type.Optional(Type.String({ description: "Default model override." })),
			node: Type.Optional(
				Type.String({ description: "Default fleet node pin: local or a fleet.nodes id (omit for automatic placement)." }),
			),
			thinking_level: Type.Optional(stringEnum(THINKING_LEVELS)),
			cwd: Type.Optional(Type.String({ description: "Default agent working directory." })),
			timeout_ms: Type.Optional(Type.Number({ description: "Abort the dispatch after this many ms." })),
			max_output_bytes: Type.Optional(Type.Number({ description: "Max summary bytes returned." })),
		}),
		baseActionClass: "dispatch",
		executionMode: "sequential",
		prepareArguments: prepareDispatchArguments,
		async run(rawArgs, options): Promise<ToolResult> {
			const args = prepareDispatchArguments(rawArgs);
			if (args.list === true) {
				const catalog = deps.getAgentCatalog?.().trim() ?? "";
				if (catalog.length === 0) {
					return { kind: "error", message: "dispatch: no agent catalog is available in this context" };
				}
				return { kind: "ok", output: catalog };
			}
			const parsed = dispatchRequestsFromArgs(args);
			if (!parsed.ok) return { kind: "error", message: parsed.message };
			const mode = args.mode === "sequential" ? "sequential" : args.mode === "pipeline" ? "pipeline" : "parallel";
			if (args.mode !== undefined && args.mode !== "parallel" && args.mode !== "sequential" && args.mode !== "pipeline") {
				return {
					kind: "error",
					message: `dispatch: mode must be parallel, sequential, or pipeline; got '${String(args.mode)}'`,
				};
			}
			if (options?.signal?.aborted) return { kind: "error", message: "dispatch: aborted" };
			const maxOutputBytes = maxOutputBytesArg(args);
			const timeoutMs = timeoutMsArg(args);

			try {
				let runs: CompletedRun[];
				if (mode === "pipeline" && parsed.requests.length > 1) {
					runs = await runPipeline(deps, parsed.requests, timeoutMs, options?.signal);
				} else if (mode === "sequential" || mode === "pipeline" || parsed.requests.length === 1) {
					// A single-task pipeline has nothing to thread, so it degrades to
					// plain sequential and no pipeline-input message is sent.
					runs = await runSequential(deps, parsed.requests, mode, timeoutMs, options?.signal);
				} else {
					runs = await runBatch(deps, parsed.requests, timeoutMs, options?.signal);
				}
				const output = formatDispatchOutput(mode, runs, maxOutputBytes);
				const details = dispatchDetails(mode, runs);
				const failed = runs.filter((run) => run.receipt.exitCode !== 0);
				if (failed.length > 0) return { kind: "error", message: output, details };
				return { kind: "ok", output, details };
			} catch (err) {
				if (err instanceof PipelineHaltError) {
					const haltMessage = `dispatch: ${err.message}`;
					const output = formatDispatchOutput("pipeline", err.runs, maxOutputBytes);
					return {
						kind: "error",
						message: `${haltMessage}\n\n${output}`,
						details: dispatchDetails("pipeline", err.runs),
					};
				}
				return { kind: "error", message: `dispatch: ${err instanceof Error ? err.message : String(err)}` };
			}
		},
	};
}

/**
 * One at a time: each run completes before the next dispatches. Also serves
 * single-task parallel calls, where batching adds nothing. The timeout and
 * abort signal cover the whole sequence; remaining tasks are skipped once
 * either fires and the skip is reported through the thrown error.
 */
async function runSequential(
	deps: DispatchToolDeps,
	requests: ReadonlyArray<DispatchRequest>,
	mode: string,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<CompletedRun[]> {
	const runs: CompletedRun[] = [];
	let expired = false;
	let activeRunId: string | null = null;
	// The operator signal is a cancel; the timer is a timeout. Both stop the
	// sequence, but the timeout carries a cause so the receipt names it.
	const abortActive = (bySignal: boolean): void => {
		expired = true;
		if (activeRunId !== null) {
			deps.dispatch.abort(
				activeRunId,
				bySignal ? undefined : { cause: "timeout", detail: `timed out after ${timeoutMs}ms` },
			);
		}
	};
	const onSignalAbort = (): void => abortActive(true);
	const timer = timeoutMs !== undefined ? setTimeout(() => abortActive(false), timeoutMs) : null;
	signal?.addEventListener("abort", onSignalAbort, { once: true });
	try {
		for (const request of requests) {
			if (expired || signal?.aborted) {
				throw new Error(
					`${mode} dispatch stopped after ${runs.length}/${requests.length} task(s): ${signal?.aborted ? "aborted" : `timed out after ${timeoutMs}ms`}`,
				);
			}
			const handle = await deps.dispatch.dispatch(request);
			activeRunId = handle.runId;
			const summary = await consumeDispatchEvents(handle.runId, request.agentId, handle.events, deps.bus);
			const receipt = await handle.finalPromise;
			activeRunId = null;
			runs.push({
				receipt,
				receiptPath: deps.dispatch.getRun(receipt.runId)?.receiptPath ?? null,
				summary,
			});
		}
		return runs;
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onSignalAbort);
	}
}

/** A pipeline step failed when its worker exited nonzero or its outcome is not success. */
function isPipelineStepFailure(receipt: RunReceipt): boolean {
	if (receipt.exitCode !== 0) return true;
	return receipt.outcome !== undefined && receipt.outcome !== "succeeded";
}

function pipelineFailureReason(receipt: RunReceipt): string {
	if (receipt.outcome !== undefined && receipt.outcome !== "succeeded") return `outcome=${receipt.outcome}`;
	return `exit=${receipt.exitCode}`;
}

/**
 * Chain worker outputs: each step runs to completion, then its final assistant
 * text is threaded to the next step as `pipelineInput` (data, not instruction
 * text). Step 1 receives none. A failed step halts the chain and the thrown
 * error names the step and how many later steps were skipped, mirroring
 * runSequential's "stopped after N/M" phrasing. Whole-sequence timeout and
 * abort handling match runSequential.
 */
async function runPipeline(
	deps: DispatchToolDeps,
	requests: ReadonlyArray<DispatchRequest>,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<CompletedRun[]> {
	const runs: CompletedRun[] = [];
	let expired = false;
	let activeRunId: string | null = null;
	// The operator signal is a cancel; the timer is a timeout. Both stop the
	// chain, but the timeout carries a cause so the receipt names it.
	const abortActive = (bySignal: boolean): void => {
		expired = true;
		if (activeRunId !== null) {
			deps.dispatch.abort(
				activeRunId,
				bySignal ? undefined : { cause: "timeout", detail: `timed out after ${timeoutMs}ms` },
			);
		}
	};
	const onSignalAbort = (): void => abortActive(true);
	const timer = timeoutMs !== undefined ? setTimeout(() => abortActive(false), timeoutMs) : null;
	signal?.addEventListener("abort", onSignalAbort, { once: true });
	try {
		let previous: { runId: string; text: string } | null = null;
		for (const [index, base] of requests.entries()) {
			if (expired || signal?.aborted) {
				throw new Error(
					`pipeline dispatch stopped after ${runs.length}/${requests.length} task(s): ${signal?.aborted ? "aborted" : `timed out after ${timeoutMs}ms`}`,
				);
			}
			// Thread the previous step's output as data; the task string the
			// orchestrator authored is sent verbatim. Step 1 (previous === null)
			// carries no pipeline input.
			const request: DispatchRequest =
				previous === null
					? base
					: { ...base, pipelineInput: { fromRunId: previous.runId, position: index + 1, text: previous.text } };
			const handle = await deps.dispatch.dispatch(request);
			activeRunId = handle.runId;
			const summary = await consumeDispatchEvents(handle.runId, request.agentId, handle.events, deps.bus);
			const receipt = await handle.finalPromise;
			activeRunId = null;
			runs.push({
				receipt,
				receiptPath: deps.dispatch.getRun(receipt.runId)?.receiptPath ?? null,
				summary,
			});
			if (isPipelineStepFailure(receipt)) {
				const skipped = requests.length - (index + 1);
				throw new PipelineHaltError(
					`pipeline dispatch halted at step ${index + 1}/${requests.length} (run ${receipt.runId}, ${pipelineFailureReason(receipt)}); skipped ${skipped} later step(s)`,
					[...runs],
				);
			}
			previous = { runId: receipt.runId, text: summary.lastAssistantText };
		}
		return runs;
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onSignalAbort);
	}
}

async function runBatch(
	deps: DispatchToolDeps,
	requests: ReadonlyArray<DispatchRequest>,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<CompletedRun[]> {
	const handle = await deps.dispatch.dispatchBatch(requests);
	// The operator signal is a cancel; the timer is a timeout. The timeout
	// carries a cause so each killed run's receipt names it.
	const abort = (bySignal: boolean): void => {
		const reason = bySignal ? undefined : ({ cause: "timeout", detail: `timed out after ${timeoutMs}ms` } as const);
		for (const runId of handle.runIds) deps.dispatch.abort(runId, reason);
	};
	const onSignalAbort = (): void => abort(true);
	const timer = timeoutMs !== undefined ? setTimeout(() => abort(false), timeoutMs) : null;
	signal?.addEventListener("abort", onSignalAbort, { once: true });
	try {
		const summaries = await consumeBatchEvents(handle.batchId, handle.events, deps.bus);
		const receipts = await handle.finalPromise;
		return receipts.map((receipt) => ({
			receipt,
			receiptPath: deps.dispatch.getRun(receipt.runId)?.receiptPath ?? null,
			summary: summaries.get(receipt.runId) ?? { count: 0, types: [], lastAssistantText: "" },
		}));
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onSignalAbort);
	}
}
