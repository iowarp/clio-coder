import { ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { compact } from "../../src/domains/session/compaction/compact.js";
import { estimateTokens } from "../../src/domains/session/compaction/tokens.js";
import type { MessageEntry, SessionEntry } from "../../src/domains/session/entries.js";
import { registerEngineFauxProvider } from "../../src/engine/api-registry.js";
import { syntheticCompactionSummary } from "../harness/compaction-summary.js";

const timestamp = "2026-11-07T00:00:00.000Z";
function message(turnId: string, role: MessageEntry["role"], payload: unknown): MessageEntry {
	return { kind: "message", turnId, parentTurnId: null, timestamp, role, payload };
}
function chain(entries: SessionEntry[]): SessionEntry[] {
	return entries.map((entry, index) => ({ ...entry, parentTurnId: entries[index - 1]?.turnId ?? null }));
}

// afterF-2: a turn ended right after a checkpoint whose kept suffix was one
// whole-file read. That suffix (3432 tokens) was under twice the checkpoint
// (2 x 2117), so the next request, 112 tokens over the window, compacted
// nothing and was refused.
describe("overflow compaction of a retained suffix", () => {
	let faux: ReturnType<typeof registerEngineFauxProvider>;
	let calls: number;
	beforeEach(() => {
		calls = 0;
		faux = registerEngineFauxProvider({ api: "overflow-fit-fixture", models: [{ id: "summary" }], tokensPerSecond: 0 });
		faux.setResponses(
			Array.from({ length: 2 }, () => (_context, _options, _state, resolved) => {
				calls += 1;
				return {
					role: "assistant",
					content: [{ type: "text", text: syntheticCompactionSummary("List the multipliers") }],
					api: resolved.api,
					provider: resolved.provider,
					model: resolved.id,
					stopReason: "stop",
					timestamp: Date.now(),
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
			}),
		);
	});
	afterEach(() => faux.unregister());
	function model() {
		const resolved = faux.getModel("summary");
		ok(resolved);
		return { ...resolved, contextWindow: 32768, maxTokens: 4096 };
	}
	function session(): SessionEntry[] {
		const checkpoint: SessionEntry = {
			kind: "compactionSummary",
			turnId: "checkpoint",
			parentTurnId: null,
			timestamp,
			summary: `## Goal\nList the multipliers.\n\n## Progress\n${"Read src/mod_c.ts in full. ".repeat(40)}`,
			firstKeptTurnId: "a-read",
			tokensBefore: 15000,
		};
		return chain([
			message("u1", "user", { text: "Read src/mod_c.ts and src/mod_d.ts, then list the multipliers." }),
			message("a-read", "assistant", {
				content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "src/mod_d.ts" } }],
			}),
			message("r-read", "tool_result", {
				toolCallId: "call_read",
				toolName: "read",
				result: { content: [{ type: "text", text: "const scaled = x * 20 + 5;\n".repeat(60) }] },
				isError: false,
			}),
			checkpoint,
			message("answer", "assistant", { content: [{ type: "text", text: "h05 uses 20." }] }),
		]);
	}

	it("rewrites a checkpoint whose kept suffix is under twice its size when the request must fit", async () => {
		const entries = session();
		const checkpointTokens = estimateTokens(entries[3] as SessionEntry);
		const suffixTokens = estimateTokens(entries[1] as SessionEntry) + estimateTokens(entries[2] as SessionEntry);
		ok(suffixTokens > checkpointTokens && suffixTokens < 2 * checkpointTokens, `${suffixTokens} vs ${checkpointTokens}`);

		const automatic = await compact({ entries, model: model(), keepRecentTokens: 10000 });
		strictEqual(automatic.summary, "");
		strictEqual(automatic.emptyReason, "protected-recent");
		strictEqual(calls, 0, "an automatic pass does not pay to rewrite a small suffix");

		const overflow = await compact({ entries, model: model(), keepRecentTokens: 10000, requireFit: true });
		strictEqual(calls, 1);
		ok(overflow.summary.length > 0, "a request that cannot fit otherwise gets the rewrite");
		strictEqual(overflow.emptyReason, undefined);
	});
});
