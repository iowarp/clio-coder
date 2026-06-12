import type { Api, Model } from "@earendil-works/pi-ai";
import type { EndpointStatus, ProvidersContract } from "./contract.js";
import { resolveModelCapabilities } from "./model-capabilities.js";
import { inferLocalModelFamily, isHarmonyModelId } from "./model-family.js";
import { availableThinkingLevels, type CapabilityFlags, type ThinkingLevel } from "./types/capability-flags.js";
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
}

interface CapabilityHints {
	reasoning?: boolean;
	thinkingFormat?: string;
}

function capabilityHints(reasoning: boolean | undefined, thinkingFormat: string | undefined): CapabilityHints {
	const hints: CapabilityHints = {};
	if (reasoning !== undefined) hints.reasoning = reasoning;
	if (thinkingFormat !== undefined) hints.thinkingFormat = thinkingFormat;
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
	};
}

const LEVELS_ON_OFF: ReadonlyArray<ThinkingLevel> = ["off", "low"];
const LEVELS_ALWAYS_ON: ReadonlyArray<ThinkingLevel> = ["high"];
const LEVELS_NONE: ReadonlyArray<ThinkingLevel> = ["off"];
const LEVEL_ORDER: ReadonlyArray<ThinkingLevel> = ["off", "minimal", "low", "medium", "high", "xhigh"];
const HARMONY_LEVELS: ReadonlyArray<ThinkingLevel> = ["low", "medium", "high"];

function isLow(level: ThinkingLevel): level is "low" {
	return level === "low";
}

function isMedium(level: ThinkingLevel): level is "medium" {
	return level === "medium";
}

function isHigh(level: ThinkingLevel): level is "high" | "xhigh" {
	return level === "high" || level === "xhigh";
}

function effortFor(quirks: ThinkingQuirks, level: ThinkingLevel): string | undefined {
	if (isLow(level)) return quirks.effortByLevel?.low;
	if (isMedium(level)) return quirks.effortByLevel?.medium;
	if (isHigh(level)) return quirks.effortByLevel?.high;
	if (level === "minimal") return quirks.effortByLevel?.low;
	return undefined;
}

function budgetFor(quirks: ThinkingQuirks, level: ThinkingLevel): number | undefined {
	if (isLow(level) || level === "minimal") return quirks.budgetByLevel?.low;
	if (isMedium(level)) return quirks.budgetByLevel?.medium;
	if (isHigh(level)) return quirks.budgetByLevel?.high;
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

export function inferThinkingMechanism(
	quirks: LocalModelQuirks | undefined,
	caps: CapabilityHints | undefined,
): ThinkingMechanism {
	if (quirks?.thinking?.mechanism) return quirks.thinking.mechanism;
	if (!caps?.reasoning) return "none";
	switch (caps.thinkingFormat) {
		case "anthropic-extended":
			return "budget-tokens";
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
			const effort = quirks?.thinking ? effortFor(quirks.thinking, level) : undefined;
			const result: AppliedThinking = {
				thinkingActive: requestedActive,
				mechanism,
				noticeKind: "applied",
				notice: "",
			};
			if (requestedActive && effort) result.effort = effort;
			return result;
		}
		case "budget-tokens": {
			const budget = quirks?.thinking ? budgetFor(quirks.thinking, level) : undefined;
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
	if (budgets.low !== undefined) out.push("low");
	if (budgets.medium !== undefined) out.push("medium");
	if (budgets.high !== undefined) out.push("high");
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
	if (efforts.low !== undefined) out.push("low");
	if (efforts.medium !== undefined) out.push("medium");
	if (efforts.high !== undefined) out.push("high");
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
	if ((configured === "high" || configured === "xhigh") && available.includes("high")) return "high";
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
	if (input.apiFamily !== "openai-completions") return false;
	const format = input.capabilities.thinkingFormat;
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
	const mechanism = inferThinkingMechanism(quirks, capabilityHints(input.capabilities.reasoning, thinkingFormat));
	const baseLevels = availableThinkingLevels(input.capabilities, {
		runtimeId: input.runtimeId,
		modelId: input.modelId,
	});
	const supportedLevels = restrictThinkingLevelsByMechanism(baseLevels, mechanism, quirks, { harmony });
	const effectiveLevel = effectiveThinkingLevel(configuredLevel, supportedLevels);
	let applied = applyThinkingMechanism(
		quirks,
		effectiveLevel,
		capabilityHints(input.capabilities.reasoning, thinkingFormat),
	);

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

function resolveRequestCapability(
	thinking: ResolvedThinkingCapability,
	parser: ResponseParserKind,
): ResolvedRequestCapability {
	const request: ResolvedRequestCapability = { budgetEnforcement: thinking.budgetEnforcement };
	if (thinking.mechanism === "effort-levels" && thinking.effort) {
		request.reasoningEffort = thinking.effort;
	}
	if (thinking.mechanism === "budget-tokens" && thinking.budgetTokens !== undefined) {
		request.budgetTokens = thinking.budgetTokens;
	}
	if (thinking.mechanism === "on-off" && thinking.chatTemplateKwargs) {
		request.chatTemplateKwargs = { ...thinking.chatTemplateKwargs };
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
		request: resolveRequestCapability(thinking, parser),
		response: {
			parser,
			stripTokenizerSentinels: true,
		},
	};
	if (quirks) result.quirks = quirks;
	return result;
}

export function resolveModelRuntimeCapabilitiesForStatus(
	status: Pick<EndpointStatus, "endpoint" | "runtime" | "capabilities" | "probeCapabilities" | "probeModelId">,
	wireModelId: string | null | undefined,
	knowledgeBase: KnowledgeBase | null,
	options?: { detectedReasoning?: boolean | null; configuredThinkingLevel?: ThinkingLevel },
): ResolvedModelRuntimeCapabilities {
	const modelId = wireModelId?.trim() || status.endpoint.defaultModel?.trim() || "";
	const kbHit = modelId ? (knowledgeBase?.lookup(modelId) ?? null) : null;
	const capabilities = resolveModelCapabilities(status, modelId, knowledgeBase, {
		detectedReasoning: options?.detectedReasoning ?? null,
	});
	return resolveModelRuntimeCapabilities({
		targetId: status.endpoint.id,
		runtimeId: status.runtime?.id ?? status.endpoint.runtime,
		apiFamily: status.runtime?.apiFamily ?? null,
		modelId,
		capabilities,
		kbHit,
		...(options?.configuredThinkingLevel ? { configuredThinkingLevel: options.configuredThinkingLevel } : {}),
	});
}

export function resolveModelRuntimeCapabilitiesForProviders(
	providers: ProvidersContract,
	endpointId: string | null | undefined,
	wireModelId: string | null | undefined,
	configuredThinkingLevel?: ThinkingLevel,
): ResolvedModelRuntimeCapabilities | null {
	const id = endpointId?.trim();
	if (!id) return null;
	const status = providers.list().find((entry) => entry.endpoint.id === id);
	if (!status) return null;
	const modelId = wireModelId?.trim() || status.endpoint.defaultModel?.trim() || "";
	const detectedReasoning =
		modelId && typeof providers.getDetectedReasoning === "function" ? providers.getDetectedReasoning(id, modelId) : null;
	return resolveModelRuntimeCapabilitiesForStatus(status, modelId, providers.knowledgeBase, {
		detectedReasoning,
		...(configuredThinkingLevel ? { configuredThinkingLevel } : {}),
	});
}

function capabilitiesFromModel(model: Model<Api> & ClioRuntimeMetadata): CapabilityFlags {
	const format = model.compat?.thinkingFormat;
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

export function resolveEndpointRuntimeCapabilities(
	endpoint: TargetDescriptor,
	runtime: RuntimeDescriptor,
	wireModelId: string,
	capabilities: CapabilityFlags,
	knowledgeBase: KnowledgeBase | null,
	configuredThinkingLevel?: ThinkingLevel,
): ResolvedModelRuntimeCapabilities {
	const kbHit = knowledgeBase?.lookup(wireModelId) ?? null;
	return resolveModelRuntimeCapabilities({
		targetId: endpoint.id,
		runtimeId: runtime.id,
		apiFamily: runtime.apiFamily,
		modelId: wireModelId,
		capabilities,
		kbHit,
		...(configuredThinkingLevel ? { configuredThinkingLevel } : {}),
	});
}

export function supportedThinkingLevelLabels(resolved: ResolvedModelRuntimeCapabilities): ReadonlyArray<string> {
	return resolved.thinking.supportedLevels.map((level) => thinkingLevelChoiceLabel(resolved.thinking.mechanism, level));
}

export function sortedSupportedThinkingLevels(levels: Iterable<ThinkingLevel>): ReadonlyArray<ThinkingLevel> {
	return sortedThinkingLevels(levels);
}
