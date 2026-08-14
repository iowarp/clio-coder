import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ObservabilityContract } from "../../src/domains/observability/contract.js";
import {
	createDispatchTraceMirror,
	SESSION_TRACE_ASSIGNMENT_ID,
	type SessionTurnTrace,
	TraceReader,
} from "../../src/domains/observability/trace-store.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { createTurnPersistence } from "../../src/interactive/turn-persistence.js";
import type { AgentRuntime, ChatTurnState } from "../../src/interactive/turn-state.js";
import { createTurnState } from "../../src/interactive/turn-state.js";

/**
 * D2: the dispatch trace mirror subscribes to five dispatch bus channels, and
 * an interactive turn is not a dispatch. The only rows a session used to
 * contribute to trace.sqlite came from the workers it dispatched, so the
 * operator's own turns were structurally invisible to `clio-coder trace` and to any
 * question of the form "what did this run actually execute".
 *
 * The turn's ledger appends already carry the whole trace vocabulary, so the
 * mirror hangs off them as a second sink rather than off new event plumbing.
 */
describe("contracts/trace/session turns", () => {
	let dir = "";
	let db = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "clio-trace-session-"));
		db = join(dir, "trace.sqlite");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function fakeSession(): SessionContract {
		let counter = 0;
		let current: { id: string } | null = null;
		return {
			create: (input: unknown) => {
				current = { id: "session-1" };
				void input;
				return current;
			},
			current: () => current,
			append: () => {
				counter += 1;
				return { id: `turn-${counter}` };
			},
			appendEntry: () => {},
		} as unknown as SessionContract;
	}

	function runtimeFixture(): AgentRuntime {
		return {
			agent: { sessionId: null } as unknown as AgentRuntime["agent"],
			targetId: "mini",
			runtimeId: "llamacpp",
			wireModelId: "Nemo-3.5-Lightning",
			runtimeResolution: {} as AgentRuntime["runtimeResolution"],
		};
	}

	function assistantMessage(text: string, usage: Record<string, unknown> | null): AgentMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: "stop",
			...(usage === null ? {} : { usage }),
		} as unknown as AgentMessage;
	}

	interface Harness {
		persistence: ReturnType<typeof createTurnPersistence>;
		state: ChatTurnState;
		flush: () => Promise<void>;
	}

	function harness(): Harness {
		const mirror = createDispatchTraceMirror(db);
		const observability = {
			recordSessionTurn: (trace: SessionTurnTrace) => mirror.enqueueSessionTurn(trace),
		} as unknown as ObservabilityContract;
		const state = createTurnState("off" as never);
		state.runtime = runtimeFixture();
		const persistence = createTurnPersistence({
			state,
			session: fakeSession(),
			getSettings: () => ({ orchestrator: {} }) as never,
			middlewareToolChoice: { reset: () => {} } as never,
			consumePersistedEcho: () => false,
			removeQueuedMirrorEntry: () => {},
			promptCachePayloadForAssistant: () => ({}),
			promptSideTokens: () => 0,
			observability,
		});
		return { persistence, state, flush: () => mirror.flush() };
	}

	function toolStart(toolCallId: string, toolName: string): Extract<AgentEvent, { type: "tool_execution_start" }> {
		return { type: "tool_execution_start", toolCallId, toolName, args: { path: "README.md" } } as never;
	}

	it("records an operator turn and its tool calls as a run beside dispatched runs", async () => {
		const { persistence, flush } = harness();
		persistence.appendSubmittedUserTurn(runtimeFixture(), "what does this repo do?", undefined, false);
		persistence.appendToolCallTurn(toolStart("call-1", "read"));
		persistence.appendToolResultTurn({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "read",
			result: "a file",
			isError: false,
			durationMs: 42,
			resultSummary: { lines: 3 },
			outcome: "ok",
		} as never);
		persistence.appendAssistantTurn(
			assistantMessage("it is a coding agent", { input: 100, output: 20, totalTokens: 120 }),
		);
		await flush();

		const reader = new TraceReader(db);
		try {
			const runs = reader.runs();
			strictEqual(runs.length, 1, "the operator's turn is one run row");
			const run = runs[0];
			ok(run);
			strictEqual(run.assignment_id, SESSION_TRACE_ASSIGNMENT_ID, "a session turn has no assignment id");
			strictEqual(run.run_id, "session:turn-1");
			strictEqual(run.agent, "orchestrator");
			strictEqual(run.target, "mini");
			strictEqual(run.model, "Nemo-3.5-Lightning");
			strictEqual(run.runtime, "llamacpp");
			strictEqual(run.request, "what does this repo do?");
			strictEqual(run.status, "success");
			strictEqual(run.total_tokens, 120);
			ok(run.ended_at !== null, "a finished turn carries an end time");

			const phases = reader.phases(run.run_id);
			strictEqual(phases.length, 1);
			strictEqual(phases[0]?.status, "success");
			strictEqual(phases[0]?.input_tokens, 100);
			strictEqual(phases[0]?.output_tokens, 20);

			const events = reader.events(run.run_id);
			deepStrictEqual(
				events.map((event) => event.type),
				["agent_start", "tool_call", "message", "agent_end"],
			);
			const toolEvent = events.find((event) => event.type === "tool_call");
			ok(toolEvent);
			strictEqual(toolEvent.name, "read");
			ok(toolEvent.ended_at !== null, "the call and its result collapse into one completed row");
			const payload = JSON.parse(toolEvent.payload_json ?? "{}") as Record<string, unknown>;
			strictEqual(payload.duration_ms, 42);
			strictEqual(payload.ok, true);
			strictEqual(payload.outcome, "ok");
		} finally {
			reader.close();
		}
	});

	/**
	 * E14 taught the tool-result row to carry the admission verdict so a resumed
	 * session labels a blocked call the way the live panel did. The mirror
	 * carries the same fields, which is the whole point of pointing an operator
	 * at a session turn to ask what it executed.
	 */
	it("carries the E14 verdict fields for a blocked tool call", async () => {
		const { persistence, flush } = harness();
		persistence.appendSubmittedUserTurn(runtimeFixture(), "delete everything", undefined, false);
		persistence.appendToolCallTurn(toolStart("call-9", "bash"));
		persistence.appendToolResultTurn({
			type: "tool_execution_end",
			toolCallId: "call-9",
			toolName: "bash",
			result: "denied",
			isError: true,
			durationMs: 3,
			outcome: "blocked",
			blockReason: "safety rail refused rm -rf",
		} as never);
		persistence.appendAssistantTurn(assistantMessage("I cannot do that", null));
		await flush();

		const reader = new TraceReader(db);
		try {
			const events = reader.events("session:turn-1");
			const toolEvent = events.find((event) => event.type === "tool_call");
			ok(toolEvent);
			const payload = JSON.parse(toolEvent.payload_json ?? "{}") as Record<string, unknown>;
			strictEqual(payload.ok, false);
			strictEqual(payload.outcome, "blocked");
			strictEqual(payload.block_reason, "safety rail refused rm -rf");
		} finally {
			reader.close();
		}
	});

	/**
	 * An assistant message that asked for tools has not ended the turn. Closing
	 * the run there would report a turn as finished while its tool calls were
	 * still landing, and the tool rows would arrive after the end event.
	 */
	it("keeps the turn open across an assistant message that calls tools", async () => {
		const { persistence, flush } = harness();
		persistence.appendSubmittedUserTurn(runtimeFixture(), "read the readme", undefined, false);
		persistence.appendAssistantTurn({
			role: "assistant",
			content: [{ type: "toolCall", toolCallId: "call-1", toolName: "read" }],
			stopReason: "toolUse",
		} as unknown as AgentMessage);
		await flush();

		const reader = new TraceReader(db);
		try {
			strictEqual(reader.run("session:turn-1")?.status, "running");
		} finally {
			reader.close();
		}
	});

	it("writes nothing at all without an observability sink", async () => {
		const state = createTurnState("off" as never);
		state.runtime = runtimeFixture();
		const persistence = createTurnPersistence({
			state,
			session: fakeSession(),
			getSettings: () => ({ orchestrator: {} }) as never,
			middlewareToolChoice: { reset: () => {} } as never,
			consumePersistedEcho: () => false,
			removeQueuedMirrorEntry: () => {},
			promptCachePayloadForAssistant: () => ({}),
			promptSideTokens: () => 0,
		});
		persistence.appendSubmittedUserTurn(runtimeFixture(), "hello", undefined, false);
		persistence.appendAssistantTurn(assistantMessage("hi", null));
		strictEqual(existsSync(db), false, "no sink means no database is created");
	});
});
