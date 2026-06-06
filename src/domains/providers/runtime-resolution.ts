import { targetRequiresAuth } from "./auth/index.js";
import type { EndpointStatus, ProvidersContract } from "./contract.js";
import { isOrchestratorTargetEligibleRuntime, isWorkerTargetEligibleRuntime } from "./eligibility.js";
import { resolveModelCapabilities } from "./model-capabilities.js";
import {
	type ResolvedModelRuntimeCapabilities,
	resolveEndpointRuntimeCapabilities,
	resolveModelRuntimeCapabilities,
} from "./model-runtime-capabilities.js";
import type { CapabilityFlags, ThinkingLevel } from "./types/capability-flags.js";
import type { EndpointDescriptor } from "./types/endpoint-descriptor.js";
import type {
	RuntimeApiFamily,
	RuntimeAuth,
	RuntimeDescriptor,
	RuntimeKind,
	RuntimeTier,
} from "./types/runtime-descriptor.js";

export type RuntimeResolutionUse = "orchestrator" | "print" | "dispatch";
export type RuntimeResolutionSeverity = "info" | "warning" | "error";

export interface RuntimeResolutionDiagnostic {
	severity: RuntimeResolutionSeverity;
	code: string;
	message: string;
}

export interface RuntimeCapabilityDecision {
	chat: boolean;
	tools: boolean;
	reasoning: boolean;
	vision: boolean;
	streaming: boolean;
	contextWindow: number;
	maxTokens: number;
}

export interface ResolvedRuntimeTarget {
	targetId: string;
	endpoint: EndpointDescriptor;
	runtime: RuntimeDescriptor;
	runtimeId: string;
	runtimeKind: RuntimeKind;
	apiFamily: RuntimeApiFamily;
	auth: RuntimeAuth;
	authRequired: boolean;
	wireModelId: string;
	requestedThinkingLevel: ThinkingLevel;
	effectiveThinkingLevel: ThinkingLevel;
	capabilities: CapabilityFlags;
	capabilityDecisions: RuntimeCapabilityDecision;
	modelRuntime: ResolvedModelRuntimeCapabilities;
	/** True when live probe/detection data should beat synthesized model hints for reasoning. */
	modelReasoningAuthoritative: boolean;
	diagnostics: RuntimeResolutionDiagnostic[];
	runtimeTier?: RuntimeTier;
}

export interface RuntimeTargetSnapshot {
	targetId: string;
	runtimeId: string;
	runtimeKind: RuntimeKind;
	apiFamily: RuntimeApiFamily;
	auth: RuntimeAuth;
	authRequired: boolean;
	wireModelId: string;
	requestedThinkingLevel: ThinkingLevel;
	effectiveThinkingLevel: ThinkingLevel;
	capabilities: RuntimeCapabilityDecision;
	thinking: {
		mechanism: ResolvedModelRuntimeCapabilities["thinking"]["mechanism"];
		display: string;
		supportedLevels: ReadonlyArray<ThinkingLevel>;
		budgetEnforcement: ResolvedModelRuntimeCapabilities["thinking"]["budgetEnforcement"];
		noticeKind: ResolvedModelRuntimeCapabilities["thinking"]["noticeKind"];
		notice: string;
	};
	request: ResolvedModelRuntimeCapabilities["request"];
	response: ResolvedModelRuntimeCapabilities["response"];
	diagnostics: RuntimeResolutionDiagnostic[];
	runtimeTier?: RuntimeTier;
}

export type RuntimeTargetResolution =
	| { ok: true; target: ResolvedRuntimeTarget; diagnostics: RuntimeResolutionDiagnostic[] }
	| { ok: false; diagnostics: RuntimeResolutionDiagnostic[] };

export interface ResolveRuntimeTargetInput {
	endpointId?: string | null;
	wireModelId?: string | null;
	requestedThinkingLevel?: ThinkingLevel;
	requiredCapabilities?: ReadonlyArray<string>;
	use?: RuntimeResolutionUse;
	requireTools?: boolean;
	requireStreaming?: boolean;
	requireOutputBudget?: boolean;
}

function diagnostic(severity: RuntimeResolutionSeverity, code: string, message: string): RuntimeResolutionDiagnostic {
	return { severity, code, message };
}

function hasError(diagnostics: ReadonlyArray<RuntimeResolutionDiagnostic>): boolean {
	return diagnostics.some((entry) => entry.severity === "error");
}

function statusFor(
	providers: ProvidersContract,
	endpoint: EndpointDescriptor,
	runtime: RuntimeDescriptor,
	_wireModelId: string,
): EndpointStatus {
	const existing = providers.list().find((entry) => entry.endpoint.id === endpoint.id);
	if (existing) return existing;
	const capabilities: CapabilityFlags = { ...runtime.defaultCapabilities, ...(endpoint.capabilities ?? {}) };
	return {
		endpoint,
		runtime,
		available: true,
		reason: "synthetic-status",
		health: { status: "unknown", lastCheckAt: null, lastError: null, latencyMs: null },
		capabilities,
		probeCapabilities: null,
		probeModelId: null,
		discoveredModels: runtime.knownModels ?? [],
	};
}

function requiredCapabilitySupported(capabilities: CapabilityFlags, name: string): boolean {
	const value = (capabilities as unknown as Record<string, unknown>)[name];
	return value !== undefined && value !== false && value !== 0 && value !== "";
}

function streamingDecision(runtime: RuntimeDescriptor): boolean {
	// HTTP/native runtimes stream through pi-ai/pi-agent-core. Worker-only
	// subprocess runtimes are line/event parsed by Clio when admitted as dispatch
	// workers, but they are intentionally blocked for orchestrator and print use.
	return runtime.kind === "http" || runtime.kind === "subprocess";
}

function capabilityDecisions(runtime: RuntimeDescriptor, capabilities: CapabilityFlags): RuntimeCapabilityDecision {
	return {
		chat: capabilities.chat,
		tools: capabilities.tools,
		reasoning: capabilities.reasoning,
		vision: capabilities.vision,
		streaming: streamingDecision(runtime),
		contextWindow: capabilities.contextWindow,
		maxTokens: capabilities.maxTokens,
	};
}

function appendCapabilityDiagnostics(
	diagnostics: RuntimeResolutionDiagnostic[],
	input: ResolveRuntimeTargetInput,
	capabilities: CapabilityFlags,
	decisions: RuntimeCapabilityDecision,
	targetId: string,
): void {
	if (!decisions.chat) {
		diagnostics.push(diagnostic("error", "chat-unsupported", `target '${targetId}' does not advertise chat support`));
	}
	if (input.requireTools === true && !decisions.tools) {
		diagnostics.push(diagnostic("warning", "tools-unsupported", `target '${targetId}' does not support tool calls`));
	}
	if (input.requireStreaming === true && !decisions.streaming) {
		diagnostics.push(diagnostic("error", "streaming-unsupported", `target '${targetId}' cannot stream responses`));
	}
	if (input.requireOutputBudget === true && decisions.maxTokens <= 0) {
		diagnostics.push(
			diagnostic("warning", "output-budget-unknown", `target '${targetId}' does not expose a positive output budget`),
		);
	}
	for (const capability of input.requiredCapabilities ?? []) {
		if (!requiredCapabilitySupported(capabilities, capability)) {
			diagnostics.push(
				diagnostic(
					"error",
					"required-capability-missing",
					`target '${targetId}' does not satisfy required capability '${capability}'`,
				),
			);
		}
	}
}

function appendThinkingDiagnostics(
	diagnostics: RuntimeResolutionDiagnostic[],
	resolved: ResolvedModelRuntimeCapabilities,
	requested: ThinkingLevel,
): void {
	const thinking = resolved.thinking;
	if (thinking.effectiveLevel !== requested) {
		diagnostics.push(
			diagnostic(
				"warning",
				"thinking-coerced",
				`thinking ${requested} resolved to ${thinking.display} for ${resolved.runtimeId}/${resolved.modelId}`,
			),
		);
	}
	if (thinking.notice.length === 0) return;
	const severity: RuntimeResolutionSeverity =
		thinking.noticeKind === "unsupported" ||
		thinking.noticeKind === "always-on" ||
		thinking.noticeKind === "ignored-on-off"
			? "warning"
			: "info";
	diagnostics.push(diagnostic(severity, `thinking-${thinking.noticeKind}`, thinking.notice));
}

function nonNegativeFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

interface ModelCapabilitiesResolution {
	capabilities: CapabilityFlags;
	reasoningAuthoritative: boolean;
}

function normalizedModelId(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

function probeReasoningApplies(status: EndpointStatus, wireModelId: string): boolean {
	if (status.probeCapabilities?.reasoning === undefined) return false;
	const modelId = normalizedModelId(wireModelId) ?? normalizedModelId(status.endpoint.defaultModel);
	const probeModelId = normalizedModelId(status.probeModelId);
	if (probeModelId !== null) return modelId !== null && probeModelId === modelId;
	const defaultModelId = normalizedModelId(status.endpoint.defaultModel);
	return modelId !== null && defaultModelId !== null && modelId === defaultModelId;
}

function modelCapabilitiesFor(
	providers: ProvidersContract,
	status: EndpointStatus,
	wireModelId: string,
): ModelCapabilitiesResolution {
	const detectedReasoning = providers.getDetectedReasoning(status.endpoint.id, wireModelId);
	return {
		capabilities: resolveModelCapabilities(status, wireModelId, providers.knowledgeBase, { detectedReasoning }),
		reasoningAuthoritative: detectedReasoning !== null || probeReasoningApplies(status, wireModelId),
	};
}

export function resolveRuntimeTarget(
	providers: ProvidersContract,
	input: ResolveRuntimeTargetInput,
): RuntimeTargetResolution {
	const diagnostics: RuntimeResolutionDiagnostic[] = [];
	const endpointId = input.endpointId?.trim();
	if (!endpointId) {
		return {
			ok: false,
			diagnostics: [diagnostic("error", "target-not-configured", "no target is configured")],
		};
	}

	const endpoint = providers.getEndpoint(endpointId);
	if (!endpoint) {
		return {
			ok: false,
			diagnostics: [diagnostic("error", "target-not-found", `target '${endpointId}' not found in settings.targets`)],
		};
	}

	const runtime = providers.getRuntime(endpoint.runtime);
	if (!runtime) {
		return {
			ok: false,
			diagnostics: [diagnostic("error", "runtime-not-registered", `runtime '${endpoint.runtime}' not registered`)],
		};
	}

	if ((input.use === "orchestrator" || input.use === "print") && !isOrchestratorTargetEligibleRuntime(runtime)) {
		return {
			ok: false,
			diagnostics: [
				diagnostic(
					"error",
					"worker-only-target-unsupported",
					`target '${endpointId}' uses a worker-only runtime (${runtime.id}); subprocess runtimes can only be used as worker targets, not as orchestrator or print targets`,
				),
			],
		};
	}

	if (input.use === "dispatch" && !isWorkerTargetEligibleRuntime(runtime)) {
		return {
			ok: false,
			diagnostics: [
				diagnostic(
					"error",
					"dispatch-runtime-unsupported",
					`target '${endpointId}' uses runtime '${runtime.id}' (${runtime.kind}); dispatch supports HTTP/native targets plus codex-cli and opencode-cli worker-only subprocess targets`,
				),
			],
		};
	}

	const wireModelId = input.wireModelId?.trim() || endpoint.defaultModel?.trim();
	if (!wireModelId) {
		return {
			ok: false,
			diagnostics: [diagnostic("error", "model-not-configured", `target '${endpointId}' has no model configured`)],
		};
	}

	const status = statusFor(providers, endpoint, runtime, wireModelId);

	const requestedThinkingLevel = input.requestedThinkingLevel ?? "off";
	const capabilityResolution = modelCapabilitiesFor(providers, status, wireModelId);
	const capabilities = capabilityResolution.capabilities;
	const modelRuntime = resolveEndpointRuntimeCapabilities(
		endpoint,
		runtime,
		wireModelId,
		capabilities,
		providers.knowledgeBase,
		requestedThinkingLevel,
	);
	const decisions = capabilityDecisions(runtime, capabilities);
	appendCapabilityDiagnostics(diagnostics, input, capabilities, decisions, endpointId);
	appendThinkingDiagnostics(diagnostics, modelRuntime, requestedThinkingLevel);

	if (hasError(diagnostics)) return { ok: false, diagnostics };

	const target: ResolvedRuntimeTarget = {
		targetId: endpoint.id,
		endpoint,
		runtime,
		runtimeId: runtime.id,
		runtimeKind: runtime.kind,
		apiFamily: runtime.apiFamily,
		auth: runtime.auth,
		authRequired: targetRequiresAuth(endpoint, runtime),
		wireModelId,
		requestedThinkingLevel,
		effectiveThinkingLevel: modelRuntime.thinking.effectiveLevel,
		capabilities,
		capabilityDecisions: decisions,
		modelRuntime,
		modelReasoningAuthoritative: capabilityResolution.reasoningAuthoritative,
		diagnostics,
	};
	if (runtime.tier !== undefined) target.runtimeTier = runtime.tier;
	return { ok: true, target, diagnostics };
}

function modelHintPatch(target: ResolvedRuntimeTarget, model: unknown): Partial<CapabilityFlags> {
	if (!model || typeof model !== "object") return {};
	const record = model as Record<string, unknown>;
	const patch: Partial<CapabilityFlags> = {};
	if (!target.modelReasoningAuthoritative && typeof record.reasoning === "boolean") patch.reasoning = record.reasoning;
	const contextWindow = nonNegativeFiniteNumber(record.contextWindow);
	if (contextWindow !== undefined && target.capabilities.contextWindow <= 0) patch.contextWindow = contextWindow;
	const maxTokens = nonNegativeFiniteNumber(record.maxTokens);
	if (maxTokens !== undefined && target.capabilities.maxTokens <= 0) patch.maxTokens = maxTokens;
	if (Array.isArray(record.input)) patch.vision = record.input.includes("image");
	return patch;
}

function withoutStaleRuntimeDiagnostics(
	diagnostics: ReadonlyArray<RuntimeResolutionDiagnostic>,
	decisions: RuntimeCapabilityDecision,
): RuntimeResolutionDiagnostic[] {
	return diagnostics.filter((entry) => {
		if (entry.code.startsWith("thinking-")) return false;
		if (entry.code === "output-budget-unknown" && decisions.maxTokens > 0) return false;
		if (entry.code === "tools-unsupported" && decisions.tools) return false;
		return true;
	});
}

export function refineRuntimeTargetWithModelHints(
	target: ResolvedRuntimeTarget,
	model: unknown,
): ResolvedRuntimeTarget {
	const patch = modelHintPatch(target, model);
	if (Object.keys(patch).length === 0) return target;
	const capabilities: CapabilityFlags = { ...target.capabilities, ...patch };
	const modelRuntime = resolveModelRuntimeCapabilities({
		targetId: target.targetId,
		runtimeId: target.runtimeId,
		apiFamily: target.apiFamily,
		modelId: target.wireModelId,
		capabilities,
		...(target.modelRuntime.quirks ? { quirks: target.modelRuntime.quirks } : {}),
		configuredThinkingLevel: target.requestedThinkingLevel,
	});
	const decisions = capabilityDecisions(target.runtime, capabilities);
	const diagnostics = withoutStaleRuntimeDiagnostics(target.diagnostics, decisions);
	appendThinkingDiagnostics(diagnostics, modelRuntime, target.requestedThinkingLevel);
	return {
		...target,
		capabilities,
		capabilityDecisions: decisions,
		modelRuntime,
		effectiveThinkingLevel: modelRuntime.thinking.effectiveLevel,
		diagnostics,
	};
}

export function runtimeTargetSnapshot(target: ResolvedRuntimeTarget): RuntimeTargetSnapshot {
	const snapshot: RuntimeTargetSnapshot = {
		targetId: target.targetId,
		runtimeId: target.runtimeId,
		runtimeKind: target.runtimeKind,
		apiFamily: target.apiFamily,
		auth: target.auth,
		authRequired: target.authRequired,
		wireModelId: target.wireModelId,
		requestedThinkingLevel: target.requestedThinkingLevel,
		effectiveThinkingLevel: target.effectiveThinkingLevel,
		capabilities: { ...target.capabilityDecisions },
		thinking: {
			mechanism: target.modelRuntime.thinking.mechanism,
			display: target.modelRuntime.thinking.display,
			supportedLevels: [...target.modelRuntime.thinking.supportedLevels],
			budgetEnforcement: target.modelRuntime.thinking.budgetEnforcement,
			noticeKind: target.modelRuntime.thinking.noticeKind,
			notice: target.modelRuntime.thinking.notice,
		},
		request: { ...target.modelRuntime.request },
		response: { ...target.modelRuntime.response },
		diagnostics: target.diagnostics.map((entry) => ({ ...entry })),
	};
	if (target.runtimeTier !== undefined) snapshot.runtimeTier = target.runtimeTier;
	return snapshot;
}

export function firstRuntimeResolutionError(diagnostics: ReadonlyArray<RuntimeResolutionDiagnostic>): string | null {
	return diagnostics.find((entry) => entry.severity === "error")?.message ?? null;
}
