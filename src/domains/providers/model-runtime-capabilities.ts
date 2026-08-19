import type { Api, Model } from "../../engine/types.js";
import { getCatalogModelForRuntime } from "./catalog.js";
import type { ProvidersContract, TargetStatus } from "./contract.js";
import { resolveModelCapabilities } from "./model-capabilities.js";
import { inferLocalModelFamily, isHarmonyModelId } from "./model-family.js";
import {
	defaultAnthropicBudgetForLevel,
	defaultAnthropicEffortForLevel,
	type ThinkingEffortByLevel,
	thinkingBudgetFromMap,
	thinkingEffortFromMap,
} from "./thinking-control-policy.js";
import {
	availableThinkingLevels,
	type CapabilityFlags,
	type ThinkingLevel,
	VALID_THINKING_LEVELS,
} from "./types/capability-flags.js";
import type { KnowledgeBase, KnowledgeBaseHit } from "./types/knowledge-base.js";
import {
	extractLocalModelQuirks,
	type LocalModelQuirks,
	type ThinkingMechanism,
	type ThinkingQuirks,
} from "./types/local-model-quirks.js";
import type { RuntimeApiFamily, RuntimeDescriptor } from "./types/runtime-descriptor.js";
import type { TargetDescriptor } from "./types/target-descriptor.js";

export type AppliedThinkingNoticeKind = "applied" | "ignored-on-off" | "always-on" | "unsupported";
export type ThinkingBudgetEnforcement = "enforced" | "informational" | "none";
export type ResponseParserKind = "none" | "harmony";

export interface AppliedThinking {
	thinkingActive: boolean;
	mechanism: ThinkingMechanism;
	effort?: string;
	budgetTokens?: number;
	chatTemplateKwargs?: Record<string, boolean>;
	noticeKind: AppliedThinkingNoticeKind;
	notice: string;
}

export interface ResolvedThinkingCapability extends AppliedThinking {
	configuredLevel: ThinkingLevel;
	effectiveLevel: ThinkingLevel;
	supportedLevels: ReadonlyArray<ThinkingLevel>;
	display: string;
	budgetEnforcement: ThinkingBudgetEnforcement;
}

export interface ResolvedRequestCapability {
	reasoningEffort?: string;
	budgetTokens?: number;
	budgetEnforcement: ThinkingBudgetEnforcement;
	chatTemplateKwargs?: Record<string, boolean | string>;
}

export interface ResolvedResponseCapability {
	parser: ResponseParserKind;
	stripTokenizerSentinels: boolean;
}

export interface ResolvedModelRuntimeCapabilities {
	targetId: string | null;
	runtimeId: string;
	apiFamily: RuntimeApiFamily | string | null;
	modelId: string;
	family: string;
	capabilities: CapabilityFlags;
	quirks?: LocalModelQuirks;
	thinking: ResolvedThinkingCapability;
	request: ResolvedRequestCapability;
	response: ResolvedResponseCapability;
}

export interface ResolveRuntimeCapabilitiesInput {
	targetId?: string | null;
	runtimeId: string;
	apiFamily?: RuntimeApiFamily | string | null;
	modelId: string;
	capabilities: CapabilityFlags;
	kbHit?: KnowledgeBaseHit | null;
	quirks?: LocalModelQuirks;
	configuredThinkingLevel?: ThinkingLevel;
	adaptiveThinking?: boolean;
	thinkingLevelMap?: ThinkingEffortByLevel;
}

interface CapabilityHints {
	reasoning?: boolean;
	thinkingFormat?: string;
	maxTokens?: number | undefined;
	adaptiveThinking?: boolean | undefined;
	thinkingLevelMap?: ThinkingEffortByLevel | undefined;
}

function capabilityHints(input: {
	reasoning: boolean | undefined;
	thinkingFormat: string | undefined;
	maxTokens?: number | undefined;
	adaptiveThinking?: boolean | undefined;
	thinkingLevelMap?: ThinkingEffortByLevel | undefined;
}): CapabilityHints {
	const hints: CapabilityHints = {};
	if (input.reasoning !== undefined) hints.reasoning = input.reasoning;
	if (input.thinkingFormat !== undefined) hints.thinkingFormat = input.thinkingFormat;
	if (input.maxTokens !== undefined) hints.maxTokens = input.maxTokens;
	if (input.adaptiveThinking !== undefined) hints.adaptiveThinking = input.adaptiveThinking;
	if (input.thinkingLevelMap !== undefined) hints.thinkingLevelMap = input.thinkingLevelMap;
	return hints;
}

interface ClioRuntimeMetadata {
	clio?: {
		targetId?: string;
		runtimeId?: string;
		lifecycle?: "user-managed" | "clio-managed";
		gateway?: boolean;
		family?: string;
		quirks?: LocalModelQuirks;
	};
	compat?: {
		thinkingFormat?: string;
		forceAdaptiveThinking?: boolean;
	};
}

const LEVELS_ON_OFF: ReadonlyArray<ThinkingLevel> = ["off", "low"];
const LEVELS_ALWAYS_ON: ReadonlyArray<ThinkingLevel> = ["high"];
const LEVELS_NONE: ReadonlyArray<ThinkingLevel> = ["off"];
/** Ascending intensity. VALID_THINKING_LEVELS is already declared in that order. */
const LEVEL_ORDER: ReadonlyArray<ThinkingLevel> = VALID_THINKING_LEVELS;
const HARMONY_LEVELS: ReadonlyArray<ThinkingLevel> = ["low", "medium", "high"];

function effortFor(
	quirks: ThinkingQuirks | undefined,
	level: ThinkingLevel,
	caps?: CapabilityHints,
): string | undefined {
	const explicit = thinkingEffortFromMap(quirks?.effortByLevel, level);
	if (explicit !== undefined) return explicit;
	if (quirks?.effortByLevel) return undefined;
	if (caps?.thinkingFormat === "anthropic-extended" && caps.adaptiveThinking === true) {
		return defaultAnthropicEffortForLevel(level, caps.thinkingLevelMap);
	}
	return undefined;
}

function budgetFor(
	quirks: ThinkingQuirks | undefined,
	level: ThinkingLevel,
	caps?: CapabilityHints,
): number | undefined {
	if (quirks?.budgetByLevel) return thinkingBudgetFromMap(quirks.budgetByLevel, level);
	if (caps?.thinkingFormat === "anthropic-extended" && caps.adaptiveThinking !== true) {
		return defaultAnthropicBudgetForLevel(level, caps.maxTokens);
	}
	return undefined;
}

export function isHarmonyThinkingFormat(format: string | null | undefined): boolean {
	return format === "harmony";
}

export type HarmonyReasoningEffort = "low" | "medium" | "high";

export function harmonyReasoningEffort(level: string | undefined): HarmonyReasoningEffort {
	if (level === "high" || level === "xhigh") return "high";
	if (level === "medium") return "medium";
	return "low";
}

/**
 * Reasoning class of a model, derived from its thinking mechanism. Catalog
 * data (quirks.thinking.mechanism plus capabilities.reasoning) is the single
 * source: "never" must not emit thinking at any dial, "always" cannot be
 * silenced, "switchable" follows the dial through a wire/template control.
 */
export type ReasoningClass = "never" | "switchable" | "always";

export function reasoningClassForMechanism(mechanism: ThinkingMechanism | null | undefined): ReasoningClass {
	if (mechanism === "none") return "never";
	if (mechanism === "always-on") return "always";
	return "switchable";
}

export function inferThinkingMechanism(
	quirks: LocalModelQuirks | undefined,
	caps: CapabilityHints | undefined,
): ThinkingMechanism {
	if (quirks?.thinking?.mechanism) return quirks.thinking.mechanism;
	if (!caps?.reasoning) return "none";
	switch (caps.thinkingFormat) {
		case "anthropic-extended":
			return caps.adaptiveThinking === true ? "effort-levels" : "budget-tokens";
		case "openai-codex":
		case "harmony":
			return "effort-levels";
		default:
			return "on-off";
	}
}

export function applyThinkingMechanism(
	quirks: LocalModelQuirks | undefined,
	level: ThinkingLevel,
	caps?: CapabilityHints,
): AppliedThinking {
	const mechanism = inferThinkingMechanism(quirks, caps);
	const requestedActive = level !== "off";

	switch (mechanism) {
		case "none":
			return {
				thinkingActive: false,
				mechanism,
				noticeKind: requestedActive ? "unsupported" : "applied",
				notice: requestedActive ? "model does not support thinking; level ignored" : "",
			};
		case "always-on":
			return {
				thinkingActive: true,
				mechanism,
				noticeKind: level === "off" ? "always-on" : "applied",
				notice: level === "off" ? "model emits chain-of-thought unconditionally; off was ignored" : "",
			};
		case "on-off": {
			const result: AppliedThinking = {
				thinkingActive: requestedActive,
				mechanism,
				chatTemplateKwargs: { enable_thinking: requestedActive },
				noticeKind: "applied",
				notice: "",
			};
			if (requestedActive && level !== "low") {
				result.noticeKind = "ignored-on-off";
				result.notice = "model has on/off thinking; level coerced to on";
			}
			return result;
		}
		case "effort-levels": {
			const effort = effortFor(quirks?.thinking, level, caps);
			const result: AppliedThinking = {
				thinkingActive: requestedActive,
				mechanism,
				noticeKind: "applied",
				notice: "",
			};
			// An off-effort is carried too. Suppressing a model that reasons by
			// default is an instruction that has to reach the wire; omitting the
			// field only works for models whose default is already silence.
			if (effort) result.effort = effort;
			return result;
		}
		case "budget-tokens": {
			const budget = budgetFor(quirks?.thinking, level, caps);
			const result: AppliedThinking = {
				thinkingActive: requestedActive,
				mechanism,
				noticeKind: "applied",
				notice: "",
			};
			if (requestedActive && budget !== undefined) result.budgetTokens = budget;
			return result;
		}
	}
}

function sortedThinkingLevels(levels: Iterable<ThinkingLevel>): ThinkingLevel[] {
	const set = new Set(levels);
	return LEVEL_ORDER.filter((level) => set.has(level));
}

function supportedBudgetLevels(
	baseLevels: ReadonlyArray<ThinkingLevel>,
	quirks: LocalModelQuirks | undefined,
): ReadonlyArray<ThinkingLevel> {
	const budgets = quirks?.thinking?.budgetByLevel;
	if (!budgets) return baseLevels;
	const out: ThinkingLevel[] = ["off"];
	if (budgets.minimal !== undefined) out.push("minimal");
	if (budgets.low !== undefined) out.push("low");
	if (budgets.medium !== undefined) out.push("medium");
	if (budgets.high !== undefined) out.push("high");
	if (budgets.xhigh !== undefined) out.push("xhigh");
	return out;
}

function supportedEffortLevels(
	baseLevels: ReadonlyArray<ThinkingLevel>,
	quirks: LocalModelQuirks | undefined,
	harmony: boolean,
): ReadonlyArray<ThinkingLevel> {
	if (harmony) return HARMONY_LEVELS;
	const efforts = quirks?.thinking?.effortByLevel;
	if (!efforts) return baseLevels;
	const out: ThinkingLevel[] = [];
	if (baseLevels.includes("off")) out.push("off");
	if (efforts.minimal !== undefined) out.push("minimal");
	if (efforts.low !== undefined) out.push("low");
	if (efforts.medium !== undefined) out.push("medium");
	if (efforts.high !== undefined) out.push("high");
	if (efforts.xhigh !== undefined) out.push("xhigh");
	return out.length > 0 ? out : baseLevels;
}

export function restrictThinkingLevelsByMechanism(
	levels: ReadonlyArray<ThinkingLevel>,
	mechanism: ThinkingMechanism | null,
	quirks?: LocalModelQuirks,
	options?: { harmony?: boolean },
): ReadonlyArray<ThinkingLevel> {
	if (mechanism === "none") return LEVELS_NONE;
	if (mechanism === "always-on") return LEVELS_ALWAYS_ON;
	if (mechanism === "on-off") return LEVELS_ON_OFF;
	if (mechanism === "budget-tokens") return supportedBudgetLevels(levels, quirks);
	if (mechanism === "effort-levels") return supportedEffortLevels(levels, quirks, options?.harmony === true);
	return levels;
}

export function effectiveThinkingLevel(
	configured: ThinkingLevel | undefined,
	available: ReadonlyArray<ThinkingLevel>,
): ThinkingLevel {
	const fallback = available[0] ?? "off";
	if (!configured) return fallback;
	if (available.includes(configured)) return configured;
	// Catalog effort maps intentionally stop at xhigh; `max` must clamp to that
	// supported ceiling instead of falling through to the generic low fallback.
	if (configured === "max" && available.includes("xhigh")) return "xhigh";
	if ((configured === "high" || configured === "xhigh" || configured === "max") && available.includes("high")) {
		return "high";
	}
	if (configured === "medium" && available.includes("medium")) return "medium";
	if (configured !== "off" && available.includes("low")) return "low";
	if (configured === "off" && !available.includes("off") && available.includes("low")) return "low";
	return fallback;
}

export function thinkingLevelDisplayWord(mechanism: ThinkingMechanism | null, level: ThinkingLevel): string {
	if (mechanism === "none") return "off";
	if (mechanism === "always-on") return "forced";
	if (mechanism === "on-off") return level === "off" ? "off" : "on";
	return level;
}

export function thinkingLevelChoiceLabel(mechanism: ThinkingMechanism | null, level: ThinkingLevel): string {
	return thinkingLevelDisplayWord(mechanism, level);
}

export function thinkingLevelFromChoiceLabel(value: string): ThinkingLevel | null {
	if (value === "on") return "low";
	if (value === "forced") return "high";
	if (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	) {
		return value;
	}
	return null;
}

function acceptsBudgetTokensField(input: Pick<ResolveRuntimeCapabilitiesInput, "apiFamily" | "capabilities">): boolean {
	const format = input.capabilities.thinkingFormat;
	if (format === "anthropic-extended") {
		return (
			input.apiFamily === "anthropic-messages" ||
			input.apiFamily === "bedrock-converse-stream" ||
			input.apiFamily === "claude-agent-sdk"
		);
	}
	if (input.apiFamily !== "openai-completions") return false;
	return format === "openrouter" || format === "zai";
}

function resolveBudgetEnforcement(
	mechanism: ThinkingMechanism,
	input: Pick<ResolveRuntimeCapabilitiesInput, "apiFamily" | "capabilities">,
): ThinkingBudgetEnforcement {
	if (mechanism !== "budget-tokens") return "none";
	return acceptsBudgetTokensField(input) ? "enforced" : "informational";
}

function appendNotice(base: AppliedThinking, notice: string, kind: AppliedThinkingNoticeKind): AppliedThinking {
	if (notice.length === 0) return base;
	return {
		...base,
		noticeKind: base.notice.length > 0 ? base.noticeKind : kind,
		notice: base.notice.length > 0 ? `${base.notice}; ${notice}` : notice,
	};
}

function resolveResponseParser(input: ResolveRuntimeCapabilitiesInput, family: string): ResponseParserKind {
	if (input.capabilities.thinkingFormat === "harmony") return "harmony";
	if (family === "openai-gpt-oss") return "harmony";
	if (isHarmonyModelId(input.modelId)) return "harmony";
	return "none";
}

function capabilityFamily(input: ResolveRuntimeCapabilitiesInput): string {
	return input.kbHit?.entry.family ?? inferLocalModelFamily(input.modelId);
}

function resolveQuirks(input: ResolveRuntimeCapabilitiesInput): LocalModelQuirks | undefined {
	return input.quirks ?? extractLocalModelQuirks(input.kbHit?.entry.quirks);
}

function resolveThinkingCapability(
	input: ResolveRuntimeCapabilitiesInput,
	quirks: LocalModelQuirks | undefined,
	parser: ResponseParserKind,
): ResolvedThinkingCapability {
	const configuredLevel = input.configuredThinkingLevel ?? "off";
	const harmony = parser === "harmony";
	const thinkingFormat = harmony ? "harmony" : input.capabilities.thinkingFormat;
	const hints = capabilityHints({
		reasoning: input.capabilities.reasoning,
		thinkingFormat,
		maxTokens: input.capabilities.maxTokens,
		adaptiveThinking: input.adaptiveThinking,
		thinkingLevelMap: input.thinkingLevelMap,
	});
	const mechanism = inferThinkingMechanism(quirks, hints);
	const baseLevels = availableThinkingLevels(input.capabilities, {
		runtimeId: input.runtimeId,
		modelId: input.modelId,
	});
	const supportedLevels = restrictThinkingLevelsByMechanism(baseLevels, mechanism, quirks, { harmony });
	const effectiveLevel = effectiveThinkingLevel(configuredLevel, supportedLevels);
	let applied = applyThinkingMechanism(quirks, effectiveLevel, hints);

	if (harmony) {
		const effort = harmonyReasoningEffort(effectiveLevel);
		applied = {
			...applied,
			thinkingActive: true,
			mechanism: "effort-levels",
			effort,
		};
		if (configuredLevel !== effectiveLevel) {
			applied = appendNotice(
				applied,
				`Harmony models support low/medium/high reasoning only; ${configuredLevel} was coerced to ${effectiveLevel}`,
				"applied",
			);
		}
	} else if (mechanism === "on-off" && configuredLevel !== effectiveLevel) {
		applied = appendNotice(
			applied,
			`model has on/off thinking; ${configuredLevel} was coerced to ${thinkingLevelDisplayWord(mechanism, effectiveLevel)}`,
			"ignored-on-off",
		);
	} else if (mechanism === "always-on" && configuredLevel !== effectiveLevel) {
		applied = appendNotice(applied, `${configuredLevel} was ignored because thinking is always on`, "always-on");
	} else if (mechanism === "none" && configuredLevel !== effectiveLevel) {
		applied = appendNotice(applied, `${configuredLevel} was ignored because thinking is unsupported`, "unsupported");
	}

	const budgetEnforcement = resolveBudgetEnforcement(mechanism, input);
	if (applied.thinkingActive && mechanism === "budget-tokens" && budgetEnforcement === "informational") {
		applied = appendNotice(
			applied,
			"target does not expose an enforceable per-request thinking budget; level is advisory",
			"applied",
		);
	}

	return {
		...applied,
		configuredLevel,
		effectiveLevel,
		supportedLevels,
		display: thinkingLevelDisplayWord(applied.mechanism, effectiveLevel),
		budgetEnforcement,
	};
}

/**
 * Runtimes whose OpenAI-compatible surface reads the on-off thinking control
 * from `reasoning_effort` rather than `chat_template_kwargs.enable_thinking`.
 * Measured against the live fleet on 2026-08-11 with
 * `nvidia-nemotron-3.5-lightning-30b-a3b`: LM Studio suppressed reasoning
 * entirely for `reasoning_effort: "none"` and ignored `enable_thinking: false`,
 * while llama.cpp did the reverse. Sending the wrong spelling reads as "no
 * preference" to the server, so the model keeps reasoning at every dial.
 */
const REASONING_EFFORT_ON_OFF_RUNTIMES: ReadonlySet<string> = new Set(["lmstudio"]);

/** `none` is LM Studio's documented off value; on-off models have no finer dial than `low`. */
function onOffReasoningEffort(thinkingActive: boolean): string {
	return thinkingActive ? "low" : "none";
}

function resolveRequestCapability(
	thinking: ResolvedThinkingCapability,
	parser: ResponseParserKind,
	runtimeId: string,
): ResolvedRequestCapability {
	const request: ResolvedRequestCapability = { budgetEnforcement: thinking.budgetEnforcement };
	if (thinking.mechanism === "effort-levels" && thinking.effort) {
		request.reasoningEffort = thinking.effort;
	}
	if (thinking.mechanism === "effort-levels" && !thinking.thinkingActive) {
		request.chatTemplateKwargs = { ...(request.chatTemplateKwargs ?? {}), enable_thinking: false };
	}
	if (thinking.mechanism === "budget-tokens" && thinking.budgetTokens !== undefined) {
		request.budgetTokens = thinking.budgetTokens;
	}
	if (thinking.mechanism === "on-off" && thinking.chatTemplateKwargs) {
		request.chatTemplateKwargs = { ...thinking.chatTemplateKwargs };
		if (REASONING_EFFORT_ON_OFF_RUNTIMES.has(runtimeId)) {
			request.reasoningEffort = onOffReasoningEffort(thinking.thinkingActive);
		}
	}
	if (parser === "harmony" && thinking.effort) {
		request.reasoningEffort = thinking.effort;
		request.chatTemplateKwargs = { ...(request.chatTemplateKwargs ?? {}), reasoning_effort: thinking.effort };
	}
	return request;
}

export function resolveModelRuntimeCapabilities(
	input: ResolveRuntimeCapabilitiesInput,
): ResolvedModelRuntimeCapabilities {
	const family = capabilityFamily(input);
	const quirks = resolveQuirks(input);
	const parser = resolveResponseParser(input, family);
	const thinking = resolveThinkingCapability(input, quirks, parser);
	const result: ResolvedModelRuntimeCapabilities = {
		targetId: input.targetId ?? null,
		runtimeId: input.runtimeId,
		apiFamily: input.apiFamily ?? null,
		modelId: input.modelId,
		family,
		capabilities: input.capabilities,
		thinking,
		request: resolveRequestCapability(thinking, parser, input.runtimeId),
		response: {
			parser,
			stripTokenizerSentinels: true,
		},
	};
	if (quirks) result.quirks = quirks;
	return result;
}

export function resolveModelRuntimeCapabilitiesForStatus(
	status: Pick<TargetStatus, "target" | "runtime" | "capabilities" | "probeCapabilities" | "probeModelId">,
	wireModelId: string | null | undefined,
	knowledgeBase: KnowledgeBase | null,
	options?: { detectedReasoning?: boolean | null; configuredThinkingLevel?: ThinkingLevel },
): ResolvedModelRuntimeCapabilities {
	const modelId = wireModelId?.trim() || status.target.defaultModel?.trim() || "";
	const kbHit = modelId ? (knowledgeBase?.lookup(modelId) ?? null) : null;
	const capabilities = resolveModelCapabilities(status, modelId, knowledgeBase, {
		detectedReasoning: options?.detectedReasoning ?? null,
	});
	const runtimeId = status.runtime?.id ?? status.target.runtime;
	return resolveModelRuntimeCapabilities({
		targetId: status.target.id,
		runtimeId,
		apiFamily: status.runtime?.apiFamily ?? null,
		modelId,
		capabilities,
		kbHit,
		...thinkingHintsForCatalogModel(runtimeId, modelId),
		...(options?.configuredThinkingLevel ? { configuredThinkingLevel: options.configuredThinkingLevel } : {}),
	});
}

export function resolveModelRuntimeCapabilitiesForProviders(
	providers: ProvidersContract,
	targetId: string | null | undefined,
	wireModelId: string | null | undefined,
	configuredThinkingLevel?: ThinkingLevel,
): ResolvedModelRuntimeCapabilities | null {
	const id = targetId?.trim();
	if (!id) return null;
	const status = providers.list().find((entry) => entry.target.id === id);
	if (!status) return null;
	const modelId = wireModelId?.trim() || status.target.defaultModel?.trim() || "";
	const detectedReasoning =
		modelId && typeof providers.getDetectedReasoning === "function" ? providers.getDetectedReasoning(id, modelId) : null;
	return resolveModelRuntimeCapabilitiesForStatus(status, modelId, providers.knowledgeBase, {
		detectedReasoning,
		...(configuredThinkingLevel ? { configuredThinkingLevel } : {}),
	});
}

function thinkingHintsForModel(
	model: Model<Api> | undefined,
): Pick<ResolveRuntimeCapabilitiesInput, "adaptiveThinking" | "thinkingLevelMap"> {
	const out: Pick<ResolveRuntimeCapabilitiesInput, "adaptiveThinking" | "thinkingLevelMap"> = {};
	if (!model) return out;
	const compat = model.compat as { forceAdaptiveThinking?: boolean } | undefined;
	if (compat?.forceAdaptiveThinking !== undefined) out.adaptiveThinking = compat.forceAdaptiveThinking;
	if (model.thinkingLevelMap) out.thinkingLevelMap = model.thinkingLevelMap as ThinkingEffortByLevel;
	return out;
}

function thinkingHintsForCatalogModel(
	runtimeId: string | null | undefined,
	modelId: string,
): Pick<ResolveRuntimeCapabilitiesInput, "adaptiveThinking" | "thinkingLevelMap"> {
	if (!runtimeId || modelId.length === 0) return {};
	return thinkingHintsForModel(getCatalogModelForRuntime(runtimeId, modelId));
}

function thinkingFormatFromModelApi(api: Api): CapabilityFlags["thinkingFormat"] | undefined {
	switch (api) {
		case "anthropic-messages":
		case "bedrock-converse-stream":
		case "claude-agent-sdk":
		case "claude-code-subprocess":
			return "anthropic-extended";
		case "openai-codex-responses":
			return "openai-codex";
		default:
			return undefined;
	}
}

function capabilitiesFromModel(model: Model<Api> & ClioRuntimeMetadata): CapabilityFlags {
	const format = model.compat?.thinkingFormat ?? thinkingFormatFromModelApi(model.api);
	const caps: CapabilityFlags = {
		chat: true,
		tools: true,
		reasoning: model.reasoning === true,
		vision: Array.isArray(model.input) && model.input.includes("image"),
		audio: false,
		embeddings: false,
		rerank: false,
		fim: false,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
	if (
		format === "qwen-chat-template" ||
		format === "openrouter" ||
		format === "zai" ||
		format === "anthropic-extended" ||
		format === "deepseek-r1" ||
		format === "openai-codex" ||
		format === "harmony"
	) {
		caps.thinkingFormat = format;
	}
	return caps;
}

export function resolveModelRuntimeCapabilitiesForModel<TApi extends Api>(
	model: Model<TApi>,
	configuredThinkingLevel?: ThinkingLevel,
): ResolvedModelRuntimeCapabilities {
	const metadata = (model as Model<TApi> & ClioRuntimeMetadata).clio;
	const caps = capabilitiesFromModel(model as Model<Api> & ClioRuntimeMetadata);
	return resolveModelRuntimeCapabilities({
		targetId: metadata?.targetId ?? null,
		runtimeId: metadata?.runtimeId ?? model.provider,
		apiFamily: model.api,
		modelId: model.id,
		capabilities: caps,
		...thinkingHintsForModel(model),
		...(metadata?.quirks ? { quirks: metadata.quirks } : {}),
		kbHit: metadata?.family
			? {
					matchKind: "family",
					entry: {
						family: metadata.family,
						matchPatterns: [metadata.family],
						capabilities: {},
					},
				}
			: null,
		...(configuredThinkingLevel ? { configuredThinkingLevel } : {}),
	});
}

export function coerceThinkingLevelForRuntime(
	input: ResolveRuntimeCapabilitiesInput,
	requested: ThinkingLevel | undefined,
): ThinkingLevel {
	return resolveModelRuntimeCapabilities({
		...input,
		configuredThinkingLevel: requested ?? input.configuredThinkingLevel ?? "off",
	}).thinking.effectiveLevel;
}

export function resolveTargetRuntimeCapabilities(
	target: TargetDescriptor,
	runtime: RuntimeDescriptor,
	wireModelId: string,
	capabilities: CapabilityFlags,
	knowledgeBase: KnowledgeBase | null,
	configuredThinkingLevel?: ThinkingLevel,
): ResolvedModelRuntimeCapabilities {
	const kbHit = knowledgeBase?.lookup(wireModelId) ?? null;
	return resolveModelRuntimeCapabilities({
		targetId: target.id,
		runtimeId: runtime.id,
		apiFamily: runtime.apiFamily,
		modelId: wireModelId,
		capabilities,
		kbHit,
		...thinkingHintsForCatalogModel(runtime.id, wireModelId),
		...(configuredThinkingLevel ? { configuredThinkingLevel } : {}),
	});
}

export function supportedThinkingLevelLabels(resolved: ResolvedModelRuntimeCapabilities): ReadonlyArray<string> {
	return resolved.thinking.supportedLevels.map((level) => thinkingLevelChoiceLabel(resolved.thinking.mechanism, level));
}

export function sortedSupportedThinkingLevels(levels: Iterable<ThinkingLevel>): ReadonlyArray<ThinkingLevel> {
	return sortedThinkingLevels(levels);
}
