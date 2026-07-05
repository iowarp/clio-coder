import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { projectWorkerEventForStdout } from "../../src/worker/event-projection.js";

// A pi `message_update` carries the full cumulative assistant message twice:
// once at the top level (`message`) and once nested under
// `assistantMessageEvent.partial`. Only `delta` is incremental. Build a
// realistic event for a streaming turn whose cumulative text is `cumulative`.
function messageUpdate(cumulative: string, delta: string): Record<string, unknown> {
	const message = {
		role: "assistant",
		content: [{ type: "text", text: cumulative }],
		usage: { input: 0, output: 0 },
		stopReason: null,
	};
	return {
		type: "message_update",
		message,
		assistantMessageEvent: {
			type: "text_delta",
			contentIndex: 0,
			delta,
			partial: message,
		},
	};
}

// Serialize the way the worker NDJSON emitter does (one JSON line per event).
function stdoutBytes(events: unknown[]): number {
	let total = 0;
	for (const event of events) total += `${JSON.stringify(event)}\n`.length;
	return total;
}

// Simulate a streaming turn of `totalChars` delivered in `chunk`-char deltas,
// returning the raw and projected event streams the worker would emit.
function simulateTurn(totalChars: number, chunk: number): { raw: unknown[]; projected: unknown[] } {
	const raw: unknown[] = [];
	const projected: unknown[] = [];
	let acc = "";
	for (let i = 0; i < totalChars; i += chunk) {
		const delta = "x".repeat(Math.min(chunk, totalChars - i));
		acc += delta;
		const event = messageUpdate(acc, delta);
		raw.push(event);
		projected.push(projectWorkerEventForStdout(event as never));
	}
	return { raw, projected };
}

// The dispatch board's sole read of message_update (dispatch-board.ts): it stamps
// first-token latency when the nested assistantMessageEvent is a delta kind.
function dispatchBoardSeesFirstToken(event: unknown): boolean {
	const assistantEvent = ((event as { assistantMessageEvent?: { type?: unknown } }).assistantMessageEvent ?? {}) as {
		type?: unknown;
	};
	return (
		assistantEvent.type === "text_delta" ||
		assistantEvent.type === "thinking_delta" ||
		assistantEvent.type === "toolcall_start" ||
		assistantEvent.type === "toolcall_delta"
	);
}

describe("worker event projection", () => {
	it("strips the two per-delta cumulative snapshots from message_update", () => {
		const event = messageUpdate("hello world", " world");
		const projected = projectWorkerEventForStdout(event as never) as Record<string, unknown>;
		strictEqual(projected.type, "message_update");
		ok(!("message" in projected), "top-level cumulative message must be dropped");
		const ame = projected.assistantMessageEvent as Record<string, unknown>;
		ok(ame, "assistantMessageEvent must survive for the TTFT discriminant");
		ok(!("partial" in ame), "cumulative assistantMessageEvent.partial must be dropped");
	});

	it("keeps the incremental delta and the structural discriminants", () => {
		const event = messageUpdate("hello world", " world");
		const projected = projectWorkerEventForStdout(event as never) as {
			assistantMessageEvent: { type?: unknown; contentIndex?: unknown; delta?: unknown };
		};
		strictEqual(projected.assistantMessageEvent.type, "text_delta");
		strictEqual(projected.assistantMessageEvent.contentIndex, 0);
		strictEqual(projected.assistantMessageEvent.delta, " world");
	});

	it("preserves the dispatch-board first-token discriminant through projection", () => {
		for (const kind of ["text_delta", "thinking_delta", "toolcall_start", "toolcall_delta"]) {
			const event = {
				type: "message_update",
				message: { role: "assistant", content: [] },
				assistantMessageEvent: { type: kind, contentIndex: 0, delta: "d", partial: { role: "assistant", content: [] } },
			};
			ok(dispatchBoardSeesFirstToken(event), `raw ${kind} must be a first-token`);
			ok(
				dispatchBoardSeesFirstToken(projectWorkerEventForStdout(event as never)),
				`projected ${kind} must be a first-token`,
			);
		}
	});

	it("passes load-bearing and unknown events through byte-identical", () => {
		const messageEnd = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "final answer" }],
				usage: { input: 10, output: 20, cacheRead: 5 },
				stopReason: "stop",
			},
		};
		const agentEnd = { type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "stop" }] };
		const toolFinish = { type: "clio_tool_finish", payload: { tool: "grep", outcome: "ok" } };
		const heartbeat = { type: "heartbeat", at: 123 };
		const unknownEvent = { type: "clio_tool_approval_request", payload: { tool: "write" } };
		for (const event of [messageEnd, agentEnd, toolFinish, heartbeat, unknownEvent]) {
			deepStrictEqual(projectWorkerEventForStdout(event as never), event, `${event.type} must pass through unchanged`);
		}
	});

	it("collapses a streaming turn from quadratic back to linear stdout", () => {
		// 10KB response in 20-char deltas: the raw stream is >100x the payload;
		// the projected stream must be a small linear multiple.
		const payload = 10240;
		const { raw, projected } = simulateTurn(payload, 20);
		const rawBytes = stdoutBytes(raw);
		const projectedBytes = stdoutBytes(projected);
		ok(rawBytes > payload * 100, `raw stream should be quadratic (>100x); saw ${(rawBytes / payload).toFixed(1)}x`);
		ok(
			projectedBytes < payload * 10,
			`projected stream should be linear (<10x payload); saw ${(projectedBytes / payload).toFixed(1)}x`,
		);
		ok(projectedBytes < rawBytes / 10, `projection should cut at least 10x; raw=${rawBytes} projected=${projectedBytes}`);
	});

	it("keeps projected per-delta size bounded by the delta, not the cumulative length", () => {
		// The last delta of a long turn must not carry the whole message: its
		// serialized size must stay within a small constant of the delta itself.
		const { projected } = simulateTurn(50000, 40);
		const last = `${JSON.stringify(projected[projected.length - 1])}\n`.length;
		ok(last < 400, `projected tail line must not scale with cumulative length; saw ${last} bytes`);
	});
});
