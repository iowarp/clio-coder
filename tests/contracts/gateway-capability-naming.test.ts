/**
 * "Name the capability": wherever a person or an external consumer reads tool
 * activity, a gateway op=call reads as the capability it ran, as a direct call
 * read in v056, with a marker that it went through the gateway. A chain keeps
 * its own gateway entry and adds one child entry per settled step, linked to
 * the parent call. The provider and the ledger keep the wire name `gateway`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHeadlessJsonProjector, projectHeadlessJsonEvent } from "../../src/cli/modes/json-stream.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import { writeTranscriptExport } from "../../src/domains/session/transcript-export.js";
import { buildTurnPreview } from "../../src/domains/session/tree/preview.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import type { ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import { createInteractiveEventProjection } from "../../src/interactive/interactive-event-projection.js";
import {
	renderToolExecution,
	renderToolPreview,
	type ToolExecutionFinished,
	toolRowTitle,
} from "../../src/interactive/renderers/tool-execution.js";
import { transcriptDetail } from "../../src/interactive/transcript-detail.js";

const event = (value: Record<string, unknown>): ChatLoopEvent => value as unknown as ChatLoopEvent;
const plain = (rows: readonly string[]): string[] => rows.map((row) => stripTerminalSequences(row));

const bashArgs = { command: "npm test" };
const gatewayBashArgs = { op: "call", capability: "bash", args: bashArgs };
const bashResult = { content: [{ type: "text", text: "ok\nall good" }], details: { exitCode: 0 } };

const admitted = (actionClass: string, outcome: "ok" | "error") => ({
	chainAdmission: { outcome, decision: "allowed", actionClass },
});

const chainArgs = {
	op: "chain",
	steps: [
		{ id: "a", capability: "grep", args: { pattern: "TODO", path: "src" } },
		{ id: "b", capability: "bash", args: bashArgs },
		{ id: "c", capability: "ls", args: { path: "docs" } },
	],
};
const chainResult = {
	content: [{ type: "text", text: '{"status":"failed","results":[],"pending":["c"]}' }],
	details: {
		op: "chain",
		steps: [
			{ id: "a", capability: "grep", kind: "ok", truncated: true },
			{ id: "b", capability: "bash", kind: "error", truncated: false },
		],
		pending: ["c"],
		chainResults: [
			{
				id: "a",
				capability: "grep",
				args: { pattern: "TODO", path: "src" },
				isError: false,
				result: {
					content: [{ type: "text", text: "src/a.ts:1:TODO" }],
					details: { kind: "ok", ...admitted("read", "ok") },
				},
			},
			{
				id: "b",
				capability: "bash",
				args: bashArgs,
				isError: true,
				result: {
					content: [{ type: "text", text: "boom\nbash: command failed (exit 1)" }],
					details: { kind: "error", exitCode: 1, ...admitted("execute", "error") },
				},
			},
		],
	},
};

test("json stream: a gateway op=call crosses as the capability it ran, marked via gateway", () => {
	const projector = createHeadlessJsonProjector();
	assert.deepEqual(
		projector.project(
			event({ type: "tool_execution_start", toolCallId: "call_1", toolName: "gateway", args: gatewayBashArgs }),
		),
		[{ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: bashArgs, via: "gateway" }],
	);
	const partialResult = { content: [{ type: "text", text: "ok" }] };
	assert.deepEqual(
		projector.project(
			event({
				type: "tool_execution_update",
				toolCallId: "call_1",
				toolName: "gateway",
				args: gatewayBashArgs,
				partialResult,
			}),
		),
		[
			{
				type: "tool_execution_update",
				toolCallId: "call_1",
				toolName: "bash",
				args: bashArgs,
				partialResult,
				via: "gateway",
			},
		],
	);
	const result = { ...bashResult, details: { ...bashResult.details, capability: "bash" } };
	assert.deepEqual(
		projector.project(
			event({
				type: "tool_execution_end",
				toolCallId: "call_1",
				toolName: "gateway",
				result,
				isError: false,
				outcome: "ok",
			}),
		),
		[
			{
				type: "tool_execution_end",
				toolCallId: "call_1",
				toolName: "bash",
				result,
				isError: false,
				outcome: "ok",
				via: "gateway",
			},
		],
	);
});

test("json stream: a refused capability's end frame keeps the name its start frame carried", () => {
	const projector = createHeadlessJsonProjector();
	projector.project(
		event({ type: "tool_execution_start", toolCallId: "call_2", toolName: "gateway", args: gatewayBashArgs }),
	);
	// A blocked nested call returns no `details.capability`, so the frame alone cannot name it.
	const refused = { content: [{ type: "text", text: "blocked" }], details: { nestedBlockedVerdict: {} } };
	const [frame] = projector.project(
		event({ type: "tool_execution_end", toolCallId: "call_2", toolName: "gateway", result: refused, isError: true }),
	);
	assert.deepEqual(frame, {
		type: "tool_execution_end",
		toolCallId: "call_2",
		toolName: "bash",
		result: refused,
		isError: true,
		via: "gateway",
	});
});

test("json stream: direct calls, find and the chain's own frames keep their v056 shape", () => {
	const direct = event({ type: "tool_execution_start", toolCallId: "d", toolName: "bash", args: bashArgs });
	assert.equal(projectHeadlessJsonEvent(direct), direct);
	const find = event({
		type: "tool_execution_start",
		toolCallId: "f",
		toolName: "gateway",
		args: { op: "find", query: "git" },
	});
	assert.equal(projectHeadlessJsonEvent(find), find);
	const chainStart = event({ type: "tool_execution_start", toolCallId: "c", toolName: "gateway", args: chainArgs });
	assert.deepEqual(createHeadlessJsonProjector().project(chainStart), [chainStart]);
});

test("json stream: a chain's end frame is followed by a start/end pair per settled step", () => {
	const projector = createHeadlessJsonProjector();
	const end = event({
		type: "tool_execution_end",
		toolCallId: "call_3",
		toolName: "gateway",
		result: chainResult,
		isError: true,
		outcome: "error",
	});
	const frames = projector.project(end);
	assert.equal(frames.length, 5);
	assert.equal(frames[0], end);
	const [grep, bash] = chainResult.details.chainResults;
	assert.deepEqual(frames.slice(1), [
		{
			type: "tool_execution_start",
			toolCallId: "call_3:a",
			parentToolCallId: "call_3",
			toolName: "grep",
			args: grep?.args,
			via: "gateway",
		},
		{
			type: "tool_execution_end",
			toolCallId: "call_3:a",
			parentToolCallId: "call_3",
			toolName: "grep",
			result: grep?.result,
			isError: false,
			via: "gateway",
			outcome: "ok",
			actionClass: "read",
			decision: "allowed",
		},
		{
			type: "tool_execution_start",
			toolCallId: "call_3:b",
			parentToolCallId: "call_3",
			toolName: "bash",
			args: bashArgs,
			via: "gateway",
		},
		{
			type: "tool_execution_end",
			toolCallId: "call_3:b",
			parentToolCallId: "call_3",
			toolName: "bash",
			result: bash?.result,
			isError: true,
			via: "gateway",
			outcome: "error",
			actionClass: "execute",
			decision: "allowed",
		},
	]);
});

test("tui: a gateway op=call row reads as the direct capability row plus via gateway", () => {
	const direct: ToolExecutionFinished = {
		toolCallId: "d",
		toolName: "bash",
		args: bashArgs,
		result: bashResult,
		isError: false,
		durationMs: 1200,
	};
	const gateway: ToolExecutionFinished = {
		...direct,
		toolName: "gateway",
		args: gatewayBashArgs,
		result: { ...bashResult, details: { ...bashResult.details, capability: "bash" } },
	};
	const detail = transcriptDetail("detailed");
	const directRows = plain(renderToolPreview(direct, 100, detail));
	const gatewayRows = plain(renderToolPreview(gateway, 100, detail));
	assert.equal(directRows[0], "$ ran `npm test` · exit 0 · 2 lines ✓ · 1.2s");
	assert.equal(gatewayRows[0], "$ ran `npm test` · exit 0 · 2 lines · via gateway ✓ · 1.2s");
	assert.deepEqual(gatewayRows.slice(1), directRows.slice(1));
	assert.equal(toolRowTitle(gateway), "$ ran `npm test` · exit 0 · 2 lines · via gateway");
	// The expanded body echoes the command and states the default exit status, as a direct bash call does.
	// With no structured exit code a settled bash call states the default `exit 0`.
	const expanded = plain(
		renderToolExecution({ ...gateway, result: { content: bashResult.content, details: { capability: "bash" } } }, 100, {
			unbounded: true,
		}),
	);
	assert.ok(expanded.some((row) => row.includes("output · exit 0")));
	assert.ok(expanded.some((row) => row.includes("$ npm test")));
	assert.ok(!expanded.some((row) => row.includes("capability")));
	// A running call streams its partial output under the capability's own row.
	const running = plain(
		renderToolPreview({ toolCallId: "g", toolName: "gateway", args: gatewayBashArgs, phase: "running" }, 100, detail, {
			partialResult: { content: [{ type: "text", text: "partial line" }] },
		}),
	);
	assert.match(running[0] ?? "", /^\$ running `npm test` · via gateway/u);
	assert.ok(running.some((row) => row.includes("partial line")));
});

test("tui: a chain is one row that lists each step with its status, capability and key argument", () => {
	const chain: ToolExecutionFinished = {
		toolCallId: "c",
		toolName: "gateway",
		args: chainArgs,
		result: chainResult,
		isError: true,
		durationMs: 3000,
	};
	const rows = plain(renderToolPreview(chain, 100, transcriptDetail("standard")));
	assert.match(rows[0] ?? "", /chained 3 steps · 1 failed · 1 not run ✗ · 3\.0s$/u);
	// The chain's own cut of a step's output is a fact on that step's row.
	assert.ok(rows.some((row) => row.includes("✓ grep `TODO` in src · truncated")));
	assert.ok(rows.some((row) => row.includes("✗ bash `npm test` · exit 1")));
	assert.ok(rows.some((row) => row.includes("◌ ls docs · not run")));
	// The failing step's output is the body; the aggregate JSON and the steps argument never are.
	assert.ok(rows.some((row) => row.includes("boom")));
	assert.ok(!rows.some((row) => row.includes('"status"') || row.includes("steps ›")));
	const running = plain(
		renderToolPreview(
			{ toolCallId: "c", toolName: "gateway", args: chainArgs, phase: "running" },
			100,
			transcriptDetail(),
		),
	);
	assert.match(running[0] ?? "", /chaining 3 steps/u);
	assert.equal(running.filter((row) => row.includes("◌ ")).length, 3);
});

test("tree preview and transcript export name the capability and each chain step", () => {
	assert.equal(
		buildTurnPreview({ kind: "tool_call", payload: { toolCallId: "g", name: "gateway", args: gatewayBashArgs } }),
		'bash("npm test") via gateway',
	);
	assert.equal(
		buildTurnPreview({ kind: "tool_call", payload: { toolCallId: "c", name: "gateway", args: chainArgs } }),
		"gateway chain(grep, bash, ls)",
	);
	assert.equal(
		buildTurnPreview({
			kind: "assistant",
			payload: { content: [{ type: "toolCall", id: "g", name: "gateway", arguments: gatewayBashArgs }] },
		}),
		"(tool calls) bash",
	);

	const at = "2026-09-26T09:00:00.000Z";
	const message = (turnId: string, parentTurnId: string | null, role: string, payload: unknown): SessionEntry =>
		({ kind: "message", turnId, parentTurnId, timestamp: at, role, payload }) as SessionEntry;
	const entries = [
		message("u1", null, "user", { text: "check" }),
		message("t1", "u1", "tool_call", { toolCallId: "g", name: "gateway", args: gatewayBashArgs }),
		// A refused capability's result names no capability; it takes its call's name.
		message("t2", "t1", "tool_result", { toolCallId: "g", toolName: "gateway", result: bashResult, isError: true }),
		message("t3", "t2", "tool_call", { toolCallId: "c", name: "gateway", args: chainArgs }),
		message("t4", "t3", "tool_result", { toolCallId: "c", toolName: "gateway", result: chainResult, isError: true }),
	];
	const dir = mkdtempSync(join(tmpdir(), "clio-coder-gateway-export-"));
	const written = writeTranscriptExport({
		sessionId: "s1",
		leafTurnId: () => null,
		readEntries: () => entries,
		cwd: dir,
		path: "out.md",
	});
	assert.equal(written.level, "success");
	const markdown = readFileSync(join(dir, "out.md"), "utf8");
	assert.ok(markdown.includes("**Tool call:** `bash` via gateway"));
	assert.ok(markdown.includes("**Failed:** `bash` via gateway"));
	assert.ok(markdown.includes('"command": "npm test"'));
	assert.ok(!markdown.includes('"op": "call"'));
	// The chain keeps its own gateway call and result, then each settled step follows as its own.
	assert.ok(markdown.includes("**Tool call:** `gateway`\n"));
	assert.ok(markdown.includes("**Tool call:** `grep` via gateway"));
	assert.ok(markdown.includes("**Result:** `grep` via gateway"));
	assert.ok(markdown.indexOf("**Failed:** `gateway`") < markdown.indexOf("**Tool call:** `grep` via gateway"));
});

test("footer tallies count the capability a gateway call ran and each settled chain step", () => {
	const noop = (): void => undefined;
	const handlers: Array<(event: ChatLoopEvent) => void> = [];
	const starts: string[] = [];
	const ends: Array<[string, string, boolean]> = [];
	const projection = createInteractiveEventProjection({
		bus: createSafeEventBus(),
		chat: {
			onEvent: (handler) => {
				handlers.push(handler);
				return noop;
			},
			cancel: noop,
		},
		status: { subscribe: () => noop },
		getTerminalColumns: () => 80,
		applyChatEvent: noop,
		setFollowUpMessages: noop,
		isAskUserWaiting: () => false,
		closeAskUserSession: noop,
		resetAskUserCancellation: noop,
		recordToolStart: (toolName) => starts.push(toolName),
		recordToolEnd: (toolName, toolCallId, isError) => ends.push([toolName, toolCallId, isError]),
		setLastTurnSummary: noop,
		startTerminalProgress: noop,
		stopTerminalProgress: noop,
		refreshLiveWorkspaceGit: noop,
		refreshFooter: noop,
		requestRender: noop,
		notify: noop,
		dismissNotification: noop,
		appendTranscriptNotice: noop,
		refreshSettingsOverlay: noop,
	});
	const emit = (value: Record<string, unknown>): void => {
		for (const handler of handlers) handler(event(value));
	};
	emit({ type: "tool_execution_start", toolCallId: "g", toolName: "gateway", args: gatewayBashArgs });
	emit({
		type: "tool_execution_end",
		toolCallId: "g",
		toolName: "gateway",
		result: { ...bashResult, details: { capability: "bash" } },
		isError: false,
	});
	emit({ type: "tool_execution_start", toolCallId: "c", toolName: "gateway", args: chainArgs });
	emit({ type: "tool_execution_end", toolCallId: "c", toolName: "gateway", result: chainResult, isError: true });
	assert.deepEqual(starts, ["bash", "gateway", "grep", "bash"]);
	// The chain failed through its bash step, so the failure is counted once, on that step.
	assert.deepEqual(ends, [
		["bash", "g", false],
		["gateway", "c", false],
		["grep", "c:a", false],
		["bash", "c:b", true],
	]);
	projection.dispose();
});
