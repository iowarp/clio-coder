/**
 * What became of an operator message, read back the way `clio-coder telemetry timeline` reads it: the real queue and
 * recorder write into an in-memory journal, and the timeline read model answers from those records.
 */
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { mainAgent } from "../../src/core/telemetry/context.js";
import { TimelineSchema, type TimelineV1 } from "../../src/core/telemetry/dto.js";
import type { TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { makeTelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { validPayload } from "../../src/core/telemetry/events.js";
import type { PendingTelemetry } from "../../src/core/telemetry/producer.js";
import { abandonedSettlement, beginCall, registerTelemetrySink } from "../../src/core/telemetry/producer.js";
import { foldMessagePaths } from "../../src/domains/session/message-path-view.js";
import type { SessionSource } from "../../src/domains/telemetry/read-model.js";
import { callsReport, timeline } from "../../src/domains/telemetry/read-model.js";
import { createMessagePath } from "../../src/session-control/message-path.js";
import { createTurnQueues } from "../../src/session-control/turn-queues.js";
import { type ChatTurnState, ContinuationState } from "../../src/session-control/turn-state.js";

type MessageEntry = Extract<TimelineV1["entries"][number], { kind: "message" }>;

function rig(sessionId: string) {
	const pending: PendingTelemetry[] = [];
	const release = registerTelemetrySink(sessionId, { enqueue: (record) => Boolean(pending.push(record)) });
	const context = { sessionId, agent: mainAgent(sessionId), turnId: "turn-1" };
	const path = createMessagePath({ sessionId: () => sessionId, turnId: () => "turn-1" });
	const engine: string[] = [];
	const agent = {
		steer: (message: { content: string }) => engine.push(message.content),
		followUp: (message: { content: string }) => engine.push(message.content),
		clearAllQueues: () => {},
	};
	const state = { streaming: true, runtime: { agent }, continuation: new ContinuationState() };
	const queues = createTurnQueues({
		state: state as unknown as ChatTurnState,
		emitQueueUpdateEvent: () => {},
		emitQueuedUserTurn: () => {},
		emitNotice: () => {},
		emitQueueHeld: () => {},
		emitQueueDropped: () => {},
		onEvent: (event) => path.queueEvent(event),
		submit: async () => {},
	});
	/** The request the engine would send now, and how its call settles. */
	const sendCall = (answered = true): string => {
		const call = beginCall(
			{
				target: {
					targetId: "t",
					runtimeId: "r",
					api: "openai-completions",
					requestedModel: "m",
					reportedModel: { kind: "unknown", reason: "not-observed" },
				},
				roundKind: "normal",
				toolChoice: "auto",
			},
			context,
		);
		path.requestSent({ callId: call.callId, attemptId: call.attemptId, attempt: call.attempt, context });
		const dropped = abandonedSettlement(true, "transport_dropped");
		const facts = call.settle(answered ? { ...dropped, disposition: "settled", stop: { reason: "stop" } } : dropped);
		ok(facts);
		path.callSettled(facts);
		return call.callId;
	};
	const records = (): TelemetryRecord[] =>
		pending.map(
			(record) =>
				makeTelemetryRecord(record.kind, record.data as never, record.ctx, {
					t: new Date(record.wallMs).toISOString(),
					mono: record.mono,
				}) as TelemetryRecord,
		);
	const read = (): { dto: TimelineV1; rows: MessageEntry[]; source: SessionSource } => {
		const source: SessionSource = {
			sessionId,
			journal: { present: true, records: records(), modes: ["standard"], skipped: 0, damaged: 0 },
			runs: new Map(),
			parent: null,
		};
		const dto = timeline(source, null, { now: new Date() });
		ok(Value.Check(TimelineSchema, dto), [...Value.Errors(TimelineSchema, dto)][0]?.message);
		return { dto, source, rows: dto.entries.filter((entry): entry is MessageEntry => entry.kind === "message") };
	};
	const prompt = () =>
		queues.handOverBeforePrompt(agent as unknown as Parameters<typeof queues.handOverBeforePrompt>[0]);
	return { queues, path, engine, read, records, release, sendCall, prompt };
}

test("a steer reads as queued, handed over at its slot and carried by its call, in clock order", () => {
	const f = rig("path-steer");
	try {
		const entry = f.queues.steer("correct course");
		ok(entry);
		f.queues.handOverAtFinishTurn(false);
		strictEqual(f.queues.acknowledgeInjected("correct course")?.id, entry.id);
		const failedCallId = f.sendCall(false);
		const callId = f.sendCall();
		const { rows } = f.read();
		deepStrictEqual(
			rows.map((row) => row.step),
			["queued", "handed-over", "carried", "carried"],
		);
		ok(rows.every((row) => row.messageId === entry.id));
		strictEqual(rows[0]?.lane, "steer");
		strictEqual(rows[1]?.slot, "finish-turn");
		// A call that dropped did not deliver it, so the next one that leaves carries it too.
		strictEqual(rows[2]?.callId, failedCallId);
		strictEqual(rows[2]?.callFailure, "transport_dropped");
		strictEqual(rows[3]?.callId, callId);
		strictEqual(rows[3]?.callDisposition, "settled");
		const clocks = rows.map((row) => Date.parse(row.at));
		deepStrictEqual(
			clocks,
			[...clocks].sort((a, b) => a - b),
		);
		// An answered call ends the path: the next request carries the history, not this message's delivery.
		f.sendCall();
		strictEqual(f.read().rows.length, 4);
	} finally {
		f.release();
	}
});

test("every way out of the queue says why and leaves no carried row", () => {
	const f = rig("path-removals");
	try {
		const leave = (text: string, go: (id: string) => void): string => {
			const entry = f.queues.steer(text);
			ok(entry);
			go(entry.id);
			return entry.id;
		};
		const expected: Array<[string, string]> = [
			[
				leave("removed", (id) => {
					f.queues.removeEntry(id);
				}),
				"removed",
			],
			[
				leave("edited", (id) => {
					f.queues.removeEntry(id, "to-editor");
				}),
				"to-editor",
			],
			[
				leave("sent", (id) => {
					f.queues.removeEntry(id, "sent-now");
				}),
				"sent-now",
			],
			[leave("restored", () => f.queues.clearQueuedMirror()), "restored"],
			[leave("dropped", () => f.queues.reset()), "cancelled"],
		];
		f.sendCall();
		const { rows } = f.read();
		strictEqual(rows.filter((row) => row.step === "carried").length, 0);
		deepStrictEqual(
			rows.filter((row) => row.step === "removed").map((row) => [row.messageId, row.reason]),
			expected,
		);
	} finally {
		f.release();
	}
});

test("a stop holds the queue, and the next prompt releases it to be delivered and carried", () => {
	const f = rig("path-hold");
	try {
		const entry = f.queues.steer("wait for me");
		ok(entry);
		f.queues.onRunCancelled({ hold: false });
		// A second Esc adds nothing to the path.
		f.queues.onRunCancelled({ hold: false });
		f.queues.handOverAtFinishTurn(false);
		deepStrictEqual(f.engine, []);
		f.prompt();
		f.queues.handOverAtFinishTurn(false);
		f.queues.acknowledgeInjected("wait for me");
		const callId = f.sendCall();
		const { rows } = f.read();
		deepStrictEqual(
			rows.map((row) => row.step),
			["queued", "held", "released", "handed-over", "carried"],
		);
		strictEqual(rows[1]?.why, "operator-stop");
		strictEqual(rows[4]?.callId, callId);
	} finally {
		f.release();
	}
});

test("no message text reaches the journal or the timeline, and its length does", () => {
	const f = rig("path-sentinel");
	try {
		const sentinel = "SENTINEL-do-not-journal-7f3a";
		const queued = f.queues.steer(sentinel);
		ok(queued);
		f.queues.handOverAtFinishTurn(false);
		f.queues.acknowledgeInjected(sentinel);
		const prompt = { id: "prompt_fresh", submittedAt: Date.now() };
		f.path.submitted(prompt, {
			chars: sentinel.length,
			by: "operator",
			wallMs: prompt.submittedAt,
			mono: performance.now(),
		});
		f.path.prompted(prompt);
		f.sendCall();
		const records = f.records().filter((record) => record.k === "message.stepped");
		ok(records.every((record) => validPayload("message.stepped", record.data)));
		strictEqual(JSON.stringify(f.records()).includes(sentinel), false);
		const { dto, rows } = f.read();
		strictEqual(JSON.stringify(dto).includes(sentinel), false);
		deepStrictEqual(
			rows.filter((row) => row.chars !== null).map((row) => row.chars?.display),
			[String(sentinel.length), String(sentinel.length)],
		);
	} finally {
		f.release();
	}
});

test("/view folds each path to what happened, what carried it, and no raw id or text in its primary rows", () => {
	const f = rig("path-view");
	try {
		const delivered = f.queues.steer("SENTINEL delivered");
		ok(delivered);
		f.queues.handOverAtFinishTurn(false);
		f.queues.acknowledgeInjected("SENTINEL delivered");
		f.sendCall(false);
		f.sendCall();
		const failed = f.queues.steer("SENTINEL failed");
		ok(failed);
		f.queues.handOverAtFinishTurn(false);
		f.queues.acknowledgeInjected("SENTINEL failed");
		f.sendCall(false);
		const removed = f.queues.steer("SENTINEL removed");
		ok(removed);
		f.queues.removeEntry(removed.id);
		const held = f.queues.steer("SENTINEL held");
		ok(held);
		f.queues.onRunCancelled({ hold: false });
		const { dto, source } = f.read();
		const calls = callsReport(source, {}, { now: new Date() }).calls;
		const fold = (queued?: ReadonlySet<string>) =>
			new Map(foldMessagePaths(dto, calls, queued, () => "12:00:00").map((path) => [path.id, path]));

		const live = fold(new Set([held.id]));
		strictEqual(live.get(delivered.id)?.state, "delivered");
		match(live.get(delivered.id)?.summary ?? "", /Delivered by call \d+ to m,.*1 earlier call/u);
		strictEqual(live.get(failed.id)?.state, "failed");
		match(live.get(failed.id)?.title ?? "", /^Failed · steer · \d+ chars$/u);
		strictEqual(live.get(removed.id)?.state, "removed");
		strictEqual(live.get(held.id)?.state, "held");
		match(live.get(held.id)?.summary ?? "", /you stopped the run/u);
		for (const path of live.values()) {
			const primary = [path.title, path.summary, ...path.steps].join("\n");
			strictEqual(primary.includes(path.id), false);
			strictEqual(primary.includes("SENTINEL"), false);
		}
		// A message the queue no longer holds has no live slot coming, whatever its last row said.
		strictEqual(fold(new Set()).get(held.id)?.state, "lost");
		strictEqual(fold().get(held.id)?.state, "held");
	} finally {
		f.release();
	}
});
