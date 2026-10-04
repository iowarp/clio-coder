import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	COMPACTION_SYSTEM_PROMPT,
	COMPACTION_TURN_PREFIX_PROMPT_TEMPLATE,
	COMPACTION_USER_PROMPT_TEMPLATE,
	compact,
} from "../../src/domains/session/compaction/compact.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { toTaskLedgerEntryFields } from "../../src/domains/session/task-board.js";
import { registerEngineFauxProvider } from "../../src/engine/api-registry.js";
import { resolvedRequestContext } from "../../src/engine/context.js";
import { buildModelReplayAgentMessagesFromTurns } from "../../src/session-control/model-session-replay.js";
import { syntheticCompactionSummary } from "../harness/compaction-summary.js";

function history(text = "Earlier work"): SessionEntry[] {
	return [text, "Continue"].map((body, i) => ({
		kind: "message",
		turnId: `user-${i}`,
		parentTurnId: i === 0 ? null : "user-0",
		timestamp: "2026-09-07T00:00:00Z",
		role: "user",
		payload: { text: body },
	}));
}

describe("compaction checkpoint format and semantic replay", () => {
	const valid = syntheticCompactionSummary("Repair the exchange.");
	for (const [name, text] of [
		["normally stopped partial checkpoint", "## Goal\nRepair the exchange."],
		["missing progress subsection", valid.replace("### Blocked", "### Risks")],
		["headings hidden in backtick fence", `\`\`\`markdown\n${valid}\n\`\`\``],
		["headings hidden in tilde fence", `~~~~markdown\n${valid}\n~~~~`],
		["unfinished fence before last heading", valid.replace("## Critical Context", "```\n## Critical Context")],
		["reordered sections", valid.replace("## Goal", "## Next Steps").replace("## Next Steps\n(none)", "## Goal\n(none)")],
	] as const) {
		it(`rejects ${name} before producing a checkpoint`, async () => {
			const provider = registerEngineFauxProvider({ api: "summary-format", models: [{ id: "fixture" }] });
			try {
				const model = provider.getModel("fixture");
				ok(model);
				const entries = history();
				const original = structuredClone(entries);
				await rejects(
					compact({ entries, model, summarize: async () => ({ text }) }),
					/incomplete.*checkpoint|required.*heading/i,
				);
				deepStrictEqual(entries, original);
			} finally {
				provider.unregister();
			}
		});
	}

	it("accepts the required headings outside fenced examples and keeps the split-turn format distinct", async () => {
		const provider = registerEngineFauxProvider({ api: "summary-format", models: [{ id: "fixture" }] });
		try {
			const model = provider.getModel("fixture");
			ok(model);
			const entries = history();
			entries.push({
				kind: "message",
				turnId: "tail",
				parentTurnId: "user-1",
				timestamp: "2026-09-07T00:00:00Z",
				role: "assistant",
				payload: { text: "tail ".repeat(2000) },
			});
			const prompts: string[] = [];
			const result = await compact({
				entries,
				model,
				keepRecentTokens: 100,
				summarize: async ({ userText }) => {
					prompts.push(userText);
					return {
						text: userText.includes(COMPACTION_TURN_PREFIX_PROMPT_TEMPLATE)
							? "Continue the active request after the observed tool calls."
							: `${valid}\n\n~~~md\n## Goal\nexample\n~~~`,
					};
				},
			});
			strictEqual(result.isSplitTurn, true);
			strictEqual(prompts.length, 2);
			ok(prompts[0]?.includes(COMPACTION_USER_PROMPT_TEMPLATE));
			ok(!prompts[1]?.includes(COMPACTION_USER_PROMPT_TEMPLATE));
			ok(result.summary.includes("**Turn Context (split turn):**"));
		} finally {
			provider.unregister();
		}
	});

	it("freezes the task board at the checkpoint while later work stays in the suffix", () => {
		const board = {
			boardId: "b1",
			title: "Repair",
			tasks: [{ id: "t1", status: "pending" as const, title: "Fix exchange" }],
			activeRunIds: [],
		};
		const timestamp = "2026-09-07T00:00:00Z";
		const entries: SessionEntry[] = [
			...history(),
			{ ...toTaskLedgerEntryFields(board, new Date(timestamp)), turnId: "board", timestamp, parentTurnId: "user-0" },
			{
				kind: "compactionSummary",
				turnId: "checkpoint",
				parentTurnId: "user-1",
				timestamp,
				summary: valid,
				firstKeptTurnId: "user-1",
				tokensBefore: 10000,
			},
		];
		const before = buildModelReplayAgentMessagesFromTurns(entries);
		strictEqual(before[1]?.role, "user");
		ok(JSON.stringify(before[1]).includes("[Task board as of checkpoint] Repair\\nt1 pending Fix exchange"));
		const after = buildModelReplayAgentMessagesFromTurns([
			...entries,
			{
				...toTaskLedgerEntryFields(
					{ ...board, tasks: [{ id: "t1", title: "Fix exchange", status: "completed" }] },
					new Date(timestamp),
				),
				turnId: "updated-board",
				timestamp,
				parentTurnId: "user-1",
			},
			{
				kind: "message",
				role: "assistant",
				turnId: "later",
				parentTurnId: "user-1",
				timestamp,
				payload: { text: "Task t1 completed" },
			},
		]);
		deepStrictEqual(after.slice(0, before.length), before);
		ok(JSON.stringify(after).includes("Task t1 completed"));
	});

	it("replays the whole checkpoint beyond the ordinary replay cap", () => {
		const summary = `${valid}\n${"x".repeat(25000)}\nEND_CHECKPOINT_SENTINEL`;
		const messages = buildModelReplayAgentMessagesFromTurns([
			{
				kind: "compactionSummary",
				turnId: "checkpoint",
				parentTurnId: null,
				timestamp: "2026-09-07T00:00:00Z",
				summary,
				firstKeptTurnId: "",
				tokensBefore: 10000,
			},
		]);
		const replay = JSON.stringify(messages);
		ok(replay.includes("END_CHECKPOINT_SENTINEL"));
		ok(replay.includes("x".repeat(25000)));
	});

	it("replays an archived checkpoint through the actual prompt and preserves its named facts", async () => {
		const fixture = JSON.parse(
			readFileSync(new URL("../fixtures/compaction/recorded-checkpoint.json", import.meta.url), "utf8"),
		) as {
			provenance: { kind: string };
			entries: SessionEntry[];
			response: string;
			mustSurvive: Array<{ name: string; text: string }>;
		};
		strictEqual(fixture.provenance.kind, "recorded-session-checkpoint");
		const provider = registerEngineFauxProvider({
			api: "summary-format",
			models: [{ id: "fixture" }],
			tokensPerSecond: 0,
		});
		try {
			const model = provider.getModel("fixture");
			ok(model);
			provider.setResponses([
				(context, _options, _state, resolved) => {
					strictEqual(resolvedRequestContext(context).systemPrompt, COMPACTION_SYSTEM_PROMPT);
					const prompt = JSON.stringify(context.messages);
					ok(prompt.includes(JSON.stringify(COMPACTION_USER_PROMPT_TEMPLATE).slice(1, -1)));
					ok(prompt.includes("FOXTROT"));
					return {
						role: "assistant",
						content: [{ type: "text", text: fixture.response }],
						api: resolved.api,
						provider: resolved.provider,
						model: resolved.id,
						stopReason: "stop",
						timestamp: 0,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					};
				},
			]);
			const result = await compact({ entries: fixture.entries, model, keepRecentTokens: 100000 });
			for (const fact of fixture.mustSurvive) ok(result.summary.includes(fact.text), fact.name);
		} finally {
			provider.unregister();
		}
	});

	it("preserves synthetic architecture, open bug, and exact identifier facts through checkpoint and fresh replay", async () => {
		const fixture = JSON.parse(
			readFileSync(new URL("../fixtures/compaction/synthetic-facts.json", import.meta.url), "utf8"),
		) as {
			provenance: { kind: string };
			entries: SessionEntry[];
			response: string;
			mustSurvive: Array<{ name: string; text: string }>;
		};
		strictEqual(fixture.provenance.kind, "synthetic-authored-fixture");
		const facts = fixture.mustSurvive;
		const entries = fixture.entries;
		const provider = registerEngineFauxProvider({ api: "summary-format", models: [{ id: "fixture" }] });
		try {
			const model = provider.getModel("fixture");
			ok(model);
			const result = await compact({
				entries,
				model,
				summarize: async ({ userText }) => {
					for (const fact of facts) ok(userText.includes(fact.text), `input ${fact.name}`);
					return { text: fixture.response };
				},
			});
			ok(result.firstKeptTurnId);
			const replay = buildModelReplayAgentMessagesFromTurns([
				...entries,
				{
					kind: "compactionSummary",
					turnId: "checkpoint",
					parentTurnId: "user-1",
					timestamp: "2026-09-07T00:00:00Z",
					summary: result.summary,
					firstKeptTurnId: result.firstKeptTurnId,
					tokensBefore: result.tokensBefore,
				},
			]);
			for (const fact of facts) {
				ok(result.summary.includes(fact.text), fact.name);
				ok(JSON.stringify(replay).includes(fact.text), `fresh replay ${fact.name}`);
			}
		} finally {
			provider.unregister();
		}
	});
	it("carries an operator Remember sentence verbatim when the summary drops it", async () => {
		const provider = registerEngineFauxProvider({ api: "summary-format", models: [{ id: "fixture" }] });
		try {
			const model = provider.getModel("fixture");
			ok(model);
			const entries = history("Remember: the deploy codeword is MARBLE-OTTER. Then read src/ layout.");
			entries.push({
				kind: "message",
				turnId: "tail",
				parentTurnId: "user-1",
				timestamp: "2026-09-07T00:00:00Z",
				role: "assistant",
				payload: { text: "tail ".repeat(2000) },
			});
			const result = await compact({
				entries,
				model,
				keepRecentTokens: 100,
				summarize: async () => ({ text: syntheticCompactionSummary("Read the layout.") }),
			});
			ok(result.summary.includes('<operator-notes encoding="xml">\n- Remember: the deploy codeword is MARBLE-OTTER.'));
			ok(!result.summary.includes("Then read src/ layout"));
		} finally {
			provider.unregister();
		}
	});
});
