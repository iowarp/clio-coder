import { createHash } from "node:crypto";
import type { Api, Context, Message, Model, SystemMessage } from "@earendil-works/pi-ai";
import { getSystemMessageText, normalizeContext, resolveTranscript, toToolDeclaration } from "@earendil-works/pi-ai";
import type { CacheRequestStructure } from "../core/cache-telemetry.js";
import { providerCheckpointFromMessage } from "../core/provider-checkpoint-handle.js";
import { matchesTrace, traceValue } from "../core/value-trace.js";

const digest = (value: unknown): string =>
	createHash("sha256")
		.update(JSON.stringify(value) ?? "")
		.digest("hex");

/**
 * Only the fields a provider serializes enter an entry's digest. Clio annotates messages after they settle (call ids,
 * accounting, failures), and those annotations never reach the wire, so they must not read as a changed prefix.
 */
function wireFields(message: Message | SystemMessage): Record<string, unknown> {
	if (message.role === "system") {
		return {
			role: message.role,
			content: message.content,
			sections: message.sections,
			toolsAdded: message.toolsAdded?.map(toToolDeclaration),
			toolsRemoved: message.toolsRemoved,
		};
	}
	const fields = message as Partial<Record<string, unknown>>;
	// A native checkpoint handle reaches the wire as the provider's opaque state, so a different handle is a different
	// element. Only a message that carries one gains the field, so every other digest is unchanged (F14).
	const checkpoint = providerCheckpointFromMessage(message)?.digest;
	return {
		...(checkpoint ? { checkpoint } : {}),
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
	};
}

type DigestedEntry = { trace: unknown[] | null; digest: string };
type CompiledPrompt = { systemPrompt: string; sections: ReadonlyArray<{ id: string; contentHash?: string }> };

/**
 * The transcript resolved the way the provider resolves it before serializing. Clio adds a mid-conversation system
 * message only for a model whose compat flag is set (`supportsPolicyUpdates` in turn-context.ts), and Pi folds every
 * other later system message into the leading one, so the flag alone decides the shape (#423, #434).
 */
function requestStructure(
	model: Model<Api>,
	context: Context,
	compiled: CompiledPrompt | null | undefined,
	previous: ReadonlyArray<DigestedEntry>,
): { structure: CacheRequestStructure; entries: DigestedEntry[] } {
	const midConversation = (model.compat as { supportsMidConvoSystemMessages?: boolean } | undefined)
		?.supportsMidConvoSystemMessages;
	const { messages } = resolveTranscript(normalizeContext(context), midConversation === true);
	const first = messages[0];
	const head = first?.role === "system" ? first : undefined;
	const rest = head ? messages.slice(1) : messages;
	const system = head ? getSystemMessageText(head) : "";
	const entries = rest.map((message, index): DigestedEntry => {
		const fields = wireFields(message);
		const prior = previous[index];
		if (prior?.trace && matchesTrace(fields, prior.trace)) return prior;
		return { trace: traceValue(fields), digest: digest(fields) };
	});
	const structure: CacheRequestStructure = {
		system: digest(system),
		...(compiled && compiled.systemPrompt === system
			? { sections: compiled.sections.map(({ id, contentHash }) => ({ id, ...(contentHash ? { contentHash } : {}) })) }
			: {}),
		tools: digest((head?.toolsAdded ?? []).map(toToolDeclaration)),
		entries: entries.map((entry) => entry.digest),
		roles: rest.map((message) => message.role),
		answered: rest.some((message) => message.role === "assistant"),
	};
	return { structure, entries };
}

/**
 * One runtime's request structures. Each wire entry keeps the trace of the fields it hashed, by position, so the next
 * request rehashes only an entry whose wire fields differ by key or leaf: an appended tool result no longer serializes
 * and hashes every entry before it. Equality is the exact trace, never a message id, a count or an object reference.
 */
export function createRequestStructures(): (
	model: Model<Api>,
	context: Context,
	compiled?: CompiledPrompt | null,
) => CacheRequestStructure {
	let previous: DigestedEntry[] = [];
	return (model, context, compiled) => {
		const { structure, entries } = requestStructure(model, context, compiled, previous);
		previous = entries;
		return structure;
	};
}
