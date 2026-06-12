/**
 * Dispatch domain wire-up (post-W5).
 *
 * Resolves a DispatchRequest to an TargetDescriptor + RuntimeDescriptor +
 * wire model id via the providers contract. Gates admission on safety
 * scopes, concurrency, budget, and capability flags. Every admitted runtime
 * kind enters through the native worker subprocess; the worker entry
 * rehydrates the runtime descriptor and delegates runtime-specific execution
 * behind the engine boundary.
 */

import { createHash } from "node:crypto";
import { BusChannels, type DispatchCompletedPayload } from "../../core/bus-events.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { readClioVersion, readPiMonoVersion } from "../../core/package-root.js";
import { isSkillActivation, type SkillActivation } from "../../core/skill-activation.js";
import { isBuiltinToolName, type ToolName, ToolNames } from "../../core/tool-names.js";
import {
	type AcpDelegationRunHandle,
	type AcpDelegationRunInput,
	startAcpDelegationRun,
} from "../../engine/acp/adapter.js";
import { applyToolProfile, type ToolProfileName } from "../../tools/profiles.js";
import {
	serializeWorkerRuntimeDescriptor,
	WORKER_SPEC_VERSION,
	type WorkerPromptMessage,
} from "../../worker/spec-contract.js";
import type { AgentsContract } from "../agents/contract.js";
import type { AgentRecipe } from "../agents/recipe.js";
import { type AgentAudience, assertAgentSpecPolicy, isUserVisibleAgent, normalizeAgentSpec } from "../agents/spec.js";
import type { ConfigContract } from "../config/contract.js";
import type { MiddlewareContract } from "../middleware/contract.js";
import {
	type CapabilityFlags,
	canonicalizeWireModelId,
	firstRuntimeResolutionError,
	type ProvidersContract,
	type ResolvedRuntimeTarget,
	type RuntimeDescriptor,
	resolveModelCapabilities,
	resolveRuntimeTarget,
	runtimeTargetSnapshot,
	type TargetDescriptor,
	type ThinkingLevel,
	targetRequiresAuth,
} from "../providers/index.js";
import type { ActionClass } from "../safety/action-classifier.js";
import type { SafetyContract } from "../safety/contract.js";
import type { ScopeSpec } from "../safety/scope.js";
import type { SchedulingContract } from "../scheduling/contract.js";
import { admit } from "./admission.js";
import { type BackoffState, createBackoff, nextDelay } from "./backoff.js";
import { type BatchState, createBatch, onRunComplete, snapshotBatch } from "./batch-tracker.js";
import {
	DispatchConcurrencyError,
	type DispatchContract,
	type DispatchRequest,
	type DispatchSnapshot,
} from "./contract.js";
import { classifyHeartbeat, DEFAULT_HEARTBEAT_SPEC, type HeartbeatSpec, type HeartbeatStatus } from "./heartbeat.js";
import { recoverOrphanReceipts } from "./orphan-recovery.js";
import { type RunTerminationEvidence, resolveRunOutcome, runStatusForOutcome } from "./outcome.js";
import { collectReproducibilityMetadata } from "./reproducibility.js";
import { detectRunIdentity } from "./run-identity.js";
import { type Ledger, openLedger } from "./state.js";
import {
	countToolCalls,
	recordToolFinish,
	snapshotToolStats,
	summarizeToolActivity,
	zeroSuccessfulToolNote,
} from "./tool-stats.js";
import {
	type DispatchRequestOrigin,
	RETRYABLE_OUTCOMES,
	type RunEnvelope,
	type RunKind,
	type RunLineage,
	type RunOutcome,
	type RunReceipt,
	type RunReceiptDraft,
	type RunReceiptUpstreamResponse,
	type RunStatus,
	type SafetyBlockedAttempt,
	type ToolCallStat,
} from "./types.js";
import { validateJobSpec } from "./validation.js";
import { type SpawnedWorker, type SpawnedWorkerResult, spawnNativeWorker, type WorkerSpec } from "./worker-spawn.js";

interface RunTokenMeter {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
}

interface ActiveRun {
	runId: string;
	/** Original request, kept verbatim so a retry re-passes the full admission chain. */
	req: DispatchRequest;
	abort: () => void;
	/** Hard termination used by the reconciler; for native workers this is the SIGTERM→SIGKILL path. */
	kill: () => void;
	/**
	 * Send an operator steer line to the run's input channel. Returns false
	 * when the channel is gone. Absent for run kinds without one (ACP).
	 */
	steer?: (text: string) => boolean;
	promise: Promise<void>;
	recipe: AgentRecipe | null;
	startedAt: string;
	targetId: string;
	wireModelId: string;
	runtimeId: string;
	runtimeKind: RunKind;
	agentAudience?: AgentAudience;
	requestOrigin?: DispatchRequestOrigin;
	agentId: string;
	task: string;
	cwd: string;
	aborted: boolean;
	/** Set by the reconciler before terminating a dead/stalled worker. */
	stallKilled: boolean;
	/** ACP event-inactivity window; null for native runs (heartbeat spec governs those). */
	stallTimeoutMs: number | null;
	lineage: RunLineage;
	heartbeatAt: { current: number } | null;
	heartbeatStatus: HeartbeatStatus;
	meter: RunTokenMeter;
	pricing: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null;
	finalPromise: Promise<RunReceipt>;
}

export interface DispatchBundleOptions {
	spawnWorker?: (spec: WorkerSpec, opts?: { cwd?: string }) => SpawnedWorker;
	startAcpDelegationRun?: (input: AcpDelegationRunInput) => AcpDelegationRunHandle;
	heartbeatSpec?: HeartbeatSpec;
	heartbeatIntervalMs?: number;
	resilienceCooldownMs?: number;
	now?: () => number;
	/**
	 * Session-effective settings view for worker target resolution. The
	 * interactive orchestrator injects this so /run and agent dispatches use
	 * the fleet routing the running session sees, not whatever another process
	 * last wrote to settings.yaml. Falls back to the shared config snapshot
	 * when absent (headless boots, tests).
	 */
	getSettings?: () => Readonly<ReturnType<ConfigContract["get"]>> | undefined;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 1000;
const DEFAULT_RESILIENCE_COOLDOWN_MS = 15_000;
/** ACP event-inactivity stall window (Symphony §5.3.6 semantics); <= 0 disables. */
const DEFAULT_ACP_STALL_TIMEOUT_MS = 300_000;

function requestOriginFor(req: DispatchRequest): DispatchRequestOrigin {
	return req.requestOrigin ?? "agent";
}

function sha256(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

function promptHash(systemPrompt: string): string | null {
	return systemPrompt.length > 0 ? sha256(systemPrompt) : null;
}

function promptCompositionHash(parts: ReadonlyArray<string>): string | null {
	const text = parts
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.join("\n\n");
	return text.length > 0 ? sha256(text) : null;
}

function toolSignature(tools: ReadonlyArray<ToolName>): string {
	return sha256(JSON.stringify([...tools].sort()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finitePositive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nestedFinitePositive(record: Record<string, unknown>, path: readonly string[]): number | undefined {
	let cursor: unknown = record;
	for (const key of path) {
		if (!isRecord(cursor)) return undefined;
		cursor = cursor[key];
	}
	return finitePositive(cursor);
}

function extractReasoningTokenCount(usage: unknown): number {
	if (!isRecord(usage)) return 0;
	const direct =
		finitePositive(usage.reasoningTokens) ?? finitePositive(usage.reasoning_tokens) ?? finitePositive(usage.reasoning);
	if (direct !== undefined) return direct;
	const paths: ReadonlyArray<readonly string[]> = [
		["outputDetails", "reasoningTokens"],
		["output_details", "reasoning_tokens"],
		["output_tokens_details", "reasoning_tokens"],
		["completion_tokens_details", "reasoning_tokens"],
		["completionTokensDetails", "reasoningTokens"],
		["details", "reasoningTokens"],
	];
	for (const path of paths) {
		const value = nestedFinitePositive(usage, path);
		if (value !== undefined) return value;
	}
	return 0;
}

function readStringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

const MAX_WORKER_DIAGNOSTIC_DETAIL_CHARS = 2048;
const MAX_WORKER_DIAGNOSTIC_FAILURE_CHARS = 4096;

function compactDiagnosticText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncateDiagnosticText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `...${value.slice(value.length - maxChars + 3)}`;
}

function workerDiagnosticsText(result: SpawnedWorkerResult, maxChars: number): string | null {
	const parts: string[] = [];
	const stderr = typeof result.stderrTail === "string" ? compactDiagnosticText(result.stderrTail) : "";
	if (stderr.length > 0) {
		parts.push(`stderr: ${truncateDiagnosticText(stderr, maxChars)}`);
	}
	const malformedStdoutLines =
		typeof result.malformedStdoutLines === "number" && Number.isFinite(result.malformedStdoutLines)
			? Math.max(0, Math.floor(result.malformedStdoutLines))
			: 0;
	if (malformedStdoutLines > 0) {
		parts.push(`malformed stdout lines: ${malformedStdoutLines}`);
	}
	if (parts.length === 0) return null;
	return truncateDiagnosticText(parts.join("; "), maxChars);
}

function mergeWorkerDiagnosticDetail(
	base: string | null,
	result: SpawnedWorkerResult,
	include: boolean,
): string | null {
	if (!include) return base;
	const diagnostics = workerDiagnosticsText(result, MAX_WORKER_DIAGNOSTIC_DETAIL_CHARS);
	if (diagnostics === null) return base;
	return base !== null && base.length > 0 ? `${base}; ${diagnostics}` : diagnostics;
}

function mergeWorkerDiagnosticFailure(
	base: string | undefined,
	result: SpawnedWorkerResult,
	include: boolean,
): string | undefined {
	if (!include) return base;
	const diagnostics = workerDiagnosticsText(result, MAX_WORKER_DIAGNOSTIC_FAILURE_CHARS);
	if (diagnostics === null) return base;
	return base !== undefined && base.length > 0 ? `${base}; ${diagnostics}` : diagnostics;
}

const DISPATCH_TASK_CONTRACT = [
	"# Dispatch Task Contract",
	"The assigned task is authoritative. The role guidance below is not itself a task.",
	"Do not invent a different task, source tree, file path, or implementation plan.",
	"If the assigned task asks for an exact response, a direct answer, or says not to inspect files or use tools, answer directly without tool calls.",
	"Use tools only when they are necessary for the assigned task and allowed by the configured tool profile.",
].join("\n");

export function pickOrchestratorScope(safety: SafetyContract): ScopeSpec {
	return safety.scopes.workspace;
}

function pickWorkerScope(safety: SafetyContract, requestedActions: ReadonlyArray<ActionClass>): ScopeSpec {
	if (requestedActions.every((action) => action === "read")) return safety.scopes.readonly;
	return safety.scopes.workspace;
}

export function deriveRequestedActions(
	tools: ReadonlyArray<ToolName>,
	safety: SafetyContract,
): ReadonlyArray<ActionClass> {
	const actions = new Set<ActionClass>();
	for (const tool of tools) {
		actions.add(safety.classify({ tool }).actionClass);
	}
	return [...actions].sort();
}

export function buildStableSystemPrompt(req: DispatchRequest, recipe: AgentRecipe | null): string {
	const base = req.systemPrompt && req.systemPrompt.length > 0 ? req.systemPrompt : (recipe?.body ?? "");
	const skillBlock = recipe && req.noSkills !== true ? renderAgentSkillPrompt(recipe) : "";
	const body = [base, skillBlock].filter((part) => part.trim().length > 0).join("\n\n");
	const guardedBase = body.length > 0 ? `${DISPATCH_TASK_CONTRACT}\n\n${body}` : DISPATCH_TASK_CONTRACT;
	return guardedBase;
}

function renderAgentSkillPrompt(recipe: AgentRecipe): string {
	const skills = recipe.skills ?? [];
	if (skills.length === 0) return "";
	const skillList = skills.map((skill) => `\`${skill}\``).join(", ");
	return [
		"# Agent-Bound Skills",
		`This run binds these skills: ${skillList}. read_skill admits exactly these names and rejects any other.`,
		"Load a bound skill with `read_skill` when it matches the assigned task, then follow its workflow.",
		"Skills provide reusable know-how and resources; they never expand your tool authority.",
		"If a bound skill fails to load, continue with the assigned task and report the missing skill.",
	].join("\n");
}

export function buildDynamicPromptMessages(req: DispatchRequest): WorkerPromptMessage[] {
	const memory = req.memorySection?.trim() ?? "";
	if (memory.length === 0) return [];
	return [
		{
			id: "dispatch-memory",
			body: memory,
			contentHash: sha256(memory),
		},
	];
}

interface ResolvedTarget {
	target: TargetDescriptor;
	runtime: RuntimeDescriptor;
	wireModelId: string;
	thinkingLevel: ThinkingLevel;
	capabilities: CapabilityFlags | null;
	modelCapabilities: CapabilityFlags | null;
	runtimeResolution: ResolvedRuntimeTarget;
}

interface WorkerTargetConfig {
	target: string | null;
	model: string | null;
	thinkingLevel: ThinkingLevel;
}

type WorkerProfileMap = Record<string, WorkerTargetConfig>;

interface WorkerTargets {
	workerDefault: WorkerTargetConfig | null;
	workerProfiles: WorkerProfileMap;
}

interface DispatchAdmissionStage {
	allowedTools: ReadonlyArray<ToolName>;
	requestedActions: ReadonlyArray<ActionClass>;
	toolProfile?: ToolProfileName;
}

interface DispatchWorkerSpecInput {
	req: DispatchRequest;
	target: ResolvedTarget;
	admission: DispatchAdmissionStage;
	recipe?: AgentRecipe | null;
	systemPrompt: string;
	dynamicPromptMessages: ReadonlyArray<WorkerPromptMessage>;
	promptSignature: string | null;
	toolSignature: string;
	dynamicHash: string | null;
	apiKey: string | undefined;
	middlewareSnapshot: ReturnType<MiddlewareContract["snapshot"]>;
}

interface DispatchLifecycleStage {
	recipe: AgentRecipe | null;
	admission: DispatchAdmissionStage;
	target: ResolvedTarget;
	cwd: string;
	systemPrompt: string;
	dynamicPromptMessages: ReadonlyArray<WorkerPromptMessage>;
	compiledPromptHash: string | null;
	staticCompositionHash: string | null;
	sessionShellHash: string | null;
	dynamicHash: string | null;
	promptSignature: string | null;
	toolSignature: string;
	apiKey: string | undefined;
	runtimeKind: RunKind;
	agentAudience: AgentAudience;
	requestOrigin: DispatchRequestOrigin;
	runtimeLimitations: string[];
}

interface AcpDelegationLifecycleStage {
	admission: DispatchAdmissionStage;
	agentConfig: ReturnType<ConfigContract["get"]>["delegation"]["agents"][number];
	cwd: string;
	systemPrompt: string;
	dynamicPromptMessages: ReadonlyArray<WorkerPromptMessage>;
	compiledPromptHash: string | null;
	staticCompositionHash: string | null;
	sessionShellHash: string | null;
	dynamicHash: string | null;
	promptSignature: string | null;
	toolSignature: string;
	runtimeLimitations: string[];
	requestOrigin: DispatchRequestOrigin;
}

function capabilityInfoForTarget(providers: ProvidersContract, targetId: string): CapabilityFlags | null {
	return providers.list().find((entry) => entry.target.id === targetId)?.capabilities ?? null;
}

function capabilityInfoForModel(
	providers: ProvidersContract,
	targetId: string,
	wireModelId: string | null | undefined,
): CapabilityFlags | null {
	const status = providers.list().find((entry) => entry.target.id === targetId);
	if (!status) return null;
	const modelId = wireModelId ?? status.target.defaultModel ?? null;
	const detectedReasoning = modelId ? providers.getDetectedReasoning(targetId, modelId) : null;
	return resolveModelCapabilities(status, modelId, providers.knowledgeBase, { detectedReasoning });
}

function runtimeIdForTarget(providers: ProvidersContract, targetId: string): string | null {
	return providers.getTarget(targetId)?.runtime ?? null;
}

function supportsRequiredCapabilities(
	capabilities: CapabilityFlags | null,
	required: ReadonlyArray<string> | undefined,
): boolean {
	if (!required || required.length === 0) return true;
	if (!capabilities) return false;
	const caps = capabilities as unknown as Record<string, unknown>;
	for (const name of required) {
		const value = caps[name];
		if (value === undefined || value === false || value === 0 || value === "") return false;
	}
	return true;
}

function runtimeLimitations(_runtimeKind: RunKind, _runtimeId: string): string[] {
	// Clio only drives HTTP/native runtimes through pi-agent-core, which Clio
	// observes and controls directly, so there are no runtime-imposed dispatch
	// limitations to record.
	return [];
}

function acpRuntimeLimitations(): string[] {
	return ["external ACP agent executes its own tools; Clio mediates permission requests and records decisions"];
}

function readWorkerTargets(settings: ReturnType<ConfigContract["get"]> | undefined): WorkerTargets {
	const workerDefault = settings?.workers?.default
		? {
				target: settings.workers.default.target ?? null,
				model: settings.workers.default.model ?? null,
				thinkingLevel: (settings.workers.default.thinkingLevel ?? "off") as ThinkingLevel,
			}
		: null;
	const workerProfiles: WorkerProfileMap = {};
	for (const [name, profile] of Object.entries(settings?.workers?.profiles ?? {})) {
		workerProfiles[name] = {
			target: profile.target ?? null,
			model: profile.model ?? null,
			thinkingLevel: (profile.thinkingLevel ?? "off") as ThinkingLevel,
		};
	}
	return { workerDefault, workerProfiles };
}

function resolveDispatchAdmissionStage(
	req: DispatchRequest,
	recipe: AgentRecipe,
	safety: SafetyContract,
): DispatchAdmissionStage {
	const recipeTools = recipe.tools;
	const candidateTools = recipeTools && recipeTools.length > 0 ? (Array.from(recipeTools) as ToolName[]) : [];
	const allowedTools = applyToolProfile(candidateTools, req.toolProfile, { agentId: req.agentId, task: req.task });
	assertAgentSpecPolicy(normalizeAgentSpec(recipe));
	const unavailableTools = allowedTools.filter((tool) => isBuiltinToolName(tool) && !candidateTools.includes(tool));
	if (unavailableTools.length > 0) {
		throw new Error(
			`dispatch: admission denied: agent '${req.agentId}' cannot expose undeclared tools: ${unavailableTools.join(", ")}`,
		);
	}
	const requestedActions = deriveRequestedActions(allowedTools, safety);
	const orchScope = pickOrchestratorScope(safety);
	const workerScope = pickWorkerScope(safety, requestedActions);
	const verdict = admit(
		{
			requestedScope: workerScope,
			orchestratorScope: orchScope,
			requestedActions,
			agentId: req.agentId,
		},
		safety.isSubset,
	);
	if (!verdict.admitted) {
		throw new Error(`dispatch: admission denied: ${verdict.reason}`);
	}
	return {
		allowedTools,
		requestedActions,
		...(req.toolProfile !== undefined ? { toolProfile: req.toolProfile } : {}),
	};
}

function resolveDelegationAdmissionStage(req: DispatchRequest, safety: SafetyContract): DispatchAdmissionStage {
	const allowedTools = applyToolProfile([], req.toolProfile);
	const requestedActions = deriveRequestedActions(allowedTools, safety);
	const orchScope = pickOrchestratorScope(safety);
	const workerScope = pickWorkerScope(safety, requestedActions);
	const verdict = admit(
		{
			requestedScope: workerScope,
			orchestratorScope: orchScope,
			requestedActions,
			agentId: req.agentId,
		},
		safety.isSubset,
	);
	if (!verdict.admitted) {
		throw new Error(`dispatch: delegation admission denied: ${verdict.reason}`);
	}
	return {
		allowedTools,
		requestedActions,
		...(req.toolProfile !== undefined ? { toolProfile: req.toolProfile } : {}),
	};
}

export function buildDispatchWorkerSpec(input: DispatchWorkerSpecInput, config?: ConfigContract): WorkerSpec {
	const spec: WorkerSpec = {
		specVersion: WORKER_SPEC_VERSION,
		systemPrompt: input.systemPrompt,
		dynamicPromptMessages: input.dynamicPromptMessages,
		...(input.promptSignature !== null ? { promptSignature: input.promptSignature } : {}),
		toolSignature: input.toolSignature,
		...(input.dynamicHash !== null ? { dynamicHash: input.dynamicHash } : {}),
		agentId: input.req.agentId,
		task: input.req.task,
		target: input.target.target,
		runtime: serializeWorkerRuntimeDescriptor(input.target.runtime),
		runtimeId: input.target.runtime.id,
		wireModelId: input.target.wireModelId,
		thinkingLevel: input.target.thinkingLevel,
		allowedTools: input.admission.allowedTools,
		middlewareSnapshot: input.middlewareSnapshot,
	};
	spec.runtimeResolution = runtimeTargetSnapshot(input.target.runtimeResolution);
	if (input.target.modelCapabilities) spec.modelCapabilities = input.target.modelCapabilities;
	if (input.apiKey) spec.apiKey = input.apiKey;
	if (input.req.noSkills !== undefined) spec.noSkills = input.req.noSkills;
	if (input.req.skillPaths !== undefined) spec.skillPaths = input.req.skillPaths;
	// Recipe-declared skills become a harness-enforced read_skill allowlist in
	// the worker. Only forwarded when the admitted tool surface can use them.
	const recipeSkills = (input.recipe?.skills ?? []).map((name) => name.trim()).filter((name) => name.length > 0);
	if (
		input.req.noSkills !== true &&
		recipeSkills.length > 0 &&
		input.admission.allowedTools.includes(ToolNames.ReadSkill)
	) {
		spec.agentSkills = [...new Set(recipeSkills)];
	}
	if (input.req.trustProjectCompatRoots !== undefined) {
		spec.trustProjectCompatRoots = input.req.trustProjectCompatRoots;
	} else if (config) {
		spec.trustProjectCompatRoots = config.get().skills.trustProjectCompatRoots === true;
	}
	// Non-stall posture (Symphony §10.5): a dispatched worker has no operator
	// to answer a permission prompt, so the resolution policy ships with the
	// spec and the worker enforces it within bounded time.
	spec.onPermission = config?.get().workers.onPermission ?? "deny";
	// Workers inherit the session's autonomy level at admission time (sd-01
	// §2.5); the worker registry applies the same mapping the orchestrator's
	// does, with asks resolving through onPermission above.
	spec.autonomy = config?.get().autonomy ?? "auto-edit";
	return spec;
}

function pickCapabilityMatchedWorker(
	required: ReadonlyArray<string> | undefined,
	runtimeId: string | undefined,
	workerDefault: WorkerTargetConfig | null,
	workerProfiles: WorkerProfileMap,
	providers: ProvidersContract,
): WorkerTargetConfig | null {
	if ((!required || required.length === 0) && !runtimeId) return null;
	if (
		workerDefault?.target &&
		(!runtimeId || runtimeIdForTarget(providers, workerDefault.target) === runtimeId) &&
		supportsRequiredCapabilities(capabilityInfoForModel(providers, workerDefault.target, workerDefault.model), required)
	) {
		return workerDefault;
	}
	for (const profile of Object.values(workerProfiles)) {
		if (!profile.target) continue;
		if (runtimeId && runtimeIdForTarget(providers, profile.target) !== runtimeId) continue;
		if (supportsRequiredCapabilities(capabilityInfoForModel(providers, profile.target, profile.model), required)) {
			return profile;
		}
	}
	return null;
}

function resolveDispatchTarget(
	req: DispatchRequest,
	recipe: AgentRecipe,
	workerDefault: WorkerTargetConfig | null,
	workerProfiles: WorkerProfileMap,
	providers: ProvidersContract,
): ResolvedTarget {
	let selectedWorkerTarget: WorkerTargetConfig | null = null;
	let targetId = req.target ?? null;
	if (!targetId && req.workerProfile) {
		const profile = workerProfiles[req.workerProfile];
		if (!profile) throw new Error(`dispatch: fleet profile '${req.workerProfile}' not configured`);
		if (!profile.target) throw new Error(`dispatch: fleet profile '${req.workerProfile}' has no target`);
		selectedWorkerTarget = profile;
		targetId = profile.target;
	}
	if (!targetId) targetId = recipe.target ?? null;
	if (!targetId) {
		selectedWorkerTarget = pickCapabilityMatchedWorker(
			req.requiredCapabilities,
			req.workerRuntime,
			workerDefault,
			workerProfiles,
			providers,
		);
		targetId = selectedWorkerTarget?.target ?? null;
	}
	if (!targetId && req.workerRuntime) {
		throw new Error(`dispatch: no worker target configured for runtime '${req.workerRuntime}'`);
	}
	if (!targetId) {
		selectedWorkerTarget = workerDefault;
		targetId = workerDefault?.target ?? null;
	}
	if (!targetId) {
		throw new Error("dispatch: no target configured (set the fleet default, add a fleet profile, or pass target)");
	}
	const target = providers.getTarget(targetId);
	if (!target) throw new Error(`dispatch: target '${targetId}' not found`);
	const runtime = providers.getRuntime(target.runtime);
	if (!runtime) throw new Error(`dispatch: runtime '${target.runtime}' not registered`);
	const matchingDefault = workerDefault?.target === targetId ? workerDefault : null;
	const fallbackWorkerTarget = selectedWorkerTarget ?? matchingDefault;
	const requestedWireModelId = req.model ?? recipe.model ?? fallbackWorkerTarget?.model ?? target.defaultModel;
	if (!requestedWireModelId) {
		throw new Error(`dispatch: no model for target '${targetId}' (set a fleet profile model or target.defaultModel)`);
	}
	const status = providers.list().find((entry) => entry.target.id === target.id);
	const wireModelId = status ? canonicalizeWireModelId(status, requestedWireModelId) : requestedWireModelId;
	const thinkingLevel = (req.thinkingLevel ??
		recipe.thinkingLevel ??
		fallbackWorkerTarget?.thinkingLevel ??
		"off") as ThinkingLevel;
	const resolved = resolveRuntimeTarget(providers, {
		targetId,
		wireModelId,
		requestedThinkingLevel: thinkingLevel,
		use: "dispatch",
		requireOutputBudget: true,
	});
	if (!resolved.ok) {
		throw new Error(
			`dispatch: target resolution failed: ${firstRuntimeResolutionError(resolved.diagnostics) ?? resolved.diagnostics.map((entry) => entry.message).join("; ")}`,
		);
	}
	const modelCapabilities = resolved.target.capabilities;
	return {
		target,
		runtime,
		wireModelId,
		thinkingLevel: resolved.target.effectiveThinkingLevel,
		capabilities: capabilityInfoForTarget(providers, target.id),
		modelCapabilities,
		runtimeResolution: resolved.target,
	};
}

function enforceCapabilityGate(
	targetId: string,
	capabilities: CapabilityFlags | null,
	required: ReadonlyArray<string> | undefined,
): void {
	if (!required || required.length === 0) return;
	if (!capabilities) {
		throw new Error(`dispatch: admission denied: capability info unavailable for target '${targetId}'`);
	}
	const caps = capabilities as unknown as Record<string, unknown>;
	for (const name of required) {
		const value = caps[name];
		if (value === undefined || value === false || value === 0 || value === "") {
			throw new Error(`dispatch: admission denied: capability '${name}' not supported by target '${targetId}'`);
		}
	}
}

export function createDispatchBundle(
	context: DomainContext,
	options?: DispatchBundleOptions,
): DomainBundle<DispatchContract> {
	const maybeSafety = context.getContract<SafetyContract>("safety");
	const maybeAgents = context.getContract<AgentsContract>("agents");
	const maybeProviders = context.getContract<ProvidersContract>("providers");
	const maybeMiddleware = context.getContract<MiddlewareContract>("middleware");
	if (!maybeSafety) throw new Error("dispatch domain requires 'safety' contract");
	if (!maybeAgents) throw new Error("dispatch domain requires 'agents' contract");
	if (!maybeProviders) throw new Error("dispatch domain requires 'providers' contract");
	if (!maybeMiddleware) throw new Error("dispatch domain requires 'middleware' contract");
	const safety: SafetyContract = maybeSafety;
	const agents: AgentsContract = maybeAgents;
	const providers: ProvidersContract = maybeProviders;
	const middleware: MiddlewareContract = maybeMiddleware;
	const config = context.getContract<ConfigContract>("config");
	const scheduling = context.getContract<SchedulingContract>("scheduling");
	const spawnWorker = options?.spawnWorker ?? spawnNativeWorker;
	const startAcpRun = options?.startAcpDelegationRun ?? startAcpDelegationRun;
	const heartbeatSpec = options?.heartbeatSpec ?? DEFAULT_HEARTBEAT_SPEC;
	const heartbeatIntervalMs = options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
	const resilienceCooldownMs = options?.resilienceCooldownMs ?? DEFAULT_RESILIENCE_COOLDOWN_MS;
	const now = options?.now ?? (() => Date.now());

	let ledger: Ledger | null = null;
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	const active = new Map<string, ActiveRun>();
	const targetCooldowns = new Map<string, { until: number; reason: string }>();

	/**
	 * Budget admission preflight denial. The dispatch dies before any worker or
	 * run row exists, so without this denied tool_call row the audit log would
	 * carry no trace that the admission gate refused the dispatch.
	 */
	function denyDispatchForBudget(preflight: { currentUsd: number; ceilingUsd: number }, agentId: string): never {
		const reason = `budget ceiling crossed: $${preflight.currentUsd.toFixed(4)} / $${preflight.ceilingUsd.toFixed(4)}`;
		safety.audit.recordToolCall?.({
			tool: "dispatch",
			classification: { actionClass: "dispatch", reasons: ["budget admission preflight"] },
			decision: "denied",
			reasons: [reason],
			reasonCode: "budget-ceiling",
			args: { agentId },
		});
		throw new Error(`dispatch: admission denied: ${reason}`);
	}

	/**
	 * In-memory retry queue (Symphony §14.3: it does not survive restart and
	 * must not pretend to). Keyed by the finished run's id; backoff state is
	 * keyed by the retry chain's rootRunId.
	 */
	interface RetryQueueEntry {
		runId: string;
		agentId: string;
		attempt: number;
		dueAt: number;
		reason: string;
		timer: ReturnType<typeof setTimeout>;
	}
	const retryQueue = new Map<string, RetryQueueEntry>();
	const retryBackoff = new Map<string, BackoffState>();
	let draining = false;

	/** Session-scope totals for the operator snapshot; finalized runs only. */
	const finalizedTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 };

	function workersMaxRetries(): number {
		const value = config?.get().workers?.maxRetries;
		return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 2;
	}

	function lineageFor(req: DispatchRequest, runId: string): RunLineage {
		if (req.lineage) return { ...req.lineage };
		return { parentRunId: null, rootRunId: runId, attempt: 0, depth: 0 };
	}

	function accumulateFinalizedTotals(receipt: RunReceipt): void {
		finalizedTotals.inputTokens += receipt.inputTokenCount ?? 0;
		finalizedTotals.outputTokens += receipt.outputTokenCount ?? 0;
		finalizedTotals.totalTokens += receipt.tokenCount;
		finalizedTotals.costUsd += receipt.costUsd;
		const startMs = Date.parse(receipt.startedAt);
		const endMs = Date.parse(receipt.endedAt);
		if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
			finalizedTotals.runtimeSeconds += Math.max(0, endMs - startMs) / 1000;
		}
	}

	function maybeScheduleRetry(run: ActiveRun, outcome: RunOutcome, detail: string | null): void {
		if (draining) return;
		const rootRunId = run.lineage.rootRunId;
		if (!RETRYABLE_OUTCOMES.has(outcome)) {
			retryBackoff.delete(rootRunId);
			return;
		}
		const maxRetries = workersMaxRetries();
		if (maxRetries <= 0 || run.lineage.attempt >= maxRetries) {
			retryBackoff.delete(rootRunId);
			return;
		}
		const backoff = retryBackoff.get(rootRunId) ?? createBackoff();
		const { state: nextBackoff, delayMs: backoffDelayMs } = nextDelay(backoff);
		retryBackoff.set(rootRunId, nextBackoff);
		// Retries re-pass every admission gate, including the target cooldown.
		// Honoring the gate means waiting it out, not skipping it: schedule no
		// earlier than the cooldown expiry so the retry is not denied on
		// arrival by a cooldown this same failure created.
		const cooldown = targetCooldowns.get(cooldownKey(run.targetId, run.runtimeId, run.wireModelId));
		const cooldownRemainingMs = cooldown ? Math.max(0, cooldown.until - now()) : 0;
		const delayMs = Math.max(backoffDelayMs, cooldownRemainingMs > 0 ? cooldownRemainingMs + 250 : 0);
		const attempt = run.lineage.attempt + 1;
		const reason = detail !== null ? `${outcome}: ${detail}` : outcome;
		const timer = setTimeout(() => {
			retryQueue.delete(run.runId);
			void executeRetry(run, attempt);
		}, delayMs);
		timer.unref?.();
		retryQueue.set(run.runId, {
			runId: run.runId,
			agentId: run.agentId,
			attempt,
			dueAt: now() + delayMs,
			reason,
			timer,
		});
	}

	/**
	 * A retry is a brand-new run with a new runId, re-validated through the
	 * full admission chain. If admission rejects it the chain ends as
	 * denied_by_policy; there is no requeue.
	 */
	async function executeRetry(run: ActiveRun, attempt: number): Promise<void> {
		if (draining) return;
		const retryReq: DispatchRequest = {
			...run.req,
			requestOrigin: "internal",
			lineage: {
				parentRunId: run.runId,
				rootRunId: run.lineage.rootRunId,
				attempt,
				depth: run.lineage.depth,
			},
		};
		try {
			const handle = await dispatch(retryReq);
			// No interactive consumer exists for a retry, so drain the event
			// stream here; token accounting and tool stats fold in as a side
			// effect of iteration.
			void (async () => {
				for await (const _ of handle.events) {
					// drained
				}
			})().catch(() => {});
			handle.finalPromise.catch(() => {});
		} catch (err) {
			retryBackoff.delete(run.lineage.rootRunId);
			const message = err instanceof Error ? err.message : String(err);
			context.bus.emit(BusChannels.DispatchFailed, {
				runId: run.runId,
				agentId: run.agentId,
				...(run.requestOrigin !== undefined ? { requestOrigin: run.requestOrigin } : {}),
				targetId: run.targetId,
				wireModelId: run.wireModelId,
				runtimeId: run.runtimeId,
				runtimeKind: run.runtimeKind,
				reason: "retry_denied",
				outcome: "denied_by_policy" satisfies RunOutcome,
				outcomeDetail: `retry attempt ${attempt} rejected: ${message}`,
			});
		}
	}

	function requireLedger(): Ledger {
		if (!ledger) throw new Error("dispatch: ledger not initialised");
		return ledger;
	}

	function heartbeatIso(heartbeatMs: number): string {
		return new Date(heartbeatMs).toISOString();
	}

	function heartbeatRunStatus(status: HeartbeatStatus): RunStatus {
		return status === "alive" ? "running" : status;
	}

	function emitHeartbeatStatus(run: ActiveRun, status: HeartbeatStatus): void {
		context.bus.emit(BusChannels.DispatchProgress, {
			runId: run.runId,
			agentId: run.agentId,
			targetId: run.targetId,
			wireModelId: run.wireModelId,
			runtimeId: run.runtimeId,
			runtimeKind: run.runtimeKind,
			...(run.agentAudience !== undefined ? { agentAudience: run.agentAudience } : {}),
			...(run.requestOrigin !== undefined ? { requestOrigin: run.requestOrigin } : {}),
			event: {
				type: "heartbeat_status",
				status,
				heartbeatAt: run.heartbeatAt ? heartbeatIso(run.heartbeatAt.current) : null,
			},
		});
	}

	/**
	 * Reconciler tick (Symphony §8.1: reconcile before dispatch). Observes
	 * every running entry and acts on the classification: a stale native
	 * worker gets one operator-visible warning per transition, a dead one is
	 * terminated through the SIGTERM→SIGKILL path and finalized as stalled by
	 * the run's own finalizer. ACP delegations have no periodic heartbeat, so
	 * they are bounded by an event-inactivity stall window instead of the
	 * native heartbeat spec. This loop runs on its own timer and never
	 * consults admission gates: a budget ceiling breach cannot prevent the
	 * reconciler from killing a dead worker.
	 */
	function checkActiveHeartbeats(): void {
		if (!ledger) return;
		const tickNow = now();
		for (const run of active.values()) {
			if (run.aborted || run.stallKilled || !run.heartbeatAt) continue;
			const heartbeatMs = run.heartbeatAt.current;
			if (!Number.isFinite(heartbeatMs)) continue;
			if (run.runtimeKind === "acp-delegation") {
				ledger.update(run.runId, { heartbeatAt: heartbeatIso(heartbeatMs) });
				const stallMs = run.stallTimeoutMs;
				if (stallMs === null || stallMs <= 0) continue;
				if (tickNow - heartbeatMs <= stallMs) continue;
				run.stallKilled = true;
				run.heartbeatStatus = "dead";
				emitHeartbeatStatus(run, "dead");
				try {
					run.kill();
				} catch {
					// peer may have exited between classification and kill
				}
				continue;
			}
			const status = classifyHeartbeat(heartbeatMs, tickNow, heartbeatSpec);
			const patch: Partial<RunEnvelope> = {
				status: heartbeatRunStatus(status),
				heartbeatAt: heartbeatIso(heartbeatMs),
			};
			ledger.update(run.runId, patch);
			if (status === run.heartbeatStatus) continue;
			run.heartbeatStatus = status;
			emitHeartbeatStatus(run, status);
			if (status !== "dead") continue;
			run.stallKilled = true;
			try {
				run.kill();
			} catch {
				// child may have exited between classification and reap attempt
			}
		}
	}

	function startHeartbeatWatchdog(): void {
		if (heartbeatTimer || heartbeatIntervalMs <= 0) return;
		heartbeatTimer = setInterval(checkActiveHeartbeats, heartbeatIntervalMs);
		heartbeatTimer.unref?.();
	}

	function stopHeartbeatWatchdog(): void {
		if (!heartbeatTimer) return;
		clearInterval(heartbeatTimer);
		heartbeatTimer = null;
	}

	function cooldownKey(targetId: string, runtimeId: string, wireModelId: string): string {
		return `${targetId}\0${runtimeId}\0${wireModelId}`;
	}

	function assertTargetNotCoolingDown(targetId: string, runtimeId: string, wireModelId: string): void {
		const key = cooldownKey(targetId, runtimeId, wireModelId);
		const cooldown = targetCooldowns.get(key);
		if (!cooldown) return;
		const remaining = cooldown.until - now();
		if (remaining <= 0) {
			targetCooldowns.delete(key);
			return;
		}
		throw new Error(
			`dispatch: target '${targetId}' is cooling down for ${Math.ceil(remaining / 1000)}s after ${cooldown.reason}`,
		);
	}

	function recordTargetOutcome(
		targetId: string,
		runtimeId: string,
		wireModelId: string,
		status: RunStatus,
		exitCode: number,
	): void {
		const key = cooldownKey(targetId, runtimeId, wireModelId);
		if (status === "completed" && exitCode === 0) {
			targetCooldowns.delete(key);
			return;
		}
		if (resilienceCooldownMs <= 0) return;
		targetCooldowns.set(key, { until: now() + resilienceCooldownMs, reason: status });
	}

	async function resolveLifecycle(req: DispatchRequest): Promise<DispatchLifecycleStage> {
		const recipe = agents.get(req.agentId);
		if (!recipe) {
			throw new Error(`dispatch: unknown agent recipe: ${req.agentId}`);
		}
		const spec = normalizeAgentSpec(recipe);
		if (req.requestOrigin === "user" && !isUserVisibleAgent(spec)) {
			throw new Error(
				`dispatch: agent '${req.agentId}' is a ${spec.audience} agent reserved for Clio internal orchestration`,
			);
		}
		const admission = resolveDispatchAdmissionStage(req, recipe, safety);
		const targets = readWorkerTargets(options?.getSettings?.() ?? config?.get());
		const target = resolveDispatchTarget(req, recipe, targets.workerDefault, targets.workerProfiles, providers);
		enforceCapabilityGate(target.target.id, target.modelCapabilities, req.requiredCapabilities);

		const cwd = req.cwd ?? process.cwd();
		const systemPrompt = buildStableSystemPrompt(req, recipe);
		const dynamicPromptMessages = buildDynamicPromptMessages(req);
		const dynamicText = dynamicPromptMessages.map((message) => message.body).join("\n\n");
		const compiledPromptHash = promptCompositionHash([systemPrompt, dynamicText]);
		const staticCompositionHash = promptHash(systemPrompt);
		const sessionShellHash = staticCompositionHash;
		const dynamicHash = dynamicPromptMessages.length > 0 ? sha256(dynamicText) : sha256("");
		const currentToolSignature = toolSignature(admission.allowedTools);
		const auth = targetRequiresAuth(target.target, target.runtime)
			? await providers.auth.resolveForTarget(target.target, target.runtime)
			: null;
		// pi-ai's openai-completions provider refuses to stream without an apiKey
		// even when the target is a local server that ignores Authorization headers.
		// Match chat-loop's LOCAL_API_KEY_FALLBACK so dispatch-spawned workers can
		// reach openai-compat local endpoints (LM Studio, llama.cpp) without
		// requiring the user to invent a credential.
		const apiKey = auth?.apiKey ?? (auth === null ? "clio-local-target" : undefined);
		const runtimeKind: RunKind = target.runtime.kind;
		const limitations = runtimeLimitations(runtimeKind, target.runtime.id);
		return {
			recipe,
			admission,
			target,
			cwd,
			systemPrompt,
			dynamicPromptMessages,
			compiledPromptHash,
			staticCompositionHash,
			sessionShellHash,
			dynamicHash,
			promptSignature: compiledPromptHash,
			toolSignature: currentToolSignature,
			apiKey,
			runtimeKind,
			agentAudience: spec.audience,
			requestOrigin: requestOriginFor(req),
			runtimeLimitations: limitations,
		};
	}

	function resolveAcpDelegationLifecycle(req: DispatchRequest): AcpDelegationLifecycleStage {
		const agentId = req.delegationAgentId;
		if (!agentId) throw new Error("dispatch: missing delegationAgentId");
		if (req.agentId && maybeAgents) {
			const spec = maybeAgents.getSpec(req.agentId);
			if (spec && (spec.audience === "shadow" || spec.audience === "internal")) {
				throw new Error(
					`dispatch: shadow or internal agent '${req.agentId}' cannot run on external ACP agent '${agentId}'`,
				);
			}
		}
		const settings = config?.get();
		if (!settings) throw new Error("dispatch: config domain required for ACP delegation");
		const configured = settings.delegation.agents.find((entry) => entry.id === agentId);
		if (!configured) throw new Error(`dispatch: ACP delegation agent '${agentId}' not configured`);
		const admission = resolveDelegationAdmissionStage(req, safety);
		const cwd = req.cwd ?? process.cwd();
		const systemPrompt = buildStableSystemPrompt(req, null);
		const dynamicPromptMessages = buildDynamicPromptMessages(req);
		const dynamicText = dynamicPromptMessages.map((message) => message.body).join("\n\n");
		const compiledPromptHash = promptCompositionHash([systemPrompt, dynamicText]);
		const staticCompositionHash = promptHash(systemPrompt);
		const sessionShellHash = staticCompositionHash;
		const dynamicHash = dynamicPromptMessages.length > 0 ? sha256(dynamicText) : sha256("");
		const currentToolSignature = toolSignature(admission.allowedTools);
		return {
			admission,
			agentConfig: configured,
			cwd,
			systemPrompt,
			dynamicPromptMessages,
			compiledPromptHash,
			staticCompositionHash,
			sessionShellHash,
			dynamicHash,
			promptSignature: compiledPromptHash,
			toolSignature: currentToolSignature,
			requestOrigin: requestOriginFor(req),
			runtimeLimitations: acpRuntimeLimitations(),
		};
	}

	async function dispatchAcpDelegation(req: DispatchRequest): Promise<{
		runId: string;
		events: AsyncIterableIterator<unknown>;
		finalPromise: Promise<RunReceipt>;
	}> {
		const lifecycle = resolveAcpDelegationLifecycle(req);
		const targetId = `delegation:${lifecycle.agentConfig.id}`;
		const runtimeId = "acp";
		const wireModelId = lifecycle.agentConfig.id;
		assertTargetNotCoolingDown(targetId, runtimeId, wireModelId);

		if (scheduling) {
			const preflight = scheduling.preflight();
			if (preflight.verdict === "over" || preflight.verdict === "at") {
				denyDispatchForBudget(preflight, req.agentId);
			}
		}

		let workerSlotHeld = false;
		const releaseWorkerSlot = (): void => {
			if (!workerSlotHeld || !scheduling) return;
			workerSlotHeld = false;
			scheduling.releaseWorker();
		};
		if (scheduling) {
			workerSlotHeld = scheduling.tryAcquireWorker();
			if (!workerSlotHeld) {
				throw new DispatchConcurrencyError(scheduling.activeWorkers());
			}
		}

		let acp: AcpDelegationRunHandle;
		try {
			acp = startAcpRun({
				agent: lifecycle.agentConfig,
				task: req.task,
				systemPrompt: lifecycle.systemPrompt,
				dynamicPromptMessages: lifecycle.dynamicPromptMessages,
				cwd: lifecycle.cwd,
				safety,
				autonomy: config?.get().autonomy ?? "auto-edit",
				clientVersion: readClioVersion(),
			});
		} catch (error) {
			releaseWorkerSlot();
			throw error;
		}

		const tokenMeter = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
		const safetyDecisionCounts = { allowed: 0, blocked: 0, permissionRequested: 0 };
		const blockedAttempts: SafetyBlockedAttempt[] = [];
		const toolStats = new Map<string, ToolCallStat>();
		const upstreamResponses: RunReceiptUpstreamResponse[] = [];
		let failureMessage: string | undefined;
		let runIdForPermissionAudit: string | null = null;
		const enrichedEvents: AsyncIterableIterator<unknown> = (async function* () {
			for await (const raw of acp.events) {
				const event = raw as {
					type?: string;
					message?: {
						role?: string;
						usage?: unknown;
						model?: unknown;
						responseModel?: unknown;
						responseId?: unknown;
						stopReason?: unknown;
						errorMessage?: unknown;
					};
					payload?: {
						tool?: string;
						posture?: string;
						durationMs?: number;
						outcome?: "ok" | "error" | "blocked";
						decision?: "allowed" | "blocked" | "permission_requested";
						actionClass?: string;
						ruleId?: string;
						reasonCode?: string;
						policySource?: string;
						reason?: string;
					};
				};
				if (event.type === "message_end" && event.message?.role === "assistant" && isRecord(event.message.usage)) {
					const u = event.message.usage;
					tokenMeter.inputTokens += typeof u.input === "number" ? u.input : 0;
					tokenMeter.outputTokens += typeof u.output === "number" ? u.output : 0;
					tokenMeter.cacheReadTokens += typeof u.cacheRead === "number" ? u.cacheRead : 0;
					tokenMeter.cacheWriteTokens += typeof u.cacheWrite === "number" ? u.cacheWrite : 0;
					tokenMeter.reasoningTokens += extractReasoningTokenCount(u);
					const model = readStringOrNull(event.message.model);
					const responseModel = readStringOrNull(event.message.responseModel);
					const responseId = readStringOrNull(event.message.responseId);
					if (model !== null || responseModel !== null || responseId !== null) {
						upstreamResponses.push({ model, responseModel, responseId });
					}
					if (event.message.stopReason === "error") {
						const message = readStringOrNull(event.message.errorMessage);
						if (message !== null) failureMessage = message;
					}
				}
				if (event.type === "clio_permission_resolved" && event.payload && typeof event.payload.tool === "string") {
					context.bus.emit(BusChannels.PermissionResolved, {
						status: "denied",
						tool: event.payload.tool,
						...(typeof event.payload.actionClass === "string" ? { actionClass: event.payload.actionClass } : {}),
						...(typeof event.payload.reason === "string" ? { reason: event.payload.reason } : {}),
						...(runIdForPermissionAudit !== null ? { requestedBy: runIdForPermissionAudit } : {}),
					});
				}
				if (event.type === "clio_tool_finish" && event.payload && typeof event.payload.tool === "string") {
					recordToolFinish(toolStats, event.payload);
					if (event.payload.decision === "allowed") safetyDecisionCounts.allowed += 1;
					else if (event.payload.decision === "blocked") safetyDecisionCounts.blocked += 1;
					else if (event.payload.decision === "permission_requested") safetyDecisionCounts.permissionRequested += 1;
					if (event.payload.outcome === "blocked" || event.payload.decision === "blocked") {
						const attempt: SafetyBlockedAttempt = { tool: event.payload.tool };
						if (event.payload.actionClass !== undefined) attempt.actionClass = event.payload.actionClass;
						if (event.payload.ruleId !== undefined) attempt.ruleId = event.payload.ruleId;
						if (event.payload.reasonCode !== undefined) attempt.reasonCode = event.payload.reasonCode;
						if (event.payload.policySource !== undefined) attempt.policySource = event.payload.policySource;
						if (event.payload.reason !== undefined) attempt.reason = event.payload.reason;
						blockedAttempts.push(attempt);
					}
				}
				yield raw;
			}
		})();

		const ledgerRef = requireLedger();
		const envelope = ledgerRef.create({
			agentId: req.agentId,
			requestOrigin: lifecycle.requestOrigin,
			task: req.task,
			targetId,
			wireModelId,
			runtimeId,
			runtimeKind: "acp-delegation",
			sessionId: null,
			cwd: lifecycle.cwd,
			staticShellHash: lifecycle.staticCompositionHash,
			sessionShellHash: lifecycle.sessionShellHash,
			dynamicHash: lifecycle.dynamicHash,
			promptSignature: lifecycle.promptSignature,
			toolSignature: lifecycle.toolSignature,
		});
		runIdForPermissionAudit = envelope.id;
		const lineage = lineageFor(req, envelope.id);
		const identity = detectRunIdentity();
		ledgerRef.update(envelope.id, {
			status: "running",
			pid: acp.pid,
			heartbeatAt: heartbeatIso(acp.heartbeatAt.current),
			lineage,
			identity,
		});
		// One durable write at start so sibling processes (clio fleet status)
		// can observe the running row; finalization persists the terminal state.
		void ledgerRef.persist().catch(() => {});
		context.bus.emit(BusChannels.DispatchEnqueued, {
			runId: envelope.id,
			agentId: req.agentId,
			requestOrigin: lifecycle.requestOrigin,
			targetId,
			wireModelId,
			runtimeId,
			runtimeKind: "acp-delegation",
		});
		context.bus.emit(BusChannels.DispatchStarted, {
			runId: envelope.id,
			agentId: req.agentId,
			requestOrigin: lifecycle.requestOrigin,
			targetId,
			wireModelId,
			runtimeId,
			runtimeKind: "acp-delegation",
			pid: acp.pid,
		});

		const startedAt = envelope.startedAt;
		const activeRun: ActiveRun = {
			runId: envelope.id,
			req,
			abort: acp.abort,
			kill: acp.kill,
			promise: acp.promise.then(() => undefined),
			recipe: null,
			startedAt,
			targetId,
			wireModelId,
			runtimeId,
			runtimeKind: "acp-delegation",
			requestOrigin: lifecycle.requestOrigin,
			agentId: req.agentId,
			task: req.task,
			cwd: lifecycle.cwd,
			aborted: false,
			stallKilled: false,
			stallTimeoutMs: lifecycle.agentConfig.stallTimeoutMs ?? DEFAULT_ACP_STALL_TIMEOUT_MS,
			lineage,
			heartbeatAt: acp.heartbeatAt,
			heartbeatStatus: "alive",
			meter: tokenMeter,
			pricing: null,
			finalPromise: undefined as unknown as Promise<RunReceipt>,
		};

		const buildReceiptDraft = (
			result: Awaited<AcpDelegationRunHandle["promise"]>,
			endedAt: string,
			status: RunStatus,
			outcome: RunOutcome,
			outcomeDetail: string | null,
		): RunReceiptDraft => {
			tokenMeter.inputTokens += result.usage.inputTokens;
			tokenMeter.outputTokens += result.usage.outputTokens;
			tokenMeter.cacheReadTokens += result.usage.cacheReadTokens;
			tokenMeter.cacheWriteTokens += result.usage.cacheWriteTokens;
			tokenMeter.reasoningTokens += result.usage.reasoningTokens;
			const tokenCount =
				tokenMeter.inputTokens + tokenMeter.outputTokens + tokenMeter.cacheReadTokens + tokenMeter.cacheWriteTokens;
			const safetyMetadata = safety.policy?.metadata() ?? null;
			const init = result.delegation.initialize;
			const agentInfo = init?.agentInfo;
			const finalFailureMessage = result.failureMessage ?? failureMessage;
			return {
				runId: envelope.id,
				agentId: req.agentId,
				requestOrigin: lifecycle.requestOrigin,
				task: req.task,
				targetId,
				wireModelId,
				runtimeId,
				runtimeKind: "acp-delegation",
				outcome,
				outcomeDetail,
				lineage,
				identity,
				startedAt,
				endedAt,
				exitCode: status === "dead" ? 1 : status === "interrupted" ? 1 : result.exitCode,
				...(finalFailureMessage !== undefined ? { failureMessage: finalFailureMessage } : {}),
				tokenCount,
				inputTokenCount: tokenMeter.inputTokens,
				outputTokenCount: tokenMeter.outputTokens,
				cacheReadTokenCount: tokenMeter.cacheReadTokens,
				cacheWriteTokenCount: tokenMeter.cacheWriteTokens,
				reasoningTokenCount: tokenMeter.reasoningTokens,
				...(upstreamResponses.length > 0 ? { upstreamResponses: [...upstreamResponses] } : {}),
				costUsd: 0,
				compiledPromptHash: lifecycle.compiledPromptHash,
				staticCompositionHash: lifecycle.staticCompositionHash,
				staticShellHash: lifecycle.staticCompositionHash,
				sessionShellHash: lifecycle.sessionShellHash,
				dynamicHash: lifecycle.dynamicHash,
				promptSignature: lifecycle.promptSignature,
				toolSignature: lifecycle.toolSignature,
				clioVersion: readClioVersion(),
				piMonoVersion: readPiMonoVersion(),
				platform: process.platform,
				nodeVersion: process.version,
				toolCalls: countToolCalls(toolStats),
				toolStats: snapshotToolStats(toolStats),
				// Clio-observed telemetry only: an external ACP agent executes its
				// own tools, so no zero-activity note is derived from this record.
				toolActivity: summarizeToolActivity(toolStats, (tool) => safety.classify({ tool }).actionClass),
				safety: {
					decisions: safetyDecisionCounts,
					blockedAttempts,
					requestedActions: lifecycle.admission.requestedActions,
					...(lifecycle.admission.toolProfile !== undefined ? { toolProfile: lifecycle.admission.toolProfile } : {}),
					runtimeLimitations: lifecycle.runtimeLimitations,
				},
				reproducibility: collectReproducibilityMetadata(lifecycle.cwd, safetyMetadata),
				delegation: {
					agentConfigId: lifecycle.agentConfig.id,
					command: lifecycle.agentConfig.command,
					args: [...(lifecycle.agentConfig.args ?? [])],
					acpSessionId: result.delegation.acpSessionId,
					acpProtocolVersion: typeof init?.protocolVersion === "number" ? init.protocolVersion : null,
					acpAgentName: agentInfo?.title ?? agentInfo?.name ?? null,
					acpAgentVersion: agentInfo?.version ?? null,
					agentCapabilities: init?.agentCapabilities ?? {},
					toolCallsRequested: result.delegation.toolCallsRequested,
					toolCallsApproved: result.delegation.toolCallsApproved,
					toolCallsDenied: result.delegation.toolCallsDenied,
					toolGovernance: lifecycle.agentConfig.toolGovernance ?? "clio-policy",
					toolCallLog: acp.toolCallLog(),
				},
				sessionId: result.delegation.acpSessionId,
			};
		};

		const emitTerminalDispatchEvent = (receipt: RunReceipt, outcome: RunOutcome): void => {
			const startMs = Date.parse(receipt.startedAt);
			const endMs = Date.parse(receipt.endedAt);
			const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
			const payload: DispatchCompletedPayload = {
				runId: envelope.id,
				agentId: req.agentId,
				requestOrigin: lifecycle.requestOrigin,
				targetId,
				wireModelId,
				runtimeId,
				runtimeKind: "acp-delegation",
				outcome,
				outcomeDetail: receipt.outcomeDetail ?? null,
				lineage,
				tokenCount: receipt.tokenCount,
				inputTokenCount: receipt.inputTokenCount ?? 0,
				outputTokenCount: receipt.outputTokenCount ?? 0,
				cacheReadTokenCount: receipt.cacheReadTokenCount ?? 0,
				cacheWriteTokenCount: receipt.cacheWriteTokenCount ?? 0,
				reasoningTokenCount: receipt.reasoningTokenCount ?? 0,
				staticShellHash: receipt.staticShellHash ?? null,
				sessionShellHash: receipt.sessionShellHash ?? null,
				dynamicHash: receipt.dynamicHash ?? null,
				costUsd: receipt.costUsd,
				durationMs,
				exitCode: receipt.exitCode,
				toolActivity: receipt.toolActivity ?? null,
			};
			if (outcome === "succeeded") {
				context.bus.emit(BusChannels.DispatchCompleted, payload);
				return;
			}
			context.bus.emit(BusChannels.DispatchFailed, { ...payload, reason: outcome });
		};

		const finalPromise = (async (): Promise<RunReceipt> => {
			try {
				const result = await acp.promise;
				const endedAt = new Date().toISOString();
				const evidence: RunTerminationEvidence = {
					exitCode: result.exitCode,
					abortedByOperator: activeRun.aborted,
					stallKilled: activeRun.stallKilled,
					timedOut: result.timedOut === true,
					permissionFailure: false,
					policyDenied: null,
					stopReason: result.stopReason ?? null,
				};
				const { outcome, detail } = resolveRunOutcome(evidence);
				const status = runStatusForOutcome(outcome);
				const receiptDraft = buildReceiptDraft(result, endedAt, status, outcome, detail);
				const ledgerPatch: Partial<RunEnvelope> = {
					status,
					outcome,
					outcomeDetail: detail,
					endedAt,
					exitCode: receiptDraft.exitCode,
					sessionId: receiptDraft.sessionId,
					tokenCount: receiptDraft.tokenCount,
					inputTokenCount: receiptDraft.inputTokenCount ?? 0,
					outputTokenCount: receiptDraft.outputTokenCount ?? 0,
					costUsd: receiptDraft.costUsd,
					staticShellHash: receiptDraft.staticShellHash ?? null,
					sessionShellHash: receiptDraft.sessionShellHash ?? null,
					dynamicHash: receiptDraft.dynamicHash ?? null,
					cacheReadTokenCount: receiptDraft.cacheReadTokenCount ?? 0,
					cacheWriteTokenCount: receiptDraft.cacheWriteTokenCount ?? 0,
					reasoningTokenCount: receiptDraft.reasoningTokenCount ?? 0,
					heartbeatAt: heartbeatIso(acp.heartbeatAt.current),
				};
				ledgerRef.update(envelope.id, ledgerPatch);
				const receipt = ledgerRef.recordReceipt(envelope.id, receiptDraft);
				await ledgerRef.persist();
				active.delete(envelope.id);
				recordTargetOutcome(targetId, runtimeId, wireModelId, status, receipt.exitCode);
				accumulateFinalizedTotals(receipt);
				emitTerminalDispatchEvent(receipt, outcome);
				maybeScheduleRetry(activeRun, outcome, detail);
				return receipt;
			} finally {
				releaseWorkerSlot();
			}
		})();

		activeRun.finalPromise = finalPromise;
		active.set(envelope.id, activeRun);

		return {
			runId: envelope.id,
			events: enrichedEvents,
			finalPromise,
		};
	}

	async function dispatch(req: DispatchRequest): Promise<{
		runId: string;
		events: AsyncIterableIterator<unknown>;
		finalPromise: Promise<RunReceipt>;
	}> {
		const settings = config?.get();
		const isAcpAgent = settings?.delegation?.agents?.some((entry) => entry.id === req.agentId) ?? false;
		if (isAcpAgent && !req.delegationAgentId) {
			req.delegationAgentId = req.agentId;
		}

		const { systemPrompt: _sp, ...jobSpec } = req;
		const validated = validateJobSpec(jobSpec);
		if (!validated.ok) {
			throw new Error(`dispatch: invalid spec: ${validated.errors.join("; ")}`);
		}
		if (req.delegationAgentId) {
			return dispatchAcpDelegation(req);
		}

		const lifecycle = await resolveLifecycle(req);
		assertTargetNotCoolingDown(lifecycle.target.target.id, lifecycle.target.runtime.id, lifecycle.target.wireModelId);

		if (scheduling) {
			const preflight = scheduling.preflight();
			if (preflight.verdict === "over" || preflight.verdict === "at") {
				denyDispatchForBudget(preflight, req.agentId);
			}
		}

		let workerSlotHeld = false;
		const releaseWorkerSlot = (): void => {
			if (!workerSlotHeld || !scheduling) return;
			workerSlotHeld = false;
			scheduling.releaseWorker();
		};

		if (scheduling) {
			workerSlotHeld = scheduling.tryAcquireWorker();
			if (!workerSlotHeld) {
				throw new DispatchConcurrencyError(scheduling.activeWorkers());
			}
		}

		const tokenMeter = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
		const safetyDecisionCounts = { allowed: 0, blocked: 0, permissionRequested: 0 };
		const blockedAttempts: SafetyBlockedAttempt[] = [];
		const spec = buildDispatchWorkerSpec(
			{
				req,
				target: lifecycle.target,
				admission: lifecycle.admission,
				recipe: lifecycle.recipe,
				systemPrompt: lifecycle.systemPrompt,
				dynamicPromptMessages: lifecycle.dynamicPromptMessages,
				promptSignature: lifecycle.promptSignature,
				toolSignature: lifecycle.toolSignature,
				dynamicHash: lifecycle.dynamicHash,
				middlewareSnapshot: middleware.snapshot(),
				apiKey: lifecycle.apiKey,
			},
			config ?? undefined,
		);
		let worker: SpawnedWorker;
		try {
			worker = spawnWorker(spec, { cwd: lifecycle.cwd });
		} catch (error) {
			releaseWorkerSlot();
			throw error;
		}
		const pid = worker.pid;
		const abort = () => worker.abort();
		const sendToWorker = worker.send?.bind(worker);
		const steer = sendToWorker ? (text: string) => sendToWorker({ type: "steer", text }) : undefined;
		const heartbeatAt = worker.heartbeatAt;
		const workerEvents = worker.events;
		const workerDone = worker.promise;

		const toolStats = new Map<string, ToolCallStat>();
		const upstreamResponses: RunReceiptUpstreamResponse[] = [];
		const skillActivations: SkillActivation[] = [];
		let failureMessage: string | undefined;
		let runIdForPermissionAudit: string | null = null;
		const enrichedEvents: AsyncIterableIterator<unknown> = (async function* () {
			for await (const raw of workerEvents) {
				const event = raw as {
					type?: string;
					message?: {
						role?: string;
						usage?: unknown;
						model?: unknown;
						responseModel?: unknown;
						responseId?: unknown;
						stopReason?: unknown;
						errorMessage?: unknown;
					};
					payload?: {
						tool?: string;
						posture?: string;
						durationMs?: number;
						outcome?: "ok" | "error" | "blocked";
						decision?: "allowed" | "blocked" | "permission_requested";
						actionClass?: string;
						ruleId?: string;
						reasonCode?: string;
						policySource?: string;
						reason?: string;
						skillActivation?: unknown;
					};
				};
				if (event.type === "message_end" && event.message?.role === "assistant" && isRecord(event.message.usage)) {
					const u = event.message.usage;
					tokenMeter.inputTokens += typeof u.input === "number" ? u.input : 0;
					tokenMeter.outputTokens += typeof u.output === "number" ? u.output : 0;
					tokenMeter.cacheReadTokens += typeof u.cacheRead === "number" ? u.cacheRead : 0;
					tokenMeter.cacheWriteTokens += typeof u.cacheWrite === "number" ? u.cacheWrite : 0;
					tokenMeter.reasoningTokens += extractReasoningTokenCount(u);
					const model = readStringOrNull(event.message.model);
					const responseModel = readStringOrNull(event.message.responseModel);
					const responseId = readStringOrNull(event.message.responseId);
					if (model !== null || responseModel !== null || responseId !== null) {
						upstreamResponses.push({ model, responseModel, responseId });
					}
					if (event.message.stopReason === "error") {
						const message = readStringOrNull(event.message.errorMessage);
						if (message !== null) failureMessage = message;
					}
				}
				if (event.type === "clio_permission_resolved" && event.payload && typeof event.payload.tool === "string") {
					context.bus.emit(BusChannels.PermissionResolved, {
						status: "denied",
						tool: event.payload.tool,
						...(typeof event.payload.actionClass === "string" ? { actionClass: event.payload.actionClass } : {}),
						...(typeof event.payload.reason === "string" ? { reason: event.payload.reason } : {}),
						...(runIdForPermissionAudit !== null ? { requestedBy: runIdForPermissionAudit } : {}),
					});
				}
				if (event.type === "clio_tool_finish" && event.payload && typeof event.payload.tool === "string") {
					recordToolFinish(toolStats, event.payload);
					if (isSkillActivation(event.payload.skillActivation)) {
						skillActivations.push(event.payload.skillActivation);
					}
					if (event.payload.decision === "allowed") safetyDecisionCounts.allowed += 1;
					else if (event.payload.decision === "blocked") safetyDecisionCounts.blocked += 1;
					else if (event.payload.decision === "permission_requested") safetyDecisionCounts.permissionRequested += 1;
					if (event.payload.outcome === "blocked" || event.payload.decision === "blocked") {
						const attempt: SafetyBlockedAttempt = { tool: event.payload.tool };
						if (event.payload.actionClass !== undefined) attempt.actionClass = event.payload.actionClass;
						if (event.payload.ruleId !== undefined) attempt.ruleId = event.payload.ruleId;
						if (event.payload.reasonCode !== undefined) attempt.reasonCode = event.payload.reasonCode;
						if (event.payload.policySource !== undefined) attempt.policySource = event.payload.policySource;
						if (event.payload.reason !== undefined) attempt.reason = event.payload.reason;
						blockedAttempts.push(attempt);
					}
				}
				yield raw;
			}
		})();

		const ledgerRef = requireLedger();
		const envelope = ledgerRef.create({
			agentId: req.agentId,
			agentAudience: lifecycle.agentAudience,
			requestOrigin: lifecycle.requestOrigin,
			task: req.task,
			targetId: lifecycle.target.target.id,
			wireModelId: lifecycle.target.wireModelId,
			runtimeId: lifecycle.target.runtime.id,
			runtimeKind: lifecycle.runtimeKind,
			sessionId: null,
			cwd: lifecycle.cwd,
			staticShellHash: lifecycle.staticCompositionHash,
			sessionShellHash: lifecycle.sessionShellHash,
			dynamicHash: lifecycle.dynamicHash,
			promptSignature: lifecycle.promptSignature,
			toolSignature: lifecycle.toolSignature,
		});
		runIdForPermissionAudit = envelope.id;
		const lineage = lineageFor(req, envelope.id);
		const identity = detectRunIdentity();
		ledgerRef.update(envelope.id, {
			status: "running",
			pid,
			lineage,
			identity,
			...(heartbeatAt ? { heartbeatAt: heartbeatIso(heartbeatAt.current) } : {}),
		});
		// One durable write at start so sibling processes (clio fleet status)
		// can observe the running row; finalization persists the terminal state.
		void ledgerRef.persist().catch(() => {});

		context.bus.emit(BusChannels.DispatchEnqueued, {
			runId: envelope.id,
			agentId: req.agentId,
			agentAudience: lifecycle.agentAudience,
			requestOrigin: lifecycle.requestOrigin,
			targetId: lifecycle.target.target.id,
			wireModelId: lifecycle.target.wireModelId,
			runtimeId: lifecycle.target.runtime.id,
			runtimeKind: lifecycle.runtimeKind,
		});
		context.bus.emit(BusChannels.DispatchStarted, {
			runId: envelope.id,
			agentId: req.agentId,
			agentAudience: lifecycle.agentAudience,
			requestOrigin: lifecycle.requestOrigin,
			targetId: lifecycle.target.target.id,
			wireModelId: lifecycle.target.wireModelId,
			runtimeId: lifecycle.target.runtime.id,
			runtimeKind: lifecycle.runtimeKind,
			pid,
		});

		const startedAt = envelope.startedAt;

		const activeRun: ActiveRun = {
			runId: envelope.id,
			req,
			abort,
			kill: abort,
			...(steer ? { steer } : {}),
			promise: workerDone.then(() => undefined),
			recipe: lifecycle.recipe,
			startedAt,
			targetId: lifecycle.target.target.id,
			wireModelId: lifecycle.target.wireModelId,
			runtimeId: lifecycle.target.runtime.id,
			runtimeKind: lifecycle.runtimeKind,
			agentAudience: lifecycle.agentAudience,
			requestOrigin: lifecycle.requestOrigin,
			agentId: req.agentId,
			task: req.task,
			cwd: lifecycle.cwd,
			aborted: false,
			stallKilled: false,
			stallTimeoutMs: null,
			lineage,
			heartbeatAt,
			heartbeatStatus: "alive",
			meter: tokenMeter,
			pricing: lifecycle.target.target.pricing ?? null,
			finalPromise: undefined as unknown as Promise<RunReceipt>,
		};

		const buildReceiptDraft = (
			result: SpawnedWorkerResult,
			endedAt: string,
			status: RunStatus,
			outcome: RunOutcome,
			outcomeDetail: string | null,
		): RunReceiptDraft => {
			const receiptExitCode = status === "dead" ? 1 : (result.exitCode ?? 1);
			const toolActivity = summarizeToolActivity(toolStats, (tool) => safety.classify({ tool }).actionClass);
			// A run that exits 0 with zero successful tool calls keeps its
			// succeeded outcome (the harness cannot judge semantic completion),
			// but the receipt must not stay silent about the empty trail.
			const activityNote = outcome === "succeeded" ? zeroSuccessfulToolNote(toolActivity) : null;
			const includeDiagnostics = outcome !== "succeeded";
			const finalOutcomeDetail = mergeWorkerDiagnosticDetail(outcomeDetail ?? activityNote, result, includeDiagnostics);
			const finalFailureMessage = mergeWorkerDiagnosticFailure(failureMessage, result, includeDiagnostics);
			const pricing = lifecycle.target.target.pricing;
			const costUsd = pricing
				? (tokenMeter.inputTokens * pricing.input) / 1_000_000 +
					(tokenMeter.outputTokens * pricing.output) / 1_000_000 +
					(tokenMeter.cacheReadTokens * (pricing.cacheRead ?? 0)) / 1_000_000 +
					(tokenMeter.cacheWriteTokens * (pricing.cacheWrite ?? 0)) / 1_000_000
				: 0;
			const safetyMetadata = safety.policy?.metadata() ?? null;
			const tokenCount =
				tokenMeter.inputTokens + tokenMeter.outputTokens + tokenMeter.cacheReadTokens + tokenMeter.cacheWriteTokens;
			return {
				runId: envelope.id,
				agentId: req.agentId,
				agentAudience: lifecycle.agentAudience,
				requestOrigin: lifecycle.requestOrigin,
				task: req.task,
				targetId: lifecycle.target.target.id,
				wireModelId: lifecycle.target.wireModelId,
				runtimeId: lifecycle.target.runtime.id,
				runtimeKind: lifecycle.runtimeKind,
				outcome,
				lineage,
				identity,
				startedAt,
				endedAt,
				exitCode: receiptExitCode,
				outcomeDetail: finalOutcomeDetail,
				...(finalFailureMessage !== undefined ? { failureMessage: finalFailureMessage } : {}),
				tokenCount,
				inputTokenCount: tokenMeter.inputTokens,
				outputTokenCount: tokenMeter.outputTokens,
				cacheReadTokenCount: tokenMeter.cacheReadTokens,
				cacheWriteTokenCount: tokenMeter.cacheWriteTokens,
				reasoningTokenCount: tokenMeter.reasoningTokens,
				...(upstreamResponses.length > 0 ? { upstreamResponses: [...upstreamResponses] } : {}),
				costUsd,
				compiledPromptHash: lifecycle.compiledPromptHash,
				staticCompositionHash: lifecycle.staticCompositionHash,
				staticShellHash: lifecycle.staticCompositionHash,
				sessionShellHash: lifecycle.sessionShellHash,
				dynamicHash: lifecycle.dynamicHash,
				promptSignature: lifecycle.promptSignature,
				toolSignature: lifecycle.toolSignature,
				clioVersion: readClioVersion(),
				piMonoVersion: readPiMonoVersion(),
				platform: process.platform,
				nodeVersion: process.version,
				toolCalls: countToolCalls(toolStats),
				toolStats: snapshotToolStats(toolStats),
				toolActivity,
				...(skillActivations.length > 0 ? { skillActivations: [...skillActivations] } : {}),
				safety: {
					decisions: safetyDecisionCounts,
					blockedAttempts,
					requestedActions: lifecycle.admission.requestedActions,
					...(lifecycle.admission.toolProfile !== undefined ? { toolProfile: lifecycle.admission.toolProfile } : {}),
					runtimeLimitations: lifecycle.runtimeLimitations,
				},
				reproducibility: collectReproducibilityMetadata(lifecycle.cwd, safetyMetadata),
				runtimeResolution: runtimeTargetSnapshot(lifecycle.target.runtimeResolution),
				sessionId: null,
			};
		};

		const emitTerminalDispatchEvent = (receipt: RunReceipt, outcome: RunOutcome): void => {
			const startMs = Date.parse(receipt.startedAt);
			const endMs = Date.parse(receipt.endedAt);
			const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
			const payload: DispatchCompletedPayload = {
				runId: envelope.id,
				agentId: req.agentId,
				agentAudience: lifecycle.agentAudience,
				requestOrigin: lifecycle.requestOrigin,
				targetId: lifecycle.target.target.id,
				wireModelId: lifecycle.target.wireModelId,
				runtimeId: lifecycle.target.runtime.id,
				runtimeKind: lifecycle.runtimeKind,
				outcome,
				outcomeDetail: receipt.outcomeDetail ?? null,
				lineage,
				tokenCount: receipt.tokenCount,
				inputTokenCount: receipt.inputTokenCount ?? 0,
				outputTokenCount: receipt.outputTokenCount ?? 0,
				cacheReadTokenCount: receipt.cacheReadTokenCount ?? 0,
				cacheWriteTokenCount: receipt.cacheWriteTokenCount ?? 0,
				reasoningTokenCount: receipt.reasoningTokenCount ?? 0,
				staticShellHash: receipt.staticShellHash ?? null,
				sessionShellHash: receipt.sessionShellHash ?? null,
				dynamicHash: receipt.dynamicHash ?? null,
				costUsd: receipt.costUsd,
				durationMs,
				exitCode: receipt.exitCode,
				toolActivity: receipt.toolActivity ?? null,
			};
			if (outcome === "succeeded") {
				context.bus.emit(BusChannels.DispatchCompleted, payload);
				return;
			}
			context.bus.emit(BusChannels.DispatchFailed, { ...payload, reason: outcome });
		};

		const finalPromise = (async (): Promise<RunReceipt> => {
			try {
				const result = await workerDone;
				const endedAt = new Date().toISOString();
				const evidence: RunTerminationEvidence = {
					exitCode: result.exitCode ?? null,
					abortedByOperator: activeRun.aborted,
					stallKilled: activeRun.stallKilled,
					timedOut: false,
					permissionFailure: false,
					policyDenied: null,
					stopReason: null,
				};
				const { outcome, detail } = resolveRunOutcome(evidence);
				const status = runStatusForOutcome(outcome);
				const receiptDraft = buildReceiptDraft(result, endedAt, status, outcome, detail);
				const ledgerPatch: Partial<RunEnvelope> = {
					status,
					outcome,
					outcomeDetail: receiptDraft.outcomeDetail ?? detail,
					endedAt,
					exitCode: receiptDraft.exitCode,
					tokenCount: receiptDraft.tokenCount,
					inputTokenCount: receiptDraft.inputTokenCount ?? 0,
					outputTokenCount: receiptDraft.outputTokenCount ?? 0,
					costUsd: receiptDraft.costUsd,
					staticShellHash: receiptDraft.staticShellHash ?? null,
					sessionShellHash: receiptDraft.sessionShellHash ?? null,
					dynamicHash: receiptDraft.dynamicHash ?? null,
					...(receiptDraft.cacheReadTokenCount !== undefined
						? { cacheReadTokenCount: receiptDraft.cacheReadTokenCount }
						: {}),
					...(receiptDraft.cacheWriteTokenCount !== undefined
						? { cacheWriteTokenCount: receiptDraft.cacheWriteTokenCount }
						: {}),
					...(activeRun.heartbeatAt ? { heartbeatAt: heartbeatIso(activeRun.heartbeatAt.current) } : {}),
				};
				if (receiptDraft.reasoningTokenCount !== undefined) {
					ledgerPatch.reasoningTokenCount = receiptDraft.reasoningTokenCount;
				}
				ledgerRef.update(envelope.id, ledgerPatch);
				const receipt = ledgerRef.recordReceipt(envelope.id, receiptDraft);
				await ledgerRef.persist();
				active.delete(envelope.id);
				recordTargetOutcome(
					lifecycle.target.target.id,
					lifecycle.target.runtime.id,
					lifecycle.target.wireModelId,
					status,
					receipt.exitCode,
				);
				accumulateFinalizedTotals(receipt);
				emitTerminalDispatchEvent(receipt, outcome);
				maybeScheduleRetry(activeRun, outcome, detail);
				return receipt;
			} finally {
				releaseWorkerSlot();
			}
		})();

		activeRun.finalPromise = finalPromise;
		active.set(envelope.id, activeRun);

		return {
			runId: envelope.id,
			events: enrichedEvents,
			finalPromise,
		};
	}

	function mergeBatchEvents(
		batchId: string,
		handles: ReadonlyArray<{
			runId: string;
			agentId: string;
			events: AsyncIterableIterator<unknown>;
			finalPromise: Promise<RunReceipt>;
		}>,
		batchRef: { current: BatchState },
	): AsyncIterableIterator<unknown> {
		return (async function* batchEvents(): AsyncIterableIterator<unknown> {
			yield { type: "batch_started", batch: snapshotBatch(batchRef.current) };
			const readers = new Map<
				string,
				{
					handle: (typeof handles)[number];
					next: Promise<IteratorResult<unknown>>;
				}
			>();
			for (const handle of handles) {
				readers.set(handle.runId, { handle, next: handle.events.next() });
			}
			while (readers.size > 0) {
				const race = [...readers.entries()].map(async ([runId, reader]) => ({
					runId,
					result: await reader.next,
				}));
				const { runId, result } = await Promise.race(race);
				const reader = readers.get(runId);
				if (!reader) continue;
				if (result.done) {
					readers.delete(runId);
					continue;
				}
				reader.next = reader.handle.events.next();
				yield {
					type: "batch_run_event",
					batchId,
					runId,
					agentId: reader.handle.agentId,
					event: result.value,
				};
			}
			yield { type: "batch_events_drained", batch: snapshotBatch(batchRef.current) };
		})();
	}

	async function dispatchBatch(reqs: ReadonlyArray<DispatchRequest>): Promise<{
		batchId: string;
		runIds: ReadonlyArray<string>;
		events: AsyncIterableIterator<unknown>;
		finalPromise: Promise<ReadonlyArray<RunReceipt>>;
	}> {
		if (reqs.length === 0) throw new Error("dispatch: batch requires at least one request");
		const handles: Array<Awaited<ReturnType<typeof dispatch>> & { agentId: string }> = [];
		const settledRunIds = new Set<string>();
		// Admission is sequential so the concurrency gate can throttle instead
		// of failing the whole batch: when a slot is unavailable the batch
		// waits for one of its own in-flight runs (or a short delay covering
		// externally-held slots) and retries that member. Every other
		// admission failure still aborts the batch.
		const slotWaitMs = 250;
		try {
			for (const req of reqs) {
				for (;;) {
					try {
						const handle = await dispatch(req);
						handle.finalPromise.finally(() => settledRunIds.add(handle.runId)).catch(() => {});
						handles.push({ ...handle, agentId: req.agentId });
						break;
					} catch (err) {
						if (!(err instanceof DispatchConcurrencyError)) throw err;
						const waiters: Array<Promise<unknown>> = handles
							.filter((handle) => !settledRunIds.has(handle.runId))
							.map((handle) => handle.finalPromise.catch(() => undefined));
						waiters.push(new Promise((resolve) => setTimeout(resolve, slotWaitMs)));
						await Promise.race(waiters);
					}
				}
			}
		} catch (err) {
			for (const handle of handles) {
				try {
					contract.abort(handle.runId);
				} catch {
					// best-effort cleanup for partially admitted batches
				}
			}
			throw err;
		}
		const batchRef = { current: createBatch(handles.map((handle) => handle.runId)) };
		const finalPromise = Promise.all(
			handles.map(async (handle) => {
				const receipt = await handle.finalPromise;
				batchRef.current = onRunComplete(batchRef.current, handle.runId, receipt.exitCode !== 0);
				return receipt;
			}),
		).then((receipts) => receipts as ReadonlyArray<RunReceipt>);
		return {
			batchId: batchRef.current.id,
			runIds: batchRef.current.runIds,
			events: mergeBatchEvents(batchRef.current.id, handles, batchRef),
			finalPromise,
		};
	}

	const extension: DomainExtension = {
		async start() {
			ledger = openLedger();
			// Symphony P10: restart recovery from durable artifacts. Adopt
			// receipts whose ledger rows were lost to a crash between
			// recordReceipt() and persist(); quarantine tampered ones.
			try {
				const recovery = recoverOrphanReceipts(ledger);
				if (recovery.recovered > 0 || recovery.corrupt > 0 || recovery.abandoned > 0) {
					await ledger.persist();
					if (process.env.CLIO_INTERACTIVE !== "1") {
						process.stderr.write(
							`[dispatch] ledger recovery: recovered=${recovery.recovered} corrupt=${recovery.corrupt} abandoned=${recovery.abandoned} skipped=${recovery.skipped}\n`,
						);
					}
				}
			} catch {
				// Recovery is best-effort; a failed scan never blocks startup.
			}
			startHeartbeatWatchdog();
		},
		async stop() {
			draining = true;
			for (const entry of retryQueue.values()) clearTimeout(entry.timer);
			retryQueue.clear();
			retryBackoff.clear();
			stopHeartbeatWatchdog();
			await drain();
		},
	};

	function emitRunAborted(run: ActiveRun, source: "dispatch_abort" | "dispatch_drain"): void {
		const startedMs = Date.parse(run.startedAt);
		const at = Date.now();
		const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, at - startedMs) : null;
		context.bus.emit(BusChannels.RunAborted, {
			source,
			runId: run.runId,
			startedAt: run.startedAt,
			elapsedMs,
			at,
		});
	}

	/**
	 * Operator snapshot (Symphony §13.3/§13.4). Pure copy of in-memory state:
	 * no I/O, no locks. A consumer failure cannot affect orchestration because
	 * nothing here mutates dispatch state.
	 */
	function snapshot(): DispatchSnapshot {
		const tickNow = now();
		const running: DispatchSnapshot["running"] = [];
		const totals = { ...finalizedTotals };
		for (const run of active.values()) {
			let heartbeat: "alive" | "stale" | "dead" | "n/a" = "n/a";
			if (run.heartbeatAt && Number.isFinite(run.heartbeatAt.current)) {
				if (run.runtimeKind === "acp-delegation") {
					const stallMs = run.stallTimeoutMs;
					if (stallMs !== null && stallMs > 0) {
						heartbeat = tickNow - run.heartbeatAt.current > stallMs ? "dead" : "alive";
					}
				} else {
					heartbeat = classifyHeartbeat(run.heartbeatAt.current, tickNow, heartbeatSpec);
				}
			}
			const meter = run.meter;
			const totalTokens = meter.inputTokens + meter.outputTokens + meter.cacheReadTokens + meter.cacheWriteTokens;
			const pricing = run.pricing;
			const costUsd = pricing
				? (meter.inputTokens * pricing.input +
						meter.outputTokens * pricing.output +
						meter.cacheReadTokens * (pricing.cacheRead ?? 0) +
						meter.cacheWriteTokens * (pricing.cacheWrite ?? 0)) /
					1_000_000
				: 0;
			const startedMs = Date.parse(run.startedAt);
			const elapsedMs = Number.isFinite(startedMs) ? Math.max(0, tickNow - startedMs) : 0;
			running.push({
				runId: run.runId,
				agentId: run.agentId,
				runtimeKind: run.runtimeKind,
				outcomePhase: run.stallKilled ? "terminating" : run.aborted ? "aborting" : "running",
				heartbeat,
				lineage: { ...run.lineage },
				startedAt: run.startedAt,
				elapsedMs,
				tokens: { input: meter.inputTokens, output: meter.outputTokens, total: totalTokens },
				costUsd,
			});
			totals.inputTokens += meter.inputTokens;
			totals.outputTokens += meter.outputTokens;
			totals.totalTokens += totalTokens;
			totals.costUsd += costUsd;
			totals.runtimeSeconds += elapsedMs / 1000;
		}
		const retrying = [...retryQueue.values()].map((entry) => ({
			runId: entry.runId,
			agentId: entry.agentId,
			attempt: entry.attempt,
			dueAt: new Date(entry.dueAt).toISOString(),
			reason: entry.reason,
		}));
		return {
			generatedAt: new Date(tickNow).toISOString(),
			running,
			retrying,
			totals,
		};
	}

	async function drain(): Promise<void> {
		draining = true;
		for (const entry of retryQueue.values()) clearTimeout(entry.timer);
		retryQueue.clear();
		const runs = Array.from(active.values());
		for (const run of runs) {
			emitRunAborted(run, "dispatch_drain");
			run.aborted = true;
			try {
				run.abort();
			} catch {
				// best-effort; promise still resolves on child close
			}
		}
		await Promise.allSettled(runs.map((r) => r.finalPromise));
		if (ledger) await ledger.persist();
	}

	const contract: DispatchContract = {
		dispatch,
		dispatchBatch,
		listRuns(status) {
			const l = requireLedger();
			return status ? l.list({ status }) : l.list();
		},
		getRun(runId) {
			if (!ledger) return null;
			return ledger.get(runId);
		},
		abort(runId) {
			const run = active.get(runId);
			if (!run) return;
			emitRunAborted(run, "dispatch_abort");
			run.aborted = true;
			try {
				run.abort();
			} catch {
				// child may already be gone
			}
		},
		steer(runId, text) {
			const trimmed = text.trim();
			if (trimmed.length === 0) {
				throw new Error("steer: empty message");
			}
			const run = active.get(runId);
			if (!run) {
				throw new Error(`steer: run '${runId}' is not active; only running native workers accept steers`);
			}
			if (run.aborted || run.stallKilled) {
				throw new Error(`steer: run '${runId}' is ${run.aborted ? "aborting" : "terminating"} and cannot be steered`);
			}
			if (!run.steer) {
				throw new Error(
					`steer: run '${runId}' (${run.runtimeKind}) has no input channel; only native workers accept steers`,
				);
			}
			if (!run.steer(trimmed)) {
				throw new Error(`steer: run '${runId}' no longer accepts input; the worker has exited or its stdin is closed`);
			}
		},
		snapshot,
		drain,
	};

	return { extension, contract };
}
