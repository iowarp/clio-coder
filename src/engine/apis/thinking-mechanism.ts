import type { ThinkingLevel } from "../../domains/providers/types/capability-flags.js";
import type {
	LocalModelQuirks,
	ThinkingMechanism,
	ThinkingQuirks,
} from "../../domains/providers/types/local-model-quirks.js";

export type AppliedThinkingNoticeKind = "applied" | "ignored-on-off" | "always-on" | "unsupported";

/**
 * Result of mapping a Clio-level ThinkingLevel onto the family's actual
 * thinking surface. Adapters consume the typed fields, while the prompt
 * compiler renders `noticeKind` and `notice` into the Runtime block so the
 * model sees an honest description of what is in flight.
 */
export interface AppliedThinking {
	/** True when the engine should treat this turn as a reasoning turn. */
	thinkingActive: boolean;
	/** Mechanism used to drive the request payload, after fallback inference. */
	mechanism: ThinkingMechanism;
	/** reasoning_effort string for openai-compat effort-levels. */
	effort?: string;
	/** Numeric thinking budget for budget-tokens mechanisms (informational on lmstudio-native). */
	budgetTokens?: number;
	/** chat_template_kwargs payload for openai-compat on-off mechanisms. */
	chatTemplateKwargs?: Record<string, boolean>;
	/** Category of the human notice for TUI/audit. Empty string when there is nothing to say. */
	noticeKind: AppliedThinkingNoticeKind;
	/** One-line human-readable explanation of any coercion or override. */
	notice: string;
}

interface CapabilityHints {
	/** True when the model advertises reasoning capability. */
	reasoning?: boolean;
	/** Family-level thinkingFormat the catalog already knows about. */
	thinkingFormat?: string;
}

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

/**
 * Infer a thinking mechanism when the catalog did not annotate the family.
 * Falls back to the pre-existing capability flags so legacy entries continue
 * to drive sampler selection and payload shape without a YAML edit.
 */
function inferMechanism(caps: CapabilityHints | undefined): ThinkingMechanism {
	if (!caps?.reasoning) return "none";
	switch (caps.thinkingFormat) {
		case "anthropic-extended":
			return "budget-tokens";
		case "openai-codex":
			return "effort-levels";
		default:
			return "on-off";
	}
}

/**
 * Map Clio's ThinkingLevel onto the family's thinking surface. Honors the
 * catalog's `quirks.thinking` when present; otherwise infers from capability
 * flags so the helper drops in cleanly for entries that have not been
 * annotated yet.
 *
 * The helper is the single source of truth for `thinkingActive`. Adapters use
 * it to pick `quirks.sampling.thinking` vs `quirks.sampling.instruct`, which
 * keeps the sampler choice aligned with the actual request shape.
 */
export function applyThinkingMechanism(
	quirks: LocalModelQuirks | undefined,
	level: ThinkingLevel,
	caps?: CapabilityHints,
): AppliedThinking {
	const mechanism: ThinkingMechanism = quirks?.thinking?.mechanism ?? inferMechanism(caps);
	const requestedActive = level !== "off";

	switch (mechanism) {
		case "none": {
			const result: AppliedThinking = {
				thinkingActive: false,
				mechanism,
				noticeKind: requestedActive ? "unsupported" : "applied",
				notice: requestedActive ? "model does not support thinking; level ignored" : "",
			};
			return result;
		}
		case "always-on": {
			const result: AppliedThinking = {
				thinkingActive: true,
				mechanism,
				noticeKind: level === "off" ? "always-on" : "applied",
				notice: level === "off" ? "model emits chain-of-thought unconditionally; off was ignored" : "",
			};
			return result;
		}
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
				result.notice = "model has on-off thinking; coerced to on";
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
