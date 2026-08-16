/**
 * What a worker's block actually looks like in the transcript, driven through
 * the real fold rather than hand-built entry literals: the four shapes the
 * design fixes (human live, human ACP peer, agent folded, agent expanded) plus
 * failure, failover, and placement under the tool call that spawned the run.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	DispatchCompletedPayload,
	DispatchFailedPayload,
	DispatchStartedPayload,
} from "../../src/core/bus-events.js";
import type { ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import { type ChatPanel, createChatPanel } from "../../src/interactive/chat-panel.js";
import { GLYPH } from "../../src/interactive/theme/index.js";
import { createWorkerStream, type WorkerStream } from "../../src/interactive/worker-stream.js";
import { createTestClock } from "../harness/clock.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");
const strip = (text: string): string => text.replace(ANSI, "");

const frozen = createTestClock();

function started(overrides: Partial<DispatchStartedPayload> = {}): DispatchStartedPayload {
	return {
		runId: "r1",
		agentId: "coder",
		requestOrigin: "user",
		targetId: "mini",
		wireModelId: "Nemo-3.5-Lightning",
		runtimeId: "lmstudio",
		runtimeKind: "http",
		pid: 1,
		assignmentId: "r1",
		attempt: 0,
		...overrides,
	};
}

function completed(overrides: Partial<DispatchCompletedPayload> = {}): DispatchCompletedPayload {
	return {
		runId: "r1",
		agentId: "coder",
		requestOrigin: "user",
		targetId: "mini",
		wireModelId: "Nemo-3.5-Lightning",
		runtimeId: "lmstudio",
		runtimeKind: "http",
		outcome: "succeeded",
		outcomeCode: null,
		outcomeDetail: null,
		lineage: { rootRunId: "r1", parentRunId: null, attempt: 0, depth: 0 },
		tokenCount: 4800,
		inputTokenCount: 4000,
		outputTokenCount: 800,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		staticShellHash: null,
		sessionShellHash: null,
		dynamicHash: null,
		costUsd: 0,
		durationMs: 9600,
		exitCode: 0,
		toolActivity: { calls: 3, succeeded: 3, failed: 0, blocked: 0, mutatingSucceeded: false },
		...overrides,
	};
}

function failed(overrides: Partial<DispatchFailedPayload> = {}): DispatchFailedPayload {
	return {
		runId: "r1",
		agentId: "scout",
		requestOrigin: "agent",
		targetId: "mini",
		wireModelId: "Nemo-3.5",
		runtimeId: "lmstudio",
		runtimeKind: "http",
		outcome: "failed",
		outcomeCode: "result_contract_exhausted",
		outcomeDetail: "no conforming result after 3 rounds\ntrailing detail",
		reason: "failed",
		exitCode: 1,
		durationMs: 41_000,
		...overrides,
	};
}

function delta(text: string): unknown {
	return { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } };
}

function messageEnd(text: string): unknown {
	return { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } };
}

interface Harness {
	panel: ChatPanel;
	worker: WorkerStream;
	push: (change: { entry: Parameters<ChatPanel["applyWorkerState"]>[0] } | null) => void;
	render: (width?: number) => string;
}

function harness(options: { expandKey?: string } = {}): Harness {
	const panel = createChatPanel({
		now: frozen.now,
		...(options.expandKey !== undefined ? { getToolExpandKey: () => options.expandKey } : {}),
	});
	// No receipt files exist under a contracts run, so the fold falls back to the
	// terminal payload. The footer facts asserted below are the payload's.
	const worker = createWorkerStream({ readReceipt: () => null });
	return {
		panel,
		worker,
		push: (change) => {
			if (change !== null) panel.applyWorkerState(change.entry);
		},
		render: (width = 96) => strip(panel.render(width).join("\n")),
	};
}

describe("worker transcript blocks", () => {
	it("streams a human-origin run under its own attributed header", () => {
		const h = harness();
		h.panel.appendUser("/run coder say hello");
		h.push(h.worker.started(started()));
		h.push(h.worker.progress({ runId: "r1", agentId: "coder", event: delta("Hello! I'm the coder worker.") }));
		h.push(
			h.worker.progress({ runId: "r1", agentId: "coder", event: { type: "clio_tool_start", payload: { tool: "read" } } }),
		);
		const live = h.render();
		ok(live.includes(`${GLYPH.workerHuman} you → coder · mini/Nemo-3.5-Lightning · run r1`), live);
		ok(live.includes("│ Hello! I'm the coder worker."), live);
		ok(live.includes(`│ ${GLYPH.phaseTool} read`), live);
		ok(live.includes("└ ● running"), live);

		h.push(h.worker.completed(completed()));
		const settled = h.render();
		ok(settled.includes(`└ ${GLYPH.ok} ok · 4.8k tok · 9.6s`), settled);
		ok(!settled.includes("running"), settled);
	});

	it("renders an ACP peer with the same body and a protocol-named header", () => {
		const h = harness();
		h.push(
			h.worker.started(
				started({ runId: "r7", assignmentId: "r7", agentId: "codex", runtimeKind: "acp-delegation", runtimeId: "acp" }),
			),
		);
		h.push(h.worker.progress({ runId: "r7", agentId: "codex", event: messageEnd("patched the header") }));
		h.push(
			h.worker.completed(
				completed({
					runId: "r7",
					agentId: "codex",
					runtimeKind: "acp-delegation",
					runtimeId: "acp",
					// An ACP peer reports no token usage of its own; the footer names
					// the calls it mediated instead of claiming it spent nothing.
					tokenCount: 0,
					durationMs: 41_000,
				}),
			),
		);
		const rendered = h.render();
		ok(rendered.includes(`${GLYPH.workerHuman} you → codex · (acp) · run r7`), rendered);
		ok(rendered.includes("│ patched the header"), rendered);
		ok(rendered.includes(`└ ${GLYPH.ok} ok · 3 tool calls · 41s`), rendered);
	});

	it("folds an agent-origin card to one row and expands it on demand", () => {
		const h = harness({ expandKey: "Ctrl+O" });
		h.push(
			h.worker.started(
				started({ requestOrigin: "agent", agentId: "scout", targetId: "zbook", wireModelId: "gemma-4-26b" }),
			),
		);
		h.push(h.worker.progress({ runId: "r1", agentId: "scout", event: messageEnd("three candidate files") }));
		h.push(h.worker.completed(completed({ requestOrigin: "agent", agentId: "scout", durationMs: 41_000 })));

		const folded = h.render();
		ok(folded.includes(`${GLYPH.workerAgent} agent → scout · zbook/gemma-4-26b · run r1`), folded);
		ok(folded.includes(`${GLYPH.ok} ok 41s`), folded);
		ok(folded.includes("[Ctrl+O expand]"), folded);
		ok(!folded.includes("three candidate files"), folded);

		strictEqual(h.panel.toggleLastToolExpanded(), true);
		const expanded = h.render();
		ok(expanded.includes("│ three candidate files"), expanded);
		ok(expanded.includes(`└ ${GLYPH.ok} ok · 4.8k tok · 41s`), expanded);
		ok(!expanded.includes("[Ctrl+O expand]"), expanded);
	});

	it("reports a failure with its outcome code, exit status, and first detail line", () => {
		const h = harness();
		h.push(h.worker.started(started({ requestOrigin: "agent", agentId: "scout" })));
		h.push(h.worker.failed(failed()));
		strictEqual(h.panel.toggleLastToolExpanded(), true);
		// Wide enough that the footer does not wrap; the failure text wraps rather
		// than truncating, which is asserted separately below.
		const rendered = h.render(160);
		ok(rendered.includes(`└ ${GLYPH.error} result_contract_exhausted · exit=1`), rendered);
		ok(rendered.includes("no conforming result after 3 rounds"), rendered);
		ok(!rendered.includes("trailing detail"), rendered);
		// A narrow terminal must still show the whole reason: a footer that cut it
		// would report that something failed while hiding what.
		ok(h.render(60).replace(/\s+/g, " ").includes("no conforming result after 3 rounds"), h.render(60));
	});

	it("keeps a failover in one block with a single attempt rail line", () => {
		const h = harness();
		h.push(h.worker.started(started()));
		h.push(h.worker.progress({ runId: "r1", agentId: "coder", event: delta("first attempt") }));
		// The sequence the domain publishes: the first attempt seals as failed,
		// then the retry starts under the same assignment as an internal-origin
		// request, and its terminal event carries that origin too.
		h.push(h.worker.failed(failed({ runId: "r1", agentId: "coder", requestOrigin: "user" })));
		h.push(
			h.worker.started(
				started({
					runId: "r2",
					attempt: 1,
					assignmentId: "r1",
					requestOrigin: "internal",
					targetId: "dynamo",
					wireModelId: "qwen3",
				}),
			),
		);
		ok(h.render().includes("● attempt 2"), `the block reopens for the retry:\n${h.render()}`);
		h.push(h.worker.completed(completed({ runId: "r2", requestOrigin: "internal" })));
		const rendered = h.render();
		strictEqual(rendered.split(GLYPH.workerHuman).length - 1, 1, `exactly one worker block:\n${rendered}`);
		ok(rendered.includes("↻ failed over → attempt 2 on dynamo/qwen3"), rendered);
		ok(rendered.includes(`└ ${GLYPH.ok} ok`), `sealed by the attempt that finished:\n${rendered}`);
	});

	it("nests agent-origin cards under the tool call that spawned them, in spawn order", () => {
		const h = harness();
		h.panel.appendUser("find the slow path");
		h.panel.applyEvent({ type: "text_delta", delta: "Scouting." } as ChatLoopEvent);
		h.panel.applyEvent({
			type: "tool_execution_start",
			toolCallId: "call_1",
			toolName: "dispatch",
			args: { mode: "parallel" },
		} as ChatLoopEvent);
		for (const index of [1, 2, 3]) {
			h.push(
				h.worker.started(
					started({
						runId: `s${index}`,
						assignmentId: `s${index}`,
						requestOrigin: "agent",
						agentId: `scout-${index}`,
						parentToolCallId: "call_1",
					}),
				),
			);
		}
		h.panel.applyEvent({ type: "text_delta", delta: "Three scouts are out." } as ChatLoopEvent);
		const rendered = h.render();
		const cardOrder = [1, 2, 3].map((index) => rendered.indexOf(`agent → scout-${index}`));
		deepStrictEqual(
			cardOrder,
			[...cardOrder].sort((a, b) => a - b),
			`cards render in spawn order:\n${rendered}`,
		);
		ok(rendered.indexOf("dispatch") < (cardOrder[0] ?? -1), `cards sit under the tool segment:\n${rendered}`);
		ok(rendered.indexOf("Three scouts are out.") > (cardOrder[2] ?? 0), `later narration sits below:\n${rendered}`);
	});

	it("never lets a worker's tool arguments reach the transcript", () => {
		const h = harness();
		h.push(h.worker.started(started()));
		h.push(
			h.worker.progress({
				runId: "r1",
				agentId: "coder",
				event: { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "/etc/shadow" } },
			}),
		);
		h.push(
			h.worker.progress({ runId: "r1", agentId: "coder", event: { type: "clio_tool_start", payload: { tool: "read" } } }),
		);
		const rendered = h.render();
		ok(rendered.includes(`${GLYPH.phaseTool} read`), rendered);
		ok(!rendered.includes("/etc/shadow"), rendered);
	});

	it("points to /view when the live tail dropped lines", () => {
		const h = harness();
		h.push(h.worker.started(started()));
		for (let index = 0; index < 60; index += 1) {
			h.push(h.worker.progress({ runId: "r1", agentId: "coder", event: delta(`line ${index}\n`) }));
		}
		const rendered = h.render();
		ok(/… \d+ more lines, \/view dispatch:r1/.test(rendered), rendered);
	});

	it("restores the origin default fold on replay collapse, not a blanket fold", () => {
		const h = harness();
		h.push(h.worker.started(started()));
		h.push(h.worker.started(started({ runId: "a1", assignmentId: "a1", requestOrigin: "agent", agentId: "scout" })));
		h.panel.collapseAllTools();
		const rendered = h.render();
		ok(rendered.includes(`${GLYPH.workerHuman} you → coder`), rendered);
		ok(rendered.includes("└ ● running"), `the operator's own run stays open:\n${rendered}`);
		ok(rendered.includes(`${GLYPH.workerAgent} agent → scout`), rendered);
		strictEqual(rendered.split("● running").length - 1, 2, `one open block, one folded row:\n${rendered}`);
	});
});
