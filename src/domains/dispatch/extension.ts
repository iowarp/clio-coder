/**
 * Dispatch domain wire-up (post-W5).
 *
 * Resolves a DispatchRequest to an EndpointDescriptor + RuntimeDescriptor +
 * wire model id via the providers contract. Gates admission on safety
 * scopes, concurrency, budget, and capability flags. Every admitted runtime
 * kind enters through the native worker subprocess; the worker entry
 * rehydrates the runtime descriptor and delegates runtime-specific execution
 * behind the engine boundary.
 */

import { createHash } from "node:crypto";
import { BusChannels } from "../../core/bus-events.js";
import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import { readClioVersion, readPiMonoVersion } from "../../core/package-root.js";
import { isSkillActivation, type SkillActivation } from "../../core/skill-activation.js";
import { isBuiltinToolName, type ToolName } from "../../core/tool-names.js";
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
	type EndpointDescriptor,
	firstRuntimeResolutionError,
	type ProvidersContract,
	type ResolvedRuntimeTarget,
	type RuntimeDescriptor,
	resolveModelCapabilities,
	resolveRuntimeTarget,
	runtimeTargetSnapshot,
	type ThinkingLevel,
	targetRequiresAuth,
} from "../providers/index.js";
import type { ActionClass } from "../safety/action-classifier.js";
import type { SafetyContract } from "../safety/contract.js";
import type { ScopeSpec } from "../safety/scope.js";
import type { SchedulingContract } from "../scheduling/contract.js";
import { admit } from "./admission.js";
import { type BatchState, createBatch, onRunComplete, snapshotBatch } from "./batch-tracker.js";
import type { DispatchContract, DispatchRequest } from "./contract.js";
import { classifyHeartbeat, DEFAULT_HEARTBEAT_SPEC, type HeartbeatSpec, type HeartbeatStatus } from "./heartbeat.js";
import { collectReproducibilityMetadata } from "./reproducibility.js";
import { type Ledger, openLedger } from "./state.js";
import { countToolCalls, recordToolFinish, snapshotToolStats } from "./tool-stats.js";
import type {
	DispatchRequestOrigin,
	RunEnvelope,
	RunKind,
	RunReceipt,
	RunReceiptDraft,
	RunReceiptUpstreamResponse,
	RunStatus,
	SafetyBlockedAttempt,
	ToolCallStat,
} from "./types.js";
import { validateJobSpec } from "./validation.js";
import { type SpawnedWorker, spawnNativeWorker, type WorkerSpec } from "./worker-spawn.js";

interface ActiveRun {
	runId: string;
	abort: () => void;
	promise: Promise<void>;
	recipe: AgentRecipe | null;
	startedAt: string;
	endpointId: string;
	wireModelId: string;
	runtimeId: string;
	runtimeKind: RunKind;
	agentAudience?: AgentAudience;
	requestOrigin?: DispatchRequestOrigin;
	agentId: string;
	task: string;
	cwd: string;
	aborted: boolean;
	heartbeatAt: { current: number } | null;
	heartbeatStatus: HeartbeatStatus;
	terminalStatusOverride: RunStatus | null;
	finalPromise: Promise<RunReceipt>;
}

export interface DispatchBundleOptions {
	spawnWorker?: (spec: WorkerSpec, opts?: { cwd?: string }) => SpawnedWorker;
	startAcpDelegationRun?: (input: AcpDelegationRunInput) => AcpDelegationRunHandle;
	heartbeatSpec?: HeartbeatSpec;
	heartbeatIntervalMs?: number;
	resilienceCooldownMs?: number;
	now?: () => number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 1000;
const DEFAULT_RESILIENCE_COOLDOWN_MS = 15_000;

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

export function buildSystemPrompt(req: DispatchRequest, recipe: AgentRecipe | null): string {
	return buildStableSystemPrompt(req, recipe);
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
		`This recipe declares preferred skills: ${skillList}.`,
		"Use `read_skill` only when one of those skills matches the assigned task.",
		"Skills provide reusable know-how and resources; they never expand your tool authority.",
		"If a declared skill is unavailable, continue with the assigned task and report the missing skill.",
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
	endpoint: EndpointDescriptor;
	runtime: RuntimeDescriptor;
	wireModelId: string;
	thinkingLevel: ThinkingLevel;
	capabilities: CapabilityFlags | null;
	modelCapabilities: CapabilityFlags | null;
	runtimeResolution: ResolvedRuntimeTarget;
}

interface WorkerTargetConfig {
	endpoint: string | null;
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

function capabilityInfoForEndpoint(providers: ProvidersContract, endpointId: string): CapabilityFlags | null {
	return providers.list().find((entry) => entry.endpoint.id === endpointId)?.capabilities ?? null;
}

function capabilityInfoForModel(
	providers: ProvidersContract,
	endpointId: string,
	wireModelId: string | null | undefined,
): CapabilityFlags | null {
	const status = providers.list().find((entry) => entry.endpoint.id === endpointId);
	if (!status) return null;
	const modelId = wireModelId ?? status.endpoint.defaultModel ?? null;
	const detectedReasoning = modelId ? providers.getDetectedReasoning(endpointId, modelId) : null;
	return resolveModelCapabilities(status, modelId, providers.knowledgeBase, { detectedReasoning });
}

function runtimeIdForEndpoint(providers: ProvidersContract, endpointId: string): string | null {
	return providers.getEndpoint(endpointId)?.runtime ?? null;
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
				endpoint: settings.workers.default.endpoint ?? null,
				model: settings.workers.default.model ?? null,
				thinkingLevel: (settings.workers.default.thinkingLevel ?? "off") as ThinkingLevel,
			}
		: null;
	const workerProfiles: WorkerProfileMap = {};
	for (const [name, profile] of Object.entries(settings?.workers?.profiles ?? {})) {
		workerProfiles[name] = {
			endpoint: profile.endpoint ?? null,
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
		endpoint: input.target.endpoint,
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
	if (input.req.trustProjectCompatRoots !== undefined) {
		spec.trustProjectCompatRoots = input.req.trustProjectCompatRoots;
	} else if (config) {
		spec.trustProjectCompatRoots = config.get().skills.trustProjectCompatRoots === true;
	}
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
		workerDefault?.endpoint &&
		(!runtimeId || runtimeIdForEndpoint(providers, workerDefault.endpoint) === runtimeId) &&
		supportsRequiredCapabilities(capabilityInfoForModel(providers, workerDefault.endpoint, workerDefault.model), required)
	) {
		return workerDefault;
	}
	for (const profile of Object.values(workerProfiles)) {
		if (!profile.endpoint) continue;
		if (runtimeId && runtimeIdForEndpoint(providers, profile.endpoint) !== runtimeId) continue;
		if (supportsRequiredCapabilities(capabilityInfoForModel(providers, profile.endpoint, profile.model), required)) {
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
	let endpointId = req.endpoint ?? null;
	if (!endpointId && req.workerProfile) {
		const profile = workerProfiles[req.workerProfile];
		if (!profile) throw new Error(`dispatch: fleet profile '${req.workerProfile}' not configured`);
		if (!profile.endpoint) throw new Error(`dispatch: fleet profile '${req.workerProfile}' has no target`);
		selectedWorkerTarget = profile;
		endpointId = profile.endpoint;
	}
	if (!endpointId) endpointId = recipe.endpoint ?? null;
	if (!endpointId) {
		selectedWorkerTarget = pickCapabilityMatchedWorker(
			req.requiredCapabilities,
			req.workerRuntime,
			workerDefault,
			workerProfiles,
			providers,
		);
		endpointId = selectedWorkerTarget?.endpoint ?? null;
	}
	if (!endpointId && req.workerRuntime) {
		throw new Error(`dispatch: no worker target configured for runtime '${req.workerRuntime}'`);
	}
	if (!endpointId) {
		selectedWorkerTarget = workerDefault;
		endpointId = workerDefault?.endpoint ?? null;
	}
	if (!endpointId) {
		throw new Error("dispatch: no target configured (set the fleet default, add a fleet profile, or pass target)");
	}
	const endpoint = providers.getEndpoint(endpointId);
	if (!endpoint) throw new Error(`dispatch: target '${endpointId}' not found`);
	const runtime = providers.getRuntime(endpoint.runtime);
	if (!runtime) throw new Error(`dispatch: runtime '${endpoint.runtime}' not registered`);
	const matchingDefault = workerDefault?.endpoint === endpointId ? workerDefault : null;
	const fallbackWorkerTarget = selectedWorkerTarget ?? matchingDefault;
	const wireModelId = req.model ?? recipe.model ?? fallbackWorkerTarget?.model ?? endpoint.defaultModel;
	if (!wireModelId) {
		throw new Error(`dispatch: no model for target '${endpointId}' (set a fleet profile model or target.defaultModel)`);
	}
	const thinkingLevel = (req.thinkingLevel ??
		recipe.thinkingLevel ??
		fallbackWorkerTarget?.thinkingLevel ??
		"off") as ThinkingLevel;
	const resolved = resolveRuntimeTarget(providers, {
		endpointId,
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
		endpoint,
		runtime,
		wireModelId,
		thinkingLevel: resolved.target.effectiveThinkingLevel,
		capabilities: capabilityInfoForEndpoint(providers, endpoint.id),
		modelCapabilities,
		runtimeResolution: resolved.target,
	};
}

function enforceCapabilityGate(
	endpointId: string,
	capabilities: CapabilityFlags | null,
	required: ReadonlyArray<string> | undefined,
): void {
	if (!required || required.length === 0) return;
	if (!capabilities) {
		throw new Error(`dispatch: admission denied: capability info unavailable for endpoint '${endpointId}'`);
	}
	const caps = capabilities as unknown as Record<string, unknown>;
	for (const name of required) {
		const value = caps[name];
		if (value === undefined || value === false || value === 0 || value === "") {
			throw new Error(`dispatch: admission denied: capability '${name}' not supported by endpoint '${endpointId}'`);
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
			endpointId: run.endpointId,
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

	function checkActiveHeartbeats(): void {
		if (!ledger) return;
		const tickNow = now();
		for (const run of active.values()) {
			if (run.aborted || run.terminalStatusOverride || !run.heartbeatAt) continue;
			const heartbeatMs = run.heartbeatAt.current;
			if (!Number.isFinite(heartbeatMs)) continue;
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
			run.terminalStatusOverride = "dead";
			try {
				run.abort();
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

	function cooldownKey(endpointId: string, runtimeId: string, wireModelId: string): string {
		return `${endpointId}\0${runtimeId}\0${wireModelId}`;
	}

	function assertTargetNotCoolingDown(endpointId: string, runtimeId: string, wireModelId: string): void {
		const key = cooldownKey(endpointId, runtimeId, wireModelId);
		const cooldown = targetCooldowns.get(key);
		if (!cooldown) return;
		const remaining = cooldown.until - now();
		if (remaining <= 0) {
			targetCooldowns.delete(key);
			return;
		}
		throw new Error(
			`dispatch: target '${endpointId}' is cooling down for ${Math.ceil(remaining / 1000)}s after ${cooldown.reason}`,
		);
	}

	function recordTargetOutcome(
		endpointId: string,
		runtimeId: string,
		wireModelId: string,
		status: RunStatus,
		exitCode: number,
	): void {
		const key = cooldownKey(endpointId, runtimeId, wireModelId);
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
		const targets = readWorkerTargets(config?.get());
		const target = resolveDispatchTarget(req, recipe, targets.workerDefault, targets.workerProfiles, providers);
		enforceCapabilityGate(target.endpoint.id, target.modelCapabilities, req.requiredCapabilities);

		const cwd = req.cwd ?? process.cwd();
		const systemPrompt = buildStableSystemPrompt(req, recipe);
		const dynamicPromptMessages = buildDynamicPromptMessages(req);
		const dynamicText = dynamicPromptMessages.map((message) => message.body).join("\n\n");
		const compiledPromptHash = promptCompositionHash([systemPrompt, dynamicText]);
		const staticCompositionHash = promptHash(systemPrompt);
		const sessionShellHash = staticCompositionHash;
		const dynamicHash = dynamicPromptMessages.length > 0 ? sha256(dynamicText) : sha256("");
		const currentToolSignature = toolSignature(admission.allowedTools);
		const auth = targetRequiresAuth(target.endpoint, target.runtime)
			? await providers.auth.resolveForTarget(target.endpoint, target.runtime)
			: null;
		// pi-ai's openai-completions provider refuses to stream without an apiKey
		// even when the target is a local server that ignores Authorization headers.
		// Match chat-loop's LOCAL_API_KEY_FALLBACK so dispatch-spawned workers can
		// reach openai-compat local endpoints (LM Studio, llama.cpp) without
		// requiring the user to invent a credential.
		const apiKey = auth?.apiKey ?? (auth === null ? "clio-local-endpoint" : undefined);
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
		const endpointId = `delegation:${lifecycle.agentConfig.id}`;
		const runtimeId = "acp";
		const wireModelId = lifecycle.agentConfig.id;
		assertTargetNotCoolingDown(endpointId, runtimeId, wireModelId);

		if (scheduling) {
			const preflight = scheduling.preflight();
			if (preflight.verdict === "over" || preflight.verdict === "at") {
				throw new Error(
					`dispatch: admission denied: budget ceiling crossed: $${preflight.currentUsd.toFixed(4)} / $${preflight.ceilingUsd.toFixed(4)}`,
				);
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
				throw new Error(
					`dispatch: admission denied: concurrency limit reached (${scheduling.activeWorkers()} active workers)`,
				);
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
			endpointId,
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
		ledgerRef.update(envelope.id, {
			status: "running",
			pid: acp.pid,
			heartbeatAt: heartbeatIso(acp.heartbeatAt.current),
		});
		context.bus.emit(BusChannels.DispatchEnqueued, {
			runId: envelope.id,
			agentId: req.agentId,
			requestOrigin: lifecycle.requestOrigin,
			endpointId,
			wireModelId,
			runtimeId,
			runtimeKind: "acp-delegation",
		});
		context.bus.emit(BusChannels.DispatchStarted, {
			runId: envelope.id,
			agentId: req.agentId,
			requestOrigin: lifecycle.requestOrigin,
			endpointId,
			wireModelId,
			runtimeId,
			runtimeKind: "acp-delegation",
			pid: acp.pid,
		});

		const startedAt = envelope.startedAt;
		const activeRun: ActiveRun = {
			runId: envelope.id,
			abort: acp.abort,
			promise: acp.promise.then(() => undefined),
			recipe: null,
			startedAt,
			endpointId,
			wireModelId,
			runtimeId,
			runtimeKind: "acp-delegation",
			requestOrigin: lifecycle.requestOrigin,
			agentId: req.agentId,
			task: req.task,
			cwd: lifecycle.cwd,
			aborted: false,
			heartbeatAt: acp.heartbeatAt,
			heartbeatStatus: "alive",
			terminalStatusOverride: null,
			finalPromise: undefined as unknown as Promise<RunReceipt>,
		};

		const buildReceiptDraft = (
			result: Awaited<AcpDelegationRunHandle["promise"]>,
			endedAt: string,
			status: RunStatus,
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
				endpointId,
				wireModelId,
				runtimeId,
				runtimeKind: "acp-delegation",
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

		const emitTerminalDispatchEvent = (receipt: RunReceipt, status: RunStatus): void => {
			const startMs = Date.parse(receipt.startedAt);
			const endMs = Date.parse(receipt.endedAt);
			const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
			const payload = {
				runId: envelope.id,
				agentId: req.agentId,
				requestOrigin: lifecycle.requestOrigin,
				endpointId,
				wireModelId,
				runtimeId,
				runtimeKind: "acp-delegation",
				tokenCount: receipt.tokenCount,
				cacheReadTokenCount: receipt.cacheReadTokenCount ?? 0,
				cacheWriteTokenCount: receipt.cacheWriteTokenCount ?? 0,
				reasoningTokenCount: receipt.reasoningTokenCount ?? 0,
				staticShellHash: receipt.staticShellHash ?? null,
				sessionShellHash: receipt.sessionShellHash ?? null,
				dynamicHash: receipt.dynamicHash ?? null,
				costUsd: receipt.costUsd,
				durationMs,
				exitCode: receipt.exitCode,
			};
			if (status === "completed") {
				context.bus.emit(BusChannels.DispatchCompleted, payload);
				return;
			}
			context.bus.emit(BusChannels.DispatchFailed, { ...payload, reason: status });
		};

		const finalPromise = (async (): Promise<RunReceipt> => {
			try {
				const result = await acp.promise;
				const endedAt = new Date().toISOString();
				const status: RunStatus =
					activeRun.terminalStatusOverride ??
					(activeRun.aborted ? "interrupted" : result.exitCode === 0 ? "completed" : "failed");
				activeRun.terminalStatusOverride = status;
				const receiptDraft = buildReceiptDraft(result, endedAt, status);
				const ledgerPatch: Partial<RunEnvelope> = {
					status,
					endedAt,
					exitCode: receiptDraft.exitCode,
					sessionId: receiptDraft.sessionId,
					tokenCount: receiptDraft.tokenCount,
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
				recordTargetOutcome(endpointId, runtimeId, wireModelId, status, receipt.exitCode);
				emitTerminalDispatchEvent(receipt, status);
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
		assertTargetNotCoolingDown(lifecycle.target.endpoint.id, lifecycle.target.runtime.id, lifecycle.target.wireModelId);

		if (scheduling) {
			const preflight = scheduling.preflight();
			if (preflight.verdict === "over" || preflight.verdict === "at") {
				throw new Error(
					`dispatch: admission denied: budget ceiling crossed: $${preflight.currentUsd.toFixed(4)} / $${preflight.ceilingUsd.toFixed(4)}`,
				);
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
				throw new Error(
					`dispatch: admission denied: concurrency limit reached (${scheduling.activeWorkers()} active workers)`,
				);
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
		const heartbeatAt = worker.heartbeatAt;
		const workerEvents = worker.events;
		const workerDone = worker.promise.then((r) => ({ exitCode: r.exitCode }));

		const toolStats = new Map<string, ToolCallStat>();
		const upstreamResponses: RunReceiptUpstreamResponse[] = [];
		const skillActivations: SkillActivation[] = [];
		let failureMessage: string | undefined;
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
			endpointId: lifecycle.target.endpoint.id,
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
		ledgerRef.update(
			envelope.id,
			heartbeatAt
				? { status: "running", pid, heartbeatAt: heartbeatIso(heartbeatAt.current) }
				: { status: "running", pid },
		);

		context.bus.emit(BusChannels.DispatchEnqueued, {
			runId: envelope.id,
			agentId: req.agentId,
			agentAudience: lifecycle.agentAudience,
			requestOrigin: lifecycle.requestOrigin,
			endpointId: lifecycle.target.endpoint.id,
			wireModelId: lifecycle.target.wireModelId,
			runtimeId: lifecycle.target.runtime.id,
			runtimeKind: lifecycle.runtimeKind,
		});
		context.bus.emit(BusChannels.DispatchStarted, {
			runId: envelope.id,
			agentId: req.agentId,
			agentAudience: lifecycle.agentAudience,
			requestOrigin: lifecycle.requestOrigin,
			endpointId: lifecycle.target.endpoint.id,
			wireModelId: lifecycle.target.wireModelId,
			runtimeId: lifecycle.target.runtime.id,
			runtimeKind: lifecycle.runtimeKind,
			pid,
		});

		const startedAt = envelope.startedAt;

		const activeRun: ActiveRun = {
			runId: envelope.id,
			abort,
			promise: workerDone.then(() => undefined),
			recipe: lifecycle.recipe,
			startedAt,
			endpointId: lifecycle.target.endpoint.id,
			wireModelId: lifecycle.target.wireModelId,
			runtimeId: lifecycle.target.runtime.id,
			runtimeKind: lifecycle.runtimeKind,
			agentAudience: lifecycle.agentAudience,
			requestOrigin: lifecycle.requestOrigin,
			agentId: req.agentId,
			task: req.task,
			cwd: lifecycle.cwd,
			aborted: false,
			heartbeatAt,
			heartbeatStatus: "alive",
			terminalStatusOverride: null,
			finalPromise: undefined as unknown as Promise<RunReceipt>,
		};

		const buildReceiptDraft = (
			result: { exitCode?: number | null },
			endedAt: string,
			status: RunStatus,
		): RunReceiptDraft => {
			const receiptExitCode = status === "dead" ? 1 : (result.exitCode ?? 1);
			const pricing = lifecycle.target.endpoint.pricing;
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
				endpointId: lifecycle.target.endpoint.id,
				wireModelId: lifecycle.target.wireModelId,
				runtimeId: lifecycle.target.runtime.id,
				runtimeKind: lifecycle.runtimeKind,
				startedAt,
				endedAt,
				exitCode: receiptExitCode,
				...(failureMessage !== undefined ? { failureMessage } : {}),
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

		const emitTerminalDispatchEvent = (receipt: RunReceipt, status: RunStatus): void => {
			const startMs = Date.parse(receipt.startedAt);
			const endMs = Date.parse(receipt.endedAt);
			const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
			const payload = {
				runId: envelope.id,
				agentId: req.agentId,
				agentAudience: lifecycle.agentAudience,
				requestOrigin: lifecycle.requestOrigin,
				endpointId: lifecycle.target.endpoint.id,
				wireModelId: lifecycle.target.wireModelId,
				runtimeId: lifecycle.target.runtime.id,
				runtimeKind: lifecycle.runtimeKind,
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
			};
			if (status === "completed") {
				context.bus.emit(BusChannels.DispatchCompleted, payload);
				return;
			}
			context.bus.emit(BusChannels.DispatchFailed, { ...payload, reason: status });
		};

		const finalPromise = (async (): Promise<RunReceipt> => {
			try {
				const result = await workerDone;
				const endedAt = new Date().toISOString();
				const status: RunStatus =
					activeRun.terminalStatusOverride ??
					(activeRun.aborted ? "interrupted" : result.exitCode === 0 ? "completed" : "failed");
				activeRun.terminalStatusOverride = status;
				const receiptDraft = buildReceiptDraft(result, endedAt, status);
				const ledgerPatch: Partial<RunEnvelope> = {
					status,
					endedAt,
					exitCode: receiptDraft.exitCode,
					tokenCount: receiptDraft.tokenCount,
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
					lifecycle.target.endpoint.id,
					lifecycle.target.runtime.id,
					lifecycle.target.wireModelId,
					status,
					receipt.exitCode,
				);
				emitTerminalDispatchEvent(receipt, status);
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
		try {
			const admitted = await Promise.all(
				reqs.map(async (req) => {
					const handle = await dispatch(req);
					return { ...handle, agentId: req.agentId };
				}),
			);
			handles.push(...admitted);
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
			startHeartbeatWatchdog();
		},
		async stop() {
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

	async function drain(): Promise<void> {
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
		drain,
	};

	return { extension, contract };
}
