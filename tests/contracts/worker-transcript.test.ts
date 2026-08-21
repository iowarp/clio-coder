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
		ok(live.includes(`${GLYPH.workerHuman} coder · mini/Nemo-3.5-Lightning · run r1`), live);
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
		ok(rendered.includes(`${GLYPH.workerHuman} codex (acp) · run r7`), rendered);
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
		// One row shaped like a tool subline: identity, glyph, elapsed, the chord.
		ok(folded.includes(`${GLYPH.workerAgent} scout · zbook/gemma-4-26b · run r1 ${GLYPH.ok} · 41s (Ctrl+O)`), folded);
		ok(!folded.includes("three candidate files"), folded);

		strictEqual(h.panel.toggleLastToolExpanded(), true);
		const expanded = h.render();
		ok(expanded.includes("│ three candidate files"), expanded);
		ok(expanded.includes(`└ ${GLYPH.ok} ok · 4.8k tok · 41s`), expanded);
		ok(!expanded.includes("(Ctrl+O)"), expanded);
	});

	it("gives identity the row before elapsed, and cuts identity last, at 40 columns", () => {
		const h = harness({ expandKey: "Ctrl+O" });
		h.push(
			h.worker.started(
				started({ requestOrigin: "agent", agentId: "scout-3", targetId: "zbook", wireModelId: "gemma-4-26b" }),
			),
		);
		h.push(h.worker.completed(completed({ requestOrigin: "agent", agentId: "scout-3", durationMs: 41_000 })));
		const narrow = h.render(40);
		ok(
			narrow.split("\n").every((row) => row.length <= 40),
			`inside 40 columns:\n${narrow}`,
		);
		ok(!narrow.includes("41s"), `elapsed is the first unit to go:\n${narrow}`);
		ok(narrow.includes(`${GLYPH.workerAgent} scout-3 · zbook/gemma-4-2`), `the route survives:\n${narrow}`);
		ok(narrow.endsWith(`${GLYPH.ok} (Ctrl+O)`), `status and chord stay whole:\n${narrow}`);
		// A card that carries no chord has the room for the whole identity.
		h.push(h.worker.started(started({ runId: "r2", assignmentId: "r2", requestOrigin: "agent", agentId: "scout-4" })));
		h.push(h.worker.completed(completed({ runId: "r2", requestOrigin: "agent", agentId: "scout-4" })));
		ok(h.render(40).includes(`${GLYPH.workerAgent} scout-3 · zbook/gemma-4-26b · run r1 ${GLYPH.ok}`), h.render(40));
	});

	it("reports a failure with its outcome code and exit status on one footer line, and the reason on the rail", () => {
		const h = harness();
		h.push(h.worker.started(started({ requestOrigin: "agent", agentId: "scout" })));
		h.push(h.worker.failed(failed()));
		// Folded, the card names the outcome code and nothing of the reason.
		ok(h.render().includes(`run r1 ${GLYPH.error} result_contract_exhausted · 41s`), h.render());
		strictEqual(h.panel.toggleLastToolExpanded(), true);
		const rows = h.render(160).split("\n");
		const reason = rows.findIndex((row) => row.includes(`│ ${GLYPH.error} no conforming result after 3 rounds`));
		const footer = rows.findIndex((row) => row.startsWith(`└ ${GLYPH.error} result_contract_exhausted · exit=1 · 41s`));
		ok(reason >= 0 && footer === reason + 1, `reason on the rail, footer under it:\n${rows.join("\n")}`);
		ok(!rows.join("\n").includes("trailing detail"), "only the first line of the reason");
		// The footer never wraps: a narrow terminal closes it on whole units, and
		// the reason still wraps as prose on the rail.
		const narrow = h.render(40).split("\n");
		ok(
			narrow.every((row) => row.length <= 40),
			`inside 40 columns:\n${narrow.join("\n")}`,
		);
		strictEqual(narrow.filter((row) => row.startsWith("└")).length, 1, `one footer row:\n${narrow.join("\n")}`);
		ok(narrow.join(" ").includes("no conforming result after 3 rounds"), narrow.join("\n"));
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
		const cardOrder = [1, 2, 3].map((index) => rendered.indexOf(`${GLYPH.workerAgent} scout-${index}`));
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

	it("draws any run under a tool call as the model's folded card, whatever origin admitted it", () => {
		const h = harness();
		// A scout successor: the operator approved the plan, so admission labels it
		// user origin, but the dispatch call is what spawned it.
		h.push(h.worker.started(started({ runId: "s1", assignmentId: "s1", agentId: "scout", parentToolCallId: "call_1" })));
		h.push(h.worker.progress({ runId: "s1", agentId: "scout", event: messageEnd("successor findings") }));
		h.push(h.worker.completed(completed({ runId: "s1", agentId: "scout" })));
		// A compete judge carries no origin of its own; the domain defaults it to agent.
		h.push(
			h.worker.started(
				started({ runId: "j1", assignmentId: "j1", agentId: "judge", requestOrigin: "agent", parentToolCallId: "call_1" }),
			),
		);
		h.push(h.worker.progress({ runId: "j1", agentId: "judge", event: messageEnd("candidate 2 wins") }));
		h.push(h.worker.completed(completed({ runId: "j1", agentId: "judge", requestOrigin: "agent" })));
		const rendered = h.render();
		ok(rendered.includes(`${GLYPH.workerAgent} scout · mini/Nemo-3.5-Lightning · run s1 ${GLYPH.ok}`), rendered);
		ok(rendered.includes(`${GLYPH.workerAgent} judge · mini/Nemo-3.5-Lightning · run j1 ${GLYPH.ok}`), rendered);
		ok(!rendered.includes(GLYPH.workerHuman), `nothing here is the operator's own run:\n${rendered}`);
		ok(!rendered.includes("successor findings") && !rendered.includes("candidate 2 wins"), `folded:\n${rendered}`);
		h.panel.clearFoldOverrides();
		ok(!h.render().includes("successor findings"), `the settled view stays folded too:\n${h.render()}`);
	});

	it("keeps every row of every shape inside the release width matrix", () => {
		const h = harness({ expandKey: "Ctrl+O" });
		h.push(h.worker.started(started()));
		h.push(h.worker.progress({ runId: "r1", agentId: "coder", event: delta("Hello! I'm the coder worker.") }));
		h.push(
			h.worker.progress({ runId: "r1", agentId: "coder", event: { type: "clio_tool_start", payload: { tool: "read" } } }),
		);
		h.push(
			h.worker.started(
				started({ runId: "r7", assignmentId: "r7", agentId: "codex", runtimeKind: "acp-delegation", runtimeId: "acp" }),
			),
		);
		h.push(h.worker.completed(completed({ runId: "r7", agentId: "codex", tokenCount: 0 })));
		h.push(
			h.worker.started(
				started({ runId: "s1", assignmentId: "s1", requestOrigin: "agent", agentId: "provenance-reviewer" }),
			),
		);
		h.push(h.worker.failed(failed({ runId: "s1", agentId: "provenance-reviewer" })));
		h.push(h.worker.started(started({ runId: "s2", assignmentId: "s2", requestOrigin: "agent", agentId: "scout" })));
		for (const width of [40, 80, 120]) {
			for (const row of h.render(width).split("\n")) {
				ok(row.length <= width, `row ran past ${width} columns (${row.length}): ${JSON.stringify(row)}`);
			}
		}
	});

	it("restores the origin default fold when overrides clear, not a blanket fold", () => {
		const h = harness();
		h.push(h.worker.started(started()));
		h.push(h.worker.started(started({ runId: "a1", assignmentId: "a1", requestOrigin: "agent", agentId: "scout" })));
		strictEqual(h.panel.toggleAllToolsExpanded(), true);
		h.panel.clearFoldOverrides();
		const rendered = h.render();
		ok(rendered.includes(`${GLYPH.workerHuman} coder`), rendered);
		ok(rendered.includes("└ ● running"), `the operator's own run stays open:\n${rendered}`);
		ok(rendered.includes(`${GLYPH.workerAgent} scout`), rendered);
		strictEqual(rendered.split("● running").length - 1, 2, `one open block, one folded row:\n${rendered}`);
	});
});
