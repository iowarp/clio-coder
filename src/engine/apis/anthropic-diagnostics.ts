import type { Api, Context, Model, StreamOptions } from "@earendil-works/pi-ai";

function isAnthropicEndpoint(baseUrl: string): boolean {
	if (!baseUrl) return true;
	try {
		return new URL(baseUrl).hostname === "api.anthropic.com";
	} catch {
		return false;
	}
}

/** Compare against the last assistant in the submitted context, including resumed turns (#423). */
export function withAnthropicDiagnostics<T extends StreamOptions>(
	model: Model<Api>,
	context: Context,
	options: T | undefined,
): T | undefined {
	// #423: compatible servers need not accept Anthropic's diagnostics extension.
	if (model.api !== "anthropic-messages" || !isAnthropicEndpoint(model.baseUrl)) return options;
	let previousMessageId: string | undefined;
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role !== "assistant") continue;
		previousMessageId = message.responseId;
		break;
	}
	const previous = options?.onPayload;
	return {
		...options,
		onPayload: async (payload: unknown, currentModel: Model<Api>) => {
			const base = (await previous?.(payload, currentModel)) ?? payload;
			if (typeof base !== "object" || base === null || Array.isArray(base)) return base;
			const betas = "betas" in base && Array.isArray(base.betas) ? base.betas : [];
			return {
				...base,
				// #423: opt into comparisons without replacing Pi's OAuth and model beta headers.
				betas: [...new Set([...betas, "cache-diagnosis-2026-04-07"])],
				// #423: first requests must opt in so later diagnostics can find them for comparison.
				diagnostics: previousMessageId ? { previous_message_id: previousMessageId } : {},
			};
		},
	} as T;
}
