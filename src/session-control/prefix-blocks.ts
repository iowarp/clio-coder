import { createHash } from "node:crypto";
import type { Payload } from "../core/telemetry/schemas.js";
import type { CompiledSessionPrompt } from "../domains/prompts/compiler.js";

/** Blocks past this many are counted, not named, so a long session's record stays bounded (#434). */
const MAX_BLOCKS = 4096;
const SHA256_HEX = /^[0-9a-f]{64}$/;

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const estimate = (text: string): number => Math.ceil(text.length / 4);

/**
 * The request's prefix as commitment hashes, in send order: the compiled sections when the sent system prompt is
 * the compiled one (one block for any other), the tool set, then each message. Research capture only, since every
 * message is serialized and hashed once per request (#423, #434).
 */
export function prefixBlocksOf(
	compiled: Pick<CompiledSessionPrompt, "systemPrompt" | "sections"> | null,
	sent: { systemPrompt?: string; messages: ReadonlyArray<unknown>; tools?: ReadonlyArray<unknown> },
): Payload<"prefix.blocks"> | undefined {
	const blocks: Payload<"prefix.blocks">["blocks"] = [];
	let omitted = 0;
	const add = (block: Payload<"prefix.blocks">["blocks"][number]): void => {
		if (blocks.length < MAX_BLOCKS) blocks.push(block);
		else omitted += 1;
	};
	const system = sent.systemPrompt ?? "";
	if (
		compiled !== null &&
		compiled.systemPrompt === system &&
		compiled.sections.length > 0 &&
		compiled.sections.every((section) => section.contentHash !== undefined && SHA256_HEX.test(section.contentHash))
	) {
		for (const section of compiled.sections)
			add({
				kind: "system-section",
				id: section.id,
				hash: section.contentHash as string,
				tokens: Math.max(0, Math.round(section.tokenEstimate)),
			});
	} else if (system.length > 0) {
		add({ kind: "system-section", id: "system-prompt", hash: sha256(system.trim()), tokens: estimate(system) });
	}
	if (sent.tools && sent.tools.length > 0) {
		const tools = JSON.stringify(sent.tools);
		add({ kind: "tools", hash: sha256(tools), tokens: estimate(tools) });
	}
	for (const message of sent.messages) {
		const json = JSON.stringify(message) ?? "null";
		const role = (message as { role?: unknown } | null)?.role;
		add({
			kind: "message",
			...(typeof role === "string" && role.length > 0 ? { id: role } : {}),
			hash: sha256(json),
			tokens: estimate(json),
		});
	}
	if (blocks.length === 0) return undefined;
	return {
		label: "commitment",
		function: "sha256",
		canonicalization: "clio-prefix-v1",
		blocks,
		...(omitted > 0 ? { omitted } : {}),
	};
}
