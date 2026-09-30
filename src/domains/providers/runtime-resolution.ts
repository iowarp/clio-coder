import { runOverrides } from "../../core/run-overrides.js";
import { targetRequiresAuth } from "./auth/index.js";
import { ignoredCapabilityRaises } from "./capabilities.js";
import { getCatalogModelForRuntime, resolveCostProvenance } from "./catalog.js";
import type { ProvidersContract, TargetStatus } from "./contract.js";
import { isDispatchEligibleRuntime, isOrchestratorEligibleRuntime, isTargetEligibleRuntime } from "./eligibility.js";
import { probeCapabilitiesForModel, resolveModelCapabilities } from "./model-capabilities.js";
import { contextSlotsForModel, hasLiveModelCatalog, loadedContextWindowForModel } from "./model-discovery.js";
import {
	type ReasoningClass,
	type ResolvedModelRuntimeCapabilities,
	reasoningClassForMechanism,
	resolveModelRuntimeCapabilities,
	resolveTargetRuntimeCapabilities,
} from "./model-runtime-capabilities.js";
import type { CapabilityFlags, ThinkingLevel } from "./types/capability-flags.js";
import { VALID_THINKING_LEVELS } from "./types/capability-flags.js";
import type { ContextWindowSlots } from "./types/context-window-slots.js";
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
 * a route or model limit the target reported without resident instance state.
 * `descriptor-default` remains for historical snapshots.
 */
export type ContextWindowSource =
	| "catalog"
	| "probe"
	| "loaded"
	| "target-override"
	| "model-hint"
	| "descriptor-default"
	| "unknown";

export type ResolvedFieldKind = "serving-limit" | "model-maximum" | "default" | "request-choice" | "unknown";

/** A positive serving limit is distinct from a model's declared maximum. */
export interface ResolvedNumericField {
	value: number | null;
	source: ContextWindowSource;
	kind: ResolvedFieldKind;
	observedAt: string | null;
}

export interface ContextWindowDetails {
	/** Best static knowledge of the model's maximum; zero when none is known. */
	declaredContextWindow: number;
	modelMaximum: ResolvedNumericField;
	servingLimit: ResolvedNumericField;
	/** Raw probe result, when the target was probed. */
	probedContextWindow: number | null;
	/** Context the backend reports this model loaded at; only some runtimes report it. */
	loadedContextWindow: number | null;
	/** The serving limit for new snapshots; zero means unknown. */
	desiredContextWindow: number;
	/** What the target actually offers; zero means unknown. */
	effectiveContextWindow: number;
	/** Where `effectiveContextWindow` came from. */
	contextWindowSource: ContextWindowSource;
	/**
	 * Present when the probed window is a per-request share of the server's
	 * KV budget (llama.cpp `--ctx-size` over `--parallel` slots), so the
	 * operator surfaces can render `196,608 (786,432 / 4 slots)`.
	 */
	contextWindowSlots: ContextWindowSlots | null;
	/** Legacy diagnostic slot; no minimum size warning is emitted. */
	warning: string | null;
	/** Actionable guidance when the serving window is unknown. */
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
	maxOutputTokensField: ResolvedNumericField;
	/**
	 * Provenance of the `tools` decision when a live tool-call probe ran against
	 * this exact model. Absent when `tools` is a declared or default capability.
	 */
	toolsVerification?: ToolsVerification;
}

export interface ToolsVerification {
	source: "probe";
	status: "verified" | "failed";
	/** Epoch ms when the probe finished. */
	checkedAt: number;
	error?: string;
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
	contextWindowField: ResolvedNumericField;
	modelMaximumField: ResolvedNumericField;
	maxOutputTokensField: ResolvedNumericField;
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
	toolsVerification?: ToolsVerification;
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
		// Unknown is a normal state: no server or profile named a cap, so the configured request
		// budget applies and the server enforces its own. Info keeps it out of every start-up notice.
		diagnostics.push(
			diagnostic(
				"info",
				"output-budget-unknown",
				`target '${targetId}' does not report an output limit; the request budget applies and the server enforces its own`,
			),
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
		// A profile that lacks the requested rung and carries a higher one maps up to it (the
		// Qwopus route rejects `high` and serves `xhigh`). The operator cannot act on that, so it
		// stays info and out of start-up notices; a mapping down or to a switch still warns.
		const order: ReadonlyArray<ThinkingLevel> = VALID_THINKING_LEVELS;
		const mappedUp = order.indexOf(thinking.effectiveLevel) > order.indexOf(requested);
		diagnostics.push(
			diagnostic(
				mappedUp ? "info" : "warning",
				"thinking-coerced",
				`thinking ${requested} resolved to ${thinking.display} for ${resolved.runtimeId}/${resolved.modelId}` +
					(mappedUp ? `; the model profile supports ${thinking.supportedLevels.join(", ")}` : ""),
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

const CHAT_TEMPLATE_KWARGS_UNDELIVERABLE = "chat-template-kwargs-undeliverable";

/**
 * One warning when the family declares chat-template kwargs the runtime
 * cannot carry (#268). LM Studio ignores `chat_template_kwargs` for every
 * family measured, so a Nemotron 3.5 target on that runtime runs without the
 * `force_nonempty_content` its card asks for; the operator sees that once per
 * target and model rather than finding the key silently missing from the wire.
 */
function appendChatTemplateKwargsDiagnostics(
	diagnostics: RuntimeResolutionDiagnostic[],
	resolved: ResolvedModelRuntimeCapabilities,
): void {
	const undeliverable = resolved.request.undeliverableChatTemplateKwargs;
	if (!undeliverable || undeliverable.keys.length === 0) return;
	const keys = undeliverable.keys.join(", ");
	const declared = undeliverable.declaredUnsupported
		? "its family entry marks them unsupported there"
		: "its family entry does not say so";
	diagnostics.push(
		diagnostic(
			"warning",
			CHAT_TEMPLATE_KWARGS_UNDELIVERABLE,
			`chat-template kwargs ${keys} cannot reach ${resolved.runtimeId}, which ignores chat_template_kwargs; ${resolved.modelId} runs without them and ${declared}`,
		),
	);
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
	const modelProbe = probeCapabilitiesForModel(status, wireModelId);
	const probedContextWindow = modelProbe?.contextWindow ?? null;
	// Discovery's per-model loaded window, which the probe capabilities cannot
	// carry: `probeCapabilitiesForModel` answers for the target's default model
	// and reports a window without saying whether it is the one being served.
	const observedLoadedContextWindow = loadedContextWindowForModel(status, wireModelId);
	const loadedContextWindow = observedLoadedContextWindow;
	const contextWindowDetails = resolveContextWindowDetails(
		target,
		runtime,
		wireModelId,
		providers.knowledgeBase,
		probedContextWindow,
		loadedContextWindow,
		undefined,
		contextSlotsForModel(status, wireModelId),
		modelProbe?.contextWindow !== undefined ? (status.health?.lastCheckAt ?? null) : null,
		observedLoadedContextWindow !== null ? (status.health?.lastCheckAt ?? null) : null,
		status.discoveredModelStates?.[wireModelId]?.modelMaxContextLength ?? null,
		status.health?.lastCheckAt ?? null,
	);
	capabilities.contextWindow = contextWindowDetails.effectiveContextWindow;
	const maxOutputTokensField = resolveMaxOutputTokensField(
		target,
		runtime,
		wireModelId,
		providers.knowledgeBase,
		modelProbe?.maxTokens,
		status.health?.lastCheckAt ?? null,
	);
	capabilities.maxTokens = maxOutputTokensField.value ?? 0;
	if (contextWindowDetails.warning) {
		diagnostics.push(diagnostic("warning", "context-window-low", contextWindowDetails.warning));
	}
	if (contextWindowDetails.provenanceNotice) {
		// Keep the unknown state visible during execution: the server will be
		// the first authority to reject a request that exceeds its limit.
		diagnostics.push(diagnostic("warning", "context-window-unverified", contextWindowDetails.provenanceNotice));
	}
	// The server's report stands over an operator claim; say so where the resolved capabilities are shown.
	for (const flag of ignoredCapabilityRaises(modelProbe, target.capabilities)) {
		diagnostics.push(
			diagnostic(
				"info",
				"capability-override-ignored",
				`target '${targetId}' sets ${flag}: true, but the server reports ${flag} unsupported for '${wireModelId}'; the report stands`,
			),
		);
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
	appendChatTemplateKwargsDiagnostics(diagnostics, modelRuntime);
	const toolsVerification = toolsVerificationFor(status, wireModelId);
	if (toolsVerification?.status === "failed") {
		diagnostics.push(
			diagnostic(
				"warning",
				"tools-probe-failed",
				`target '${targetId}' model '${wireModelId}' failed the live tool-call probe: ${toolsVerification.error ?? "unknown error"}`,
			),
		);
	}

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
		maxOutputTokensField,
	};
	if (runtime.tier !== undefined) resolved.runtimeTier = runtime.tier;
	if (toolsVerification) resolved.toolsVerification = toolsVerification;
	return { ok: true, target: resolved, diagnostics };
}

/** The live tool-call probe's answer for this exact model, when one ran and was not skipped. */
function toolsVerificationFor(status: TargetStatus, wireModelId: string): ToolsVerification | null {
	const probe = status.toolProbe;
	if (!probe || probe.modelId !== wireModelId || probe.status === "skipped") return null;
	const out: ToolsVerification = { source: "probe", status: probe.status, checkedAt: probe.checkedAt };
	if (probe.error !== undefined) out.error = probe.error;
	return out;
}

function modelHintPatch(target: ResolvedRuntimeTarget, model: unknown): Partial<CapabilityFlags> {
	if (!model || typeof model !== "object") return {};
	const record = model as Record<string, unknown>;
	const patch: Partial<CapabilityFlags> = {};
	if (!target.modelReasoningAuthoritative && typeof record.reasoning === "boolean") patch.reasoning = record.reasoning;
	// No vision patch: a synthesized model's input list comes from the runtime defaults, catalog and
	// knowledge base without the live probe, so it can only discard what the resolution already knows.
	return patch;
}

function withoutStaleRuntimeDiagnostics(
	diagnostics: ReadonlyArray<RuntimeResolutionDiagnostic>,
	decisions: RuntimeCapabilityDecision,
): RuntimeResolutionDiagnostic[] {
	return diagnostics.filter((entry) => {
		if (entry.code.startsWith("thinking-")) return false;
		if (entry.code === CHAT_TEMPLATE_KWARGS_UNDELIVERABLE) return false;
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
	// Pi's cloud catalog is a labeled model maximum. A synthesized local model
	// repeats runtime defaults and cannot establish a serving window.
	const modelHintContextWindow =
		target.runtime.tier === "cloud" ? nonNegativeFiniteNumber(hintRecord?.contextWindow) : undefined;
	const modelHintMaxOutputTokens =
		target.runtime.tier === "cloud" ? positiveWindow(nonNegativeFiniteNumber(hintRecord?.maxTokens)) : undefined;
	const windowHintDiffers =
		modelHintContextWindow !== undefined &&
		modelHintContextWindow > 0 &&
		modelHintContextWindow !== target.contextWindowDetails.modelMaximum.value;
	const maxOutputHintFillsUnknown = target.maxOutputTokensField.value === null && modelHintMaxOutputTokens !== undefined;
	if (Object.keys(patch).length === 0 && !windowHintDiffers && !maxOutputHintFillsUnknown) return target;
	const capabilities: CapabilityFlags = { ...target.capabilities, ...patch };
	const maxOutputTokensField: ResolvedNumericField = maxOutputHintFillsUnknown
		? { value: modelHintMaxOutputTokens, source: "model-hint", kind: "model-maximum", observedAt: null }
		: target.maxOutputTokensField;
	capabilities.maxTokens = maxOutputTokensField.value ?? 0;
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
		target.contextWindowDetails.contextWindowSlots,
		target.contextWindowDetails.servingLimit.observedAt,
		target.contextWindowDetails.contextWindowSource === "loaded"
			? target.contextWindowDetails.servingLimit.observedAt
			: null,
		target.contextWindowDetails.modelMaximum.source === "probe" ? target.contextWindowDetails.modelMaximum.value : null,
		target.contextWindowDetails.modelMaximum.observedAt,
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
	appendChatTemplateKwargsDiagnostics(diagnostics, modelRuntime);
	return {
		...target,
		capabilities,
		capabilityDecisions: decisions,
		modelRuntime,
		effectiveThinkingLevel: modelRuntime.thinking.effectiveLevel,
		diagnostics,
		contextWindowDetails,
		maxOutputTokensField,
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
		contextWindowField: { ...target.contextWindowDetails.servingLimit },
		modelMaximumField: { ...target.contextWindowDetails.modelMaximum },
		maxOutputTokensField: { ...target.maxOutputTokensField },
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
	if (target.toolsVerification !== undefined) snapshot.toolsVerification = { ...target.toolsVerification };
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
 * The warnings a surface that prints its own thinking-clamp line should
 * announce. `thinking-coerced` and `thinking-<kind>` are the two halves of
 * that one line, so when the resolved thinking carries a notice they are
 * dropped here: an always-on model printed three lines saying one thing
 * (issue #191). With no notice, a bare coercion is still worth a line.
 */
export function runtimeResolutionWarningsBesideThinkingNotice(
	diagnostics: ReadonlyArray<RuntimeResolutionDiagnostic>,
	thinkingNotice: string,
): string[] {
	if (thinkingNotice.trim().length === 0) return runtimeResolutionWarnings(diagnostics);
	return runtimeResolutionWarnings(diagnostics.filter((entry) => !entry.code.startsWith("thinking-")));
}

function positiveWindow(value: number | null | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function resolveMaxOutputTokensField(
	target: TargetDescriptor,
	runtime: RuntimeDescriptor,
	modelId: string,
	knowledgeBase: KnowledgeBase | null,
	probedMaxTokens: number | undefined,
	observedAt: string | null,
): ResolvedNumericField {
	const live = positiveWindow(probedMaxTokens);
	const configured = positiveWindow(target.capabilities?.maxTokens);
	const modelMaximum =
		positiveWindow(knowledgeBase?.lookup(modelId, runtime.id)?.entry.modelMaxOutput) ??
		positiveWindow(getCatalogModelForRuntime(runtime.id, modelId)?.maxTokens);
	if (live !== undefined) {
		return configured !== undefined && configured < live
			? { value: configured, source: "target-override", kind: "request-choice", observedAt: null }
			: { value: live, source: "probe", kind: "serving-limit", observedAt };
	}
	if (configured !== undefined) {
		return { value: configured, source: "target-override", kind: "request-choice", observedAt: null };
	}
	if (modelMaximum !== undefined) {
		return { value: modelMaximum, source: "catalog", kind: "model-maximum", observedAt: null };
	}
	return { value: null, source: "unknown", kind: "unknown", observedAt: null };
}

/** Keep a declared model maximum apart from the window this route serves. */
export function resolveContextWindowDetails(
	target: TargetDescriptor,
	runtime: RuntimeDescriptor,
	wireModelId: string,
	knowledgeBase: KnowledgeBase | null,
	probedContextWindow: number | null,
	loadedContextWindow: number | null = null,
	modelHintContextWindow?: number,
	probedContextSlots: ContextWindowSlots | null = null,
	probeObservedAt: string | null = null,
	loadedObservedAt: string | null = null,
	reportedModelMaximum: number | null = null,
	modelMaximumObservedAt: string | null = null,
): ContextWindowDetails {
	const catalogModel = getCatalogModelForRuntime(runtime.id, wireModelId);
	const kbHit = knowledgeBase?.lookup(wireModelId, runtime.id) ?? null;

	// Model-specific knowledge, most live first. A profile's ceiling and Pi's catalog
	// row are declared maxima, so neither becomes the window this route serves.
	let modelDeclared: number | undefined;
	let modelDeclaredSource: ContextWindowDetails["contextWindowSource"] = "unknown";
	const hintWindow = positiveWindow(modelHintContextWindow);
	const reportedMaximum = positiveWindow(reportedModelMaximum);
	const kbWindow = positiveWindow(kbHit?.entry.modelMaxContext);
	const catalogWindow = positiveWindow(catalogModel?.contextWindow);
	if (reportedMaximum !== undefined) {
		modelDeclared = reportedMaximum;
		modelDeclaredSource = "probe";
	} else if (hintWindow !== undefined) {
		modelDeclared = hintWindow;
		modelDeclaredSource = "model-hint";
	} else if (kbWindow !== undefined) {
		modelDeclared = kbWindow;
		modelDeclaredSource = "catalog";
	} else if (catalogWindow !== undefined) {
		modelDeclared = catalogWindow;
		modelDeclaredSource = "catalog";
	}

	const declaredContextWindow = modelDeclared ?? 0;
	const modelMaximum: ResolvedNumericField = {
		value: modelDeclared ?? null,
		source: modelDeclaredSource,
		kind: modelDeclared === undefined ? "unknown" : "model-maximum",
		observedAt: modelDeclaredSource === "probe" ? modelMaximumObservedAt : null,
	};

	const loadedWindow = positiveWindow(loadedContextWindow);
	const probeWindow = positiveWindow(probedContextWindow);
	const overrideWindow = positiveWindow(target.capabilities?.contextWindow);
	const requestedWindow = positiveWindow(runtime.requestedContextWindow?.(target));
	// Only a model maximum is capped here. A loaded window, an override, and a
	// requested window each name what the server serves, and none of them is cold.
	const coldCap = (maximum: number): number =>
		Math.min(maximum, positiveWindow(runtime.coldContextWindowCap) ?? maximum);
	let effective = 0;
	let source: ContextWindowSource = "unknown";
	let kind: ResolvedFieldKind = "unknown";
	if (requestedWindow !== undefined) {
		// The window every request asks for (Ollama `num_ctx`) is the one the
		// server will reload the model at, so a smaller loaded window is about to
		// stop being true. A smaller override or model maximum still caps it.
		effective = Math.min(requestedWindow, overrideWindow ?? requestedWindow, probeWindow ?? requestedWindow);
		source = probeWindow === effective && effective < requestedWindow ? "probe" : "target-override";
		kind = source === "probe" ? "serving-limit" : "request-choice";
	} else if (loadedWindow !== undefined && (overrideWindow === undefined || loadedWindow <= overrideWindow)) {
		effective = loadedWindow;
		source = "loaded";
		kind = "serving-limit";
	} else if (overrideWindow !== undefined) {
		// A declaration cannot enlarge an observed server limit, including a
		// conservative limit retained after resident-state discovery failed.
		effective = Math.min(overrideWindow, probeWindow ?? overrideWindow);
		source = probeWindow !== undefined && probeWindow < overrideWindow ? "probe" : "target-override";
		kind = source === "probe" ? "serving-limit" : "request-choice";
	} else if (probeWindow !== undefined) {
		effective = coldCap(probeWindow);
		// Not "loaded": a probed window is what the target reported for the
		// model, and only a runtime that names its resident instance's window
		// has said anything about what is serving right now.
		source = "probe";
		kind = "serving-limit";
	} else if (
		runtime.tier === "cloud" &&
		typeof runtime.probeServingWindows !== "function" &&
		modelDeclared !== undefined
	) {
		// A hosted provider with no window endpoint keeps working through Pi's catalog row,
		// labeled an estimate so it is never read as a server report. A provider that does
		// have a window read stays unknown until it answers, and a local route never gets here.
		effective = modelDeclared;
		source = "catalog";
		kind = "default";
	}

	// One-run CLI override (clio-coder run --max-context-tokens), delivered over the
	// run-overrides transport; see core/run-overrides.ts.
	const targetContextWindow = effective;
	const overrideMaxContextTokens = runOverrides().maxContextTokens;
	if (overrideMaxContextTokens !== undefined && (effective === 0 || overrideMaxContextTokens < effective)) {
		effective = overrideMaxContextTokens;
		source = "target-override";
		kind = "request-choice";
	}
	const warning: string | null = null;
	const provenanceNotice =
		effective === 0
			? "Serving context window is unknown. Probe the target or configure its deployment limit; threshold compaction is disabled until a limit is known."
			: null;
	const servingLimit: ResolvedNumericField = {
		value: effective > 0 ? effective : null,
		source,
		kind,
		observedAt: source === "probe" ? probeObservedAt : source === "loaded" ? loadedObservedAt : null,
	};

	// The split explains the probed number and nothing else: once an override
	// or a loaded window decides the figure, `786,432 / 4 slots` no longer
	// describes it.
	const contextWindowSlots =
		source === "probe" &&
		probedContextSlots !== null &&
		Math.floor(probedContextSlots.totalContextSize / probedContextSlots.slots) === effective
			? probedContextSlots
			: null;

	return {
		declaredContextWindow,
		modelMaximum,
		servingLimit,
		probedContextWindow,
		loadedContextWindow: loadedWindow ?? null,
		desiredContextWindow: targetContextWindow,
		effectiveContextWindow: effective,
		contextWindowSource: source,
		contextWindowSlots,
		warning,
		provenanceNotice,
	};
}
