import { doesNotMatch, match, ok } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { compact } from "../../src/domains/session/compaction/compact.js";
import { estimateAgentContextTokens } from "../../src/domains/session/context-accounting.js";
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

/** A helper library whose later helpers sit well past the first 2000 characters. */
function library(file: string, multipliers: Record<number, number>): string {
	const helpers: string[] = [`// ${file}: numeric helper library`];
	for (let n = 1; n <= 30; n++) {
		const h = String(n).padStart(2, "0");
		const m = multipliers[n] ?? 10 + n;
		helpers.push(
			`/** ${file} helper ${n}: scales the input by ${m}. */\nexport function ${file}_h${h}(x: number): number {\n\tconst scaled = x * ${m} + ${n};\n\tif (scaled % 3 === 0) return scaled / 3;\n\treturn scaled - ${n + 7};\n}`,
		);
	}
	return helpers.join("\n\n");
}

function read(id: string, file: string, text: string): SessionEntry[] {
	return [
		message(`${id}-call`, "assistant", {
			text: "",
			content: [{ type: "toolCall", id, name: "read", arguments: { path: `src/${file}.ts` } }],
		}),
		message(`${id}-result`, "tool_result", {
			toolCallId: id,
			toolName: "read",
			result: { content: [{ type: "text", text }] },
		}),
	];
}

// beforeD-1/afterG-1 TD: a request to read mod_c and mod_d in full overflowed
// after both reads, and the split-turn checkpoint summarized mod_c's read from
// its first 2000 characters. Only mod_c_h05 survived; the answer took h15/h25
// from mod_d, still in context.
describe("split-turn checkpoint input keeps a whole read the summarizer can fit", () => {
	let faux: ReturnType<typeof registerEngineFauxProvider>;
	beforeEach(() => {
		faux = registerEngineFauxProvider({ api: "summary-tool-results-fixture", models: [{ id: "summary" }] });
	});
	afterEach(() => faux.unregister());

	const modC = library("mod_c", { 5: 31, 15: 74, 25: 83 });
	const modD = library("mod_d", { 5: 20, 15: 84, 25: 53 });
	const entries = chain([
		message("ask", "user", {
			text: "Read src/mod_c.ts and src/mod_d.ts in full, then list the h05/h15/h25 multipliers.",
		}),
		...read("c", "mod_c", modC),
		...read("d", "mod_d", modD),
	]);

	async function summaryInput(contextWindow: number): Promise<{ text: string; tokens: number }> {
		const resolved = faux.getModel("summary");
		ok(resolved);
		const model = { ...resolved, contextWindow, maxTokens: 4096 };
		let text = "";
		let tokens = 0;
		const result = await compact({
			entries,
			model,
			keepRecentTokens: 1000,
			requireFit: true,
			preserveUserTurnId: "ask",
			summarize: async ({ systemPrompt, userText }) => {
				text += userText;
				tokens += estimateAgentContextTokens({
					systemPrompt,
					messages: [{ role: "user", content: userText, timestamp: 0 }],
				});
				return { text: syntheticCompactionSummary("List the multipliers") };
			},
		});
		ok(result.isSplitTurn, "the cut keeps mod_d's read and summarizes mod_c's");
		return { text, tokens };
	}

	it("sends the whole read when it fits the summarizer's window", async () => {
		ok(modC.indexOf("x * 74") > 2000, "the fact sits past the old cap");
		const { text } = await summaryInput(200_000);
		match(text, /x \* 74 \+ 15/);
		match(text, /x \* 83 \+ 25/);
		doesNotMatch(text, /more characters truncated/);
	});

	it("caps a read at what fits a small window, above the floor", async () => {
		// Output room is half the 4000 window; the estimate gets a 20% margin.
		const { text, tokens } = await summaryInput(4000);
		ok(tokens <= (4000 - 2000) * 0.8, `${tokens} estimated tokens`);
		match(text, /x \* 74 \+ 15/);
		doesNotMatch(text, /x \* 83 \+ 25/);
		match(text, /more characters truncated/);
	});
});
