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
 * Without reported settings the chip says so rather than printing a bare label: a target's health
 * row names that target, and nothing at all is "Model not reported", never a guessed default.
 */
export function routeFacts(
	settings: RouteSettings | undefined,
	health: HealthSummary,
	config?: SessionConfig,
): RouteFacts {
	if (config && (config.options.length > 0 || config.target !== undefined))
		settings = {
			target: config.target !== undefined ? config.target : (settings?.target ?? null),
			model: config.options.find((row) => row.id === "model")?.currentValue ?? settings?.model ?? null,
			thinking:
				config.options.find((row) => row.id === "thinkingLevel")?.currentValue ?? settings?.thinking ?? "not reported",
		};
	const target = settings?.target ?? null;
	const provider = target === null ? health.providers[0] : health.providers.find((row) => row.key === target);
	const tone = provider?.tone ?? "unverified";
	const healthText = provider
		? `Target ${provider.key}: ${sentenceEnd(provider.detail ?? provider.label)}`
		: "No target health reported by Clio Coder.";
	if (settings === undefined) {
		return {
			tone,
			text: provider ? provider.key : "Model not reported",
			title: `Clio Coder has not reported this task's model. ${healthText}`,
			spoken: `Model not reported. ${healthText}`,
		};
	}
	return {
		...(config ? { config } : {}),
		tone,
		text: `${settings.target ?? "automatic routing"} · ${settings.model ?? "default model"}`,
		model:
			config?.options.find((row) => row.id === "model")?.options.find((row) => row.value === settings.model)?.name ??
			settings.model ??
			"Default model",
		...(settings.thinking === "not reported" ? {} : { thinking: settings.thinking }),
		title: `Target: ${settings.target ?? "automatic"}. Model: ${settings.model ?? "configured default"}. Thinking: ${settings.thinking}. ${healthText}`,
		spoken: `Thinking ${settings.thinking}. ${healthText}`,
	};
}

/** A reported detail may already end its sentence; the chip's text must not print a second stop. */
const sentenceEnd = (text: string): string => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);
