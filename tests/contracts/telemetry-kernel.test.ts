import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import {
	observedToolCallOrigin,
	TelemetryContextSchema,
	telemetryContext,
	withTelemetryContext,
	withToolTelemetryContext,
} from "../../src/core/telemetry/context.js";
import type { SegmentHeader, TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { makeTelemetryRecord, readTelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { EVENTS, validPayload } from "../../src/core/telemetry/events.js";
import { telemetryHub } from "../../src/core/telemetry/hub.js";
import { newAttemptId, newCallId, newRecordId, UUID_V7_PATTERN } from "../../src/core/telemetry/ids.js";
import type { PendingTelemetry } from "../../src/core/telemetry/producer.js";
import {
	beginCall,
	registerRunTelemetrySink,
	registerTelemetrySink,
	telemetryCallInContext,
} from "../../src/core/telemetry/producer.js";
import type { CallSettled } from "../../src/core/telemetry/schemas.js";
import { crc32, encodeTelemetryLine, scanTelemetrySegment } from "../../src/core/telemetry/segment.js";
import { callSettlementFromMessage } from "../../src/domains/telemetry/call-facts.js";

const context = { sessionId: "existing-session-id", agent: { role: "main" as const, id: "existing-session-id" } };
const header: SegmentHeader = {
	v: 1,
	k: "segment.open",
	schemaSet: "clio-telemetry/1",
	mode: "standard",
	capture: { content: false, deltas: false, providerHeaders: false, systemOneDataset: false, busTrace: false },
	clockOrigin: { host: "test-host", pid: 1, birthToken: "birth", monoEpochWallMs: 1000 },
	writer: { clioCoderVersion: "test", piVersion: "test" },
};
const clock = { t: "2026-10-30T12:00:00.000Z", mono: 10 };
const record = makeTelemetryRecord("session.opened", {}, context, clock);

test("telemetry keeps existing ids, mints namespaced UUIDv7 ids, and isolates concurrent call context", async () => {
	const ids = [newCallId(), newAttemptId(), newRecordId()];
	for (const [index, prefix] of ["cal", "att", "rec"].entries())
		match(ids[index] ?? "", new RegExp(`^${prefix}_${UUID_V7_PATTERN}$`));
	strictEqual(new Set(Array.from({ length: 100 }, newCallId)).size, 100);
	await Promise.all(
		["first", "second"].map((turnId) =>
			withTelemetryContext({ ...context, turnId }, async () => {
				await Promise.resolve();
				strictEqual(telemetryContext()?.sessionId, context.sessionId);
				strictEqual(telemetryContext()?.turnId, turnId);
				withTelemetryContext({ ...context, agent: { role: "memory", id: context.sessionId } }, () =>
					strictEqual(telemetryContext()?.agent.role, "memory"),
				);
				strictEqual(telemetryContext()?.agent.role, "main");
			}),
		),
	);
	strictEqual(telemetryContext(), undefined);
	strictEqual(
		Value.Check(TelemetryContextSchema, { sessionId: null, runId: "run", agent: { role: "worker", id: "run" } }),
		true,
	);
	strictEqual(Value.Check(TelemetryContextSchema, { sessionId: null, agent: { role: "worker", id: "run" } }), false);
	strictEqual(
		Value.Check(TelemetryContextSchema, { sessionId: null, runId: "", agent: { role: "worker", id: "run" } }),
		false,
	);
});

test("tool contexts retain provider attribution only within the same owner and turn", () => {
	const call = { ...context, turnId: "turn", callId: newCallId(), attemptId: newAttemptId() };
	const message = { ...call, role: "assistant", content: [{ type: "toolCall", id: "tool" }] };
	deepStrictEqual(observedToolCallOrigin([message], "tool"), { callId: call.callId, attemptId: call.attemptId });
	strictEqual(observedToolCallOrigin([message], "different-tool"), undefined);
	strictEqual(observedToolCallOrigin([message, { ...message, callId: "peer-id" }], "tool"), undefined);
	withTelemetryContext(call, () => {
		withToolTelemetryContext({ sessionId: context.sessionId, turnId: "turn", toolCallId: "tool" }, () => {
			strictEqual(telemetryContext()?.callId, call.callId);
			strictEqual(telemetryContext()?.toolCallId, "tool");
		});
		const next = { callId: newCallId(), attemptId: newAttemptId() };
		withToolTelemetryContext({ sessionId: "next-session", ...next }, () => {
			strictEqual(telemetryContext()?.callId, next.callId);
			strictEqual(telemetryContext()?.attemptId, next.attemptId);
		});
		withToolTelemetryContext({ callId: next.callId }, () => strictEqual(telemetryContext()?.attemptId, undefined));
		for (const identity of [{ sessionId: "other" }, { turnId: "next" }, { runId: "standalone" }]) {
			withToolTelemetryContext(identity, () => {
				strictEqual(telemetryContext()?.callId, undefined);
				strictEqual(telemetryContext()?.attemptId, undefined);
			});
		}
	});
});

test("an abandoned attempt settles once, as never sent before its send stage and unsettled after it (#434, R9)", () => {
	const records: PendingTelemetry[] = [];
	const release = registerTelemetrySink("abandon-session", { enqueue: (record) => Boolean(records.push(record)) });
	try {
		const started = {
			target: {
				targetId: "target",
				runtimeId: "runtime",
				api: "api",
				requestedModel: "model",
				reportedModel: { kind: "unknown", reason: "not-observed" } as const,
			},
			roundKind: "normal" as const,
			toolChoice: "auto" as const,
		};
		const ctx = { sessionId: "abandon-session", agent: { role: "main" as const, id: "abandon-session" } };
		const unsent = beginCall(started, ctx);
		strictEqual(unsent.abandon("internal")?.disposition, "never_sent");
		strictEqual(unsent.abandon("internal"), undefined, "a settled attempt is never settled twice");
		const sent = beginCall(started, ctx);
		sent.stage("send", "start");
		const facts = sent.abandon("operator_cancel");
		strictEqual(facts?.disposition, "sent_unsettled");
		deepStrictEqual(facts?.stop, { reason: "aborted", failure: "operator_cancel" });
		strictEqual(
			sent.withContext(() => telemetryCallInContext()),
			undefined,
		);
		const settled = records.flatMap((record) => (record.kind === "call.settled" ? [record.data] : []));
		strictEqual(settled.length, 2);
		ok(settled.every((data) => validPayload("call.settled", data)));
		// Only a 2xx response opens the stream; the attempt keeps the last one in memory and journals no header.
		const observed = beginCall(started, ctx);
		observed.observeResponse?.({ status: 429, headers: { "retry-after": "1" } });
		strictEqual(observed.lastResponse?.(), undefined);
		observed.observeResponse?.({ status: 200, headers: { "x-codex-primary-used-percent": "40" } });
		deepStrictEqual(observed.lastResponse?.(), { status: 200, headers: { "x-codex-primary-used-percent": "40" } });
		const answered = observed.abandon("internal");
		ok(answered?.stages.firstByte !== undefined && !JSON.stringify(answered).includes("x-codex"));
	} finally {
		release();
	}
});

test("an aborted message cannot claim a send its attempt's stages never reached (#434)", () => {
	const records: PendingTelemetry[] = [];
	const release = registerTelemetrySink("unsent-session", { enqueue: (record) => Boolean(records.push(record)) });
	try {
		const started = {
			target: {
				targetId: "target",
				runtimeId: "runtime",
				api: "api",
				requestedModel: "model",
				reportedModel: { kind: "unknown", reason: "not-observed" } as const,
			},
			roundKind: "normal" as const,
			toolChoice: "auto" as const,
		};
		const ctx = { sessionId: "unsent-session", agent: { role: "memory" as const, id: "unsent-session" } };
		const aborted = callSettlementFromMessage({ stopReason: "aborted", usage: { input: 0, output: 0 } }, "known");
		strictEqual(aborted.disposition, "sent_unsettled");
		const atAuth = beginCall(started, ctx);
		atAuth.stage("auth", "start");
		strictEqual(atAuth.settle(aborted)?.disposition, "never_sent");
		const inScope = beginCall(started, ctx);
		inScope.withContext(() => undefined);
		strictEqual(inScope.settle(aborted)?.disposition, "never_sent");
		const sent = beginCall(started, ctx);
		sent.stage("send", "start");
		strictEqual(sent.settle(aborted)?.disposition, "sent_unsettled");
		// A path that marks no stage at all cannot tell, so the message's word stands.
		strictEqual(beginCall(started, ctx).settle(aborted)?.disposition, "sent_unsettled");
		const counted = callSettlementFromMessage({ stopReason: "aborted", usage: { input: 40, output: 0 } }, "known");
		const reported = beginCall(started, ctx);
		reported.stage("auth", "start");
		strictEqual(reported.settle(counted)?.disposition, "sent_unsettled", "a provider's count is evidence of a send");
		ok(records.every((record) => validPayload(record.kind, record.data)));
	} finally {
		release();
	}
});

test("run owners stay separate from session owners, including standalone runs", () => {
	const session: PendingTelemetry[] = [];
	const run: PendingTelemetry[] = [];
	const releaseSession = registerTelemetrySink("same-id", { enqueue: (record) => Boolean(session.push(record)) });
	const releaseRun = registerRunTelemetrySink("same-id", { enqueue: (record) => Boolean(run.push(record)) });
	try {
		strictEqual(
			telemetryHub().emit("session.opened", {}, { sessionId: "same-id", agent: { role: "main", id: "same-id" } }),
			true,
		);
		strictEqual(
			telemetryHub().emit(
				"process.started",
				{},
				{ sessionId: null, runId: "same-id", agent: { role: "worker", id: "same-id" } },
			),
			true,
		);
		strictEqual(
			telemetryHub().emit(
				"process.started",
				{},
				{ sessionId: "same-id", runId: "same-id", agent: { role: "worker", id: "same-id" } },
			),
			true,
		);
		strictEqual(session.length, 1);
		deepStrictEqual(
			run.map((record) => record.ctx.sessionId),
			[null, "same-id"],
		);
		releaseRun();
		strictEqual(
			telemetryHub().emit(
				"process.started",
				{},
				{ sessionId: "same-id", runId: "same-id", agent: { role: "worker", id: "same-id" } },
			),
			false,
		);
		strictEqual(session.length, 1, "a missing run writer never falls back to the parent session");
	} finally {
		releaseRun();
		releaseSession();
	}
});

test("call schemas distinguish measured zero, unknown, absent, and never sent", () => {
	const unknown = { kind: "unknown", reason: "provider-omitted" } as const;
	const measured = { kind: "measured", value: 0, source: "provider" } as const;
	const call: CallSettled = {
		callId: newCallId(),
		attemptId: newAttemptId(),
		attempt: 0,
		target: { targetId: "test", runtimeId: "test", api: "test", requestedModel: "test", reportedModel: unknown },
		roundKind: "normal",
		toolChoice: "auto",
		disposition: "settled",
		stop: { reason: "stop" },
		usage: {
			input: measured,
			output: measured,
			cacheRead: unknown,
			cacheWrite: unknown,
			cacheWrite1h: unknown,
			reasoning: unknown,
		},
		pricing: { usd: unknown, pricedBy: "none" },
		stages: { settle: 10 },
		transport: { kind: "unknown", continuation: unknown, requestBytes: unknown, sessionPinnedToSse: unknown },
		cache: {
			firstDivergentSection: unknown,
			expectedColdReasons: [],
			rePrefilledTokens: unknown,
			uncachedPrefillTokens: unknown,
			verdict: "unknown",
		},
	};
	strictEqual(validPayload("call.settled", call), true);
	strictEqual(
		validPayload("call.settled", {
			...call,
			roundKind: "unknown",
			toolChoice: "unknown",
			stop: { reason: "unknown" },
			stages: { settle: null },
		}),
		true,
	);
	strictEqual(validPayload("call.settled", { ...call, stages: { settle: null, firstToken: 0 } }), false);
	strictEqual(
		validPayload("call.settled", { ...call, usage: { ...call.usage, input: { kind: "estimated", value: 4 } } }),
		false,
	);
	strictEqual(validPayload("call.settled", { ...call, disposition: "never_sent" }), false);
	const neverSent = {
		...call,
		disposition: "never_sent",
		usage: null,
		pricing: { usd: { kind: "absent", reason: "not-applicable" }, pricedBy: "none" },
	};
	strictEqual(validPayload("call.settled", neverSent), true);
	strictEqual(validPayload("call.settled", { ...neverSent, pricing: { usd: measured, pricedBy: "provider" } }), false);
	strictEqual(validPayload("call.settled", { ...call, stages: { send: { start: 6, end: 5 }, settle: 10 } }), false);
	strictEqual(
		validPayload("call.settled", { ...call, usage: { ...call.usage, input: { ...measured, value: Number.NaN } } }),
		false,
	);
});

test("segment readers preserve future records and distinguish a torn tail from interior corruption", () => {
	strictEqual(crc32(Buffer.from("123456789")), "cbf43926");
	const future = encodeTelemetryLine({ ...record, k: "future.kind" } as unknown as TelemetryRecord);
	const lines = Buffer.concat([encodeTelemetryLine(header), future, encodeTelemetryLine(record)]);
	const scan = scanTelemetrySegment(lines);
	deepStrictEqual(
		scan.rows.map((row) => row.kind),
		["header", "skipped", "record"],
	);
	strictEqual(scan.validBytes, lines.length);
	strictEqual(scan.tornTailBytes, 0);
	// A header under a retired writer key is skipped and counted, never upcast (#434).
	deepStrictEqual(readTelemetryRecord({ ...header, writer: { clioVersion: "dev", piVersion: "test" } }), {
		kind: "skipped",
		reason: "invalid-record",
		segment: true,
	});
	const partial = Buffer.from('{"v":1,"k":"call.settled"');
	const torn = scanTelemetrySegment(Buffer.concat([lines, partial]));
	strictEqual(torn.validBytes, lines.length);
	strictEqual(torn.tornTailBytes, partial.length);
	const bad = Buffer.from(encodeTelemetryLine(record));
	bad[10] = (bad[10] ?? 0) ^ 1;
	strictEqual(scanTelemetrySegment(Buffer.concat([lines, bad])).tornTailBytes, bad.length);
	strictEqual(
		scanTelemetrySegment(Buffer.concat([lines, bad, encodeTelemetryLine(record)])).corruptOffset,
		lines.length,
	);
	deepStrictEqual(readTelemetryRecord({ ...record, kv: 99 }), { kind: "skipped", reason: "unknown-version" });
	deepStrictEqual(readTelemetryRecord({ ...record, v: 99 }), { kind: "skipped", reason: "unknown-version" });
	deepStrictEqual(readTelemetryRecord({ ...record, cc: "content-bearing" }), {
		kind: "skipped",
		reason: "invalid-record",
	});
	for (const definition of Object.values(EVENTS))
		if (definition.durability === "journal") strictEqual(Value.Check(definition.schema, undefined), false);
	const callId = newCallId();
	const outcome = { callIds: [callId], outcome: "committed", checkpointTurnId: "checkpoint" };
	strictEqual(validPayload("compaction.settled", outcome), true);
	strictEqual(validPayload("compaction.settled", { ...outcome, checkpointTurnId: null }), false);
	strictEqual(validPayload("compaction.settled", { ...outcome, callIds: [callId, callId] }), false);
	strictEqual(validPayload("compaction.settled", { ...outcome, outcome: "failed", checkpointTurnId: null }), true);
});

test("a settled breakdown keeps its measured zeros beside a larger total; only a total-only row loses them (#434)", () => {
	// Gemini's total also counts tool-use prompt tokens that Pi maps to no breakdown field.
	const gemini = callSettlementFromMessage(
		{ stopReason: "stop", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 180 } },
		"unknown",
	);
	deepStrictEqual(gemini.usage?.cacheRead, { kind: "measured", value: 0, source: "provider" });
	deepStrictEqual(gemini.usage?.total, { kind: "measured", value: 180, source: "provider" });
	const totalOnly = callSettlementFromMessage(
		{ stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 500 } },
		"unknown",
	);
	strictEqual(totalOnly.usage?.input.kind, "unknown");
	deepStrictEqual(totalOnly.usage?.total, { kind: "measured", value: 500, source: "provider" });
});

test("message facts preserve unknown placeholders, explicit zero, terminal errors and unsent calls", () => {
	const usage = { input: 0, output: 0, cacheRead: 0, cost: { total: 0 } };
	const omitted = callSettlementFromMessage({ stopReason: "stop", usage }, "unknown");
	strictEqual(omitted.disposition, "settled_no_usage");
	strictEqual(omitted.usage?.input.kind, "unknown");
	const unverified = callSettlementFromMessage(
		{ stopReason: "stop", usage: { input: 123, clioExternal: { tokenUsage: "unverified" } } },
		"unknown",
	);
	strictEqual(unverified.usage?.input.kind, "unknown");
	const zero = callSettlementFromMessage(
		{
			stopReason: "stop",
			usage: { ...usage, clioExternal: { tokenUsage: "provider-reported", cost: "provider-reported" } },
		},
		"known",
	);
	strictEqual(zero.disposition, "settled");
	deepStrictEqual(zero.usage?.input, { kind: "measured", value: 0, source: "provider" });
	deepStrictEqual(zero.pricing.usd, { kind: "measured", value: 0, source: "provider" });
	for (const marker of [{ callInvoked: false }, { failure: { invoked: false } }, { usage: { callInvoked: false } }]) {
		const unsent = callSettlementFromMessage({ stopReason: "aborted", usage, ...marker }, "known_free");
		strictEqual(unsent.disposition, "never_sent");
		strictEqual(unsent.usage, null);
		strictEqual(unsent.pricing.usd.kind, "absent");
	}
	const error = callSettlementFromMessage(
		{ stopReason: "error", failure: { httpStatus: 429 }, usage: { input: 5 } },
		"unknown",
	);
	strictEqual(error.disposition, "settled");
	strictEqual(error.stop.failure, "rate_limited");
	const dropped = callSettlementFromMessage(
		{ stopReason: "aborted", responseId: "response", usage: { input: 5 } },
		"known",
	);
	strictEqual(dropped.disposition, "sent_unsettled");
	// What the provider reported before the stream ended is a measured lower bound; its zeros stay unknown.
	deepStrictEqual(dropped.usage?.input, { kind: "measured", value: 5, source: "provider" });
	strictEqual(dropped.usage?.output.kind, "unknown");
	strictEqual(dropped.pricing.usd.kind, "unknown");
	strictEqual(dropped.stop.failure, undefined);
	const counted = <T>(value: T) => ({ kind: "measured", value, source: "local-count" });
	const codex = (request: "full" | "delta", attribution = "exclusive") =>
		callSettlementFromMessage(
			{
				stopReason: "stop",
				usage: { input: 5, output: 1, totalTokens: 6 },
				clioCoderRequestBytes: 2048,
				codexTransport: {
					mode: "websocket",
					request: attribution === "exclusive" ? request : "unknown",
					attribution,
					counters: {
						requests: 1,
						connectionsCreated: 0,
						connectionsReused: 1,
						fullContextRequests: request === "full" ? 1 : 0,
						deltaRequests: request === "delta" ? 1 : 0,
						websocketFailures: 0,
						sseFallbacks: 0,
					},
					lastInputItems: 3,
					fallbackActive: false,
				},
			},
			"unknown",
		).transport;
	// Pi's per-session counters attribute continuation and reuse to one exclusive call; a delta frame's bytes are not
	// the payload's, and an overlapping stream proves nothing about either (#434).
	deepStrictEqual(codex("full"), {
		kind: "websocket",
		continuation: counted("full"),
		requestBytes: { kind: "estimated", value: 2048, method: "payload-json" },
		sessionPinnedToSse: counted(false),
		connectionReused: counted(true),
		websocketFailures: counted(0),
		sseFallbacks: counted(0),
	});
	const pinned = callSettlementFromMessage(
		{
			stopReason: "stop",
			usage: { input: 5, output: 1, totalTokens: 6 },
			codexTransport: {
				mode: "sse",
				request: "full",
				attribution: "exclusive",
				counters: {
					requests: 1,
					connectionsCreated: 0,
					connectionsReused: 0,
					fullContextRequests: 0,
					deltaRequests: 0,
					websocketFailures: 1,
					sseFallbacks: 1,
				},
				lastInputItems: null,
				fallbackActive: true,
				reason: "transport_failure",
				retryAt: "2026-10-30T12:00:30.000Z",
				cooldownMs: 30000,
			},
		},
		"unknown",
	).transport;
	deepStrictEqual(
		[pinned.kind, pinned.sessionPinnedToSse, pinned.websocketFailures, pinned.sseFallbacks, pinned.pinReason],
		["sse", counted(true), counted(1), counted(1), "transport_failure"],
	);
	deepStrictEqual(codex("delta").requestBytes, { kind: "unknown", reason: "not-observed" });
	deepStrictEqual(codex("full", "overlap"), {
		kind: "websocket",
		continuation: { kind: "unknown", reason: "not-observed" },
		requestBytes: { kind: "estimated", value: 2048, method: "payload-json" },
		sessionPinnedToSse: counted(false),
	});
	strictEqual(
		callSettlementFromMessage(
			{ stopReason: "error", failure: { stage: "provider", errorClass: "provider_error" } },
			"unknown",
		).disposition,
		"sent_unsettled",
		"a legacy prose classifier is not proof of a terminal provider response",
	);
});
