import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import { ToolNames } from "../core/tool-names.js";
import { clioStateDir } from "../core/xdg.js";
import type {
	AbortReason,
	DispatchContract,
	DispatchPlanTaskResolution,
	DispatchRequest,
} from "../domains/dispatch/contract.js";
import { durableAssistantTextFromEvent } from "../domains/dispatch/event-pump.js";
import {
	finalizePendingGateDecision,
	type GateDecisionArtifact,
	type GateDecisionDraft,
	materializePendingGateDecision,
	type PendingGateDecisionHandle,
	readGateDecisionArtifacts,
	readPendingGateDecisions,
	resolvePendingGateDecision,
	stagePendingGateDecision,
	stagePendingGateOutput,
	writeGateDecisionArtifact,
} from "../domains/dispatch/gate-decisions.js";
import { JUDGE_GATE_PROMPT, REVIEWER_GATE_PROMPT } from "../domains/dispatch/gate-role-prompts.js";
import { readReceiptVerification } from "../domains/dispatch/receipt-findings.js";
import { type ReceiptIntegrityResult, verifyReceiptIntegrity } from "../domains/dispatch/receipt-integrity.js";
import type { RunGateProvenance, RunGateSubjectRef, RunPlanProvenance, RunReceipt } from "../domains/dispatch/types.js";
import { DISPATCH_BRIEFING_MAX_BYTES, type JobThinkingLevel } from "../domains/dispatch/validation.js";
import { extractRunProvenance, provenanceCompactSuffix } from "../domains/evidence/provenance.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";
import {
	type CandidateWorktree,
	type CompeteGroupOwnership,
	candidateDiffStat,
	claimCompeteGroup,
	cleanupCompeteGroup,
	commitCandidateWork,
	createCandidateWorktree,
	isGitRepository,
	loadCompeteGroup,
	markCompeteGroupCleanupReady,
	markCompeteGroupWinnerPreserved,
	mergeWinnerBranch,
	protectedPathsChangedByCompeteBranch,
	recoverCleanupReadyCompeteGroups,
	registerCompeteGroupRun,
	removeCandidateWorktree,
	settleCompeteGroupRun,
	settleRecoveredCompeteDecision,
} from "./compete-worktrees.js";
import {
	DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT,
	describeDispatchPlan,
	RESOLVED_DISPATCH_PLAN_ARGUMENT,
	type ResolvedDispatchPlanArtifact,
	resolvedDispatchPlanFromArgs,
	withResolvedDispatchPlan,
} from "./dispatch-plan.js";
import { isToolProfileName, TOOL_PROFILE_NAMES } from "./profiles.js";
import type { ToolResult, ToolResultDetails, ToolSpec } from "./registry.js";
import { parseScoutSplitRecommendation, type ScoutSplitRecommendation } from "./scout-split-recommendation.js";
import { stringEnum } from "./string-enum.js";
import { truncateUtf8 } from "./truncate-utf8.js";
import {
	receiptEvidenceLabels,
	SPOT_CHECK_GUIDANCE,
	workerTextLabel,
	workerTextNonEvidenceNotices,
} from "./worker-evidence.js";

const DEFAULT_AGENT_ID = "coder";
const DEFAULT_MAX_OUTPUT_BYTES = 20_000;
const TRUNCATION_MARKER = "\n[agent output truncated]";
const PERSONA_MAX_CHARS = 8_000;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const VALID_THINKING = new Set<JobThinkingLevel>(THINKING_LEVELS);

export interface DispatchToolDeps {
	dispatch: DispatchContract;
	bus?: SafeEventBus;
	/** Instance-scoped owner for ordinary tool-owned run streams and monitor tails. */
	runEvents?: DispatchRunEventRegistry;
	/** Optional compete storage overrides for alternate backends and deterministic fault tests. */
	competeWorktrees?: {
		createCandidate?: typeof createCandidateWorktree;
		cleanupGroup?: typeof cleanupCompeteGroup;
		mergeWinner?: typeof mergeWinnerBranch;
	};
	/** Renders the agent fleet catalog for the `list: true` action. */
	getAgentCatalog?: () => string;
	/**
	 * Session-effective autonomy level. Plan provenance records how the plan
	 * gate resolved (operator approval versus full-auto logging) and compete
	 * decides whether to apply the judge's pick or hand the winner to the
	 * operator. Absent (minimal test bundles) defaults to auto-edit.
	 */
	getAutonomy?: () => AutonomyLevel;
	/** Scheduling cost ceiling recorded on plan provenance when available. */
	getCostCeilingUsd?: () => number;
}

interface EventSummary {
	count: number;
	types: string[];
	lastAssistantText: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ResolvedPlanTask = ResolvedDispatchPlanArtifact["tasks"][number];

function withResolvedTaskPin(
	request: DispatchRequest,
	task: ResolvedPlanTask | undefined,
	options: { pinTask?: boolean } = {},
): DispatchRequest {
	if (task === undefined) return request;
	// Omit the raw briefing and failover envelope before restoring the approved
	// values. With exact optional properties, approved absence means the field
	// must be absent—not present as undefined—and must clear any untrusted raw
	// default. The failover mode and allowedCandidates are execution-authoritative
	// route policy, so a post-approval raw mutation cannot widen the envelope.
	const {
		briefing: _untrustedBriefing,
		failover: _untrustedFailover,
		allowedCandidates: _untrustedCandidates,
		...requestWithoutUntrusted
	} = request;
	return {
		...requestWithoutUntrusted,
		agentId: task.agent,
		...(request.reservation !== undefined && task.role !== undefined && task.position !== undefined
			? { reservation: { ownerId: request.reservation.ownerId, memberId: `${task.role}-${task.position}` } }
			: {}),
		...(task.failover !== undefined ? { failover: task.failover } : {}),
		...(task.allowedCandidates !== undefined
			? { allowedCandidates: task.allowedCandidates.map((candidate) => ({ ...candidate })) }
			: {}),
		// Primary builder/candidate/task text comes from operator-controlled
		// arguments and must be restored from the approved artifact. Reviewer and
		// judge text is synthesized later from sealed run ids, receipts, and diff
		// stats; for those roles the artifact pins the route while the coordinator
		// retains the freshly generated task.
		task: options.pinTask === false ? request.task : task.task,
		...(task.briefing !== undefined ? { briefing: task.briefing } : {}),
		target: task.target,
		model: task.model,
		node: task.node,
		plannedNode: {
			id: task.node,
			kind: task.nodeKind,
			...(task.nodeHost !== undefined ? { host: task.nodeHost } : {}),
		},
	};
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

interface RegisteredSingleDispatch {
	runId: string;
	completion: Promise<{ receipt: RunReceipt; summary: EventSummary }>;
}

interface RegisteredBatchDispatch {
	batchId: string;
	runIds: ReadonlyArray<string>;
	completion: Promise<{ receipts: ReadonlyArray<RunReceipt>; summaries: Map<string, EventSummary> }>;
}

/**
 * Instance-scoped owner of ordinary model-facing dispatch iterators and their
 * monitor tails. Registering a handle starts its sole drain immediately; sync
 * callers await `completion` while detached callers retain that same drain.
 *
 * Review and compete coordinators are intentional exceptions: they drain each
 * gate-sensitive iterator directly, stage reviewer/judge output, and only then
 * await the receipt. They use `recordEvent` to retain monitor-tail projection
 * without surrendering iterator ownership to this registry.
 */
export interface DispatchRunEventRegistry {
	registerSingle(
		handle: Awaited<ReturnType<DispatchContract["dispatch"]>>,
		agentId: string,
		bus?: SafeEventBus,
	): RegisteredSingleDispatch;
	registerBatch(
		handle: Awaited<ReturnType<DispatchContract["dispatchBatch"]>>,
		agentIds: ReadonlyArray<string>,
		bus?: SafeEventBus,
	): RegisteredBatchDispatch;
	recordEvent(runId: string, agentId: string, event: unknown): void;
	eventTail(runId: string): { agentId: string; entries: ReadonlyArray<RunTailEntry> } | null;
}

export function createDispatchRunEventRegistry(): DispatchRunEventRegistry {
	const runTails = new Map<string, RunTailState>();
	const activeRuns = new Set<string>();
	const activeBatches = new Set<string>();

	const pruneRunTails = (): void => {
		while (runTails.size > RUN_TAIL_RUN_LIMIT) {
			let oldestKey: string | null = null;
			let oldestSeen = Number.POSITIVE_INFINITY;
			for (const [key, state] of runTails) {
				if (activeRuns.has(key) || state.lastSeenAt >= oldestSeen) continue;
				oldestKey = key;
				oldestSeen = state.lastSeenAt;
			}
			if (oldestKey === null) break;
			runTails.delete(oldestKey);
		}
	};

	const recordRunEvent = (runId: string, agentId: string, event: unknown): void => {
		const type = isRecord(event) && typeof event.type === "string" ? event.type : "unknown";
		if (type === "heartbeat" || type === "message_update") return;
		const state = runTails.get(runId) ?? { agentId, entries: [], lastSeenAt: Date.now() };
		state.lastSeenAt = Date.now();
		const entry: RunTailEntry = { at: new Date().toISOString(), type };
		const detail = eventDetail(event);
		if (detail !== undefined) entry.detail = detail;
		state.entries.push(entry);
		if (state.entries.length > RUN_TAIL_ENTRY_LIMIT) {
			state.entries.splice(0, state.entries.length - RUN_TAIL_ENTRY_LIMIT);
		}
		runTails.set(runId, state);
		pruneRunTails();
	};

	const drainSingle = async (
		runId: string,
		agentId: string,
		events: AsyncIterableIterator<unknown>,
		bus: SafeEventBus | undefined,
	): Promise<EventSummary> => {
		const summary: EventSummary = { count: 0, types: [], lastAssistantText: "" };
		for await (const event of events) {
			summary.count += 1;
			const type = isRecord(event) && typeof event.type === "string" ? event.type : "unknown";
			summary.types.push(type);
			const text = rawAssistantTextFromEvent(event);
			if (text.trim().length > 0) summary.lastAssistantText = text;
			recordRunEvent(runId, agentId, event);
			if (type !== "heartbeat") bus?.emit(BusChannels.DispatchProgress, { runId, agentId, event });
		}
		return summary;
	};

	const drainBatch = async (
		batchId: string,
		events: AsyncIterableIterator<unknown>,
		bus: SafeEventBus | undefined,
	): Promise<Map<string, EventSummary>> => {
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
			const text = rawAssistantTextFromEvent(inner);
			if (text.trim().length > 0) summary.lastAssistantText = text;
			summaries.set(runId, summary);
			recordRunEvent(runId, agentId, inner);
			if (type !== "heartbeat") bus?.emit(BusChannels.DispatchProgress, { runId, agentId, event: inner });
		}
		return summaries;
	};

	return {
		registerSingle(handle, agentId, bus) {
			if (activeRuns.has(handle.runId)) {
				throw new Error(`dispatch event registry: run '${handle.runId}' is already registered`);
			}
			activeRuns.add(handle.runId);
			const summaryPromise = drainSingle(handle.runId, agentId, handle.events, bus);
			const completion = Promise.allSettled([summaryPromise, handle.finalPromise]).then(
				([summaryResult, receiptResult]) => {
					if (summaryResult.status === "rejected") throw summaryResult.reason;
					if (receiptResult.status === "rejected") throw receiptResult.reason;
					return { receipt: receiptResult.value, summary: summaryResult.value };
				},
			);
			void completion
				.finally(() => {
					activeRuns.delete(handle.runId);
					pruneRunTails();
				})
				.catch(() => {});
			return { runId: handle.runId, completion };
		},
		registerBatch(handle, agentIds, bus) {
			if (activeBatches.has(handle.batchId)) {
				throw new Error(`dispatch event registry: batch '${handle.batchId}' is already registered`);
			}
			const duplicateRunId = handle.runIds.find((runId, index) => handle.runIds.slice(0, index).includes(runId));
			if (duplicateRunId !== undefined) {
				throw new Error(`dispatch event registry: batch '${handle.batchId}' repeats run '${duplicateRunId}'`);
			}
			const activeRunId = handle.runIds.find((runId) => activeRuns.has(runId));
			if (activeRunId !== undefined) {
				throw new Error(`dispatch event registry: run '${activeRunId}' is already registered`);
			}
			activeBatches.add(handle.batchId);
			for (const runId of handle.runIds) activeRuns.add(runId);
			const completion = Promise.allSettled([drainBatch(handle.batchId, handle.events, bus), handle.finalPromise]).then(
				([summariesResult, receiptsResult]) => {
					if (summariesResult.status === "rejected") throw summariesResult.reason;
					if (receiptsResult.status === "rejected") throw receiptsResult.reason;
					return { receipts: receiptsResult.value, summaries: summariesResult.value };
				},
			);
			void completion
				.finally(() => {
					activeBatches.delete(handle.batchId);
					for (const runId of handle.runIds) activeRuns.delete(runId);
					pruneRunTails();
				})
				.catch(() => {});
			// Seed agent routing even when a run completes before its first event.
			for (const [index, runId] of handle.runIds.entries()) {
				if (!runTails.has(runId)) {
					runTails.set(runId, { agentId: agentIds[index] ?? "unknown", entries: [], lastSeenAt: Date.now() });
				}
			}
			return { batchId: handle.batchId, runIds: handle.runIds, completion };
		},
		recordEvent: recordRunEvent,
		eventTail(runId) {
			const state = runTails.get(runId);
			if (!state) return null;
			return { agentId: state.agentId, entries: [...state.entries] };
		},
	};
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
	if ("briefing" in args && args.briefing !== undefined) {
		if (typeof args.briefing !== "string") return { ok: false, message: "briefing must be a string" };
		const briefing = args.briefing.trim();
		if (Buffer.byteLength(briefing, "utf8") > DISPATCH_BRIEFING_MAX_BYTES) {
			return { ok: false, message: `briefing must be ${DISPATCH_BRIEFING_MAX_BYTES} UTF-8 bytes or fewer` };
		}
		if (briefing.length > 0) request.briefing = briefing;
	}

	const target = stringArg(args, "target");
	if (target) request.target = target;
	const model = stringArg(args, "model");
	if (model) request.model = model;
	const node = stringArg(args, "node");
	if (node) request.node = node;
	const failover = stringArg(args, "failover");
	if (failover) {
		if (failover !== "none" && failover !== "approved" && failover !== "automatic") {
			return { ok: false, message: "failover must be one of none|approved|automatic" };
		}
		request.failover = failover;
	}
	if (args.allowed_candidates !== undefined) {
		if (!Array.isArray(args.allowed_candidates) || args.allowed_candidates.length === 0) {
			return { ok: false, message: "allowed_candidates must be a non-empty array" };
		}
		const candidates = [];
		for (const candidate of args.allowed_candidates) {
			if (!isRecord(candidate)) return { ok: false, message: "allowed_candidates entries must be objects" };
			const agentId = stringArg(candidate, "agent", "agentId");
			const candidateTarget = stringArg(candidate, "target");
			const candidateModel = stringArg(candidate, "model");
			const candidateNode = stringArg(candidate, "node");
			if (!agentId || !candidateTarget || !candidateModel || !candidateNode) {
				return {
					ok: false,
					message: "allowed_candidates entries require non-empty agent, target, model, and node",
				};
			}
			candidates.push({ agentId, target: candidateTarget, model: candidateModel, node: candidateNode });
		}
		request.allowedCandidates = candidates;
	}
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
			return { ok: false, message: "thinking_level must be one of off|minimal|low|medium|high|xhigh|max" };
		}
		request.thinkingLevel = thinkingLevel as JobThinkingLevel;
	}

	return { ok: true, request };
}

function dispatchRequestsFromArgs(
	args: Record<string, unknown>,
): { ok: true; requests: DispatchRequest[] } | { ok: false; message: string } {
	if (Object.hasOwn(args, "task") && Object.hasOwn(args, "tasks")) {
		return { ok: false, message: "dispatch: pass either task for one run or tasks for a batch, not both" };
	}
	const tasks = args.tasks;
	if (!Array.isArray(tasks) || tasks.length === 0) {
		return {
			ok: false,
			message:
				args.tasks === undefined
					? 'dispatch: missing task; pass task="..." for one run or tasks=[...] for a batch. briefing is optional context and cannot replace task. Example: {"agent":"scout","task":"map the modules that read fleet config and cite file paths"}'
					: "dispatch: tasks must be a non-empty array of task strings or {agent, task} objects",
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

/**
 * The worker's answer is the text of the last assistant `message_end` event.
 * Shared with the headless `clio run --agent` path so both surfaces extract
 * the final answer from the same event shape.
 */
function rawAssistantTextFromEvent(event: unknown): string {
	return durableAssistantTextFromEvent(event);
}

export function assistantTextFromEvent(event: unknown): string {
	return rawAssistantTextFromEvent(event).trim();
}

function normalizedAssistantText(summary: EventSummary): string {
	return summary.lastAssistantText.trim();
}

type RegisteredDispatchToolDeps = DispatchToolDeps & { runEvents: DispatchRunEventRegistry };

function fallbackProgressBus(deps: DispatchToolDeps): SafeEventBus | undefined {
	return deps.dispatch.ownsProgressBus?.(deps.bus) === true ? undefined : deps.bus;
}

/**
 * Gate-sensitive coordinator drain. Review and compete must finish this drain
 * and stage pending decision output before awaiting the receipt-facing final
 * promise; the ordinary registry's concurrent join cannot provide that edge.
 */
async function consumeGateSensitiveDispatchEvents(
	deps: RegisteredDispatchToolDeps,
	runId: string,
	agentId: string,
	events: AsyncIterableIterator<unknown>,
): Promise<EventSummary> {
	const summary: EventSummary = { count: 0, types: [], lastAssistantText: "" };
	const bus = fallbackProgressBus(deps);
	for await (const event of events) {
		summary.count += 1;
		const type = isRecord(event) && typeof event.type === "string" ? event.type : "unknown";
		summary.types.push(type);
		const text = rawAssistantTextFromEvent(event);
		if (text.trim().length > 0) summary.lastAssistantText = text;
		deps.runEvents.recordEvent(runId, agentId, event);
		if (type !== "heartbeat") bus?.emit(BusChannels.DispatchProgress, { runId, agentId, event });
	}
	return summary;
}

/**
 * Fan out without waiting: admit and spawn every task, persist the durable
 * batch record, then hand the merged event stream to a background drain so
 * token metering, run tails (monitor peek), and bus progress keep flowing
 * while the orchestrator's turn continues. The tool result carries only the
 * batch id and run ids; results are gathered later through monitor
 * mode="wait"/"collect", in this session or after a resume.
 */
async function runDetached(
	deps: RegisteredDispatchToolDeps,
	requests: ReadonlyArray<DispatchRequest>,
	sessionId: string | null,
): Promise<ToolResult> {
	const detached = deps.dispatch.detached;
	if (!detached) {
		return { kind: "error", message: "dispatch: detach is not supported in this context" };
	}
	const handle = await deps.dispatch.dispatchBatch(requests);
	const registered = deps.runEvents.registerBatch(
		handle,
		requests.map((request) => request.agentId),
		fallbackProgressBus(deps),
	);
	// dispatchBatch admits requests in order, so runIds[i] belongs to requests[i].
	const assignmentIds = handle.assignmentIds ?? handle.runIds;
	const runs = handle.runIds.map((runId, index) => ({
		runId,
		assignmentId: assignmentIds[index] ?? runId,
		agentId: requests[index]?.agentId ?? "unknown",
	}));
	registered.completion.catch(() => {});
	// The runs are live; make their assignment records durable before returning
	// so an immediate collect resolves the logical assignment (and any queued
	// retry) instead of falling back to a bare, possibly-failed first attempt.
	await deps.dispatch.assignments?.flushWrites?.();
	try {
		await detached.register({ batchId: handle.batchId, runs, sessionId });
	} catch (err) {
		// The runs are already live; report the durability gap instead of
		// pretending the batch does not exist.
		const message = err instanceof Error ? err.message : String(err);
		return {
			kind: "error",
			message: `dispatch: detached runs started (batch=${handle.batchId}, runs=${handle.runIds.join(", ")}) but the durable batch record failed: ${message}`,
			details: { mode: "detached", batchId: handle.batchId, runIds: [...handle.runIds] },
		};
	}
	const lines = [
		`dispatch (detached) batch=${handle.batchId} started ${runs.length} run(s)`,
		...runs.map((run) => `- ${run.assignmentId} agent=${run.agentId}`),
		"",
		`Runs continue in the background. Collect results with monitor(mode="collect", batch_id="${handle.batchId}"); block on one run with monitor(mode="wait", run_id=<id>).`,
	];
	return {
		kind: "ok",
		output: lines.join("\n"),
		details: {
			mode: "detached",
			batchId: handle.batchId,
			runIds: [...handle.runIds],
			runs: runs.map((run) => ({ runId: run.runId, assignmentId: run.assignmentId, agentId: run.agentId })),
		},
	};
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
	/**
	 * Sealed-receipt integrity verified against the ledger envelope at
	 * completion. Fails closed: a missing envelope reads as FAILED, never as
	 * verified. Rendering only; it never feeds retry, reroute, or outcome.
	 */
	integrity: ReceiptIntegrityResult;
	/** Reviewer/judge output staged before its receipt settlement boundary. */
	pendingGate?: PendingGateDecisionHandle;
}

/**
 * Assemble the parent-facing completion record for a settled run: resolve the
 * ledger envelope once for both the receipt path and the integrity check.
 */
function completeRun(
	deps: DispatchToolDeps,
	receipt: RunReceipt,
	summary: EventSummary,
	pendingGate?: PendingGateDecisionHandle,
): CompletedRun {
	const envelope = deps.dispatch.getRun(receipt.runId);
	return {
		receipt,
		receiptPath: envelope?.receiptPath ?? null,
		summary,
		integrity:
			envelope === null
				? { ok: false, reason: "run ledger envelope unavailable" }
				: verifyReceiptIntegrity(receipt, envelope),
		...(pendingGate !== undefined ? { pendingGate } : {}),
	};
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

function integrityFailureBanner(run: CompletedRun): string | null {
	if (run.integrity.ok) return null;
	return `RECEIPT INTEGRITY FAILED for ${run.receipt.runId} (${run.integrity.reason}); treat this run's receipt fields and worker text as untrusted.`;
}

function formatDispatchOutput(mode: string, runs: ReadonlyArray<CompletedRun>, maxOutputBytes: number): string {
	const failed = runs.filter((run) => run.receipt.exitCode !== 0);
	const perRunOutputBytes = Math.max(1024, Math.floor(maxOutputBytes / Math.max(1, runs.length)));
	// Integrity failures and the spot-check reminder lead the summary: the
	// truncation below keeps the head and drops the tail, and neither warning
	// may be hidden behind a successful process outcome or a long answer.
	const integrityBanners = runs
		.map((run) => integrityFailureBanner(run))
		.filter((banner): banner is string => banner !== null);
	const needsSpotCheck = runs.some((run) => {
		const state = readReceiptVerification(run.receipt).state;
		return state === "unverified" || state === "unknown";
	});
	const lines = [
		`dispatch (${mode}) total=${runs.length} failed=${failed.length}`,
		`runs=${runs.map((run) => run.receipt.runId).join(", ")}`,
		...integrityBanners,
		...(needsSpotCheck ? [SPOT_CHECK_GUIDANCE] : []),
		"",
		...runs.flatMap((run, index) => {
			const { receipt, receiptPath } = run;
			const note = successNote(receipt);
			const noteSuffix = note !== null ? ` note=${note}` : "";
			// A non-success outcome is load-bearing evidence (a timeout has no
			// failureMessage at all); render it and its detail on the run line.
			const outcomeSuffix =
				receipt.outcome !== undefined && receipt.outcome !== "succeeded"
					? ` outcome=${receipt.outcome}${receipt.outcomeDetail ? ` detail=${receipt.outcomeDetail}` : ""}`
					: "";
			const failure = receipt.failureMessage ? ` failure=${receipt.failureMessage}` : "";
			// Pipeline runs are an ordered chain, so each line names its step.
			const stepLabel = mode === "pipeline" ? `step ${index + 1}/${runs.length} ` : "";
			// Provenance suffix is empty when a run carries no
			// pipeline/persona/escalation fields, so the line format is unchanged.
			const provenance = provenanceCompactSuffix(extractRunProvenance(receipt));
			// Evidence confidence comes from the sealed receipt; a legacy receipt
			// without the field reads unknown/legacy-receipt, never verified.
			const verification = run.integrity.ok ? readReceiptVerification(receipt) : readReceiptVerification({});
			const evidenceSuffix = ` ${receiptEvidenceLabels(receipt, verification, run.integrity).join(" ")}${
				run.integrity.ok ? "" : " evidence_verification=unknown/receipt-integrity-failed"
			}`;
			// The sealed receipt is authoritative. Live summaries remain useful for
			// monitoring but can contain transient tool-use prose and never override
			// a missing, partial, or integrity-invalid durable answer.
			const answerText =
				run.integrity.ok &&
				(receipt.output?.state === "final" || (receipt.outcome !== undefined && receipt.outcome !== "succeeded"))
					? (receipt.output?.text ?? "")
					: "";
			const output =
				answerText.length > 0
					? truncateUtf8(answerText, perRunOutputBytes, TRUNCATION_MARKER)
					: run.integrity.ok
						? "(no receipt-sealed assistant text captured)"
						: "(worker text withheld because receipt integrity failed)";
			return [
				`- ${stepLabel}${receipt.runId} agent=${receipt.agentId} exit=${receipt.exitCode} target=${receipt.targetId} model=${receipt.wireModelId} tokens=${receipt.tokenCount} receipt=${receiptPath ?? "n/a"}${evidenceSuffix}${outcomeSuffix}${noteSuffix}${failure}${provenance}`,
				`  ${workerTextLabel(verification)}`,
				...output.split("\n").map((line) => `  ${line}`),
				...workerTextNonEvidenceNotices(receipt, verification, answerText).map((notice) => `  ${notice}`),
			];
		}),
	];
	return truncateUtf8(lines.join("\n"), maxOutputBytes, TRUNCATION_MARKER);
}

function dispatchDetails(mode: string, runs: ReadonlyArray<CompletedRun>): ToolResultDetails {
	const failed = runs.filter((run) => run.receipt.exitCode !== 0);
	let splitRecommendation: ScoutSplitRecommendation | null = null;
	for (const run of runs) {
		// Receipt integrity authenticates both the Scout identity and the sealed
		// final output used for this advisory recommendation. Transient event text
		// is never written back to the receipt or allowed to affect control flow.
		if (
			!run.integrity.ok ||
			run.receipt.agentId !== "scout" ||
			run.receipt.output?.state !== "final" ||
			run.receipt.output.text.trim().length === 0
		) {
			continue;
		}
		const parsed = parseScoutSplitRecommendation(run.receipt.output.text);
		if (parsed === null) continue;
		// The top-level shape is singular. Multiple valid Scout envelopes in one
		// dispatch are ambiguous, so fail closed instead of silently selecting one.
		if (splitRecommendation !== null) {
			splitRecommendation = null;
			break;
		}
		splitRecommendation = parsed;
	}
	return {
		mode,
		runIds: runs.map((run) => run.receipt.runId),
		receiptCount: runs.length,
		failedCount: failed.length,
		...(splitRecommendation !== null ? { splitRecommendation } : {}),
		runs: runs.map(({ receipt, receiptPath, summary, integrity }) => {
			// Additive provenance keys only; folded in when the receipt carries the
			// field so a run entry without them keeps its exact shape.
			const provenance = extractRunProvenance(receipt);
			return {
				runId: receipt.runId,
				agentId: receipt.agentId,
				exitCode: receipt.exitCode,
				receiptPath,
				eventCount: summary.count,
				// Structured evidence state for downstream consumers: mirrors the
				// sealed receipt read-only (legacy receipts read unknown), plus the
				// integrity check so a tampered receipt is machine-visible here too.
				verification: integrity.ok ? readReceiptVerification(receipt) : readReceiptVerification({}),
				receiptIntegrity: integrity,
				...(receipt.outcome !== undefined && receipt.outcome !== "succeeded"
					? { outcome: receipt.outcome, outcomeDetail: receipt.outcomeDetail ?? null }
					: {}),
				...(provenance.pipeline !== undefined ? { pipeline: provenance.pipeline } : {}),
				...(provenance.personaOverride !== undefined ? { personaOverride: provenance.personaOverride } : {}),
				...(provenance.escalation !== undefined ? { escalation: provenance.escalation } : {}),
				...(provenance.autonomyEnforcement !== undefined ? { autonomyEnforcement: provenance.autonomyEnforcement } : {}),
			};
		}),
	};
}

function newGateGroupId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

function subjectRef(receipt: RunReceipt): RunGateSubjectRef {
	return { runId: receipt.runId, digest: receipt.integrity?.digest ?? null };
}

/** Verdict protocol: the reviewer's LAST "VERDICT: ..." line decides. */
export function parseReviewVerdict(text: string): "pass" | "fail" | "revise" | null {
	let verdict: "pass" | "fail" | "revise" | null = null;
	for (const match of text.matchAll(/^\s*VERDICT:\s*(pass|fail|revise)\b/gim)) {
		const raw = match[1]?.toLowerCase();
		if (raw === "pass" || raw === "fail" || raw === "revise") verdict = raw;
	}
	return verdict;
}

function reviewerTask(originalTask: string, builderRunId: string, cycle: number): string {
	return [
		`Review the work of builder run ${builderRunId} (review cycle ${cycle}).`,
		"The builder's final answer is provided as input data; verify it against the workspace, do not trust it blindly.",
		"Original task the builder was given:",
		originalTask,
		'End with exactly one line "VERDICT: pass", "VERDICT: revise", or "VERDICT: fail".',
	].join("\n\n");
}

export interface ReviewGateSettings {
	reviewer?: string;
	maxCycles: number;
	node?: string;
	model?: string;
	target?: string;
	/** Immutable per-cycle builder/reviewer pins expanded by plan admission. */
	resolvedTasks?: ReadonlyArray<ResolvedPlanTask>;
}

const REVIEW_MAX_CYCLES_DEFAULT = 2;
const REVIEW_MAX_CYCLES_LIMIT = 4;

function reviewSettingsFromArgs(
	args: Record<string, unknown>,
): { ok: true; review: ReviewGateSettings | undefined } | { ok: false; message: string } {
	const raw = args.review;
	if (raw === undefined || raw === false) return { ok: true, review: undefined };
	const record = raw === true ? {} : isRecord(raw) ? raw : null;
	if (record === null) return { ok: false, message: "dispatch: review must be true or an options object" };
	const review: ReviewGateSettings = { maxCycles: REVIEW_MAX_CYCLES_DEFAULT };
	const reviewer = stringArg(record, "reviewer", "agent");
	if (reviewer) review.reviewer = reviewer;
	if (record.max_cycles !== undefined) {
		const cycles = record.max_cycles;
		if (typeof cycles !== "number" || !Number.isInteger(cycles) || cycles < 1 || cycles > REVIEW_MAX_CYCLES_LIMIT) {
			return { ok: false, message: `dispatch: review.max_cycles must be an integer 1..${REVIEW_MAX_CYCLES_LIMIT}` };
		}
		review.maxCycles = cycles;
	}
	const node = stringArg(record, "node");
	if (node) review.node = node;
	const model = stringArg(record, "model");
	if (model) review.model = model;
	const target = stringArg(record, "target");
	if (target) review.target = target;
	return { ok: true, review };
}

interface GateRunOutcome {
	runs: CompletedRun[];
	decisions: Array<{ artifact: GateDecisionArtifact; path: string }>;
	verdict: "pass" | "fail" | null;
	cycles: number;
	/** Set when the gate ended without a pass/fail verdict and needs the operator. */
	needsDecision?: string;
}

/**
 * Reviewer-gated dispatch: the builder runs, a read-only reviewer evaluates
 * the workspace against the task, and a revise verdict re-runs the builder
 * with the findings threaded as input data. Bounded by maxCycles; exhaustion
 * (or an unparseable reviewer answer at the last cycle) surfaces as a
 * needs-decision outcome, never a silent failure. Receipts chain backward:
 * each reviewer references the builder it reviewed, each revise builder
 * references the reviewer whose findings it received.
 */
async function runReviewGated(
	deps: RegisteredDispatchToolDeps,
	base: DispatchRequest,
	review: ReviewGateSettings,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<GateRunOutcome> {
	const group = newGateGroupId("review");
	const runs: CompletedRun[] = [];
	const decisions: Array<{ artifact: GateDecisionArtifact; path: string }> = [];
	const recordDecision = (
		draft: GateDecisionDraft,
		pending?: PendingGateDecisionHandle,
	): { artifact: GateDecisionArtifact; path: string } => {
		const decision = pending ? finalizePendingGateDecision(pending, draft) : writeGateDecisionArtifact(draft);
		decisions.push(decision);
		return decision;
	};
	let expired = false;
	let activeRunId: string | null = null;
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

	const runOne = async (request: DispatchRequest): Promise<CompletedRun> => {
		if (expired || signal?.aborted) {
			throw new Error(
				`review dispatch stopped after ${runs.length} run(s): ${signal?.aborted ? "aborted" : `timed out after ${timeoutMs}ms`}`,
			);
		}
		const handle = await deps.dispatch.dispatch(request);
		activeRunId = handle.runId;
		const summary = await consumeGateSensitiveDispatchEvents(deps, handle.runId, request.agentId, handle.events);
		let pendingGate: PendingGateDecisionHandle | undefined;
		if (request.gate?.role === "reviewer") {
			try {
				pendingGate = stagePendingGateOutput({
					group: request.gate.group,
					topology: "review",
					cycle: request.gate.cycle,
					subjects: request.gate.subjects ?? [],
					deciderRunId: handle.runId,
					finalOutput: normalizedAssistantText(summary),
					terminalCycle: request.gate.cycle === review.maxCycles,
				});
			} catch (error) {
				try {
					deps.dispatch.abort(handle.runId);
				} catch {
					// The receipt barrier below still observes the admitted process.
				}
				await Promise.allSettled([handle.finalPromise]);
				activeRunId = null;
				throw error;
			}
		}
		let receipt: RunReceipt;
		try {
			receipt = await handle.finalPromise;
		} finally {
			activeRunId = null;
		}
		const completed = completeRun(deps, receipt, summary, pendingGate);
		runs.push(completed);
		return completed;
	};

	try {
		let findings: { reviewer: CompletedRun; text: string } | null = null;
		for (let cycle = 1; cycle <= review.maxCycles; cycle += 1) {
			const builderGate: RunGateProvenance = {
				role: "builder",
				group,
				cycle,
				...(findings !== null ? { subjects: [subjectRef(findings.reviewer.receipt)], verdict: "revise" } : {}),
			};
			const builderRequest: DispatchRequest = {
				...base,
				gate: builderGate,
				...(findings !== null
					? { pipelineInput: { fromRunId: findings.reviewer.receipt.runId, position: cycle, text: findings.text } }
					: {}),
			};
			const builder = await runOne(
				withResolvedTaskPin(
					builderRequest,
					review.resolvedTasks?.find((task) => task.role === "builder" && task.position === cycle),
				),
			);
			if (isPipelineStepFailure(builder.receipt)) {
				recordDecision({
					group,
					topology: "review",
					cycle,
					outcome: "exhausted",
					subjects: [subjectRef(builder.receipt)],
					detail: `builder ended ${pipelineFailureReason(builder.receipt)}`,
				});
				return {
					runs,
					decisions,
					verdict: null,
					cycles: cycle,
					needsDecision: `builder run ${builder.receipt.runId} ended ${pipelineFailureReason(builder.receipt)} in cycle ${cycle}`,
				};
			}
			const reviewerRequest: DispatchRequest = {
				agentId: review.reviewer ?? base.agentId,
				task: reviewerTask(base.task, builder.receipt.runId, cycle),
				systemPrompt: REVIEWER_GATE_PROMPT,
				autonomy: "read-only",
				gate: { role: "reviewer", group, cycle, subjects: [subjectRef(builder.receipt)] },
				pipelineInput: {
					fromRunId: builder.receipt.runId,
					position: cycle,
					text: normalizedAssistantText(builder.summary),
				},
				...(base.cwd !== undefined ? { cwd: base.cwd } : {}),
				...(review.node !== undefined ? { node: review.node } : {}),
				...(review.model !== undefined ? { model: review.model } : {}),
				...(review.target !== undefined ? { target: review.target } : {}),
				...(base.plan !== undefined ? { plan: base.plan } : {}),
				...(base.reservation !== undefined
					? { reservation: { ownerId: base.reservation.ownerId, memberId: base.reservation.memberId } }
					: {}),
			};
			const reviewer = await runOne(
				withResolvedTaskPin(
					reviewerRequest,
					review.resolvedTasks?.find((task) => task.role === "reviewer" && task.position === cycle),
					{ pinTask: false },
				),
			);
			if (isPipelineStepFailure(reviewer.receipt)) {
				recordDecision(
					{
						group,
						topology: "review",
						cycle,
						outcome: "exhausted",
						subjects: [subjectRef(builder.receipt)],
						decider: subjectRef(reviewer.receipt),
						detail: `reviewer ended ${pipelineFailureReason(reviewer.receipt)}`,
					},
					reviewer.pendingGate,
				);
				return {
					runs,
					decisions,
					verdict: null,
					cycles: cycle,
					needsDecision: `reviewer run ${reviewer.receipt.runId} ended ${pipelineFailureReason(reviewer.receipt)} in cycle ${cycle}`,
				};
			}
			const verdict = parseReviewVerdict(normalizedAssistantText(reviewer.summary));
			if (verdict === "pass" || verdict === "fail") {
				recordDecision(
					{
						group,
						topology: "review",
						cycle,
						outcome: verdict,
						subjects: [subjectRef(builder.receipt)],
						decider: subjectRef(reviewer.receipt),
					},
					reviewer.pendingGate,
				);
				return { runs, decisions, verdict, cycles: cycle };
			}
			// An unparseable answer counts as revise: the findings text is the
			// whole reviewer answer, and the cycle bound still terminates the gate.
			const exhaustionDraft: GateDecisionDraft | null =
				cycle === review.maxCycles
					? {
							group,
							topology: "review",
							cycle,
							outcome: "exhausted",
							subjects: [subjectRef(builder.receipt)],
							decider: subjectRef(reviewer.receipt),
							detail: `review gate exhausted after ${review.maxCycles} cycle(s)`,
						}
					: null;
			const pendingExhaustion =
				exhaustionDraft === null
					? null
					: stagePendingGateDecision(exhaustionDraft, { finalOutput: normalizedAssistantText(reviewer.summary) });
			recordDecision(
				{
					group,
					topology: "review",
					cycle,
					outcome: "revise",
					subjects: [subjectRef(builder.receipt)],
					decider: subjectRef(reviewer.receipt),
					detail: verdict === "revise" ? "reviewer requested revision" : "unparseable verdict treated as revision",
				},
				reviewer.pendingGate,
			);
			if (pendingExhaustion !== null) {
				decisions.push(materializePendingGateDecision(pendingExhaustion));
				return {
					runs,
					decisions,
					verdict: null,
					cycles: cycle,
					needsDecision: `review gate exhausted after ${review.maxCycles} cycle(s) without a pass; the operator decides whether to accept, retry, or revert`,
				};
			}
			findings = { reviewer, text: normalizedAssistantText(reviewer.summary) };
		}
		throw new Error("review gate exhausted without terminal decision evidence");
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onSignalAbort);
	}
}

function judgeTask(originalTask: string, candidates: ReadonlyArray<CandidateWorktree>, stats: string[]): string {
	const lines = [
		`Rank ${candidates.length} candidate implementations of this task and pick the best one.`,
		"Original task:",
		originalTask,
		"Candidates:",
		...candidates.map(
			(candidate, index) =>
				`  ${candidate.index}. branch=${candidate.branch} worktree=${candidate.path} (${stats[index] ?? "?"})`,
		),
		'End with exactly one line "WINNER: <candidate number>".',
	];
	return lines.join("\n\n");
}

/** The judge's LAST "WINNER: n" line decides. */
export function parseJudgeWinner(text: string, candidateCount: number): number | null {
	let winner: number | null = null;
	for (const match of text.matchAll(/^\s*WINNER:\s*(\d+)\b/gim)) {
		const raw = Number.parseInt(match[1] ?? "", 10);
		if (Number.isInteger(raw) && raw >= 1 && raw <= candidateCount) winner = raw;
	}
	return winner;
}

function readVerifiedGateReceipt(deps: DispatchToolDeps, runId: string): RunReceipt | null {
	const envelope = deps.dispatch.getRun(runId);
	if (envelope === null) return null;
	const path = envelope.receiptPath ?? join(clioStateDir(), "receipts", `${runId}.json`);
	if (!existsSync(path)) return null;
	let receipt: RunReceipt;
	try {
		receipt = JSON.parse(readFileSync(path, "utf8")) as RunReceipt;
	} catch (error) {
		throw new Error(`pending gate receipt ${runId} is unreadable: ${competeErrorMessage(error)}`);
	}
	if (receipt.runId !== runId) throw new Error(`pending gate receipt path for ${runId} contains ${receipt.runId}`);
	const verification = verifyReceiptIntegrity(receipt, envelope);
	if (!verification.ok) throw new Error(`pending gate receipt ${runId} failed integrity: ${verification.reason}`);
	if (receipt.integrity?.digest === undefined) throw new Error(`pending gate receipt ${runId} has no integrity digest`);
	return receipt;
}

function settlePendingCompeteResource(handle: PendingGateDecisionHandle, draft: GateDecisionDraft): void {
	if (draft.topology !== "compete" || (draft.outcome !== "winner" && draft.outcome !== "no-winner")) return;
	const root = handle.record.resourceRoot ?? process.cwd();
	settleRecoveredCompeteDecision(root, draft.group, draft.outcome === "winner" ? (draft.winner?.index ?? null) : null);
}

/**
 * Rebuild decisions whose reviewer/judge output crossed the WAL boundary but
 * whose coordinator died before parsing or materialization. Receipt integrity
 * is verified before the output protocol is trusted. Compete worktrees move
 * to their recovered winner/no-winner state before the WAL is cleared.
 */
function recoverPendingGateEvidence(deps: DispatchToolDeps): void {
	const pending = readPendingGateDecisions();
	if (pending.errors.length > 0) {
		throw new Error(
			`pending gate decision journal is untrustworthy: ${pending.errors
				.map((entry) => `${entry.path}: ${entry.message}`)
				.join("; ")}`,
		);
	}

	for (const handle of pending.records.filter((entry) => entry.record.kind === "decision")) {
		if (handle.record.kind !== "decision") continue;
		settlePendingCompeteResource(handle, handle.record.decision);
		materializePendingGateDecision(handle);
	}

	for (const handle of pending.records.filter((entry) => entry.record.kind === "output")) {
		if (handle.record.kind !== "output") continue;
		const record = handle.record;
		const deciderReceipt = readVerifiedGateReceipt(deps, record.deciderRunId);
		if (deciderReceipt === null) {
			throw new Error(
				`pending ${record.topology} decision ${record.id} has no verified decider receipt for ${record.deciderRunId}`,
			);
		}
		const decider = subjectRef(deciderReceipt);
		let draft: GateDecisionDraft;
		if (record.topology === "review") {
			if (isPipelineStepFailure(deciderReceipt)) {
				draft = {
					group: record.group,
					topology: "review",
					cycle: record.cycle,
					outcome: "exhausted",
					subjects: record.subjects,
					decider,
					detail: `reviewer ended ${pipelineFailureReason(deciderReceipt)}`,
				};
			} else {
				const verdict = parseReviewVerdict(record.finalOutput);
				draft = {
					group: record.group,
					topology: "review",
					cycle: record.cycle,
					outcome: verdict === "pass" || verdict === "fail" ? verdict : "revise",
					subjects: record.subjects,
					decider,
					...(verdict === "pass" || verdict === "fail"
						? {}
						: {
								detail: verdict === "revise" ? "reviewer requested revision" : "unparseable verdict treated as revision",
							}),
				};
				if (draft.outcome === "revise" && record.terminalCycle === true) {
					const exhausted = stagePendingGateDecision(
						{
							group: record.group,
							topology: "review",
							cycle: record.cycle,
							outcome: "exhausted",
							subjects: record.subjects,
							decider,
							detail: `review gate exhausted after ${record.cycle} cycle(s)`,
						},
						{ finalOutput: record.finalOutput },
					);
					finalizePendingGateDecision(handle, draft);
					materializePendingGateDecision(exhausted);
					continue;
				}
			}
			finalizePendingGateDecision(handle, draft);
			continue;
		}

		const pick = isPipelineStepFailure(deciderReceipt)
			? null
			: parseJudgeWinner(record.finalOutput, record.subjects.length);
		const pickedSubject = pick === null ? undefined : record.subjects[pick - 1];
		const candidateReceipt = pickedSubject === undefined ? null : readVerifiedGateReceipt(deps, pickedSubject.runId);
		if (pickedSubject !== undefined && candidateReceipt === null) {
			throw new Error(
				`pending compete decision ${record.id} has no verified candidate receipt for ${pickedSubject.runId}`,
			);
		}
		let blockedProtected: string[] = [];
		if (pick !== null && pickedSubject !== undefined && candidateReceipt !== null) {
			const root = record.resourceRoot ?? process.cwd();
			const protectedPaths = deps.dispatch.protectedArtifactState?.().artifacts.map((artifact) => artifact.path) ?? [];
			blockedProtected = protectedPathsChangedByCompeteBranch(
				root,
				`clio/compete/${record.group}/${pick}`,
				protectedPaths,
			);
		}
		const validWinner =
			pick !== null &&
			pickedSubject !== undefined &&
			candidateReceipt !== null &&
			!isPipelineStepFailure(candidateReceipt) &&
			blockedProtected.length === 0;
		if (validWinner && pick !== null && pickedSubject !== undefined) {
			draft = {
				group: record.group,
				topology: "compete",
				cycle: record.cycle,
				outcome: "winner",
				subjects: record.subjects,
				decider,
				winner: {
					index: pick,
					subject: pickedSubject,
					branch: `clio/compete/${record.group}/${pick}`,
				},
			};
		} else {
			draft = {
				group: record.group,
				topology: "compete",
				cycle: record.cycle,
				outcome: "no-winner",
				subjects: record.subjects,
				decider,
				detail: isPipelineStepFailure(deciderReceipt)
					? `judge ended ${pipelineFailureReason(deciderReceipt)}`
					: pick === null
						? "judge returned no parseable WINNER line"
						: blockedProtected.length > 0
							? `judge-selected candidate ${pick} changes protected artifact(s): ${blockedProtected.join(", ")}`
							: `judge picked failed or missing candidate ${pick}`,
			};
		}
		const ready = resolvePendingGateDecision(handle, draft);
		settlePendingCompeteResource(ready, draft);
		materializePendingGateDecision(ready);
	}

	// A process may have died after the final winner artifact was written but
	// before the worktree manifest moved to winner-preserved. Restore that safe
	// decision point even though no pending WAL remains.
	const durable = readGateDecisionArtifacts();
	const confirmedGroups = new Set(
		durable
			.filter(
				({ artifact }) =>
					artifact.topology === "compete" &&
					(artifact.outcome === "operator-confirmed" || artifact.outcome === "full-auto-applied"),
			)
			.map(({ artifact }) => artifact.group),
	);
	for (const { artifact } of durable) {
		if (
			artifact.topology !== "compete" ||
			artifact.outcome !== "winner" ||
			artifact.winner === undefined ||
			confirmedGroups.has(artifact.group)
		) {
			continue;
		}
		settleRecoveredCompeteDecision(process.cwd(), artifact.group, artifact.winner.index);
	}
}

export interface CompeteSettings {
	candidates: number;
	judge?: { agent?: string; model?: string; target?: string; node?: string };
	/** Immutable per-candidate and judge pins expanded by plan admission. */
	resolvedTasks?: ReadonlyArray<ResolvedPlanTask>;
}

const COMPETE_MIN_CANDIDATES = 2;
const COMPETE_MAX_CANDIDATES = 4;

function competeSettingsFromArgs(
	args: Record<string, unknown>,
): { ok: true; compete: CompeteSettings } | { ok: false; message: string } {
	const raw = args.candidates;
	let candidates = COMPETE_MIN_CANDIDATES;
	if (raw !== undefined) {
		if (
			typeof raw !== "number" ||
			!Number.isInteger(raw) ||
			raw < COMPETE_MIN_CANDIDATES ||
			raw > COMPETE_MAX_CANDIDATES
		) {
			return {
				ok: false,
				message: `dispatch: candidates must be an integer ${COMPETE_MIN_CANDIDATES}..${COMPETE_MAX_CANDIDATES}`,
			};
		}
		candidates = raw;
	}
	const judgeRaw = args.judge;
	if (judgeRaw !== undefined && !isRecord(judgeRaw)) {
		return { ok: false, message: "dispatch: judge must be an options object" };
	}
	let judge: CompeteSettings["judge"];
	if (isRecord(judgeRaw)) {
		judge = {};
		const agent = stringArg(judgeRaw, "agent");
		if (agent !== undefined) judge.agent = agent;
		const model = stringArg(judgeRaw, "model");
		if (model !== undefined) judge.model = model;
		const target = stringArg(judgeRaw, "target");
		if (target !== undefined) judge.target = target;
		const node = stringArg(judgeRaw, "node");
		if (node !== undefined) judge.node = node;
	}
	return { ok: true, compete: { candidates, ...(judge !== undefined ? { judge } : {}) } };
}

interface CompeteOutcome {
	runs: CompletedRun[];
	decisions: Array<{ artifact: GateDecisionArtifact; path: string }>;
	group: string;
	winner: { index: number; branch: string; applied: boolean } | null;
	needsDecision?: string;
}

interface OwnedCompeteRun {
	runId: string;
	settled: boolean;
	abortRequested: boolean;
	settlement: Promise<CompletedRun>;
}

interface CompeteStop {
	message: string;
	reason?: AbortReason;
}

function competeErrorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function rejectedReasons(results: ReadonlyArray<PromiseSettledResult<unknown>>): unknown[] {
	return results
		.filter((result): result is PromiseRejectedResult => result.status === "rejected")
		.map((result) => result.reason as unknown);
}

/**
 * Best-of-N compete: N candidate builders run the same task in isolated
 * scratch git worktrees, each candidate's work is committed on its branch, a
 * read-only judge ranks them, and the winner is applied (full-auto) or handed
 * to the operator (supervised: the winner's branch and worktree survive; the
 * apply_winner action routes through plan approval). Losers are always
 * cleaned, including on abort and on any thrown error.
 */
async function runCompete(
	deps: RegisteredDispatchToolDeps,
	base: DispatchRequest,
	compete: CompeteSettings,
	autonomy: AutonomyLevel,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<CompeteOutcome> {
	const requestedRoot = base.cwd !== undefined && base.cwd.length > 0 ? base.cwd : process.cwd();
	if (!isGitRepository(requestedRoot)) {
		throw new Error(`compete requires a git repository at ${requestedRoot}; scratch worktrees isolate the candidates`);
	}
	const protectedPaths = deps.dispatch.protectedArtifactState?.().artifacts.map((artifact) => artifact.path) ?? [];
	// Startup recovery intentionally sweeps only groups that another lifecycle
	// durably marked cleanup-ready after all of its workers settled. Active,
	// preserved, and malformed crash leftovers remain untouched.
	recoverCleanupReadyCompeteGroups(requestedRoot);
	const group = newGateGroupId("compete");
	let ownership: CompeteGroupOwnership | null = null;
	const worktrees: CandidateWorktree[] = [];
	const runs: CompletedRun[] = [];
	const decisions: Array<{ artifact: GateDecisionArtifact; path: string }> = [];
	const recordDecision = (draft: GateDecisionDraft, pending?: PendingGateDecisionHandle) => {
		const decision = pending
			? finalizePendingGateDecision(pending, draft)
			: materializePendingGateDecision(stagePendingGateDecision(draft, { resourceRoot: requestedRoot }));
		decisions.push(decision);
		return decision;
	};
	const ownedRuns: OwnedCompeteRun[] = [];
	const abortErrors: unknown[] = [];
	let stop: CompeteStop | null = null;
	let primaryError: unknown = null;
	let winner: CompeteOutcome["winner"] = null;
	const currentWinner = (): CompeteOutcome["winner"] => winner;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let signalListenerInstalled = false;

	const abortOwnedRun = (run: OwnedCompeteRun): void => {
		if (run.settled || run.abortRequested || stop === null) return;
		run.abortRequested = true;
		try {
			deps.dispatch.abort(run.runId, stop.reason);
		} catch (err) {
			abortErrors.push(err);
		}
	};
	const requestStop = (next: CompeteStop): void => {
		if (stop === null) stop = next;
		for (const run of ownedRuns) abortOwnedRun(run);
	};
	const onSignalAbort = (): void => requestStop({ message: "compete dispatch aborted" });
	const throwIfStopped = (): void => {
		if (stop !== null) throw new Error(stop.message);
	};
	const settleRun = async (
		handle: Awaited<ReturnType<DispatchContract["dispatch"]>>,
		request: DispatchRequest,
	): Promise<CompletedRun> => {
		const summaryPromise = consumeGateSensitiveDispatchEvents(deps, handle.runId, request.agentId, handle.events).then(
			(summary) => {
				const pendingGate =
					request.gate?.role === "judge"
						? stagePendingGateOutput({
								group: request.gate.group,
								topology: "compete",
								cycle: request.gate.cycle,
								subjects: request.gate.subjects ?? [],
								deciderRunId: handle.runId,
								finalOutput: normalizedAssistantText(summary),
								...(request.cwd !== undefined ? { resourceRoot: request.cwd } : {}),
							})
						: undefined;
				return { summary, pendingGate };
			},
		);
		const [summaryResult, receiptResult] = await Promise.allSettled([summaryPromise, handle.finalPromise]);
		const failures = rejectedReasons([summaryResult, receiptResult]);
		if (failures.length > 0) {
			throw new Error(`run ${handle.runId} failed to settle: ${failures.map(competeErrorMessage).join("; ")}`);
		}
		const summaryWithGate = summaryResult.status === "fulfilled" ? summaryResult.value : null;
		const receipt = receiptResult.status === "fulfilled" ? receiptResult.value : null;
		if (summaryWithGate === null || receipt === null) throw new Error(`run ${handle.runId} produced no settled result`);
		return completeRun(deps, receipt, summaryWithGate.summary, summaryWithGate.pendingGate);
	};
	const admitOwnedRun = async (request: DispatchRequest, label: string): Promise<OwnedCompeteRun> => {
		try {
			const handle = await deps.dispatch.dispatch(request, {
				onAdmitted(admission) {
					if (ownership === null) throw new Error(`compete ${group} has no active ownership claim`);
					registerCompeteGroupRun(ownership, admission);
				},
			});
			const owned: OwnedCompeteRun = {
				runId: handle.runId,
				settled: false,
				abortRequested: false,
				settlement: Promise.resolve(null as never),
			};
			ownedRuns.push(owned);
			owned.settlement = (async () => {
				try {
					return await settleRun(handle, request);
				} catch (err) {
					requestStop({ message: `${label} failed to settle: ${competeErrorMessage(err)}` });
					throw err;
				} finally {
					owned.settled = true;
					if (ownership !== null) settleCompeteGroupRun(ownership, owned.runId);
				}
			})();
			// A concurrent admission can fail before this settlement is awaited.
			// Attach a sink immediately while preserving the original promise for
			// the transaction's mandatory all-settled barrier.
			owned.settlement.catch(() => {});
			if (stop !== null) abortOwnedRun(owned);
			return owned;
		} catch (err) {
			requestStop({ message: `${label} admission failed: ${competeErrorMessage(err)}` });
			throw err;
		}
	};
	const settledCompletedRuns = async (owned: ReadonlyArray<OwnedCompeteRun>, phase: string): Promise<CompletedRun[]> => {
		const results = await Promise.allSettled(owned.map((run) => run.settlement));
		const failures = rejectedReasons(results);
		if (failures.length > 0) {
			throw new Error(`${phase} failed: ${failures.map(competeErrorMessage).join("; ")}`);
		}
		return results.map((result) => {
			if (result.status !== "fulfilled") throw new Error(`${phase} produced no completed run`);
			return result.value;
		});
	};

	let outcome: CompeteOutcome | null = null;
	try {
		outcome = await (async (): Promise<CompeteOutcome> => {
			// The owner manifest is the transaction's first group-specific mutation;
			// every branch and worktree created below is covered by finalization.
			ownership = claimCompeteGroup(requestedRoot, group);
			const root = ownership.root;
			const createCandidate = deps.competeWorktrees?.createCandidate ?? createCandidateWorktree;
			for (let index = 1; index <= compete.candidates; index += 1) {
				throwIfStopped();
				worktrees.push(createCandidate(ownership, index));
			}

			if (timeoutMs !== undefined) {
				timer = setTimeout(
					() =>
						requestStop({
							message: `compete dispatch timed out after ${timeoutMs}ms`,
							reason: { cause: "timeout", detail: `timed out after ${timeoutMs}ms` },
						}),
					timeoutMs,
				);
			}
			signal?.addEventListener("abort", onSignalAbort, { once: true });
			signalListenerInstalled = signal !== undefined;
			if (signal?.aborted) onSignalAbort();
			throwIfStopped();

			// Candidates run concurrently through the normal per-run admission path;
			// every admission promise is observed to settlement. The first rejection
			// aborts known siblings, and any sibling accepted later sees `stop` and is
			// aborted before it can escape the transaction.
			const admissionResults = await Promise.allSettled(
				worktrees.map((worktree) => {
					const request: DispatchRequest = {
						...base,
						cwd: worktree.path,
						protectedArtifactRemap: { sourceRoot: root, workerRoot: worktree.path },
						gate: { role: "candidate", group, cycle: worktree.index },
					};
					return admitOwnedRun(
						withResolvedTaskPin(
							request,
							compete.resolvedTasks?.find((task) => task.role === "candidate" && task.position === worktree.index),
						),
						`candidate ${worktree.index}`,
					);
				}),
			);
			const admissionFailures = rejectedReasons(admissionResults);
			if (admissionFailures.length > 0) {
				const admissionMessage = `compete candidate admission failed: ${admissionFailures
					.map(competeErrorMessage)
					.join("; ")}`;
				requestStop({ message: admissionMessage });
				// All admission promises have now settled, including late accepts. Wait
				// for every accepted run before finalization removes any path.
				await Promise.allSettled(ownedRuns.map((run) => run.settlement));
				throw new Error(admissionMessage);
			}
			const candidateOwned = admissionResults.map((result) => {
				if (result.status !== "fulfilled") throw new Error("compete candidate admission produced no handle");
				return result.value;
			});
			const candidateRuns = await settledCompletedRuns(candidateOwned, "candidate settlement");
			runs.push(...candidateRuns);
			throwIfStopped();
			const stats = worktrees.map((worktree, index) => {
				const receipt = candidateRuns[index]?.receipt;
				const failed = receipt !== undefined && isPipelineStepFailure(receipt);
				if (failed) return "builder failed";
				commitCandidateWork(worktree, `clio compete ${group} candidate ${worktree.index}`);
				return candidateDiffStat(root, worktree.branch);
			});
			if (candidateRuns.every((run) => isPipelineStepFailure(run.receipt))) {
				recordDecision({
					group,
					topology: "compete",
					cycle: 1,
					outcome: "no-winner",
					subjects: candidateRuns.map((run) => subjectRef(run.receipt)),
					detail: "every candidate builder failed; nothing to judge",
				});
				return { runs, decisions, group, winner: null, needsDecision: "every candidate builder failed; nothing to judge" };
			}
			const judgeRequest: DispatchRequest = {
				agentId: compete.judge?.agent ?? base.agentId,
				task: judgeTask(base.task, worktrees, stats),
				systemPrompt: JUDGE_GATE_PROMPT,
				autonomy: "read-only",
				cwd: root,
				gate: {
					role: "judge",
					group,
					cycle: 1,
					subjects: candidateRuns.map((run) => subjectRef(run.receipt)),
				},
				...(compete.judge?.model !== undefined ? { model: compete.judge.model } : {}),
				...(compete.judge?.target !== undefined ? { target: compete.judge.target } : {}),
				...(compete.judge?.node !== undefined ? { node: compete.judge.node } : {}),
				...(base.plan !== undefined ? { plan: base.plan } : {}),
				...(base.reservation !== undefined
					? { reservation: { ownerId: base.reservation.ownerId, memberId: base.reservation.memberId } }
					: {}),
			};
			throwIfStopped();
			const judgeOwned = await admitOwnedRun(
				withResolvedTaskPin(
					judgeRequest,
					compete.resolvedTasks?.find((task) => task.role === "judge"),
					{ pinTask: false },
				),
				"judge",
			);
			const judgeRun = (await settledCompletedRuns([judgeOwned], "judge settlement"))[0];
			if (judgeRun === undefined) throw new Error("judge produced no completed run");
			runs.push(judgeRun);
			throwIfStopped();
			const judgeReceipt = judgeRun.receipt;
			const judgeSummary = judgeRun.summary;
			if (isPipelineStepFailure(judgeReceipt)) {
				recordDecision(
					{
						group,
						topology: "compete",
						cycle: 1,
						outcome: "no-winner",
						subjects: candidateRuns.map((run) => subjectRef(run.receipt)),
						decider: subjectRef(judgeReceipt),
						detail: `judge ended ${pipelineFailureReason(judgeReceipt)}`,
					},
					judgeRun.pendingGate,
				);
				return {
					runs,
					decisions,
					group,
					winner: null,
					needsDecision: `judge run ${judgeReceipt.runId} ended ${pipelineFailureReason(judgeReceipt)}; candidate worktrees were cleaned, their receipts remain; re-run compete or build directly`,
				};
			}
			const pick = parseJudgeWinner(normalizedAssistantText(judgeSummary), compete.candidates);
			if (pick === null) {
				recordDecision(
					{
						group,
						topology: "compete",
						cycle: 1,
						outcome: "no-winner",
						subjects: candidateRuns.map((run) => subjectRef(run.receipt)),
						decider: subjectRef(judgeReceipt),
						detail: "judge returned no parseable WINNER line",
					},
					judgeRun.pendingGate,
				);
				return {
					runs,
					decisions,
					group,
					winner: null,
					needsDecision:
						"judge returned no parseable WINNER line; candidate worktrees were cleaned, their receipts remain; re-run compete or build directly",
				};
			}
			const pickedWorktree = worktrees.find((worktree) => worktree.index === pick);
			const pickedRun = candidateRuns[pick - 1];
			if (!pickedWorktree || pickedRun === undefined || isPipelineStepFailure(pickedRun.receipt)) {
				recordDecision(
					{
						group,
						topology: "compete",
						cycle: 1,
						outcome: "no-winner",
						subjects: candidateRuns.map((run) => subjectRef(run.receipt)),
						decider: subjectRef(judgeReceipt),
						detail: `judge picked failed or missing candidate ${pick}`,
					},
					judgeRun.pendingGate,
				);
				return {
					runs,
					decisions,
					group,
					winner: null,
					needsDecision: `judge picked candidate ${pick}, whose builder failed; the operator decides`,
				};
			}
			const protectedChanges = protectedPathsChangedByCompeteBranch(root, pickedWorktree.branch, protectedPaths);
			if (protectedChanges.length > 0) {
				recordDecision(
					{
						group,
						topology: "compete",
						cycle: 1,
						outcome: "no-winner",
						subjects: candidateRuns.map((run) => subjectRef(run.receipt)),
						decider: subjectRef(judgeReceipt),
						detail: `judge-selected candidate ${pick} changes protected artifact(s): ${protectedChanges.join(", ")}`,
					},
					judgeRun.pendingGate,
				);
				return {
					runs,
					decisions,
					group,
					winner: null,
					needsDecision: `candidate ${pick} changes protected artifact(s) and cannot be applied: ${protectedChanges.join(", ")}`,
				};
			}
			const winnerRef = {
				index: pick,
				subject: subjectRef(pickedRun.receipt),
				branch: pickedWorktree.branch,
			};
			const winnerDecision = recordDecision(
				{
					group,
					topology: "compete",
					cycle: 1,
					outcome: "winner",
					subjects: candidateRuns.map((run) => subjectRef(run.receipt)),
					decider: subjectRef(judgeReceipt),
					winner: winnerRef,
				},
				judgeRun.pendingGate,
			);
			if (autonomy === "full-auto") {
				const merge = (deps.competeWorktrees?.mergeWinner ?? mergeWinnerBranch)(root, pickedWorktree.branch);
				if (!merge.ok) {
					winner = { index: pick, branch: pickedWorktree.branch, applied: false };
					return {
						runs,
						decisions,
						group,
						winner,
						needsDecision: `winner candidate ${pick} could not be merged (${merge.reason}); its branch ${pickedWorktree.branch} is preserved`,
					};
				}
				try {
					recordDecision({
						group,
						topology: "compete",
						cycle: 1,
						outcome: "full-auto-applied",
						subjects: [winnerRef.subject],
						winner: winnerRef,
						confirmation: {
							id: winnerDecision.artifact.id,
							digest: winnerDecision.artifact.integrity.digest,
						},
						detail: `full-auto applied ${pickedWorktree.branch} under dispatch plan ${base.plan?.hash ?? "unavailable"}`,
					});
				} catch (error) {
					winner = { index: pick, branch: pickedWorktree.branch, applied: false };
					throw new Error(
						`winner ${pickedWorktree.branch} merged but full-auto application evidence failed: ${competeErrorMessage(error)}; branch preserved for recovery`,
					);
				}
				winner = { index: pick, branch: pickedWorktree.branch, applied: true };
				return { runs, decisions, group, winner };
			}
			winner = { index: pick, branch: pickedWorktree.branch, applied: false };
			return { runs, decisions, group, winner };
		})();
	} catch (err) {
		primaryError = err;
	}
	if (timer) clearTimeout(timer);
	if (signalListenerInstalled) signal?.removeEventListener("abort", onSignalAbort);

	// No path may be removed while a worker can still write through it. On
	// every exceptional exit, abort all accepted runs (including late
	// admissions) and await the settlement promise that drains both events
	// and final receipt completion.
	if (ownedRuns.some((run) => !run.settled)) {
		requestStop({ message: "compete lifecycle exited before every worker settled" });
	}
	const finalizationErrors: unknown[] = [];
	await Promise.allSettled(ownedRuns.map((run) => run.settlement));
	finalizationErrors.push(...abortErrors);

	// Losers are always cleaned; the winner's worktree and branch survive
	// only while an operator decision is pending (supervised pick or a
	// failed merge). The durable state transition happens after the worker
	// barrier and before deletion, defining the safe restart boundary.
	const winnerAtFinalization = currentWinner();
	if (ownership !== null) {
		if (winnerAtFinalization !== null && !winnerAtFinalization.applied) {
			try {
				ownership = markCompeteGroupWinnerPreserved(ownership, winnerAtFinalization.index);
				for (const worktree of worktrees) {
					if (worktree.index === winnerAtFinalization.index) continue;
					try {
						removeCandidateWorktree(ownership, worktree, true);
					} catch (err) {
						finalizationErrors.push(err);
					}
				}
			} catch (err) {
				// Without the preserved-state record, retain every candidate; a
				// later process must not guess which path is safe to remove.
				finalizationErrors.push(err);
			}
		} else {
			try {
				ownership = markCompeteGroupCleanupReady(ownership);
			} catch (err) {
				finalizationErrors.push(err);
			}
			try {
				const cleanupGroup = deps.competeWorktrees?.cleanupGroup ?? cleanupCompeteGroup;
				cleanupGroup(ownership);
			} catch (err) {
				finalizationErrors.push(err);
			}
		}
	}

	if (finalizationErrors.length > 0) {
		const unique = [...new Set(finalizationErrors)];
		const suffix = unique.map(competeErrorMessage).join("; ");
		if (primaryError !== null) {
			throw new Error(`${competeErrorMessage(primaryError)}; compete finalization also failed: ${suffix}`);
		}
		throw new Error(`compete finalization failed: ${suffix}`);
	}
	if (primaryError !== null) throw primaryError;
	if (outcome === null) throw new Error("compete lifecycle produced no outcome");
	return outcome;
}

/**
 * Apply a preserved compete winner. Plan-scale by definition, so supervised
 * autonomy levels park this call for operator confirmation; the approval IS
 * the winner confirmation. After a successful merge the whole compete group
 * is cleaned up.
 */
function runApplyWinner(
	args: Record<string, unknown>,
	authority:
		| { outcome: "operator-confirmed"; requestId: string; requestedBy: string }
		| { outcome: "full-auto-applied" }
		| null,
	mergeWinner: typeof mergeWinnerBranch = mergeWinnerBranch,
	protectedPaths: ReadonlyArray<string> = [],
): ToolResult {
	if (authority === null) {
		return {
			kind: "error",
			message: "dispatch: apply_winner requires a registry-authenticated operator approval or full-auto authority",
		};
	}
	const raw = args.apply_winner;
	if (!isRecord(raw)) return { kind: "error", message: "dispatch: apply_winner must be an options object" };
	const branch = stringArg(raw, "branch");
	if (!branch) return { kind: "error", message: "dispatch: apply_winner.branch is required" };
	const match = /^clio\/compete\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([1-9]\d*)$/.exec(branch);
	if (!match) {
		return { kind: "error", message: "dispatch: apply_winner.branch must be a clio/compete/<group>/<n> branch" };
	}
	const group = match[1] ?? "";
	const winnerIndex = Number.parseInt(match[2] ?? "", 10);
	const root = stringArg(raw, "cwd") ?? process.cwd();
	if (!isGitRepository(root)) {
		return { kind: "error", message: `dispatch: apply_winner requires a git repository at ${root}` };
	}
	recoverCleanupReadyCompeteGroups(root);
	const ownership = loadCompeteGroup(root, group);
	if (ownership === null) {
		return {
			kind: "error",
			message: `dispatch: winner branch ${branch} has no matching compete ownership manifest; refusing to merge or delete unproven state`,
		};
	}
	if (ownership.state !== "winner-preserved" || ownership.winnerIndex !== winnerIndex) {
		return {
			kind: "error",
			message: `dispatch: winner branch ${branch} does not match the preserved winner recorded for compete group ${group}`,
		};
	}
	const winnerDecision = readGateDecisionArtifacts(group)
		.filter(
			(entry) =>
				entry.artifact.outcome === "winner" &&
				entry.artifact.winner?.index === winnerIndex &&
				entry.artifact.winner.branch === branch,
		)
		.sort(
			(left, right) =>
				left.artifact.createdAt.localeCompare(right.artifact.createdAt) ||
				left.artifact.id.localeCompare(right.artifact.id),
		)
		.at(-1);
	if (winnerDecision === undefined || winnerDecision.artifact.winner === undefined) {
		return {
			kind: "error",
			message: `dispatch: winner branch ${branch} has no integrity-valid judge decision; refusing an unauditable confirmation`,
		};
	}
	const winnerRef = winnerDecision.artifact.winner;
	const protectedChanges = protectedPathsChangedByCompeteBranch(root, branch, protectedPaths);
	if (protectedChanges.length > 0) {
		return {
			kind: "error",
			message: `dispatch: winner branch ${branch} changes protected artifact(s) and cannot be merged: ${protectedChanges.join(", ")}`,
		};
	}
	const writeConfirmation = (): { artifact: GateDecisionArtifact; path: string } =>
		writeGateDecisionArtifact({
			group,
			topology: "compete",
			cycle: 1,
			outcome: authority.outcome,
			subjects: [winnerRef.subject],
			winner: winnerRef,
			confirmation: {
				id: winnerDecision.artifact.id,
				digest: winnerDecision.artifact.integrity.digest,
			},
			detail:
				authority.outcome === "operator-confirmed"
					? `operator confirmation ${authority.requestId} (${authority.requestedBy}) approved ${branch} under dispatch plan ${describeDispatchPlan(args).hash}`
					: `full-auto applied ${branch} under dispatch plan ${describeDispatchPlan(args).hash}`,
		});
	let confirmation: { artifact: GateDecisionArtifact; path: string } | null = null;
	if (authority.outcome === "operator-confirmed") {
		try {
			confirmation = writeConfirmation();
		} catch (err) {
			return {
				kind: "error",
				message: `dispatch: could not persist operator confirmation for ${branch}: ${competeErrorMessage(err)}`,
			};
		}
	}
	const merge = mergeWinner(root, branch);
	if (!merge.ok) {
		return {
			kind: "error",
			message: `dispatch: winner branch ${branch} could not be merged: ${merge.reason}; the branch is preserved`,
			...(confirmation !== null
				? { details: { confirmationPath: confirmation.path, confirmationId: confirmation.artifact.id } }
				: {}),
		};
	}
	if (authority.outcome === "full-auto-applied") {
		try {
			confirmation = writeConfirmation();
		} catch (err) {
			return {
				kind: "error",
				message: `dispatch: winner branch ${branch} was merged, but full-auto application evidence failed: ${competeErrorMessage(err)}; branch is preserved for recovery`,
				details: { mode: "apply_winner", branch, group, applied: true, evidencePending: true },
			};
		}
	}
	if (confirmation === null) {
		return { kind: "error", message: `dispatch: winner branch ${branch} was merged without confirmation evidence` };
	}
	try {
		const cleanupOwnership = markCompeteGroupCleanupReady(ownership);
		cleanupCompeteGroup(cleanupOwnership);
	} catch (err) {
		return {
			kind: "error",
			message: `dispatch: winner branch ${branch} was merged, but compete cleanup failed: ${competeErrorMessage(err)}`,
			details: {
				mode: "apply_winner",
				branch,
				group,
				applied: true,
				cleanupPending: true,
				confirmationPath: confirmation.path,
				confirmationId: confirmation.artifact.id,
			},
		};
	}
	return {
		kind: "ok",
		output: `winner ${branch} merged into the current branch; compete group ${group} cleaned up`,
		details: {
			mode: "apply_winner",
			branch,
			group,
			confirmationPath: confirmation.path,
			confirmationId: confirmation.artifact.id,
		},
	};
}

function reviewGateResult(outcome: GateRunOutcome, maxOutputBytes: number): ToolResult {
	const body = formatDispatchOutput("review", outcome.runs, maxOutputBytes);
	const details: ToolResultDetails = {
		...dispatchDetails("review", outcome.runs),
		gate: {
			verdict: outcome.verdict,
			cycles: outcome.cycles,
			decisions: outcome.decisions.map(({ artifact, path }) => ({
				id: artifact.id,
				outcome: artifact.outcome,
				path,
				digest: artifact.integrity.digest,
			})),
			...(outcome.needsDecision !== undefined ? { needsDecision: outcome.needsDecision } : {}),
		},
	};
	if (outcome.verdict === "pass") {
		return { kind: "ok", output: `review gate passed after ${outcome.cycles} cycle(s)\n\n${body}`, details };
	}
	if (outcome.verdict === "fail") {
		return { kind: "error", message: `dispatch: review gate failed (reviewer verdict fail)\n\n${body}`, details };
	}
	return {
		kind: "error",
		message: `dispatch: review gate needs an operator decision: ${outcome.needsDecision ?? "no verdict"}\n\n${body}`,
		details,
	};
}

function competeResult(outcome: CompeteOutcome, autonomy: AutonomyLevel, maxOutputBytes: number): ToolResult {
	const body = formatDispatchOutput("compete", outcome.runs, maxOutputBytes);
	const details: ToolResultDetails = {
		...dispatchDetails("compete", outcome.runs),
		compete: {
			group: outcome.group,
			winner: outcome.winner,
			decisions: outcome.decisions.map(({ artifact, path }) => ({
				id: artifact.id,
				outcome: artifact.outcome,
				path,
				digest: artifact.integrity.digest,
			})),
			...(outcome.needsDecision !== undefined ? { needsDecision: outcome.needsDecision } : {}),
		},
	};
	if (outcome.winner?.applied === true) {
		return {
			kind: "ok",
			output: `compete winner candidate ${outcome.winner.index} applied (branch ${outcome.winner.branch} merged)\n\n${body}`,
			details,
		};
	}
	if (outcome.winner !== null && outcome.needsDecision === undefined) {
		const lines = [
			`compete winner: candidate ${outcome.winner.index} (branch ${outcome.winner.branch}), preserved for confirmation at autonomy ${autonomy}`,
			`Apply it with dispatch apply_winner={branch: "${outcome.winner.branch}"}; the approval prompt is the winner confirmation. Losing candidates were cleaned up.`,
		];
		return { kind: "ok", output: `${lines.join("\n")}\n\n${body}`, details };
	}
	return {
		kind: "error",
		message: `dispatch: compete needs an operator decision: ${outcome.needsDecision ?? "no winner"}\n\n${body}`,
		details,
	};
}

export function createDispatchTool(inputDeps: DispatchToolDeps): ToolSpec {
	const deps: RegisteredDispatchToolDeps = {
		...inputDeps,
		runEvents: inputDeps.runEvents ?? createDispatchRunEventRegistry(),
	};
	// A model can supply arbitrary JSON properties even when the schema omits
	// them. Trust resolved artifacts only when this exact tool instance created
	// the argument object at admission; a forged hidden field is stripped and
	// recomputed. Parked calls retain object identity, so approval and execution
	// consume the same immutable resolution even if settings/capacity drift.
	const preparedAdmissionArgs = new WeakSet<Record<string, unknown>>();
	const trustedResolvedPlans = new WeakMap<Record<string, unknown>, ResolvedDispatchPlanArtifact>();
	const trustedReservationOwners = new WeakMap<Record<string, unknown>, string>();
	const taskResolutions = new WeakMap<object, DispatchPlanTaskResolution>();
	const deepFreeze = <T>(value: T): T => {
		if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
		for (const child of Object.values(value)) deepFreeze(child);
		return Object.freeze(value);
	};
	const markPrepared = (args: Record<string, unknown>): Record<string, unknown> => {
		const exposed = resolvedDispatchPlanFromArgs(args);
		if (exposed !== null) {
			// The WeakMap snapshot is the execution authority. The separately
			// cloned/frozen hidden value remains available to generic registry policy
			// rendering, but cannot be mutated or replaced after preparation.
			const trusted = deepFreeze(structuredClone(exposed));
			const policyView = deepFreeze(structuredClone(exposed));
			trustedResolvedPlans.set(args, trusted);
			Object.defineProperty(args, RESOLVED_DISPATCH_PLAN_ARGUMENT, {
				value: policyView,
				enumerable: true,
				configurable: false,
				writable: false,
			});
		}
		preparedAdmissionArgs.add(args);
		return args;
	};
	const stripUntrustedPlanFields = (rawArgs: Record<string, unknown>): Record<string, unknown> => {
		const normalized = prepareDispatchArguments(rawArgs);
		const clean = { ...normalized };
		Reflect.deleteProperty(clean, RESOLVED_DISPATCH_PLAN_ARGUMENT);
		Reflect.deleteProperty(clean, DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT);
		return clean;
	};
	const preparationFailure = (args: Record<string, unknown>, err: unknown): Record<string, unknown> =>
		markPrepared({
			...args,
			[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT]: err instanceof Error ? err.message : String(err),
		});
	const resolveTask = (
		request: DispatchRequest,
		role: NonNullable<ResolvedDispatchPlanArtifact["tasks"][number]["role"]>,
		position: number,
	): ResolvedDispatchPlanArtifact["tasks"][number] => {
		const resolution = deps.dispatch.preview?.(request);
		if (resolution === undefined) throw new Error("dispatch preview is unavailable");
		// Seal the effective failover mode and the exact approved envelope into the
		// artifact so the plan hash distinguishes different fallback envelopes and
		// execution restores an operator-approved value, not raw arguments.
		const failover =
			request.failover ?? (request.node !== undefined || request.target !== undefined ? "none" : "automatic");
		const task: ResolvedDispatchPlanArtifact["tasks"][number] = {
			agent: resolution.agentId,
			task: request.task,
			...(request.briefing !== undefined ? { briefing: request.briefing } : {}),
			target: resolution.targetId,
			model: resolution.wireModelId,
			node: resolution.node.id,
			nodeKind: resolution.node.kind,
			...(resolution.node.host !== undefined ? { nodeHost: resolution.node.host } : {}),
			failover,
			...(failover === "approved" && request.allowedCandidates && request.allowedCandidates.length > 0
				? { allowedCandidates: request.allowedCandidates.map((candidate) => ({ ...candidate })) }
				: {}),
			role,
			position,
		};
		taskResolutions.set(task, resolution);
		return task;
	};
	const resolvedCostCeiling = (): number => {
		const injected = deps.getCostCeilingUsd?.();
		if (injected !== undefined && Number.isFinite(injected) && injected > 0) return injected;
		const ceiling = deps.dispatch.costCeilingUsd?.();
		if (ceiling === undefined || !Number.isFinite(ceiling) || ceiling <= 0) {
			throw new Error("dispatch scheduling cost ceiling is unavailable");
		}
		return ceiling;
	};
	const reservationWave = (
		topology: ResolvedDispatchPlanArtifact["topology"],
		task: ResolvedDispatchPlanArtifact["tasks"][number],
		index: number,
	): number => {
		if (topology === "parallel" || topology === "detached") return 0;
		if (topology === "compete") return task.role === "judge" ? 1 : 0;
		return index;
	};
	const markReservedPlan = (
		args: Record<string, unknown>,
		artifact: ResolvedDispatchPlanArtifact,
	): Record<string, unknown> => {
		const prepared = withResolvedDispatchPlan(args, artifact);
		if (deps.dispatch.reservations === undefined) return markPrepared(prepared);
		const tasks = artifact.tasks.map((task, index) => {
			const resolution = taskResolutions.get(task);
			if (resolution === undefined || task.role === undefined || task.position === undefined) {
				throw new Error("dispatch reservation resolution is incomplete");
			}
			return {
				memberId: `${task.role}-${task.position}`,
				wave: reservationWave(artifact.topology, task, index),
				resolution,
				...(task.allowedCandidates !== undefined
					? { allowedCandidates: task.allowedCandidates.map((candidate) => ({ ...candidate })) }
					: {}),
			};
		});
		const reservation = deps.dispatch.reservations.prepare({ topology: artifact.topology, tasks });
		try {
			const marked = markPrepared(prepared);
			trustedReservationOwners.set(marked, reservation.ownerId);
			return marked;
		} catch (error) {
			deps.dispatch.reservations.rollback(reservation.ownerId);
			throw error;
		}
	};
	const prepareAdmissionArguments = (rawArgs: Record<string, unknown>): Record<string, unknown> => {
		const args = stripUntrustedPlanFields(rawArgs);
		if (args.list === true) return markPrepared(args);
		if (args.apply_winner !== undefined) {
			if (!isRecord(args.apply_winner)) return markPrepared(args);
			const branch = stringArg(args.apply_winner, "branch");
			const match = branch ? /^clio\/compete\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([1-9]\d*)$/.exec(branch) : null;
			if (branch === undefined || match === null) return markPrepared(args);
			if (deps.getCostCeilingUsd === undefined && deps.dispatch.costCeilingUsd === undefined) return markPrepared(args);
			try {
				return markPrepared(
					withResolvedDispatchPlan(args, {
						version: 1,
						topology: "compete",
						tasks: [],
						costCeilingUsd: resolvedCostCeiling(),
						confirmation: {
							branch,
							group: match[1] ?? "",
							index: Number.parseInt(match[2] ?? "", 10),
						},
					}),
				);
			} catch (err) {
				return preparationFailure(args, err);
			}
		}
		if (deps.dispatch.preview === undefined) return markPrepared(args);
		const parsed = dispatchRequestsFromArgs(args);
		if (!parsed.ok) return markPrepared(args);
		if (args.mode !== undefined && !["parallel", "sequential", "pipeline", "compete"].includes(String(args.mode))) {
			return markPrepared(args);
		}
		const mode =
			args.mode === "sequential"
				? "sequential"
				: args.mode === "pipeline"
					? "pipeline"
					: args.mode === "compete"
						? "compete"
						: "parallel";
		try {
			const tasks: ResolvedDispatchPlanArtifact["tasks"] = [];
			const reviewResult = reviewSettingsFromArgs(args);
			if (!reviewResult.ok) return markPrepared(args);
			if (reviewResult.review !== undefined) {
				if (mode !== "parallel" || parsed.requests.length !== 1 || parsed.requests[0] === undefined) {
					return markPrepared(args);
				}
				const base = parsed.requests[0];
				for (let cycle = 1; cycle <= reviewResult.review.maxCycles; cycle += 1) {
					const builderSubject: RunGateSubjectRef = { runId: `plan-builder-${cycle}`, digest: null };
					tasks.push(resolveTask({ ...base, gate: { role: "builder", group: "plan-preview", cycle } }, "builder", cycle));
					tasks.push(
						resolveTask(
							{
								agentId: reviewResult.review.reviewer ?? base.agentId,
								task: reviewerTask(base.task, builderSubject.runId, cycle),
								systemPrompt: REVIEWER_GATE_PROMPT,
								autonomy: "read-only",
								gate: { role: "reviewer", group: "plan-preview", cycle, subjects: [builderSubject] },
								...(base.cwd !== undefined ? { cwd: base.cwd } : {}),
								...(reviewResult.review.node !== undefined ? { node: reviewResult.review.node } : {}),
								...(reviewResult.review.model !== undefined ? { model: reviewResult.review.model } : {}),
								...(reviewResult.review.target !== undefined ? { target: reviewResult.review.target } : {}),
							},
							"reviewer",
							cycle,
						),
					);
				}
			} else if (mode === "compete") {
				if (parsed.requests.length !== 1 || parsed.requests[0] === undefined) return markPrepared(args);
				const competeResult = competeSettingsFromArgs(args);
				if (!competeResult.ok) return markPrepared(args);
				const base = parsed.requests[0];
				const subjects: RunGateSubjectRef[] = [];
				for (let candidate = 1; candidate <= competeResult.compete.candidates; candidate += 1) {
					subjects.push({ runId: `plan-candidate-${candidate}`, digest: null });
					tasks.push(
						resolveTask(
							{ ...base, gate: { role: "candidate", group: "plan-preview", cycle: candidate } },
							"candidate",
							candidate,
						),
					);
				}
				tasks.push(
					resolveTask(
						{
							agentId: competeResult.compete.judge?.agent ?? base.agentId,
							task: `Plan-time capability check for the ${competeResult.compete.candidates}-candidate judge.`,
							systemPrompt: JUDGE_GATE_PROMPT,
							autonomy: "read-only",
							gate: { role: "judge", group: "plan-preview", cycle: 1, subjects },
							...(base.cwd !== undefined ? { cwd: base.cwd } : {}),
							...(competeResult.compete.judge?.node !== undefined ? { node: competeResult.compete.judge.node } : {}),
							...(competeResult.compete.judge?.model !== undefined ? { model: competeResult.compete.judge.model } : {}),
							...(competeResult.compete.judge?.target !== undefined ? { target: competeResult.compete.judge.target } : {}),
						},
						"judge",
						1,
					),
				);
			} else {
				for (const [index, request] of parsed.requests.entries()) {
					tasks.push(resolveTask(request, "task", index + 1));
				}
			}

			const topology = describeDispatchPlan(args).topology;
			const planScale = tasks.length > 1 || topology === "compete" || tasks.some((task) => task.node !== "local");
			if (!planScale) return markPrepared(args);
			return markReservedPlan(args, {
				version: 1,
				topology,
				tasks,
				costCeilingUsd: resolvedCostCeiling(),
			});
		} catch (err) {
			return preparationFailure(args, err);
		}
	};
	const prepareExecutionArguments = (args: Record<string, unknown>): Record<string, unknown> =>
		preparedAdmissionArgs.has(args) ? args : prepareAdmissionArguments(args);

	return {
		name: ToolNames.Dispatch,
		description:
			'Dispatch one bounded task with task, or a batch with tasks (never both). Singular example: {agent:"debugger", task:"Verify the receipt boundary", briefing:"Prior receipt evidence...", detach:true}. task is the worker assignment; briefing is separate bounded parent context/data and cannot replace task. Ordinary calls auto-wait; detach:true returns ids for monitoring/steering, and collect is the authoritative terminal batch operation before final synthesis. Batch modes are parallel (default), sequential, pipeline, or compete. Task objects may include persona and tool_profile. Sealed receipts are durable evidence; report receipt integrity, evidence verification, briefing provenance, and project-context provenance separately. Call with list:true to see agents. Do not repeat an identical successful dispatch in the same user turn.',
		parameters: Type.Object({
			list: Type.Optional(Type.Boolean({ description: "List available agents instead of dispatching." })),
			task: Type.Optional(
				Type.String({
					description:
						"Singular worker assignment/instructions. Use tasks instead for a batch; briefing is separate context and cannot replace task.",
				}),
			),
			tasks: Type.Optional(
				Type.Array(
					Type.Union([
						Type.String(),
						Type.Object({
							task: Type.String({ description: "Concrete agent task with expected output and constraints." }),
							briefing: Type.Optional(
								Type.String({
									description: `Per-task parent context/data override, max ${DISPATCH_BRIEFING_MAX_BYTES} UTF-8 bytes.`,
								}),
							),
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
							failover: Type.Optional(stringEnum(["none", "approved", "automatic"] as const)),
							allowed_candidates: Type.Optional(
								Type.Array(
									Type.Object({
										agent: Type.String(),
										target: Type.String(),
										model: Type.String(),
										node: Type.String(),
									}),
								),
							),
							cwd: Type.Optional(Type.String()),
						}),
					]),
					{ description: "Tasks to dispatch; a single object or string is accepted and wrapped." },
				),
			),
			mode: Type.Optional(
				stringEnum(
					["parallel", "sequential", "pipeline", "compete"],
					"Run tasks concurrently (default), one at a time, as a pipeline where each task receives the previous task's output as input data, or as a compete where N candidates build the same single task in scratch worktrees and a judge picks the winner.",
				),
			),
			detach: Type.Optional(
				Type.Boolean({
					description:
						"Return immediately after admission with a batch id and run ids; runs continue in the background. Collect later with the monitor tool. Parallel mode only.",
				}),
			),
			review: Type.Optional(
				Type.Union(
					[
						Type.Boolean(),
						Type.Object({
							reviewer: Type.Optional(
								Type.String({
									description: "Reviewer agent recipe id (default: the builder's agent as a read-only reviewer).",
								}),
							),
							max_cycles: Type.Optional(
								Type.Number({
									description: "Max review/revise cycles before the gate needs an operator decision (default 2, max 4).",
								}),
							),
							node: Type.Optional(Type.String({ description: "Fleet node pin for the reviewer." })),
							model: Type.Optional(Type.String({ description: "Model override for the reviewer." })),
							target: Type.Optional(Type.String({ description: "Target override for the reviewer." })),
						}),
					],
					{
						description:
							"Reviewer gate for a single task: the builder runs, a read-only reviewer verdicts pass/revise/fail against the workspace, and revise re-runs the builder with the findings.",
					},
				),
			),
			candidates: Type.Optional(Type.Number({ description: "Compete candidates 2..4 (mode=compete only, default 2)." })),
			judge: Type.Optional(
				Type.Object(
					{
						agent: Type.Optional(Type.String({ description: "Judge agent recipe id (default: the builder's agent)." })),
						model: Type.Optional(Type.String()),
						target: Type.Optional(Type.String()),
						node: Type.Optional(Type.String({ description: "Fleet node pin for the judge." })),
					},
					{ description: "Read-only judge that ranks compete candidates." },
				),
			),
			apply_winner: Type.Optional(
				Type.Object(
					{
						branch: Type.String({ description: "Preserved winner branch: clio/compete/<group>/<n>." }),
						cwd: Type.Optional(Type.String({ description: "Repository root (default: current directory)." })),
					},
					{
						description:
							"Apply a preserved compete winner: merges its branch and cleans up the compete group. Supervised autonomy parks this call so the operator confirms the winner.",
					},
				),
			),
			agent: Type.Optional(Type.String({ description: "Default agent recipe for string tasks (default coder)." })),
			briefing: Type.Optional(
				Type.String({
					description: `Separate bounded parent context/data for task, or the shared default for tasks; never worker instructions and never a task replacement. Max ${DISPATCH_BRIEFING_MAX_BYTES} UTF-8 bytes.`,
				}),
			),
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
			failover: Type.Optional(
				stringEnum(
					["none", "approved", "automatic"] as const,
					"Exact pins default to none; approved requires allowed_candidates.",
				),
			),
			allowed_candidates: Type.Optional(
				Type.Array(
					Type.Object({
						agent: Type.String(),
						target: Type.String(),
						model: Type.String(),
						node: Type.String(),
					}),
					{ description: "Exact operator-approved fallback route tuples, in preference order." },
				),
			),
			thinking_level: Type.Optional(stringEnum(THINKING_LEVELS)),
			cwd: Type.Optional(Type.String({ description: "Default agent working directory." })),
			timeout_ms: Type.Optional(Type.Number({ description: "Abort the dispatch after this many ms." })),
			max_output_bytes: Type.Optional(Type.Number({ description: "Max summary bytes returned." })),
		}),
		baseActionClass: "dispatch",
		executionMode: "sequential",
		prepareAdmissionArguments,
		disposeAdmissionArguments: (args) => {
			const ownerId = trustedReservationOwners.get(args);
			if (ownerId !== undefined) deps.dispatch.reservations?.rollbackUnconsumed(ownerId);
		},
		prepareArguments: prepareExecutionArguments,
		describeDispatchPlan: (args) => {
			const trusted = trustedResolvedPlans.get(args);
			return describeDispatchPlan(trusted === undefined ? args : { ...args, [RESOLVED_DISPATCH_PLAN_ARGUMENT]: trusted });
		},
		async run(rawArgs, options): Promise<ToolResult> {
			const args = prepareExecutionArguments(rawArgs);
			const preparationError = args[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT];
			if (typeof preparationError === "string") {
				return { kind: "error", message: `dispatch: plan admission failed: ${preparationError}` };
			}
			if (args.list === true) {
				const catalog = deps.getAgentCatalog?.().trim() ?? "";
				if (catalog.length === 0) {
					return { kind: "error", message: "dispatch: no agent catalog is available in this context" };
				}
				return { kind: "ok", output: catalog };
			}
			try {
				recoverPendingGateEvidence(deps);
			} catch (error) {
				return {
					kind: "error",
					message: `dispatch: pending gate evidence recovery failed closed: ${competeErrorMessage(error)}`,
				};
			}
			if (args.apply_winner !== undefined) {
				const confirmation = resolvedDispatchPlanFromArgs(args)?.confirmation;
				if (confirmation !== undefined) {
					const branch = isRecord(args.apply_winner) ? stringArg(args.apply_winner, "branch") : undefined;
					if (branch !== confirmation.branch) {
						return { kind: "error", message: "dispatch: winner confirmation differs from the approved plan" };
					}
				}
				const approval = options?.approval;
				const authority =
					approval?.actionClass === "dispatch"
						? {
								outcome: "operator-confirmed" as const,
								requestId: approval.requestId,
								requestedBy: approval.requestedBy,
							}
						: deps.getAutonomy?.() === "full-auto"
							? { outcome: "full-auto-applied" as const }
							: null;
				let protectedPaths: string[];
				try {
					protectedPaths = deps.dispatch.protectedArtifactState?.().artifacts.map((artifact) => artifact.path) ?? [];
				} catch (error) {
					return {
						kind: "error",
						message: `dispatch: protected artifact state is unavailable: ${competeErrorMessage(error)}`,
					};
				}
				return runApplyWinner(args, authority, deps.competeWorktrees?.mergeWinner, protectedPaths);
			}
			const parsed = dispatchRequestsFromArgs(args);
			if (!parsed.ok) return { kind: "error", message: parsed.message };
			const validModes = ["parallel", "sequential", "pipeline", "compete"];
			if (args.mode !== undefined && !validModes.includes(String(args.mode))) {
				return {
					kind: "error",
					message: `dispatch: mode must be parallel, sequential, pipeline, or compete; got '${String(args.mode)}'`,
				};
			}
			const mode =
				args.mode === "sequential"
					? "sequential"
					: args.mode === "pipeline"
						? "pipeline"
						: args.mode === "compete"
							? "compete"
							: "parallel";
			if (options?.signal?.aborted) return { kind: "error", message: "dispatch: aborted" };
			const maxOutputBytes = maxOutputBytesArg(args);
			const timeoutMs = timeoutMsArg(args);
			const reviewParsed = reviewSettingsFromArgs(args);
			if (!reviewParsed.ok) return { kind: "error", message: reviewParsed.message };
			let review = reviewParsed.review;

			// Plan provenance: plan-scale calls (multi-task, compete, remote node)
			// were either approved by the operator at admission (supervised) or run
			// unstopped at full-auto; either way every run of the plan seals the
			// same plan hash into its receipt.
			const autonomy = deps.getAutonomy?.() ?? "auto-edit";
			const authenticatedApproval = options?.approval?.actionClass === "dispatch" ? options.approval : undefined;
			const trustedResolvedPlan = trustedResolvedPlans.get(args) ?? null;
			const planArgs =
				trustedResolvedPlan === null ? args : { ...args, [RESOLVED_DISPATCH_PLAN_ARGUMENT]: trustedResolvedPlan };
			const planView = describeDispatchPlan(planArgs);
			// Production preparation always registers the authoritative snapshot.
			// The parser remains available in dispatch-plan.ts for direct utility
			// tests/tools, but a hidden model-supplied field is never execution trust.
			const resolvedPlan = trustedResolvedPlan;
			const reservationOwnerId = trustedReservationOwners.get(args);
			let requests = parsed.requests;
			if (planView.planScale && deps.dispatch.preview !== undefined && resolvedPlan === null) {
				return { kind: "error", message: "dispatch: resolved plan is missing after admission" };
			}
			if (planView.planScale && autonomy !== "full-auto" && authenticatedApproval === undefined) {
				return {
					kind: "error",
					message: "dispatch: resolved plan requires a registry-authenticated operator approval",
				};
			}
			if (resolvedPlan !== null) {
				const primaryRole = review !== undefined ? "builder" : mode === "compete" ? "candidate" : "task";
				const primaryTasks = resolvedPlan.tasks.filter((task) => task.role === primaryRole);
				const executionTasks = primaryRole === "task" ? primaryTasks : primaryTasks.slice(0, 1);
				if (executionTasks.length !== requests.length) {
					return {
						kind: "error",
						message: `dispatch: resolved plan has ${executionTasks.length} primary task(s), expected ${requests.length}`,
					};
				}
				requests = requests.map((request, index) => {
					const task = executionTasks[index];
					const pinned = withResolvedTaskPin(request, task);
					return reservationOwnerId !== undefined && task?.role !== undefined && task.position !== undefined
						? { ...pinned, reservation: { ownerId: reservationOwnerId, memberId: `${task.role}-${task.position}` } }
						: pinned;
				});
				if (review !== undefined) {
					const reviewer = resolvedPlan.tasks.find((task) => task.role === "reviewer");
					if (reviewer === undefined) {
						return { kind: "error", message: "dispatch: resolved review plan has no reviewer task" };
					}
					review = {
						...review,
						reviewer: reviewer.agent,
						target: reviewer.target,
						model: reviewer.model,
						node: reviewer.node,
						resolvedTasks: resolvedPlan.tasks,
					};
				}
			}
			if (planView.planScale) {
				const plan: RunPlanProvenance = {
					hash: planView.hash,
					topology: planView.topology,
					taskCount: planView.taskCount,
					approval: authenticatedApproval !== undefined ? "operator" : "full-auto",
					...(authenticatedApproval !== undefined
						? {
								approvalRequestId: authenticatedApproval.requestId,
								approvalRequestedBy: authenticatedApproval.requestedBy,
							}
						: {}),
					...(planView.costCeilingUsd !== undefined ? { costCeilingUsd: planView.costCeilingUsd } : {}),
				};
				requests = requests.map((request) => ({ ...request, plan }));
			}

			if (args.detach === true) {
				if (mode !== "parallel") {
					return { kind: "error", message: `dispatch: detach only supports parallel mode; got '${mode}'` };
				}
				if (review !== undefined) {
					return {
						kind: "error",
						message: "dispatch: detach cannot combine with a review gate; run gated dispatch attached",
					};
				}
				if (timeoutMs !== undefined) {
					return {
						kind: "error",
						message:
							'dispatch: detach cannot enforce timeout_ms because no caller waits on the runs; monitor(mode="wait") only observes for a bounded time, and steer(action="cancel") stops a run',
					};
				}
				try {
					return await runDetached(deps, requests, options?.sessionId ?? null);
				} catch (err) {
					return { kind: "error", message: `dispatch: ${err instanceof Error ? err.message : String(err)}` };
				}
			}

			if (mode === "compete") {
				if (requests.length !== 1 || requests[0] === undefined) {
					return { kind: "error", message: "dispatch: compete requires exactly one task" };
				}
				if (review !== undefined) {
					return { kind: "error", message: "dispatch: compete has its own judge and cannot combine with review" };
				}
				const competeParsed = competeSettingsFromArgs(args);
				if (!competeParsed.ok) return { kind: "error", message: competeParsed.message };
				let compete = competeParsed.compete;
				if (resolvedPlan !== null) {
					const judge = resolvedPlan.tasks.find((task) => task.role === "judge");
					if (judge === undefined) {
						return { kind: "error", message: "dispatch: resolved compete plan has no judge task" };
					}
					compete = {
						...compete,
						judge: { agent: judge.agent, target: judge.target, model: judge.model, node: judge.node },
						resolvedTasks: resolvedPlan.tasks,
					};
				}
				try {
					const outcome = await runCompete(deps, requests[0], compete, autonomy, timeoutMs, options?.signal);
					return competeResult(outcome, autonomy, maxOutputBytes);
				} catch (err) {
					return { kind: "error", message: `dispatch: ${err instanceof Error ? err.message : String(err)}` };
				}
			}

			if (review !== undefined) {
				if (requests.length !== 1 || requests[0] === undefined) {
					return { kind: "error", message: "dispatch: review supports exactly one task" };
				}
				if (mode !== "parallel") {
					return { kind: "error", message: `dispatch: review does not combine with mode=${mode}` };
				}
				try {
					const outcome = await runReviewGated(deps, requests[0], review, timeoutMs, options?.signal);
					return reviewGateResult(outcome, maxOutputBytes);
				} catch (err) {
					return { kind: "error", message: `dispatch: ${err instanceof Error ? err.message : String(err)}` };
				}
			}

			try {
				let runs: CompletedRun[];
				if (mode === "pipeline" && requests.length > 1) {
					runs = await runPipeline(deps, requests, timeoutMs, options?.signal);
				} else if (mode === "sequential" || mode === "pipeline" || requests.length === 1) {
					// A single-task pipeline has nothing to thread, so it degrades to
					// plain sequential and no pipeline-input message is sent.
					runs = await runSequential(deps, requests, mode, timeoutMs, options?.signal);
				} else {
					runs = await runBatch(deps, requests, timeoutMs, options?.signal);
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
	deps: RegisteredDispatchToolDeps,
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
			const registered = deps.runEvents.registerSingle(handle, request.agentId, fallbackProgressBus(deps));
			const { receipt, summary } = await registered.completion;
			activeRunId = null;
			runs.push(completeRun(deps, receipt, summary));
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
	deps: RegisteredDispatchToolDeps,
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
			const registered = deps.runEvents.registerSingle(handle, request.agentId, fallbackProgressBus(deps));
			const { receipt, summary } = await registered.completion;
			activeRunId = null;
			runs.push(completeRun(deps, receipt, summary));
			if (isPipelineStepFailure(receipt)) {
				const skipped = requests.length - (index + 1);
				throw new PipelineHaltError(
					`pipeline dispatch halted at step ${index + 1}/${requests.length} (run ${receipt.runId}, ${pipelineFailureReason(receipt)}); skipped ${skipped} later step(s)`,
					[...runs],
				);
			}
			previous = {
				runId: receipt.runId,
				text: receipt.output?.state === "final" ? receipt.output.text : "",
			};
		}
		return runs;
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onSignalAbort);
	}
}

async function runBatch(
	deps: RegisteredDispatchToolDeps,
	requests: ReadonlyArray<DispatchRequest>,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<CompletedRun[]> {
	const handle = await deps.dispatch.dispatchBatch(requests);
	const registered = deps.runEvents.registerBatch(
		handle,
		requests.map((request) => request.agentId),
		fallbackProgressBus(deps),
	);
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
		const { summaries, receipts } = await registered.completion;
		return receipts.map((receipt) =>
			completeRun(deps, receipt, summaries.get(receipt.runId) ?? { count: 0, types: [], lastAssistantText: "" }),
		);
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onSignalAbort);
	}
}
