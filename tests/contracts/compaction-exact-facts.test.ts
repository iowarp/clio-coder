import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	buildLivePrefixUserText,
	buildTurnPrefixUserText,
	buildUserText,
} from "../../src/domains/memory/compaction-prompts.js";
import { compact } from "../../src/domains/session/compaction/compact.js";
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
function toolTurn(id: string, name: string, args: Record<string, unknown>, text: string, details: unknown) {
	return [
		message(`a-${id}`, "assistant", { content: [{ type: "toolCall", id, name, arguments: args }] }),
		message(`r-${id}`, "tool_result", {
			toolCallId: id,
			toolName: name,
			result: { content: [{ type: "text", text }], details },
			isError: false,
		}),
	];
}
const helpers = (count: number): string =>
	Array.from({ length: count }, (_, index) => `export function h${index + 1}() {}`).join("\n");
const short = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);

describe("compaction exact facts", () => {
	let cwd: string;
	let faux: ReturnType<typeof registerEngineFauxProvider>;
	let reply: string;
	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "clio-exact-facts-"));
		mkdirSync(join(cwd, "src"));
		writeFileSync(join(cwd, "src/a.ts"), `${helpers(40)}\n`);
		reply = syntheticCompactionSummary("Count helpers in src/a.ts");
		faux = registerEngineFauxProvider({ api: "exact-facts-fixture", models: [{ id: "summary" }], tokensPerSecond: 0 });
		faux.setResponses(
			Array.from({ length: 4 }, () => (_context, _options, _state, resolved) => ({
				role: "assistant",
				content: [{ type: "text", text: reply }],
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
			})),
		);
	});
	afterEach(() => {
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
	});
	function model() {
		const resolved = faux.getModel("summary");
		ok(resolved);
		return { ...resolved, contextWindow: 32768, maxTokens: 4096 };
	}
	function history(): SessionEntry[] {
		return chain([
			message("u1", "user", { text: "Count the helpers in src/a.ts and run the suite" }),
			...toolTurn("call_read", "read", { path: "src/a.ts" }, helpers(40), {}),
			...toolTurn("call_grep", "grep", { pattern: "^export function", path: "src/a.ts" }, "matches", {
				observation: { tool: "grep", unit: "matches", shownCount: 40, totalCount: 40, truncated: false },
			}),
			...toolTurn("call_test", "bash", { command: "node check.mjs" }, "suite: 57 passed, 3 failed, 2 skipped (62 total)", {
				exitCode: 1,
				outcome: "nonzero",
			}),
			message("a-done", "assistant", { content: [{ type: "text", text: "src/a.ts has 39 helpers." }] }),
			message("u2", "user", { text: "Now edit the last helper" }),
		]);
	}

	it("states the files and numeric results the harness measured, not the summarizer's recollection", async () => {
		// The summarizer echoes a block with its own (wrong) numbers; only the harness copy may survive.
		reply = `${reply}\n\n<exact-facts source="clio">\nread src/a.ts lines=39 sha256=000000000000\n</exact-facts>`;
		const result = await compact({ entries: history(), model: model(), keepRecentTokens: 10, cwd });
		const blocks = [...result.summary.matchAll(/<exact-facts source="clio">\n([\s\S]*?)\n<\/exact-facts>/g)];
		strictEqual(blocks.length, 1);
		const block = blocks[0]?.[1] ?? "";
		match(block, new RegExp(`^read src/a\\.ts lines=40 sha256=${short(`${helpers(40)}\n`)}$`, "m"));
		match(block, /^grep `\^export function` src\/a\.ts: 40 matches call=call_grep$/m);
		match(block, /^bash `node check\.mjs`: exit=1, 57 passed, 3 failed, 2 skipped, 62 total call=call_test$/m);
		doesNotMatch(result.summary, /lines=39|<read-files>/);
	});

	it("carries files and results into the next checkpoint and re-measures the files on disk", async () => {
		const first = await compact({ entries: history(), model: model(), keepRecentTokens: 10, cwd });
		writeFileSync(join(cwd, "src/a.ts"), `${helpers(41)}\n`);
		const entries = chain([
			...history(),
			{
				kind: "compactionSummary",
				turnId: "c1",
				parentTurnId: null,
				timestamp,
				summary: first.summary,
				firstKeptTurnId: "u2",
				tokensBefore: 1000,
				messagesSummarized: 8,
			},
			...toolTurn("call_edit", "edit", { path: "src/a.ts", edits: [] }, "edited src/a.ts", {}),
			message("a-edit", "assistant", { content: [{ type: "text", text: "Added a helper." }] }),
			message("u3", "user", { text: "Continue" }),
		]);
		const second = await compact({ entries, model: model(), keepRecentTokens: 10, cwd });
		match(second.summary, new RegExp(`^modified src/a\\.ts lines=41 sha256=${short(`${helpers(41)}\n`)}$`, "m"));
		match(second.summary, /^bash `node check\.mjs`: exit=1, 57 passed, 3 failed, 2 skipped, 62 total call=call_test$/m);
		strictEqual(second.summary.match(/call=call_test/g)?.length, 1);
	});

	it("rides the native provider checkpoint too", async () => {
		const result = await compact({
			entries: history(),
			model: model(),
			cwd,
			providerCheckpointSource: { sessionId: "s1", archive: join(cwd, "archive.jsonl") },
			providerCompaction: async () => ({
				outputJson: "{}",
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				compatibility: { accountScope: "a", provider: "openai-codex", model: "m", protocol: "codex-responses-trigger-v1" },
				initialEffort: "low",
				effectiveEffort: "low",
				policyDigest: "p",
			}),
		});
		ok(result.providerCheckpoint);
		match(result.summary, /^Native Codex checkpoint/);
		match(result.summary, /^read src\/a\.ts lines=40 sha256=[0-9a-f]{12}$/m);
		match(result.summary, /exit=1, 57 passed/);
	});

	it("asks the summarizer to mark its own counts unverified on every route", () => {
		for (const prompt of [
			buildUserText("conversation"),
			buildTurnPrefixUserText("conversation"),
			buildLivePrefixUserText({ retainedFrom: "next" }),
		]) {
			match(prompt, /count or quantity the assistant worked out itself[^\n]*"\(unverified\)"/);
			match(prompt, /do not write one yourself/);
		}
	});
});
