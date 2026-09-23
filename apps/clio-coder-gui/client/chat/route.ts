// The route a conversation's next turn takes: the target and model Clio Coder reports for this
// session, with the target's reported health folded into one glyph. It is shown in the composer's
// actions row, beside Send, because that is where the next request leaves from. A target in any
// state other than healthy is also written out in full under the conversation header.

import type { StatusTone } from "../design/status.js";
import type { HealthSummary } from "./health.js";

export interface RouteSettings {
	readonly target: string | null;
	readonly model: string | null;
	readonly thinking: string;
}

export interface RouteFacts {
	readonly tone: StatusTone;
	/** What the chip prints: `target · model`, or the one fact that is known. */
	readonly text: string;
	/** The pointer tooltip, with every fact spelled out. */
	readonly title: string;
	/** What assistive technology hears after the text. */
	readonly spoken: string;
}

/**
 * Without reported settings the chip says so rather than printing a bare label: a target's health
 * row names that target, and nothing at all is "Model not reported", never a guessed default.
 */
export function routeFacts(settings: RouteSettings | undefined, health: HealthSummary): RouteFacts {
	const target = settings?.target ?? null;
	const provider = health.providers.find((row) => row.key === target) ?? health.providers[0];
	const tone = provider?.tone ?? "unverified";
	const healthText = provider
		? `Target ${provider.key}: ${sentenceEnd(provider.detail ?? provider.label)}`
		: "No target health reported by Clio Coder.";
	if (settings === undefined) {
		return {
			tone,
			text: provider ? provider.key : "Model not reported",
			title: `Clio Coder has not reported this session's model. ${healthText}`,
			spoken: `Model not reported. ${healthText}`,
		};
	}
	return {
		tone,
		text: `${settings.target ?? "automatic routing"} · ${settings.model ?? "default model"}`,
		title: `Target: ${settings.target ?? "automatic"}. Model: ${settings.model ?? "configured default"}. Thinking: ${settings.thinking}. ${healthText}`,
		spoken: `Thinking ${settings.thinking}. ${healthText}`,
	};
}

/** A reported detail may already end its sentence; the chip's text must not print a second stop. */
const sentenceEnd = (text: string): string => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);
