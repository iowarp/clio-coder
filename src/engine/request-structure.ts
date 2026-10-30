import { createHash } from "node:crypto";
import type { Api, Context, Message, Model, SystemMessage } from "@earendil-works/pi-ai";
import { getSystemMessageText, normalizeContext, resolveTranscript, toToolDeclaration } from "@earendil-works/pi-ai";
import type { CacheRequestStructure } from "../core/cache-telemetry.js";

const digest = (value: unknown): string =>
	createHash("sha256")
		.update(JSON.stringify(value) ?? "")
		.digest("hex");

/**
 * Only the fields a provider serializes enter an entry's digest. Clio annotates messages after they settle (call ids,
 * accounting, failures), and those annotations never reach the wire, so they must not read as a changed prefix.
 */
function entryDigest(message: Message | SystemMessage): string {
	if (message.role === "system") {
		return digest({
			role: message.role,
			content: message.content,
			sections: message.sections,
			toolsAdded: message.toolsAdded?.map(toToolDeclaration),
			toolsRemoved: message.toolsRemoved,
		});
	}
	const fields = message as Partial<Record<string, unknown>>;
	return digest({
		role: message.role,
		content: message.content,
		toolCallId: fields.toolCallId,
		toolName: fields.toolName,
		isError: fields.isError,
		// Pi replays a reply's thinking and signatures only to the model that produced it, and skips a failed reply.
		api: fields.api,
		provider: fields.provider,
		model: fields.model,
		stopReason: fields.stopReason,
	});
}

/**
 * The transcript resolved the way the provider resolves it before serializing. Clio adds a mid-conversation system
 * message only for a model whose compat flag is set (`supportsPolicyUpdates` in turn-context.ts), and Pi folds every
 * other later system message into the leading one, so the flag alone decides the shape (#423, #434).
 */
export function requestStructure(
	model: Model<Api>,
	context: Context,
	compiled?: { systemPrompt: string; sections: ReadonlyArray<{ id: string; contentHash?: string }> } | null,
): CacheRequestStructure {
	const midConversation = (model.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)
		?.supportsMidConvoSystemMessages;
	const { messages } = resolveTranscript(normalizeContext(context), midConversation === true);
	const first = messages[0];
	const head = first?.role === "system" ? first : undefined;
	const rest = head ? messages.slice(1) : messages;
	const system = head ? getSystemMessageText(head) : "";
	return {
		system: digest(system),
		...(compiled && compiled.systemPrompt === system
			? { sections: compiled.sections.map(({ id, contentHash }) => ({ id, ...(contentHash ? { contentHash } : {}) })) }
			: {}),
		tools: digest((head?.toolsAdded ?? []).map(toToolDeclaration)),
		entries: rest.map(entryDigest),
		answered: rest.some((message) => message.role === "assistant"),
	};
}
