import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { telemetryContext, withTelemetryContext } from "../../src/core/telemetry/context.js";
import type { SegmentHeader, TelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { makeTelemetryRecord, monotonicSpan, readTelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { newAttemptId, newCallId, newRecordId, UUID_V7_PATTERN } from "../../src/core/telemetry/ids.js";
import type { CallSettled } from "../../src/core/telemetry/schemas.js";
import { KIND_NAMES, KIND_REGISTRY, validPayload } from "../../src/core/telemetry/schemas.js";
import { crc32, encodeTelemetryLine, scanTelemetrySegment } from "../../src/core/telemetry/segment.js";
import { callSettlementFromMessage } from "../../src/domains/observability/call-facts.js";

const context = { sessionId: "existing-session-id", label: "main" as const };
const header: SegmentHeader = {
	v: 1,
	k: "segment.open",
	schemaSet: "clio-telemetry/1",
	mode: "standard",
	capture: { content: false, deltas: false, providerHeaders: false, systemOneDataset: false, busTrace: false },
	clockOrigin: { host: "test-host", pid: 1, birthToken: "birth", monoEpochWallMs: 1000 },
	writer: { clioVersion: "test", piVersion: "test" },
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
				withTelemetryContext({ ...context, label: "memory" }, () => strictEqual(telemetryContext()?.label, "memory"));
				strictEqual(telemetryContext()?.label, "main");
			}),
		),
	);
	strictEqual(telemetryContext(), undefined);
});

test("call schemas distinguish measured zero, unknown, absent, and never sent", () => {
	const unknown = { kind: "unknown", reason: "provider-omitted" } as const;
	const measured = { kind: "measured", value: 0, source: "provider" } as const;
	const call: CallSettled = {
		callId: newCallId(),
		attemptId: newAttemptId(),
		attempt: 0,
		label: "main",
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
	deepStrictEqual(Object.keys(KIND_REGISTRY), [...KIND_NAMES]);
	for (const definition of Object.values(KIND_REGISTRY)) strictEqual(Value.Check(definition.schema, undefined), false);
});

test("monotonic spans never cross a process or segment origin", () => {
	const start = { origin: header.clockOrigin, mono: 5 };
	strictEqual(monotonicSpan(start, { ...start, mono: 10 }), 5);
	strictEqual(monotonicSpan(start, { ...start, mono: 4 }), null);
	for (const changed of [{ pid: 2 }, { host: "other" }, { birthToken: "another" }, { monoEpochWallMs: 2000 }]) {
		strictEqual(monotonicSpan(start, { origin: { ...start.origin, ...changed }, mono: 10 }), null);
	}
});

test("message facts preserve unknown placeholders, explicit zero, terminal errors and unsent calls", () => {
	const usage = { input: 0, output: 0, cacheRead: 0, cost: { total: 0 } };
	const omitted = callSettlementFromMessage({ stopReason: "stop", usage }, "unknown");
	strictEqual(omitted.disposition, "settled_no_usage");
	strictEqual(omitted.usage?.input.kind, "unknown");
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
	strictEqual(dropped.usage?.input.kind, "unknown");
	strictEqual(dropped.pricing.usd.kind, "unknown");
	strictEqual(dropped.stop.failure, undefined);
});
