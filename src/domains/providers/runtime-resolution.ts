import { targetRequiresAuth } from "./auth/index.js";
import { getCatalogModelForRuntime } from "./catalog.js";
import type { EndpointStatus, ProvidersContract } from "./contract.js";
import { isTargetEligibleRuntime } from "./eligibility.js";
import { probeCapabilitiesForModel, resolveModelCapabilities } from "./model-capabilities.js";
import {
	type ResolvedModelRuntimeCapabilities,
	resolveEndpointRuntimeCapabilities,
	resolveModelRuntimeCapabilities,
} from "./model-runtime-capabilities.js";
import type { CapabilityFlags, ThinkingLevel } from "./types/capability-flags.js";
import type { EndpointDescriptor } from "./types/endpoint-descriptor.js";
import type { KnowledgeBase } from "./types/knowledge-base.js";
import type {
	RuntimeApiFamily,
	RuntimeAuth,
	RuntimeDescriptor,
	RuntimeKind,
	RuntimeTier,
} from "./types/runtime-descriptor.js";

export interface ContextWindowDetails {
	/** Best static knowledge of the model's window (hint > KB > catalog > runtime default). */
	declaredContextWindow: number;
	/** Raw probe result, when the endpoint was probed. */
	probedContextWindow: number | null;
	/** Context actually loaded server-side; only LM Studio reports this. */
	loadedContextWindow: number | null;
	/** What Clio wants for coding: 128k floor on local-native tiers, declared elsewhere. */
	desiredContextWindow: number;
	/** What the target actually offers; probe/loaded beats config beats declared knowledge. */
	effectiveContextWindow: number;
	/** Where `effectiveContextWindow` came from. */
	contextWindowSource:
		| "catalog"
		| "probe"
		| "loaded"
		| "endpoint-override"
		| "model-hint"
		| "descriptor-default"
		| "local-native-default"
		| "unknown";
	warning: string | null;
}

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
	contextWindowDetails: ContextWindowDetails;
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
	// HTTP/native runtimes stream through pi-ai/pi-agent-core.
	return runtime.kind === "http";
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

function probeReasoningApplies(status: EndpointStatus, wireModelId: string): boolean {
	return probeCapabilitiesForModel(status, wireModelId)?.reasoning !== undefined;
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

	if (!isTargetEligibleRuntime(runtime)) {
		return {
			ok: false,
			diagnostics: [
				diagnostic(
					"error",
					"runtime-target-unsupported",
					`target '${endpointId}' uses runtime '${runtime.id}' (${runtime.kind}); Clio only drives HTTP/native runtime targets`,
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
	const probedContextWindow = probeCapabilitiesForModel(status, wireModelId)?.contextWindow ?? null;
	const contextWindowDetails = resolveContextWindowDetails(
		endpoint,
		runtime,
		wireModelId,
		providers.knowledgeBase,
		probedContextWindow,
	);
	capabilities.contextWindow = contextWindowDetails.effectiveContextWindow;

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
		contextWindowDetails,
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
	knowledgeBase?: KnowledgeBase | null,
): ResolvedRuntimeTarget {
	const patch = modelHintPatch(target, model);
	const hintRecord = model && typeof model === "object" ? (model as Record<string, unknown>) : undefined;
	const modelHintContextWindow = nonNegativeFiniteNumber(hintRecord?.contextWindow);
	// The capability patch ignores the hint window once a target carries any
	// effective window (it always does now), so the hint must independently
	// force a re-resolution: a live model reporting a smaller loaded window
	// than the local-native floor would otherwise be silently ignored and
	// compaction would trigger too late.
	const windowHintDiffers =
		modelHintContextWindow !== undefined &&
		modelHintContextWindow > 0 &&
		modelHintContextWindow !== target.contextWindowDetails.effectiveContextWindow;
	if (Object.keys(patch).length === 0 && !windowHintDiffers) return target;
	const capabilities: CapabilityFlags = { ...target.capabilities, ...patch };
	const contextWindowDetails = resolveContextWindowDetails(
		target.endpoint,
		target.runtime,
		target.wireModelId,
		knowledgeBase ?? null,
		target.contextWindowDetails.probedContextWindow,
		modelHintContextWindow,
	);
	capabilities.contextWindow = contextWindowDetails.effectiveContextWindow;

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
		contextWindowDetails,
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

/** Recommended minimum context for coding against a local-native runtime. */
const LOCAL_NATIVE_DESIRED_CONTEXT_WINDOW = 128000;
/** Last-resort window when nothing declares one. */
const FALLBACK_CONTEXT_WINDOW = 8192;

function positiveWindow(value: number | null | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Resolve the three context-window figures a target carries:
 *
 *  - `declared`: best static knowledge of the model's window
 *    (live model hint > knowledge base > catalog > runtime default > 8192).
 *  - `desired`: what Clio wants for coding. Local-native tiers get a 128k
 *    floor regardless of what KB/catalog declare; elsewhere desired follows
 *    the declared window.
 *  - `effective`: what the target actually offers, most live source first:
 *    probe/loaded > endpoint config override > model-specific knowledge >
 *    the local-native floor (we ask local runtimes to load that much) >
 *    runtime descriptor default. `contextWindowSource` labels whichever won.
 *
 * Warns when a local-native target ends up below the 128k recommendation.
 */
export function resolveContextWindowDetails(
	endpoint: EndpointDescriptor,
	runtime: RuntimeDescriptor,
	wireModelId: string,
	knowledgeBase: KnowledgeBase | null,
	probedContextWindow: number | null,
	modelHintContextWindow?: number,
): ContextWindowDetails {
	const catalogModel = getCatalogModelForRuntime(runtime.id, wireModelId);
	const kbHit = knowledgeBase?.lookup(wireModelId) ?? null;

	// Model-specific knowledge, most live first.
	let modelDeclared: number | undefined;
	let modelDeclaredSource: ContextWindowDetails["contextWindowSource"] = "unknown";
	const hintWindow = positiveWindow(modelHintContextWindow);
	const kbWindow = positiveWindow(kbHit?.entry.capabilities?.contextWindow);
	const catalogWindow = positiveWindow(catalogModel?.contextWindow);
	if (hintWindow !== undefined) {
		modelDeclared = hintWindow;
		modelDeclaredSource = "model-hint";
	} else if (kbWindow !== undefined) {
		modelDeclared = kbWindow;
		modelDeclaredSource = "catalog";
	} else if (catalogWindow !== undefined) {
		modelDeclared = catalogWindow;
		modelDeclaredSource = "catalog";
	}

	const declaredContextWindow =
		modelDeclared ?? positiveWindow(runtime.defaultCapabilities?.contextWindow) ?? FALLBACK_CONTEXT_WINDOW;

	const desired =
		runtime.tier === "local-native"
			? Math.max(declaredContextWindow, LOCAL_NATIVE_DESIRED_CONTEXT_WINDOW)
			: declaredContextWindow;

	const probeWindow = positiveWindow(probedContextWindow);
	const overrideWindow = positiveWindow(endpoint.capabilities?.contextWindow);
	let effective: number;
	let source: ContextWindowDetails["contextWindowSource"];
	if (probeWindow !== undefined) {
		effective = probeWindow;
		source = runtime.id === "lmstudio-native" ? "loaded" : "probe";
	} else if (overrideWindow !== undefined) {
		effective = overrideWindow;
		source = "endpoint-override";
	} else if (modelDeclared !== undefined) {
		effective = modelDeclared;
		source = modelDeclaredSource;
	} else if (runtime.tier === "local-native") {
		// No live or model-specific signal; plan for the floor we ask local
		// runtimes to load.
		effective = desired;
		source = "local-native-default";
	} else {
		effective = declaredContextWindow;
		source = "descriptor-default";
	}

	let warning: string | null = null;
	if (runtime.tier === "local-native" && effective < LOCAL_NATIVE_DESIRED_CONTEXT_WINDOW) {
		warning = `Connected target offers ${effective} tokens, which is below the recommended 128k for local coding.`;
	}

	return {
		declaredContextWindow,
		probedContextWindow,
		loadedContextWindow: runtime.id === "lmstudio-native" ? probedContextWindow : null,
		desiredContextWindow: desired,
		effectiveContextWindow: effective,
		contextWindowSource: source,
		warning,
	};
}
