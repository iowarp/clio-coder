import { CLIO_CONTEXT_WINDOW_WARN_BELOW, CLIO_MIN_CONTEXT_WINDOW } from "../../core/context-floor.js";
import { runOverrides } from "../../core/run-overrides.js";
import { targetRequiresAuth } from "./auth/index.js";
import { getCatalogModelForRuntime, resolveCostProvenance } from "./catalog.js";
import type { ProvidersContract, TargetStatus } from "./contract.js";
import { isDispatchEligibleRuntime, isOrchestratorEligibleRuntime, isTargetEligibleRuntime } from "./eligibility.js";
import { probeCapabilitiesForModel, resolveModelCapabilities } from "./model-capabilities.js";
import { hasLiveModelCatalog, loadedContextWindowForModel } from "./model-discovery.js";
import {
	type ReasoningClass,
	type ResolvedModelRuntimeCapabilities,
	reasoningClassForMechanism,
	resolveModelRuntimeCapabilities,
	resolveTargetRuntimeCapabilities,
} from "./model-runtime-capabilities.js";
import type { CapabilityFlags, ThinkingLevel } from "./types/capability-flags.js";
import type { CostProvenance } from "./types/cost-provenance.js";
import type { KnowledgeBase } from "./types/knowledge-base.js";
import type {
	RuntimeApiFamily,
	RuntimeAuth,
	RuntimeDescriptor,
	RuntimeKind,
	RuntimeTier,
} from "./types/runtime-descriptor.js";
import type { TargetDescriptor } from "./types/target-descriptor.js";

/**
 * The layer that answered `effectiveContextWindow`, most authoritative first.
 * `loaded` is the window a backend reports having this model open at; `probe` is
 * a window the target reported without saying it is what is serving.
 */
export type ContextWindowSource =
	| "catalog"
	| "probe"
	| "loaded"
	| "target-override"
	| "model-hint"
	| "descriptor-default"
	| "unknown";

export interface ContextWindowDetails {
	/** Best static knowledge of the model's window (hint > KB > catalog > runtime default). */
	declaredContextWindow: number;
	/** Raw probe result, when the target was probed. */
	probedContextWindow: number | null;
	/** Context the backend reports this model loaded at; only some runtimes report it. */
	loadedContextWindow: number | null;
	/** What Clio would like for coding; advisory only and never displayed as provider truth. */
	desiredContextWindow: number;
	/** What the target actually offers; live probe/config/model knowledge only. */
	effectiveContextWindow: number;
	/** Where `effectiveContextWindow` came from. */
	contextWindowSource: ContextWindowSource;
	/** The window is below what this kind of work wants. An actionable degradation. */
	warning: string | null;
	/** The window is a placeholder rather than something the target reported. */
	provenanceNotice: string | null;
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
	target: TargetDescriptor;
	runtime: RuntimeDescriptor;
	runtimeId: string;
	runtimeKind: RuntimeKind;
	apiFamily: RuntimeApiFamily;
	auth: RuntimeAuth;
	authRequired: boolean;
	wireModelId: string;
	costProvenance: CostProvenance;
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
		/** Derived reasoning class: never | switchable | always. */
		class: ReasoningClass;
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
	targetId?: string | null;
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
	target: TargetDescriptor,
	runtime: RuntimeDescriptor,
	_wireModelId: string,
): TargetStatus {
	const existing = providers.list().find((entry) => entry.target.id === target.id);
	if (existing) return existing;
	const capabilities: CapabilityFlags = { ...runtime.defaultCapabilities, ...(target.capabilities ?? {}) };
	return {
		target,
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
	// HTTP/native runtimes stream through pi-ai/pi-agent-core. The sanctioned
	// Claude Code worker runtimes stream through their SDK/CLI worker runners.
	return isTargetEligibleRuntime(runtime);
}

function runtimeSupportsUse(runtime: RuntimeDescriptor, use: RuntimeResolutionUse): boolean {
	if (use === "dispatch") return isDispatchEligibleRuntime(runtime);
	return isOrchestratorEligibleRuntime(runtime);
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

function probeReasoningApplies(status: TargetStatus, wireModelId: string): boolean {
	return probeCapabilitiesForModel(status, wireModelId)?.reasoning !== undefined;
}

/**
 * Warn instead of silently passing a model id the target does not advertise.
 * The id still resolves (local servers accept ids they never listed), but a
 * typo or a stale settings entry surfaces here instead of at stream time.
 * Silent only when there is no basis to judge: no configured wireModels and
 * no live catalog yet.
 */
function unknownModelDiagnostic(
	target: TargetDescriptor,
	status: TargetStatus,
	wireModelId: string,
): RuntimeResolutionDiagnostic | null {
	const configured = (target.wireModels ?? []).map((id) => id.trim()).filter((id) => id.length > 0);
	const probed = hasLiveModelCatalog(status);
	const live = probed ? status.discoveredModels : null;
	if (configured.length === 0 && live === null) return null;
	if (configured.includes(wireModelId) || (live?.includes(wireModelId) ?? false)) return null;
	const sources = [
		...(configured.length > 0 ? ["configured wireModels"] : []),
		...(live !== null && live.length > 0 ? ["live model catalog"] : []),
	];
	// A catalog that came back empty is a read that failed, not a server that
	// serves nothing. Reporting it as a catalog the model is missing from sends
	// the user to fix the settings entry or add the model to the server, and
	// both of those are the wrong place to look.
	if (sources.length === 0) {
		return diagnostic(
			"warning",
			"model-catalog-unreadable",
			`target '${target.id}' returned no model list, so Clio could not check whether '${wireModelId}' is served there; requests will send the id as-is. Re-read the catalog with: clio-coder targets --probe`,
		);
	}
	return diagnostic(
		"warning",
		"model-not-in-catalog",
		`model '${wireModelId}' is not in target '${target.id}' ${sources.join(" or ")}; requests will send the id as-is. Fix the settings entry or add the model to the server if this is unintended.`,
	);
}

function modelCapabilitiesFor(
	providers: ProvidersContract,
	status: TargetStatus,
	wireModelId: string,
): ModelCapabilitiesResolution {
	const detectedReasoning = providers.getDetectedReasoning(status.target.id, wireModelId);
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
	const targetId = input.targetId?.trim();
	if (!targetId) {
		return {
			ok: false,
			diagnostics: [diagnostic("error", "target-not-configured", "no target is configured")],
		};
	}

	const target = providers.getTarget(targetId);
	if (!target) {
		return {
			ok: false,
			diagnostics: [diagnostic("error", "target-not-found", `target '${targetId}' not found in settings.targets`)],
		};
	}

	const runtime = providers.getRuntime(target.runtime);
	if (!runtime) {
		return {
			ok: false,
			diagnostics: [diagnostic("error", "runtime-not-registered", `runtime '${target.runtime}' not registered`)],
		};
	}

	if (!isTargetEligibleRuntime(runtime)) {
		return {
			ok: false,
			diagnostics: [
				diagnostic(
					"error",
					"runtime-target-unsupported",
					`target '${targetId}' uses runtime '${runtime.id}' (${runtime.kind}); Clio cannot drive this runtime as a target`,
				),
			],
		};
	}

	const resolutionUse = input.use ?? "orchestrator";
	if (!runtimeSupportsUse(runtime, resolutionUse)) {
		return {
			ok: false,
			diagnostics: [
				diagnostic(
					"error",
					"runtime-use-unsupported",
					`target '${targetId}' uses runtime '${runtime.id}' (${runtime.kind}); this runtime is only supported for worker dispatch`,
				),
			],
		};
	}

	const wireModelId = input.wireModelId?.trim() || target.defaultModel?.trim();
	if (!wireModelId) {
		return {
			ok: false,
			diagnostics: [diagnostic("error", "model-not-configured", `target '${targetId}' has no model configured`)],
		};
	}

	const status = statusFor(providers, target, runtime, wireModelId);
	const unknownModel = unknownModelDiagnostic(target, status, wireModelId);
	if (unknownModel) diagnostics.push(unknownModel);

	const requestedThinkingLevel = input.requestedThinkingLevel ?? "off";
	const capabilityResolution = modelCapabilitiesFor(providers, status, wireModelId);
	const capabilities: CapabilityFlags = { ...capabilityResolution.capabilities };
	const probedContextWindow = probeCapabilitiesForModel(status, wireModelId)?.contextWindow ?? null;
	// Discovery's per-model loaded window, which the probe capabilities cannot
	// carry: `probeCapabilitiesForModel` answers for the target's default model
	// and reports a window without saying whether it is the one being served.
	const loadedContextWindow = loadedContextWindowForModel(status, wireModelId);
	const contextWindowDetails = resolveContextWindowDetails(
		target,
		runtime,
		wireModelId,
		providers.knowledgeBase,
		probedContextWindow,
		loadedContextWindow,
	);
	capabilities.contextWindow = contextWindowDetails.effectiveContextWindow;
	if (contextWindowDetails.warning) {
		diagnostics.push(diagnostic("warning", "context-window-low", contextWindowDetails.warning));
	}
	if (contextWindowDetails.provenanceNotice) {
		// A warning, not info. Clio now assumes its own minimum when a target
		// reports nothing, so an unverified window is a number that could be
		// larger than the truth, and overrunning it fails the request rather
		// than merely wasting capacity. As info this reached only the dispatch
		// receipt JSON, which nobody reads during the run it describes.
		diagnostics.push(diagnostic("warning", "context-window-unverified", contextWindowDetails.provenanceNotice));
	}

	const modelRuntime = resolveTargetRuntimeCapabilities(
		target,
		runtime,
		wireModelId,
		capabilities,
		providers.knowledgeBase,
		requestedThinkingLevel,
	);
	const decisions = capabilityDecisions(runtime, capabilities);
	appendCapabilityDiagnostics(diagnostics, input, capabilities, decisions, targetId);
	appendThinkingDiagnostics(diagnostics, modelRuntime, requestedThinkingLevel);

	if (hasError(diagnostics)) return { ok: false, diagnostics };

	const resolved: ResolvedRuntimeTarget = {
		targetId: target.id,
		target,
		runtime,
		runtimeId: runtime.id,
		runtimeKind: runtime.kind,
		apiFamily: runtime.apiFamily,
		auth: runtime.auth,
		authRequired: targetRequiresAuth(target, runtime),
		wireModelId,
		costProvenance: resolveCostProvenance(target, runtime.id, wireModelId),
		requestedThinkingLevel,
		effectiveThinkingLevel: modelRuntime.thinking.effectiveLevel,
		capabilities,
		capabilityDecisions: decisions,
		modelRuntime,
		modelReasoningAuthoritative: capabilityResolution.reasoningAuthoritative,
		diagnostics,
		contextWindowDetails,
	};
	if (runtime.tier !== undefined) resolved.runtimeTier = runtime.tier;
	return { ok: true, target: resolved, diagnostics };
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
		target.target,
		target.runtime,
		target.wireModelId,
		knowledgeBase ?? null,
		target.contextWindowDetails.probedContextWindow,
		// A synthesized model hint carries the model's declared window, never the
		// one the backend has open. Re-resolving without the loaded number would
		// hand the planner the declared window back on the first refinement.
		target.contextWindowDetails.loadedContextWindow,
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
			class: reasoningClassForMechanism(target.modelRuntime.thinking.mechanism),
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

/**
 * The warnings a successful resolution still carries. A resolution that
 * succeeded is not a resolution that was clean: an unadvertised model id or a
 * thinking level the runtime ignores resolves fine and still changes what the
 * run does, so the caller has something to report rather than discard.
 */
export function runtimeResolutionWarnings(diagnostics: ReadonlyArray<RuntimeResolutionDiagnostic>): string[] {
	return diagnostics.filter((entry) => entry.severity === "warning").map((entry) => entry.message);
}

/**
 * Minimum context Clio is built for, applied to every tier rather than only to
 * local-native. A hosted target that reports less than this is as unable to
 * hold a repository's worth of tool results as a local one.
 */
const DESIRED_CONTEXT_WINDOW = CLIO_MIN_CONTEXT_WINDOW;
/** Last-resort window when nothing declares one. */
const FALLBACK_CONTEXT_WINDOW = CLIO_MIN_CONTEXT_WINDOW;

function positiveWindow(value: number | null | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Resolve the three context-window figures a target carries:
 *
 *  - `declared`: best static knowledge of the model's window
 *    (live model hint > knowledge base > catalog > runtime default > 8192).
 *  - `desired`: what Clio wants for coding. Local-native tiers still get a
 *    128k recommendation, but this is advisory only.
 *  - `effective`: what the target actually offers, most live source first:
 *    loaded > probe > target config override > model-specific knowledge >
 *    runtime descriptor default. Clio no longer invents a 128k effective
 *    window for unknown local models; providers must probe it or users must
 *    configure an explicit override.
 *
 * The loaded window outranks everything below it because it is the only figure
 * that describes what the backend will serve this turn. A model whose weights
 * allow 262k but which is open at 100k fails at 100k, so planning against the
 * declared number means autocompact never fires in time.
 *
 * Warns when a local-native target's effective window is below the 128k recommendation.
 */
export function resolveContextWindowDetails(
	target: TargetDescriptor,
	runtime: RuntimeDescriptor,
	wireModelId: string,
	knowledgeBase: KnowledgeBase | null,
	probedContextWindow: number | null,
	loadedContextWindow: number | null = null,
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

	const runtimeDefault = positiveWindow(runtime.defaultCapabilities?.contextWindow);
	const declaredContextWindow = modelDeclared ?? runtimeDefault ?? FALLBACK_CONTEXT_WINDOW;

	const desired = Math.max(declaredContextWindow, DESIRED_CONTEXT_WINDOW);

	const loadedWindow = positiveWindow(loadedContextWindow);
	const probeWindow = positiveWindow(probedContextWindow);
	const overrideWindow = positiveWindow(target.capabilities?.contextWindow);
	let effective: number;
	let source: ContextWindowSource;
	if (loadedWindow !== undefined) {
		effective = loadedWindow;
		source = "loaded";
	} else if (probeWindow !== undefined) {
		effective = probeWindow;
		// Not "loaded": a probed window is what the target reported for the
		// model, and only a runtime that names its resident instance's window
		// has said anything about what is serving right now.
		source = "probe";
	} else if (overrideWindow !== undefined) {
		effective = overrideWindow;
		source = "target-override";
	} else if (modelDeclared !== undefined) {
		effective = modelDeclared;
		source = modelDeclaredSource;
	} else {
		effective = declaredContextWindow;
		// `descriptor-default` is a claim that the runtime descriptor supplied
		// this number. When it did not, the number is FALLBACK_CONTEXT_WINDOW and
		// the honest label is `unknown`; attributing a hardcoded guess to the
		// descriptor makes a value nobody declared read like a declared one.
		source = runtimeDefault !== undefined ? "descriptor-default" : "unknown";
	}

	// One-run CLI override (clio-coder run --max-context-tokens), delivered over the
	// run-overrides transport; see core/run-overrides.ts.
	const overrideMaxContextTokens = runOverrides().maxContextTokens;
	if (overrideMaxContextTokens !== undefined) {
		effective = overrideMaxContextTokens;
		source = "target-override";
	}

	// Below the floor is a warning on every tier. A target that reports less
	// than Clio's minimum will compact on the first substantial read no matter
	// where it runs, and the operator can act on that only if they are told.
	let warning: string | null = null;
	if (effective < CLIO_CONTEXT_WINDOW_WARN_BELOW) {
		warning =
			`Target offers ${effective} context tokens, below the ${CLIO_CONTEXT_WINDOW_WARN_BELOW} Clio needs. ` +
			`Load the model with a larger context, or set capabilities.contextWindow on this target.`;
	}

	// Deliberately not folded into `warning`. That field means the window is
	// smaller than the work needs, which is a degradation an operator can act
	// on. Provenance is the separate question of whether the number is real:
	// Clio assumes the floor rather than a number nobody declared, and says so.
	let provenanceNotice: string | null = null;
	if (source === "descriptor-default" || source === "unknown") {
		provenanceNotice =
			`Context window ${effective} is Clio's assumed minimum, not a figure this target reported. ` +
			`Run 'clio-coder targets --probe' to read the real one.`;
	}

	return {
		declaredContextWindow,
		probedContextWindow,
		loadedContextWindow: loadedWindow ?? null,
		desiredContextWindow: desired,
		effectiveContextWindow: effective,
		contextWindowSource: source,
		warning,
		provenanceNotice,
	};
}
