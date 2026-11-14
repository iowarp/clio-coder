// The route a conversation's next turn takes: the target and model Clio Coder reports for this
// session, with the target's reported health folded into one glyph. It is shown in the composer's
// actions row, beside Send, because that is where the next request leaves from. A target in any
// state other than healthy is also written out in full under the conversation header.

import type { SessionConfig } from "../../contracts/session-config.js";
import type { StatusTone } from "../design/status.js";
import type { HealthSummary } from "./health.js";

export interface RouteSettings {
	readonly target: string | null;
	readonly model: string | null;
	readonly thinking: string;
}

export interface RouteFacts {
	readonly config?: SessionConfig;
	readonly tone: StatusTone;
	/** What the chip prints: `target · model`, or the one fact that is known. */
	readonly text: string;
	/** The compact face names the model; the full route remains in text and title. */
	readonly model?: string;
	readonly thinking?: string;
	/** The pointer tooltip, with every fact spelled out. */
	readonly title: string;
	/** What assistive technology hears after the text. */
	readonly spoken: string;
}

/**
 * A provider's health does not identify the session's route; an unreported route stays unknown. Once the session
 * reports its config, a model or thinking level that config does not carry reads `not reported`: a saved default is
 * never shown as the session's value.
 */
export function routeFacts(
	settings: RouteSettings | undefined,
	health: HealthSummary,
	config?: SessionConfig,
): RouteFacts {
	let modelReported = true;
	if (config && (config.options.length > 0 || config.target !== undefined)) {
		const model = config.options.find((row) => row.id === "model")?.currentValue;
		modelReported = model !== undefined;
		settings = {
			target: config.target !== undefined ? config.target : (settings?.target ?? null),
			model: model ?? null,
			thinking: config.options.find((row) => row.id === "thinkingLevel")?.currentValue ?? "not reported",
		};
	}
	const target = settings?.target ?? null;
	const provider = health.providers.find((row) => row.key === target);
	const tone = provider?.tone ?? "unverified";
	const healthText = provider
		? `Target ${provider.key}: ${sentenceEnd(provider.detail ?? provider.label)}`
		: "No target health reported by CLIO Coder.";
	if (settings === undefined) {
		return {
			tone,
			text: "Model not reported",
			title: `CLIO Coder has not reported this task's model. ${healthText}`,
			spoken: `Model not reported. ${healthText}`,
		};
	}
	return {
		...(config ? { config } : {}),
		tone,
		text: `${settings.target ?? "automatic routing"} · ${modelReported ? (settings.model ?? "default model") : "model not reported"}`,
		model: modelReported
			? (config?.options.find((row) => row.id === "model")?.options.find((row) => row.value === settings.model)?.name ??
				settings.model ??
				"Default model")
			: "Model not reported",
		...(settings.thinking === "not reported" ? {} : { thinking: settings.thinking }),
		title: `Target: ${settings.target ?? "automatic"}. Model: ${modelReported ? (settings.model ?? "configured default") : "not reported"}. Thinking: ${settings.thinking}. ${healthText}`,
		spoken: `Thinking ${settings.thinking}. ${healthText}`,
	};
}

/** A reported detail may already end its sentence; the chip's text must not print a second stop. */
const sentenceEnd = (text: string): string => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);
