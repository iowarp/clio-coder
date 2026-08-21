/**
 * What a worker block leaves behind, and what a resumed session makes of it.
 *
 * The live block is folded from bus events a restarted process no longer has.
 * These cases pin the two artifacts that survive it, the `workerRun` session
 * entry and the sealed receipt, and the shape they rebuild together.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { BusChannels, type DispatchStartedPayload } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { WORKER_OUTPUT_MAX_BYTES } from "../../src/domains/dispatch/event-pump.js";
import { estimateTokens } from "../../src/domains/session/compaction/tokens.js";
import { isSessionEntry, type SessionEntry, type WorkerRunEntry } from "../../src/domains/session/index.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { buildReplayAgentMessagesFromTurns, rehydrateChatPanelFromTurns } from "../../src/interactive/chat-renderer.js";
import { createInteractiveSubscriptions } from "../../src/interactive/interactive-subscriptions.js";
import { GLYPH } from "../../src/interactive/theme/index.js";
import type { WorkerRunEntryFields } from "../../src/interactive/worker-replay.js";
import type { WorkerReceiptFacts } from "../../src/interactive/worker-stream.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g");

function started(overrides: Partial<DispatchStartedPayload> = {}): DispatchStartedPayload {
	return {
		runId: "run-1",
		agentId: "coder",
		requestOrigin: "user",
		targetId: "mini",
		wireModelId: "Nemo-3.5-Lightning",
		runtimeId: "lmstudio",
		runtimeKind: "http",
		pid: 4242,
		assignmentId: "asg-1",
		attempt: 0,
		...overrides,
	};
}

/** The subscriptions wired as the application wires them, collecting what it would persist. */
function recorder(): { bus: ReturnType<typeof createSafeEventBus>; recorded: WorkerRunEntryFields[] } {
	const bus = createSafeEventBus();
	const recorded: WorkerRunEntryFields[] = [];
	createInteractiveSubscriptions({
		bus,
		refreshFooter: () => {},
		renderTaskIsland: () => {},
		renderContextIsland: () => {},
		requestRender: () => {},
		notify: () => {},
		recordWorkerRun: (fields) => recorded.push(fields),
	});
	return { bus, recorded };
}

/** The ledger's own stamping, so a projected entry is validated exactly as it would be written. */
function stamped(fields: WorkerRunEntryFields, turnId: string, timestamp: string): SessionEntry {
	return { ...fields, parentTurnId: null, turnId, timestamp } as SessionEntry;
}

function workerRunEntry(overrides: Partial<WorkerRunEntry> = {}): WorkerRunEntry {
	return {
		kind: "workerRun",
		turnId: "t1",
		parentTurnId: null,
		timestamp: "2026-08-16T10:00:00.000Z",
		assignmentId: "asg-1",
		runId: "run-1",
		origin: "user",
		agentId: "coder",
		runtime: { kind: "clio", targetId: "mini", wireModelId: "Nemo-3.5-Lightning" },
		...overrides,
	};
}

function replayPanel(
	turns: ReadonlyArray<SessionEntry>,
	readWorkerReceipt: (runId: string) => WorkerReceiptFacts | null,
): ReturnType<typeof createChatPanel> {
	const panel = createChatPanel({ getToolExpandKey: () => "Ctrl+O" });
	rehydrateChatPanelFromTurns(panel, turns, { readWorkerReceipt });
	return panel;
}

function replay(
	turns: ReadonlyArray<SessionEntry>,
	readWorkerReceipt: (runId: string) => WorkerReceiptFacts | null,
): string {
	return replayPanel(turns, readWorkerReceipt).render(96).join("\n").replace(ANSI, "");
}

describe("worker-run session entry", () => {
	it("records one entry per attempt, only for the origins that reach the transcript", () => {
		const h = recorder();
		h.bus.emit(BusChannels.DispatchStarted, started());
		h.bus.emit(
			BusChannels.DispatchStarted,
			started({ runId: "wiki-1", assignmentId: "wiki-1", requestOrigin: "internal" }),
		);
		h.bus.emit(BusChannels.DispatchStarted, started({ runId: "s1", assignmentId: "s1", requestOrigin: "agent" }));
		// A failover: same assignment, second attempt, second entry. The trail is
		// history, and history is append-only.
		h.bus.emit(BusChannels.DispatchStarted, started({ runId: "run-2", attempt: 1, targetId: "dynamo" }));

		deepStrictEqual(
			h.recorded.map((fields) => `${fields.origin}:${fields.assignmentId}:${fields.runId}`),
			["user:asg-1:run-1", "agent:s1:s1", "user:asg-1:run-2"],
		);
	});

	it("projects an entry the ledger accepts, carrying identity and route", () => {
		const h = recorder();
		h.bus.emit(BusChannels.DispatchStarted, started({ requestOrigin: "agent", parentToolCallId: "call_1" }));
		const fields = h.recorded[0];
		ok(fields !== undefined);
		const entry = stamped(fields, "t1", "2026-08-16T10:00:00.000Z");
		ok(isSessionEntry(entry), `the ledger rejected its own entry: ${JSON.stringify(entry)}`);
		strictEqual(entry.kind, "workerRun");
		if (entry.kind !== "workerRun") return;
		strictEqual(entry.agentId, "coder");
		strictEqual(entry.parentToolCallId, "call_1");
		deepStrictEqual(entry.runtime, { kind: "clio", targetId: "mini", wireModelId: "Nemo-3.5-Lightning" });
	});

	it("names an ACP peer as its runtime rather than a route it never had", () => {
		const h = recorder();
		h.bus.emit(
			BusChannels.DispatchStarted,
			started({ agentId: "codex", runtimeKind: "acp-delegation", runtimeId: "acp" }),
		);
		const fields = h.recorded[0];
		ok(fields !== undefined);
		const entry = stamped(fields, "t1", "2026-08-16T10:00:00.000Z");
		ok(isSessionEntry(entry));
		if (entry.kind !== "workerRun") return;
		deepStrictEqual(entry.runtime, { kind: "acp", peerId: "codex" });
	});

	it("never persists the worker's prose", () => {
		const h = recorder();
		h.bus.emit(BusChannels.DispatchStarted, started());
		h.bus.emit(BusChannels.DispatchProgress, {
			runId: "run-1",
			agentId: "coder",
			event: {
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "the launch codes are 1234" },
			},
		});
		h.bus.emit(BusChannels.DispatchStarted, started({ runId: "run-2", attempt: 1 }));
		for (const fields of h.recorded) {
			const written = JSON.stringify(stamped(fields, "t1", "2026-08-16T10:00:00.000Z"));
			ok(!written.includes("launch codes"), `streamed text reached the ledger: ${written}`);
		}
	});

	it("costs nothing in the context budget and never becomes a model message", () => {
		const entry = workerRunEntry();
		strictEqual(estimateTokens(entry), 0);
		deepStrictEqual(buildReplayAgentMessagesFromTurns([entry]), []);
	});
});

describe("worker block replay", () => {
	it("redraws a settled block from the entry plus the sealed receipt", () => {
		const rendered = replay([workerRunEntry()], (runId) =>
			runId === "run-1"
				? {
						outcome: "succeeded",
						tokenCount: 4800,
						durationMs: 9600,
						contract: "pass",
						text: "Hello! I'm the coder worker.",
					}
				: null,
		);
		ok(rendered.includes(`${GLYPH.workerHuman} coder · mini/Nemo-3.5-Lightning · run run-1`), rendered);
		ok(rendered.includes("│ Hello! I'm the coder worker."), rendered);
		ok(rendered.includes(`└ ${GLYPH.ok} ok · 4.8k tok · 9.6s · contract pass`), rendered);
	});

	it("renders a mutation-report answer as prose instead of raw JSON", () => {
		const report = {
			mutatedPaths: ["src/discount.ts"],
			validations: [{ name: "npx tsx --test test/discount.test.ts", passed: true, evidence: "tests 3, pass 3, fail 0" }],
			commitMessage: "Skip bogus-kind check in applyDiscount, keep numeric bounds validation",
			summary: "Remove the else branch in applyDiscount that threw InvalidDiscountError for unknown discount kinds",
		};
		const rendered = replay([workerRunEntry()], () => ({
			outcome: "succeeded",
			contract: "pass",
			text: JSON.stringify(report),
		}));
		ok(rendered.includes("│ changed src/discount.ts"), rendered);
		ok(rendered.includes(`│ ${GLYPH.ok} npx tsx --test test/discount.test.ts: tests 3, pass 3, fail 0`), rendered);
		ok(rendered.includes("│ Remove the else branch in applyDiscount"), rendered);
		ok(rendered.includes("│ commit: Skip bogus-kind check"), rendered);
		ok(!rendered.includes('{"mutatedPaths"'), rendered);
	});

	it("pretty-prints any other structured answer under the rail", () => {
		const rendered = replay([workerRunEntry()], () => ({
			outcome: "succeeded",
			text: JSON.stringify({ verdict: "pass", checks: [{ name: "npm run typecheck", passed: true }] }),
		}));
		ok(rendered.includes('│   "verdict": "pass",'), rendered);
		ok(!rendered.includes('│ {"verdict"'), rendered);
	});

	it("leaves prose that merely mentions braces alone", () => {
		const rendered = replay([workerRunEntry()], () => ({ outcome: "succeeded", text: "Done. Set {a: 1} in config." }));
		ok(rendered.includes("│ Done. Set {a: 1} in config."), rendered);
	});

	it("lists a replayed block among the panel's worker states, so /share can name it after a resume", () => {
		const panel = replayPanel([workerRunEntry()], () => ({ outcome: "succeeded", text: "Hello! I'm the coder worker." }));
		const [state] = panel.workerStates();
		strictEqual(state?.runId, "run-1");
		strictEqual(state?.pending, false);
		strictEqual(state?.text, "Hello! I'm the coder worker.");
	});

	it("bounds a replayed answer the way live settlement does", () => {
		const oversized = Array.from({ length: 1200 }, (_, index) => `line ${index}`).join("\n");
		const panel = replayPanel([workerRunEntry()], () => ({ outcome: "succeeded", text: oversized }));
		const [state] = panel.workerStates();
		ok(state !== undefined);
		ok(Buffer.byteLength(state.text, "utf8") <= WORKER_OUTPUT_MAX_BYTES, `${state.text.length} chars`);
		ok(state.droppedLines > 0, "the bound must report the lines it cost");
	});

	it("says the receipt is gone rather than leaving the block running", () => {
		const rendered = replay([workerRunEntry()], () => null);
		ok(rendered.includes(`${GLYPH.workerHuman} coder`), rendered);
		ok(rendered.includes("receipt unavailable"), rendered);
		ok(!rendered.includes("running"), `a finished run must not replay as live:\n${rendered}`);
	});

	it("folds a failover into one block with an attempt line", () => {
		const rendered = replay(
			[
				workerRunEntry(),
				workerRunEntry({
					turnId: "t2",
					runId: "run-2",
					runtime: { kind: "clio", targetId: "dynamo", wireModelId: "qwen3" },
				}),
			],
			(runId) => (runId === "run-2" ? { outcome: "succeeded", text: "second attempt answer", durationMs: 3000 } : null),
		);
		strictEqual(rendered.split(`${GLYPH.workerHuman} coder`).length - 1, 1, `one block, not two:\n${rendered}`);
		ok(rendered.includes("run run-2"), `the header names the attempt that finished:\n${rendered}`);
		ok(rendered.includes(`${GLYPH.phaseRetry} failed over → attempt 2 on dynamo/qwen3`), rendered);
		ok(rendered.includes("│ second attempt answer"), rendered);
	});

	it("nests an agent-origin card under the tool call that spawned it", () => {
		const turns: SessionEntry[] = [
			{
				kind: "message",
				turnId: "u1",
				parentTurnId: null,
				timestamp: "2026-08-16T09:59:00.000Z",
				role: "user",
				payload: { content: "find the slow path" },
			},
			{
				kind: "message",
				turnId: "c1",
				parentTurnId: "u1",
				timestamp: "2026-08-16T09:59:30.000Z",
				role: "tool_call",
				payload: { id: "call_1", name: "dispatch", args: { mode: "parallel" } },
			},
			workerRunEntry({ turnId: "w1", origin: "agent", agentId: "scout", parentToolCallId: "call_1" }),
			{
				kind: "message",
				turnId: "a1",
				parentTurnId: "c1",
				timestamp: "2026-08-16T10:01:00.000Z",
				role: "assistant",
				payload: { content: [{ type: "text", text: "The scout is back." }] },
			},
		];
		const rendered = replay(turns, () => ({
			outcome: "succeeded",
			text: "the slow path is in math.ts",
			durationMs: 41_000,
		}));
		const rows = rendered.split("\n");
		const callRow = rows.findIndex((row) => row.includes("tool action"));
		const cardRow = rows.findIndex((row) => row.includes(`${GLYPH.workerAgent} scout`));
		const replyRow = rows.findIndex((row) => row.includes("The scout is back."));
		ok(callRow >= 0 && cardRow > callRow && replyRow > cardRow, `card sits between call and reply:\n${rendered}`);
		ok(!rendered.includes("dispatch("), `the replay header stays tool-neutral:\n${rendered}`);
		// An agent-origin run replays folded, which is its settled view: the model
		// already reported on it, and the card is there for the operator who wants
		// to check that report against the worker's own words.
		ok(!rendered.includes("the slow path is in math.ts"), `folded by default:\n${rendered}`);
	});
});
