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
import type { ToolName } from "../../core/tool-names.js";
import type { SelfDevMode } from "../../selfdev/mode.js";
import { SelfDevToolNames } from "../../selfdev/tool-names.js";
import { serializeWorkerRuntimeDescriptor, WORKER_SPEC_VERSION } from "../../worker/spec-contract.js";
import type { AgentsContract } from "../agents/contract.js";
import type { AgentRecipe } from "../agents/recipe.js";
import type { ConfigContract } from "../config/contract.js";
import type { MiddlewareContract } from "../middleware/contract.js";
import type { ModesContract } from "../modes/contract.js";
import { MODE_MATRIX, type ModeName } from "../modes/matrix.js";
import type { PromptsContract } from "../prompts/index.js";
import {
	type CapabilityFlags,
	type EndpointDescriptor,
	type ProvidersContract,
	type RuntimeDescriptor,
	resolveModelCapabilities,
	type ThinkingLevel,
	targetRequiresAuth,
} from "../providers/index.js";
import type { ActionClass } from "../safety/action-classifier.js";
import type { SafetyContract } from "../safety/contract.js";
import type { ScopeSpec } from "../safety/scope.js";
import type { SchedulingContract } from "../scheduling/contract.js";
import { admit } from "./admission.js";
import type { DispatchContract, DispatchRequest } from "./contract.js";
import { classifyHeartbeat, DEFAULT_HEARTBEAT_SPEC, type HeartbeatSpec, type HeartbeatStatus } from "./heartbeat.js";
import { collectReproducibilityMetadata } from "./reproducibility.js";
import { type Ledger, openLedger } from "./state.js";
import { countToolCalls, recordToolFinish, snapshotToolStats } from "./tool-stats.js";
import type {
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

type WorkerApprovalHandler = Parameters<SpawnedWorker["onApprovalRequest"]>[0];
type WorkerApprovalRequest = Parameters<WorkerApprovalHandler>[0];
type WorkerApprovalResponse = Awaited<ReturnType<WorkerApprovalHandler>>;

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
	heartbeatSpec?: HeartbeatSpec;
	heartbeatIntervalMs?: number;
	now?: () => number;
	selfDevMode?: SelfDevMode;
	selfDevToolNames?: ReadonlyArray<ToolName>;
	getSelfDevHarnessSnapshot?: () => { kind: string; files?: ReadonlyArray<string> } | null;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 1000;
const STALE_WRITES_OVERRIDE_ENV = "CLIO_DEV_ALLOW_STALE_WRITES";
const DEFAULT_APPROVAL_RESPONSE_TIMEOUT_MS = 60000;

export interface DispatchStaleProcessDetails {
	stale_process: {
		restart_required: true;
		restart_required_paths: string[];
		blocked_action: "worker_dispatch";
		override_env: typeof STALE_WRITES_OVERRIDE_ENV;
	};
}

export class DispatchStaleProcessError extends Error {
	readonly details: DispatchStaleProcessDetails;

	constructor(details: DispatchStaleProcessDetails) {
		super(
			`dispatch: stale process guard: restart-required is active; restart Clio before dispatching workers (${details.stale_process.restart_required_paths.join(", ")})`,
		);
		this.name = "DispatchStaleProcessError";
		this.details = details;
	}
}

function sha256(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

function promptHash(systemPrompt: string): string | null {
	return systemPrompt.length > 0 ? sha256(systemPrompt) : null;
}

function staleDispatchDetails(options: DispatchBundleOptions | undefined): DispatchStaleProcessDetails | null {
	if (!options?.selfDevMode) return null;
	if (process.env[STALE_WRITES_OVERRIDE_ENV] === "1") return null;
	const snapshot = options.getSelfDevHarnessSnapshot?.();
	if (snapshot?.kind !== "restart-required") return null;
	const paths = [...(snapshot.files ?? [])];
	if (paths.length === 0) return null;
	return {
		stale_process: {
			restart_required: true,
			restart_required_paths: paths,
			blocked_action: "worker_dispatch",
			override_env: STALE_WRITES_OVERRIDE_ENV,
		},
	};
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

export function pickOrchestratorScope(safety: SafetyContract, mode: ModeName): ScopeSpec | null {
	const dispatchScope = MODE_MATRIX[mode].dispatchScope;
	if (dispatchScope === "none") return null;
	if (dispatchScope === "readonly") return safety.scopes.readonly;
	if (mode === "super") return safety.scopes.super;
	return safety.scopes.default;
}

function pickWorkerScope(safety: SafetyContract, mode: ModeName): ScopeSpec {
	if (mode === "advise") return safety.scopes.readonly;
	if (mode === "super") return safety.scopes.super;
	return safety.scopes.default;
}

export function deriveRequestedActions(
	tools: ReadonlyArray<ToolName>,
	safety: SafetyContract,
	selfDevToolNames: ReadonlyArray<ToolName> = [],
): ReadonlyArray<ActionClass> {
	const selfDev = new Set<string>(selfDevToolNames);
	const actions = new Set<ActionClass>();
	for (const tool of tools) {
		const selfDevAction = selfDevActionClass(tool, selfDev);
		const action = selfDevAction ?? safety.classify({ tool }).actionClass;
		actions.add(action);
	}
	return [...actions].sort();
}

function selfDevActionClass(tool: string, selfDevTools: ReadonlySet<string>): ActionClass | null {
	if (!selfDevTools.has(tool)) return null;
	if (tool === SelfDevToolNames.ClioIntrospect || tool === SelfDevToolNames.ClioRecall) return "read";
	if (tool === SelfDevToolNames.ClioRemember || tool === SelfDevToolNames.ClioMemoryMaintain) return "write";
	return "unknown";
}

export function buildSystemPrompt(req: DispatchRequest, recipe: AgentRecipe | null): string {
	const base = req.systemPrompt && req.systemPrompt.length > 0 ? req.systemPrompt : (recipe?.body ?? "");
	const memory = req.memorySection?.trim() ?? "";
	if (memory.length === 0) return base;
	if (base.length === 0) return memory;
	return `${memory}\n\n${base}`;
}

function prependSelfDevPreamble(systemPrompt: string, prompts: PromptsContract | undefined): string {
	const preamble = prompts?.getSelfDevWorkerPreamble()?.trim() ?? "";
	if (preamble.length === 0) return systemPrompt;
	if (systemPrompt.length === 0) return preamble;
	return `${preamble}\n\n${systemPrompt}`;
}

interface ResolvedTarget {
	endpoint: EndpointDescriptor;
	runtime: RuntimeDescriptor;
	wireModelId: string;
	thinkingLevel: ThinkingLevel;
	capabilities: CapabilityFlags | null;
	modelCapabilities: CapabilityFlags | null;
}

interface WorkerTargetConfig {
	endpoint: string | null;
	model: string | null;
	thinkingLevel: ThinkingLevel;
}

type WorkerProfileMap = Record<string, WorkerTargetConfig>;

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

function runtimeLimitations(runtimeKind: RunKind, runtimeId: string): string[] {
	if (runtimeKind === "http") return [];
	return [
		`${runtimeId} is a delegated ${runtimeKind} runtime; Clio records launch policy and final output but cannot fully observe internal tool calls made inside the external agent.`,
	];
}

export interface DispatchAutoApproveDerivation {
	supervised: boolean;
	autoApprove: "allow" | "deny" | undefined;
	runtimeLimitations: string[];
}

export function deriveAutoApproveForDispatch(
	req: Pick<DispatchRequest, "supervised" | "autoApprove">,
	existingLimitations: ReadonlyArray<string> = [],
): DispatchAutoApproveDerivation {
	const supervised = req.supervised === true;
	let autoApprove = req.autoApprove;
	const nextLimitations = [...existingLimitations];
	if (!supervised && autoApprove === undefined) {
		autoApprove = "deny";
		nextLimitations.push("headless ask auto-denied; pass --auto-approve to override");
	}
	return { supervised, autoApprove, runtimeLimitations: nextLimitations };
}

function approvalResponseTimeoutMs(): number {
	const raw = process.env.CLIO_SDK_APPROVAL_TIMEOUT_MS;
	if (raw === undefined || raw.trim().length === 0) return DEFAULT_APPROVAL_RESPONSE_TIMEOUT_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_APPROVAL_RESPONSE_TIMEOUT_MS;
}

function isApprovalResponsePayload(value: unknown): value is WorkerApprovalResponse {
	if (!value || typeof value !== "object") return false;
	const payload = value as Partial<WorkerApprovalResponse>;
	return typeof payload.requestId === "string" && (payload.decision === "allow" || payload.decision === "deny");
}

function waitForToolApprovalResponse(
	context: DomainContext,
	request: WorkerApprovalRequest,
): Promise<WorkerApprovalResponse> {
	return new Promise((resolve) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | null = null;
		let unsubscribe = (): void => {};
		const finish = (response: WorkerApprovalResponse): void => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			unsubscribe();
			resolve(response);
		};
		unsubscribe = context.bus.on(BusChannels.ToolApprovalResponse, (payload) => {
			if (!isApprovalResponsePayload(payload)) return;
			if (payload.requestId !== request.requestId) return;
			finish(payload);
		});
		const timeoutMs = approvalResponseTimeoutMs();
		if (timeoutMs > 0) {
			timeout = setTimeout(() => {
				finish({
					requestId: request.requestId,
					decision: "deny",
					reason: `approval response timed out after ${timeoutMs}ms`,
				});
			}, timeoutMs);
			timeout.unref?.();
		}
		context.bus.emit(BusChannels.ToolApprovalRequest, { request });
	});
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
	recipe: AgentRecipe | null,
	workerDefault: WorkerTargetConfig | null,
	workerProfiles: WorkerProfileMap,
	providers: ProvidersContract,
): ResolvedTarget {
	let selectedWorkerTarget: WorkerTargetConfig | null = null;
	let endpointId = req.endpoint ?? null;
	if (!endpointId && req.workerProfile) {
		const profile = workerProfiles[req.workerProfile];
		if (!profile) throw new Error(`dispatch: worker profile '${req.workerProfile}' not configured`);
		if (!profile.endpoint) throw new Error(`dispatch: worker profile '${req.workerProfile}' has no target`);
		selectedWorkerTarget = profile;
		endpointId = profile.endpoint;
	}
	if (!endpointId) endpointId = recipe?.endpoint ?? null;
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
		throw new Error(
			"dispatch: no target configured (set workers.default.target, add workers.profiles, or pass --target)",
		);
	}
	const endpoint = providers.getEndpoint(endpointId);
	if (!endpoint) throw new Error(`dispatch: target '${endpointId}' not found`);
	const runtime = providers.getRuntime(endpoint.runtime);
	if (!runtime) throw new Error(`dispatch: runtime '${endpoint.runtime}' not registered`);
	const matchingDefault = workerDefault?.endpoint === endpointId ? workerDefault : null;
	const fallbackWorkerTarget = selectedWorkerTarget ?? matchingDefault;
	const wireModelId = req.model ?? recipe?.model ?? fallbackWorkerTarget?.model ?? endpoint.defaultModel;
	if (!wireModelId) {
		throw new Error(`dispatch: no model for target '${endpointId}' (set worker profile model or target.defaultModel)`);
	}
	const thinkingLevel = (req.thinkingLevel ??
		recipe?.thinkingLevel ??
		fallbackWorkerTarget?.thinkingLevel ??
		"off") as ThinkingLevel;
	return {
		endpoint,
		runtime,
		wireModelId,
		thinkingLevel,
		capabilities: capabilityInfoForEndpoint(providers, endpoint.id),
		modelCapabilities: capabilityInfoForModel(providers, endpoint.id, wireModelId),
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
	const maybeModes = context.getContract<ModesContract>("modes");
	const maybeProviders = context.getContract<ProvidersContract>("providers");
	const maybeMiddleware = context.getContract<MiddlewareContract>("middleware");
	if (!maybeSafety) throw new Error("dispatch domain requires 'safety' contract");
	if (!maybeAgents) throw new Error("dispatch domain requires 'agents' contract");
	if (!maybeModes) throw new Error("dispatch domain requires 'modes' contract");
	if (!maybeProviders) throw new Error("dispatch domain requires 'providers' contract");
	if (!maybeMiddleware) throw new Error("dispatch domain requires 'middleware' contract");
	const safety: SafetyContract = maybeSafety;
	const agents: AgentsContract = maybeAgents;
	const modes: ModesContract = maybeModes;
	const providers: ProvidersContract = maybeProviders;
	const middleware: MiddlewareContract = maybeMiddleware;
	const prompts = context.getContract<PromptsContract>("prompts");
	const config = context.getContract<ConfigContract>("config");
	const scheduling = context.getContract<SchedulingContract>("scheduling");
	const spawnWorker = options?.spawnWorker ?? spawnNativeWorker;
	const heartbeatSpec = options?.heartbeatSpec ?? DEFAULT_HEARTBEAT_SPEC;
	const heartbeatIntervalMs = options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
	const now = options?.now ?? (() => Date.now());

	let ledger: Ledger | null = null;
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	const active = new Map<string, ActiveRun>();

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

	async function dispatch(req: DispatchRequest): Promise<{
		runId: string;
		events: AsyncIterableIterator<unknown>;
		finalPromise: Promise<RunReceipt>;
	}> {
		const { systemPrompt: _sp, ...jobSpec } = req;
		const validated = validateJobSpec(jobSpec);
		if (!validated.ok) {
			throw new Error(`dispatch: invalid spec: ${validated.errors.join("; ")}`);
		}
		const staleDetails = staleDispatchDetails(options);
		if (staleDetails) {
			throw new DispatchStaleProcessError(staleDetails);
		}

		if (scheduling) {
			const preflight = scheduling.preflight();
			if (preflight.verdict === "over" || preflight.verdict === "at") {
				throw new Error(
					`dispatch: admission denied: budget ceiling crossed: $${preflight.currentUsd.toFixed(4)} / $${preflight.ceilingUsd.toFixed(4)}`,
				);
			}
		}

		const recipe = agents.get(req.agentId);
		const currentMode = modes.current();
		const workerMode = recipe?.mode ?? currentMode;
		const recipeTools = recipe?.tools;
		const allowedToolsBase =
			recipeTools && recipeTools.length > 0 ? Array.from(recipeTools) : Array.from(modes.visibleTools());
		const allowedTools = options?.selfDevMode
			? [...new Set([...allowedToolsBase, ...(options.selfDevToolNames ?? [])])]
			: allowedToolsBase;
		const requestedActions = deriveRequestedActions(
			allowedTools as ReadonlyArray<ToolName>,
			safety,
			options?.selfDevToolNames,
		);
		const orchScope = pickOrchestratorScope(safety, currentMode);
		if (orchScope === null) {
			throw new Error(`dispatch: admission denied: mode ${currentMode} does not allow dispatch`);
		}
		const workerScope = pickWorkerScope(safety, workerMode);

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

		const settings = config?.get();
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
		const target = resolveDispatchTarget(req, recipe, workerDefault, workerProfiles, providers);
		enforceCapabilityGate(target.endpoint.id, target.modelCapabilities, req.requiredCapabilities);

		const cwd = req.cwd ?? process.cwd();
		const systemPrompt = prependSelfDevPreamble(buildSystemPrompt(req, recipe), prompts);
		const compiledPromptHash = promptHash(systemPrompt);

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
		const approval = deriveAutoApproveForDispatch(req, runtimeLimitations(runtimeKind, target.runtime.id));

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

		const tokenMeter = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
		const safetyDecisionCounts = { allowed: 0, blocked: 0, elevated: 0 };
		const blockedAttempts: SafetyBlockedAttempt[] = [];
		const spec: WorkerSpec = {
			specVersion: WORKER_SPEC_VERSION,
			systemPrompt,
			task: req.task,
			endpoint: target.endpoint,
			runtime: serializeWorkerRuntimeDescriptor(target.runtime),
			runtimeId: target.runtime.id,
			wireModelId: target.wireModelId,
			thinkingLevel: target.modelCapabilities?.reasoning === false ? "off" : target.thinkingLevel,
			allowedTools: allowedTools as ReadonlyArray<ToolName>,
			mode: workerMode,
			middlewareSnapshot: middleware.snapshot(),
			supervised: approval.supervised,
		};
		if (approval.autoApprove !== undefined) spec.autoApprove = approval.autoApprove;
		if (options?.selfDevMode) spec.selfDev = options.selfDevMode;
		if (target.modelCapabilities) spec.modelCapabilities = target.modelCapabilities;
		if (apiKey) spec.apiKey = apiKey;
		let worker: SpawnedWorker;
		try {
			worker = spawnWorker(spec, { cwd });
		} catch (error) {
			releaseWorkerSlot();
			throw error;
		}
		worker.onApprovalRequest((request) => waitForToolApprovalResponse(context, request));
		const pid = worker.pid;
		const abort = () => worker.abort();
		const heartbeatAt = worker.heartbeatAt;
		const workerEvents = worker.events;
		const workerDone = worker.promise.then((r) => ({ exitCode: r.exitCode }));

		const toolStats = new Map<string, ToolCallStat>();
		const upstreamResponses: RunReceiptUpstreamResponse[] = [];
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
					};
					payload?: {
						tool?: string;
						mode?: string;
						durationMs?: number;
						outcome?: "ok" | "error" | "blocked";
						decision?: "allowed" | "blocked" | "elevated";
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
					tokenMeter.reasoningTokens += extractReasoningTokenCount(u);
					const model = readStringOrNull(event.message.model);
					const responseModel = readStringOrNull(event.message.responseModel);
					const responseId = readStringOrNull(event.message.responseId);
					if (model !== null || responseModel !== null || responseId !== null) {
						upstreamResponses.push({ model, responseModel, responseId });
					}
				}
				if (event.type === "clio_tool_finish" && event.payload && typeof event.payload.tool === "string") {
					recordToolFinish(toolStats, event.payload);
					if (event.payload.decision === "allowed") safetyDecisionCounts.allowed += 1;
					else if (event.payload.decision === "blocked") safetyDecisionCounts.blocked += 1;
					else if (event.payload.decision === "elevated") safetyDecisionCounts.elevated += 1;
					if (event.payload.outcome === "blocked" || event.payload.decision === "blocked") {
						const attempt: SafetyBlockedAttempt = { tool: event.payload.tool };
						if (event.payload.mode !== undefined) attempt.mode = event.payload.mode;
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
			task: req.task,
			endpointId: target.endpoint.id,
			wireModelId: target.wireModelId,
			runtimeId: target.runtime.id,
			runtimeKind,
			sessionId: null,
			cwd,
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
			endpointId: target.endpoint.id,
			wireModelId: target.wireModelId,
			runtimeId: target.runtime.id,
			runtimeKind,
		});
		context.bus.emit(BusChannels.DispatchStarted, {
			runId: envelope.id,
			agentId: req.agentId,
			endpointId: target.endpoint.id,
			wireModelId: target.wireModelId,
			runtimeId: target.runtime.id,
			runtimeKind,
			pid,
		});

		const startedAt = envelope.startedAt;

		const activeRun: ActiveRun = {
			runId: envelope.id,
			abort,
			promise: workerDone.then(() => undefined),
			recipe,
			startedAt,
			endpointId: target.endpoint.id,
			wireModelId: target.wireModelId,
			runtimeId: target.runtime.id,
			runtimeKind,
			agentId: req.agentId,
			task: req.task,
			cwd,
			aborted: false,
			heartbeatAt,
			heartbeatStatus: "alive",
			terminalStatusOverride: null,
			finalPromise: undefined as unknown as Promise<RunReceipt>,
		};

		const finalPromise = (async (): Promise<RunReceipt> => {
			try {
				const result = await workerDone;
				const endedAt = new Date().toISOString();
				const status: RunStatus =
					activeRun.terminalStatusOverride ??
					(activeRun.aborted ? "interrupted" : result.exitCode === 0 ? "completed" : "failed");
				activeRun.terminalStatusOverride = status;
				const receiptExitCode = status === "dead" ? 1 : (result.exitCode ?? 1);
				const pricing = target.endpoint.pricing;
				const costUsd = pricing
					? (tokenMeter.inputTokens * pricing.input) / 1_000_000 + (tokenMeter.outputTokens * pricing.output) / 1_000_000
					: 0;
				const tokenCount = tokenMeter.inputTokens + tokenMeter.outputTokens;
				const reasoningTokenCount = tokenMeter.reasoningTokens;
				const safetyMetadata = safety.policy?.metadata(currentMode) ?? null;
				const receiptDraft: RunReceiptDraft = {
					runId: envelope.id,
					agentId: req.agentId,
					task: req.task,
					endpointId: target.endpoint.id,
					wireModelId: target.wireModelId,
					runtimeId: target.runtime.id,
					runtimeKind,
					startedAt,
					endedAt,
					exitCode: receiptExitCode,
					tokenCount,
					reasoningTokenCount,
					...(upstreamResponses.length > 0 ? { upstreamResponses: [...upstreamResponses] } : {}),
					costUsd,
					compiledPromptHash,
					staticCompositionHash: null,
					clioVersion: readClioVersion(),
					piMonoVersion: readPiMonoVersion(),
					platform: process.platform,
					nodeVersion: process.version,
					toolCalls: countToolCalls(toolStats),
					toolStats: snapshotToolStats(toolStats),
					safety: {
						decisions: safetyDecisionCounts,
						blockedAttempts,
						dispatchScope: MODE_MATRIX[currentMode].dispatchScope,
						workerMode,
						requestedActions,
						runtimeLimitations: approval.runtimeLimitations,
					},
					reproducibility: collectReproducibilityMetadata(cwd, safetyMetadata),
					sessionId: null,
				};
				ledgerRef.update(envelope.id, {
					status,
					endedAt,
					exitCode: receiptExitCode,
					tokenCount,
					reasoningTokenCount,
					costUsd,
					...(activeRun.heartbeatAt ? { heartbeatAt: heartbeatIso(activeRun.heartbeatAt.current) } : {}),
				});
				const receipt = ledgerRef.recordReceipt(envelope.id, receiptDraft);
				await ledgerRef.persist();
				active.delete(envelope.id);
				const startMs = Date.parse(receipt.startedAt);
				const endMs = Date.parse(receipt.endedAt);
				const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
				if (status === "completed") {
					context.bus.emit(BusChannels.DispatchCompleted, {
						runId: envelope.id,
						agentId: req.agentId,
						endpointId: target.endpoint.id,
						wireModelId: target.wireModelId,
						runtimeId: target.runtime.id,
						runtimeKind,
						tokenCount: receipt.tokenCount,
						reasoningTokenCount: receipt.reasoningTokenCount ?? 0,
						costUsd: receipt.costUsd,
						durationMs,
						exitCode: receiptExitCode,
					});
				} else {
					context.bus.emit(BusChannels.DispatchFailed, {
						runId: envelope.id,
						agentId: req.agentId,
						endpointId: target.endpoint.id,
						wireModelId: target.wireModelId,
						runtimeId: target.runtime.id,
						runtimeKind,
						tokenCount: receipt.tokenCount,
						reasoningTokenCount: receipt.reasoningTokenCount ?? 0,
						costUsd: receipt.costUsd,
						durationMs,
						exitCode: receiptExitCode,
						reason: status,
					});
				}
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
