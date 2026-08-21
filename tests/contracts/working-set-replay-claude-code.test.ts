import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_WORKING_SET_SETTINGS } from "../../src/domains/context/working-set/defaults.js";
import { buildPathIndex } from "../../src/domains/context/working-set/path-index.js";
import { resolveWorkingSetPolicy } from "../../src/domains/context/working-set/policies/index.js";
import {
	detectReplayInputFormat,
	loadClaudeCodeTraces,
	loadReplayTraces,
} from "../../src/domains/context/working-set/replay/load-claude-code.js";
import { buildReferenceGraph } from "../../src/domains/context/working-set/replay/reference-graph.js";
import { replayTrace } from "../../src/domains/context/working-set/replay/runner.js";
import type { Trace } from "../../src/domains/context/working-set/replay/trace.js";
import type { MessageEntry } from "../../src/domains/session/entries.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/context-replay/claude-code-01.jsonl", import.meta.url));
const CLIO_FIXTURE = fileURLToPath(new URL("../fixtures/context-replay/fixture-01.jsonl", import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messages(trace: Trace, role: MessageEntry["role"]): MessageEntry[] {
	return trace.entries.filter((entry): entry is MessageEntry => entry.kind === "message" && entry.role === role);
}

function payload(entry: MessageEntry): Record<string, unknown> {
	assert.ok(isRecord(entry.payload));
	return entry.payload;
}

function callById(trace: Trace, id: string): MessageEntry {
	const entry = messages(trace, "tool_call").find((candidate) => payload(candidate).toolCallId === id);
	assert.ok(entry, `missing tool call ${id}`);
	return entry;
}

function resultById(trace: Trace, id: string): MessageEntry {
	const entry = messages(trace, "tool_result").find((candidate) => payload(candidate).toolCallId === id);
	assert.ok(entry, `missing tool result ${id}`);
	return entry;
}

async function fixture(): Promise<Trace> {
	const loaded = await loadClaudeCodeTraces([FIXTURE]);
	assert.deepEqual(loaded.cascade, {
		found: 1,
		unreadable: 0,
		filtered: {
			sidechain_or_subagent: 0,
			summary_only: 0,
			turns_lt_8: 0,
			tool_results_lt_8: 0,
			no_file_reread: 0,
		},
		kept: 1,
	});
	const trace = loaded.traces[0];
	assert.ok(trace);
	return trace;
}

describe("contracts/working-set Claude Code replay loader", () => {
	it("converts provider records into stable, linearly chained Clio messages", async () => {
		const trace = await fixture();
		assert.equal(trace.id, "claude-code-replay-fixture-01");
		assert.equal(trace.cwd, "/fixture/claude-code-repo");
		assert.equal(trace.turnCount, 15);
		assert.equal(trace.entries.length, 56);
		assert.equal(trace.entries[0]?.kind, "message");
		for (let index = 0; index < trace.entries.length; index += 1) {
			const entry = trace.entries[index];
			assert.ok(entry);
			assert.equal(entry.turnId, `cc-${String(index).padStart(6, "0")}`);
			assert.equal(entry.parentTurnId, index === 0 ? null : trace.entries[index - 1]?.turnId);
		}
		assert.equal(JSON.stringify(trace.entries).includes("sidechain-only record"), false);

		assert.deepEqual(
			{
				user: messages(trace, "user").length,
				assistant: messages(trace, "assistant").length,
				toolCall: messages(trace, "tool_call").length,
				toolResult: messages(trace, "tool_result").length,
			},
			{ user: 15, assistant: 15, toolCall: 13, toolResult: 13 },
		);
	});

	it("normalizes tool names, argument keys, content shapes, usage, and pairing", async () => {
		const trace = await fixture();
		const readCall = callById(trace, "tool-read-a");
		assert.deepEqual(payload(readCall), {
			toolCallId: "tool-read-a",
			name: "read",
			args: { path: "src/a.ts", offset: 2, limit: 40, __claudeCodeTool: "Read" },
		});
		const grepCall = callById(trace, "tool-grep");
		assert.deepEqual(payload(grepCall), {
			toolCallId: "tool-grep",
			name: "grep",
			args: {
				pattern: "export",
				path: ".",
				__claudeCodeTool: "Grep",
				glob: "src/*.ts",
				mode: "content",
			},
		});
		const editArgs = payload(callById(trace, "tool-edit-a")).args;
		assert.deepEqual(editArgs, {
			path: "src/a.ts",
			__claudeCodeTool: "Edit",
			edits: [{ oldText: "before", newText: "after" }],
		});

		for (const call of messages(trace, "tool_call")) {
			const callPayload = payload(call);
			const id = callPayload.toolCallId;
			assert.equal(typeof id, "string");
			assert.equal(payload(resultById(trace, id as string)).toolName, callPayload.name);
		}
		const readResult = resultById(trace, "tool-read-a");
		const readResultPayload = payload(readResult);
		assert.equal(readResultPayload.isError, false);
		assert.ok(isRecord(readResultPayload.result));
		assert.equal(Array.isArray(readResultPayload.result.content), true);
		assert.ok(trace.entries.indexOf(readCall) < trace.entries.indexOf(readResult));
		assert.equal(trace.entries[trace.entries.indexOf(readResult) + 1]?.kind, "message");
		assert.equal((trace.entries[trace.entries.indexOf(readResult) + 1] as MessageEntry).role, "user");
		assert.equal(payload(resultById(trace, "tool-bash-fail")).isError, true);

		const firstAssistant = messages(trace, "assistant")[0];
		assert.ok(firstAssistant);
		const assistantPayload = payload(firstAssistant);
		assert.equal(Array.isArray(assistantPayload.content), true);
		assert.equal((assistantPayload.content as Array<Record<string, unknown>>)[0]?.type, "thinking");
		assert.deepEqual(assistantPayload.usage, {
			input: 100,
			output: 20,
			cacheRead: 80,
			cacheWrite: 5,
			reasoning: 0,
			totalTokens: 205,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
	});

	it("feeds cwd-aware normalized calls into the unchanged path index", async () => {
		const trace = await fixture();
		const index = buildPathIndex(trace.entries, { cwd: trace.cwd });
		const read = index.byRef.get(resultById(trace, "tool-read-a").turnId);
		assert.deepEqual(read, {
			ref: { entry: resultById(trace, "tool-read-a").turnId },
			toolCallId: "tool-read-a",
			toolName: "read",
			op: "read",
			path: "/fixture/claude-code-repo/src/a.ts",
			range: { offset: 1, limit: 40 },
			surfaced: [],
			isError: false,
			isBlocked: false,
			turnIndex: 1,
			entryIndex: trace.entries.indexOf(resultById(trace, "tool-read-a")),
			argsKey: '{"__claudeCodeTool":"Read","limit":40,"offset":2,"path":"src/a.ts"}',
		});
		const grep = index.byRef.get(resultById(trace, "tool-grep").turnId);
		assert.deepEqual(grep?.surfaced, ["/fixture/claude-code-repo/src/b.ts", "/fixture/claude-code-repo/src/c.ts"]);
		const edit = index.byRef.get(resultById(trace, "tool-edit-a").turnId);
		assert.equal(edit?.op, "edit");
		assert.equal(edit?.path, "/fixture/claude-code-repo/src/a.ts");
	});

	it("labels the normalized reread, discovery, and rewrite edges", async () => {
		const trace = await fixture();
		const graph = buildReferenceGraph(trace, buildPathIndex(trace.entries, { cwd: trace.cwd }));
		assert.deepEqual(graph.edges, [
			{ from: resultById(trace, "tool-read-a").turnId, toTurnIndex: 5, kind: "file_rewrite" },
			{ from: resultById(trace, "tool-read-a").turnId, toTurnIndex: 6, kind: "file_reread" },
			{ from: resultById(trace, "tool-grep").turnId, toTurnIndex: 3, kind: "file_discovery" },
			{ from: resultById(trace, "tool-grep").turnId, toTurnIndex: 4, kind: "file_discovery" },
		]);
	});

	it("counts subagent and summary-only files as distinct cascade exclusions", async () => {
		const root = await mkdtemp(join(tmpdir(), "clio-cc-replay-"));
		try {
			const subagents = join(root, "session", "subagents");
			await mkdir(subagents, { recursive: true });
			await writeFile(join(subagents, "agent-fixture.jsonl"), await readFile(FIXTURE, "utf8"), "utf8");
			await writeFile(
				join(root, "summary-only.jsonl"),
				`${JSON.stringify({ type: "summary", summary: "synthetic summary only" })}\n`,
				"utf8",
			);
			const loaded = await loadClaudeCodeTraces([root], { filter: false });
			assert.equal(loaded.cascade.found, 2);
			assert.equal(loaded.cascade.filtered.sidechain_or_subagent, 1);
			assert.equal(loaded.cascade.filtered.summary_only, 1);
			assert.equal(loaded.cascade.kept, 0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("normalizes every declared Claude Code tool mapping", async () => {
		const root = await mkdtemp(join(tmpdir(), "clio-cc-tools-"));
		const transcript = join(root, "tools.jsonl");
		const cases = [
			{
				id: "multi",
				original: "MultiEdit",
				input: { file_path: "a.ts", edits: [{ old_string: "a", new_string: "b" }] },
				name: "edit",
				args: {
					path: "a.ts",
					edits: [{ oldText: "a", newText: "b" }],
					__claudeCodeTool: "MultiEdit",
				},
			},
			{
				id: "write",
				original: "Write",
				input: { file_path: "b.ts", content: "body" },
				name: "write",
				args: { path: "b.ts", content: "body", __claudeCodeTool: "Write" },
			},
			{
				id: "glob",
				original: "Glob",
				input: { pattern: "**/*.ts", path: "src" },
				name: "find",
				args: { pattern: "**/*.ts", path: "src", __claudeCodeTool: "Glob" },
			},
			{
				id: "ls",
				original: "LS",
				input: { path: "src" },
				name: "ls",
				args: { path: "src", __claudeCodeTool: "LS" },
			},
			{
				id: "bash",
				original: "Bash",
				input: { command: "npm test", timeout: 1234 },
				name: "bash",
				args: { command: "npm test", timeout_ms: 1234, __claudeCodeTool: "Bash" },
			},
			{
				id: "web",
				original: "WebFetch",
				input: { url: "https://example.test", prompt: "extract" },
				name: "web_fetch",
				args: { url: "https://example.test", prompt: "extract", __claudeCodeTool: "WebFetch" },
			},
			{
				id: "task",
				original: "Task",
				input: { prompt: "inspect", subagent_type: "scout", description: "map" },
				name: "dispatch",
				args: { task: "inspect", agent: "scout", briefing: "map", __claudeCodeTool: "Task" },
			},
			{
				id: "todos",
				original: "TodoWrite",
				input: {
					todos: [
						{ content: "one", status: "pending" },
						{ content: "two", status: "done" },
					],
				},
				name: "tasks",
				args: {
					action: "plan",
					title: "Claude Code todos",
					tasks: ["one", "two"],
					__claudeCodeTool: "TodoWrite",
				},
			},
			{
				id: "notebook",
				original: "NotebookEdit",
				input: { notebook_path: "notes.ipynb", new_source: "print(1)", edit_mode: "replace" },
				name: "edit",
				args: {
					path: "notes.ipynb",
					new_source: "print(1)",
					edit_mode: "replace",
					__claudeCodeTool: "NotebookEdit",
				},
			},
			{
				id: "unknown",
				original: "FutureTool",
				input: { opaque: 7 },
				name: "futuretool",
				args: { opaque: 7, __claudeCodeTool: "FutureTool" },
			},
		] as const;
		try {
			const records = [
				{
					type: "assistant",
					sessionId: "tool-mapping",
					cwd: "/fixture/tools",
					timestamp: "2026-08-21T00:00:00.000Z",
					message: {
						content: cases.map((item) => ({ type: "tool_use", id: item.id, name: item.original, input: item.input })),
					},
				},
				{
					type: "user",
					timestamp: "2026-08-21T00:00:01.000Z",
					message: {
						content: cases.map((item) => ({
							type: "tool_result",
							tool_use_id: item.id,
							content: `${item.id} result`,
						})),
					},
				},
			];
			await writeFile(transcript, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
			const loaded = await loadClaudeCodeTraces([transcript], { filter: false });
			const trace = loaded.traces[0];
			assert.ok(trace);
			for (const item of cases) {
				assert.deepEqual(payload(callById(trace, item.id)), {
					toolCallId: item.id,
					name: item.name,
					args: item.args,
				});
				assert.deepEqual(payload(resultById(trace, item.id)), {
					toolCallId: item.id,
					toolName: item.name,
					result: { content: [{ type: "text", text: `${item.id} result` }] },
					isError: false,
				});
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("auto discovery ignores Clio sidecars and rejects mid-file corruption", async () => {
		const root = await mkdtemp(join(tmpdir(), "clio-replay-auto-"));
		try {
			const session = join(root, "session");
			await mkdir(session, { recursive: true });
			await writeFile(join(session, "current.jsonl"), await readFile(CLIO_FIXTURE, "utf8"), "utf8");
			await writeFile(join(session, "context-snapshots.jsonl"), '{"snapshot":true}\n', "utf8");
			await writeFile(join(session, "prompt-manifest.jsonl"), '{"manifest":true}\n', "utf8");
			const clio = await loadReplayTraces([root], "auto", { filter: false });
			assert.equal(clio.cascade.found, 1);
			assert.equal(clio.cascade.unreadable, 0);
			assert.equal(clio.cascade.kept, 1);

			const fixtureRaw = await readFile(FIXTURE, "utf8");
			const fixtureLines = fixtureRaw.trimEnd().split("\n");
			const corrupt = join(root, "corrupt.jsonl");
			await writeFile(corrupt, `${fixtureLines[0]}\nnot-json\n${fixtureLines[1]}\n`, "utf8");
			const rejected = await loadClaudeCodeTraces([corrupt], { filter: false });
			assert.equal(rejected.cascade.unreadable, 1);
			assert.equal(rejected.cascade.kept, 0);

			const partial = join(root, "partial-final.jsonl");
			await writeFile(partial, `${fixtureRaw}{"type":"assistant"`, "utf8");
			const recovered = await loadClaudeCodeTraces([partial], { filter: false });
			assert.equal(recovered.cascade.unreadable, 0);
			assert.equal(recovered.cascade.kept, 1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("auto-detects Claude Code and drives one live age-horizon eviction", async () => {
		const raw = await readFile(FIXTURE, "utf8");
		assert.equal(detectReplayInputFormat(raw), "claude-code");
		const loaded = await loadReplayTraces([FIXTURE], "auto");
		const trace = loaded.traces[0];
		assert.ok(trace);
		const replay = replayTrace(trace, resolveWorkingSetPolicy("age-horizon"), {
			policyId: "age-horizon",
			budgetTokens: 10_000,
			threshold: 0.8,
			target: 0.6,
			settings: DEFAULT_WORKING_SET_SETTINGS,
			seed: 0,
		});
		assert.equal(replay.events.length, 1);
		assert.equal(replay.entries.filter((entry) => entry.kind === "contextEviction").length, 1);
	});
});
