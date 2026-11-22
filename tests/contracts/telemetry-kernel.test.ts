import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createAssistantMessageEventStream, type StreamOptions } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import {
	claimWireEffort,
	observeWireEffort,
	stampWireEffort,
	wireEffortOf,
} from "../../src/core/telemetry/call-effort.js";
import {
	observedToolCallOrigin,
	TelemetryContextSchema,
	telemetryContext,
	withTelemetryContext,
	withToolTelemetryContext,
} from "../../src/core/telemetry/context.js";
import {
	type CallEconomics,
	callEconomicsOf,
	moneyQuantities,
	runEconomicsOf,
	sumInUnit,
} from "../../src/core/telemetry/economy.js";
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
import type { SchedulingContract } from "../../src/domains/scheduling/contract.js";
import { callSettlementFromMessage } from "../../src/domains/telemetry/call-facts.js";
import type { TelemetryContract } from "../../src/domains/telemetry/contract.js";
import { observePayloadBytes } from "../../src/engine/payload-bytes.js";
import type { EngineModel } from "../../src/engine/types.js";
import { createSideRequestAdmission } from "../../src/entry/side-request-admission.js";
import { sideQuestionUsage } from "../../src/session-control/side-question.js";

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
const MODEL = { api: "openai-responses", provider: "openai", id: "model" } as EngineModel;

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

test("a call journals the thinking level it asked for and the effort its payload sent (FX-49)", async () => {
	const records: PendingTelemetry[] = [];
	const release = registerTelemetrySink("effort-session", { enqueue: (record) => Boolean(records.push(record)) });
	try {
		const ctx = { sessionId: "effort-session", agent: { role: "main" as const, id: "effort-session" } };
		const target = {
			targetId: "target",
			runtimeId: "runtime",
			api: "openai-responses",
			requestedModel: "model",
			reportedModel: { kind: "unknown", reason: "not-observed" } as const,
		};
		const call = beginCall({ target, roundKind: "normal", toolChoice: "auto", thinkingLevel: "off" }, ctx);
		const sent = async (payloads: unknown[]): Promise<Record<string, unknown>> => {
			const message = { role: "assistant", content: [], stopReason: "stop", usage: { input: 5, output: 1 } };
			const stream = observePayloadBytes(MODEL, {} as StreamOptions, (options) => {
				const source = createAssistantMessageEventStream();
				void (async () => {
					for (const payload of payloads) await options?.onPayload?.(payload, MODEL);
					source.push({ type: "done", reason: "stop", message } as never);
					source.end();
				})();
				return source;
			});
			for await (const _event of stream);
			return message as unknown as Record<string, unknown>;
		};
		// The level is asked for off, and the payload still carries an effort: the journal shows both.
		const low = await sent([{ model: "model", reasoning: { effort: "low", summary: "auto" } }]);
		const facts = call.settle(callSettlementFromMessage(low, "none"));
		strictEqual(facts?.wireEffort, "low");
		strictEqual(facts?.thinkingLevel, "off");
		const omitted = await sent([{ model: "model", max_tokens: 10 }]);
		strictEqual(callSettlementFromMessage(omitted, "none").wireEffort, "omitted");
		// Each payload is a whole request: a retry that names no effort sent none.
		const retried = await sent([{ reasoning_effort: "high" }, { max_tokens: 10 }]);
		strictEqual(callSettlementFromMessage(retried, "none").wireEffort, "omitted");
		// A message that cannot take the fact (frozen, sealed, null) is skipped; the stamp never throws into the reply.
		for (const message of [Object.freeze({}), Object.seal({}), null]) {
			observeWireEffort(message, "high");
			stampWireEffort(message, "high");
			claimWireEffort(message);
		}
		// Managed-effort bodies pin the top-level effort for the cache; the trailing entry is the one in force.
		const anthropic = {
			output_config: { effort: "low" },
			messages: [
				{ role: "system", content: [], output_config: { effort: "medium" } },
				{ role: "user", content: "hi" },
				{ role: "system", content: [], output_config: { effort: "max" } },
			],
		};
		strictEqual(wireEffortOf(anthropic), "max");
		const responses = {
			reasoning: { effort: "medium" },
			input: [
				{ type: "configuration_update", reasoning: { effort: "low" } },
				{ role: "user", content: "hi" },
				{ type: "configuration_update", reasoning: { effort: "xhigh" } },
			],
		};
		strictEqual(wireEffortOf(responses), "xhigh");
		strictEqual(wireEffortOf({ reasoning: { effort: "medium" }, input: [{ role: "user" }] }), "medium");
		// Bedrock Converse carries the model's own fields beside the command.
		strictEqual(
			wireEffortOf({ modelId: "m", additionalModelRequestFields: { output_config: { effort: "high" } } }),
			"high",
		);
		strictEqual(wireEffortOf({ additionalModelRequestFields: { reasoning_effort: "low" } }), "low");
		const hostile = Object.defineProperty({}, "reasoning", {
			get() {
				throw new Error("getter");
			},
		});
		strictEqual(wireEffortOf(hostile), undefined);
		strictEqual(callSettlementFromMessage({ stopReason: "stop" }, "none").wireEffort, undefined, "no payload, no fact");
		const started = records.find((record) => record.kind === "call.started");
		const settled = records.find((record) => record.kind === "call.settled");
		strictEqual((started?.data as { thinkingLevel?: string }).thinkingLevel, "off");
		ok(validPayload("call.started", started?.data) && validPayload("call.settled", settled?.data));
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
		const aborted = callSettlementFromMessage({ stopReason: "aborted", usage: { input: 0, output: 0 } }, "target-rates");
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
		const counted = callSettlementFromMessage({ stopReason: "aborted", usage: { input: 40, output: 0 } }, "target-rates");
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
		k: record.k,
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

test("run.settled writes the fleet role names at version 2 and a sealed version 1 reads as recorded (M12)", () => {
	const golden = new URL("../fixtures/telemetry/golden/vccap2ywu7n8/runs/2s47tzn7p4bz/journal.jsonl", import.meta.url);
	const sealed = readFileSync(golden, "utf8")
		.split("\n")
		.filter((line) => line.includes('"k":"run.settled"'))
		.map((line) => JSON.parse(line.slice(0, line.lastIndexOf("\t"))) as TelemetryRecord<"run.settled">)[0];
	ok(sealed !== undefined && sealed.kv === 1);
	const as = (kv: number, executionRole: string) => ({ ...sealed, kv, data: { ...sealed.data, executionRole } });
	const read = (kv: number, executionRole: string) => {
		const result = readTelemetryRecord(as(kv, executionRole));
		return result.kind === "record" && result.record.k === "run.settled" ? result.record.data.executionRole : result;
	};
	// A sealed version 1 keeps its role names as recorded; a version 2 holds only the fleet vocabulary.
	strictEqual(read(1, "researcher"), "researcher");
	strictEqual(read(1, "verifier"), "verifier");
	strictEqual(read(2, "explorer"), "explorer");
	strictEqual(read(2, "seat"), "seat");
	for (const [kv, role] of [
		[2, "researcher"],
		[2, "verifier"],
		[1, "explorer"],
	] as const)
		deepStrictEqual(read(kv, role), { kind: "skipped", reason: "invalid-record", k: "run.settled" });
	const ctx = {
		sessionId: "vccap2ywu7n8",
		runId: "2s47tzn7p4bz",
		agent: { role: "worker" as const, id: "2s47tzn7p4bz" },
	};
	const written = makeTelemetryRecord("run.settled", { ...sealed.data, executionRole: "checker" } as never, ctx, {
		t: sealed.t,
		mono: 0,
	});
	strictEqual(written.kv, 2);
	strictEqual(validPayload("run.settled", { ...sealed.data, executionRole: "verifier" }), false);
});

test("economics: a sealed record without them reads as not captured, and validators refuse unsafe, negative and mixed-unit amounts", () => {
	const golden = new URL("../fixtures/telemetry/golden/vccap2ywu7n8/runs/2s47tzn7p4bz/journal.jsonl", import.meta.url);
	const records = readFileSync(golden, "utf8")
		.split("\n")
		.filter((line) => line.includes('"k":"call.settled"') || line.includes('"k":"run.settled"'))
		.map((line) => readTelemetryRecord(JSON.parse(line.slice(0, line.lastIndexOf("\t")))));
	const notCaptured = { kind: "unknown", reason: "not-captured" } as const;
	const missing = (fact: unknown) => ({
		additive: {
			providerCharge: { amount: fact },
			marginalCharge: { amount: fact },
			seatCredits: { nanoAiu: fact },
			energy: { kwh: fact, cost: { amount: fact } },
		},
		comparison: { apiEquivalent: { amount: fact } },
		funding: fact,
	});
	strictEqual(records.length, 4);
	for (const read of records) {
		ok(read.kind === "record", JSON.stringify(read));
		const { record } = read;
		if (record.k === "run.settled") deepStrictEqual(runEconomicsOf(record.data), missing(notCaptured));
		else if (record.k === "call.settled") deepStrictEqual(callEconomicsOf(record.data), missing(notCaptured));
		else ok(false, record.k);
	}
	deepStrictEqual(callEconomicsOf(undefined), missing({ kind: "unknown", reason: "not-observed" }));
	deepStrictEqual(callEconomicsOf({ disposition: "never_sent" }), missing({ kind: "absent", reason: "not-applicable" }));

	const call = records.find((read) => read.kind === "record" && read.record.k === "call.settled");
	ok(call?.kind === "record" && call.record.k === "call.settled");
	const settled = call.record.data;
	const usd = (value: number) => ({ currency: "USD", amount: { kind: "measured", value, source: "provider" } }) as const;
	const economics: CallEconomics = {
		additive: {
			providerCharge: usd(0.25),
			marginalCharge: { amount: { kind: "unknown", reason: "provider-omitted" } },
			seatCredits: {
				nanoAiu: { kind: "estimated", value: 3_000_000_000, method: "seat-listing-tariff" },
				listingAsOf: "2026-05-01",
			},
			energy: {
				kwh: { kind: "absent", reason: "not-applicable" },
				cost: { amount: { kind: "absent", reason: "not-applicable" } },
			},
		},
		comparison: {
			apiEquivalent: {
				currency: "USD",
				amount: { kind: "estimated", value: 0.4, method: "public-retail-tariff" },
				referenceRowId: "openai/gpt-5@2026-04-01",
				asOf: "2026-04-01",
				basis: "served-model",
			},
		},
		funding: {
			kind: "snapshot",
			poolId: "pool_7f3a",
			scheme: { source: "declared", kind: "seat" },
			payer: "organization",
			unit: "nano-aiu",
			period: { kind: "month" },
		},
	};
	const valid = (patch: (e: CallEconomics) => unknown) =>
		validPayload("call.settled", { ...settled, economics: patch(structuredClone(economics)) });
	strictEqual(
		valid((e) => e),
		true,
	);
	const unsafe = Number.MAX_SAFE_INTEGER + 1;
	for (const patch of [
		(e: CallEconomics) => ({
			...e,
			additive: {
				...e.additive,
				seatCredits: {
					...e.additive.seatCredits,
					nanoAiu: { kind: "estimated", value: unsafe, method: "seat-listing-tariff" },
				},
			},
		}),
		(e: CallEconomics) => ({ ...e, additive: { ...e.additive, providerCharge: usd(-0.01) } }),
		// A known amount names its currency; a route price is not a provider charge, and an API equivalent is never cash.
		(e: CallEconomics) => ({ ...e, additive: { ...e.additive, providerCharge: { amount: usd(1).amount } } }),
		(e: CallEconomics) => ({
			...e,
			additive: {
				...e.additive,
				providerCharge: { currency: "USD", amount: { kind: "estimated", value: 1, method: "target-rates" } },
			},
		}),
		(e: CallEconomics) => ({
			...e,
			comparison: { apiEquivalent: { ...e.comparison.apiEquivalent, amount: usd(1).amount } },
		}),
		(e: CallEconomics) => ({ ...e, funding: { ...e.funding, poolId: "someone@example.com" } }),
		(e: CallEconomics) => ({ ...e, savings: 1 }),
	])
		strictEqual(valid(patch), false);
	strictEqual(
		validPayload("call.settled", {
			...settled,
			usage: { ...settled.usage, input: { kind: "measured", value: unsafe, source: "provider" } },
		}),
		false,
	);
	strictEqual(
		validPayload("call.settled", {
			...settled,
			usage: { ...settled.usage, input: { kind: "measured", value: -1, source: "provider" } },
		}),
		false,
	);

	const quota = {
		provider: "openai-codex",
		targetId: "codex",
		source: "poll",
		observedAt: "2026-05-01T00:00:00.000Z",
		windows: [
			{
				key: "primary",
				usedPct: { kind: "measured", value: 40, source: "provider" },
				unit: "requests",
				durationSeconds: 18_000,
			},
		],
		displayName: "Codex",
		status: "ok",
		credits: {
			display: "12 credits",
			usedPct: { kind: "unknown", reason: "provider-omitted" },
			unit: "provider-credits",
		},
		accountPseudonym: "acct_9c1e",
	};
	strictEqual(validPayload("quota.read", quota), true);
	strictEqual(validPayload("quota.read", { ...quota, windows: [], limitOnly: true, limitReached: true }), true);
	strictEqual(validPayload("quota.read", { ...quota, accountPseudonym: "someone@example.com" }), false);
	strictEqual(validPayload("quota.read", { ...quota, windows: [{ ...quota.windows[0], durationSeconds: 0 }] }), false);
	strictEqual(validPayload("quota.read", { ...quota, limitOnly: false }), false);

	const eur = { currency: "EUR", amount: { kind: "measured", value: 1, source: "provider" } } as const;
	deepStrictEqual(sumInUnit(moneyQuantities([usd(1), eur])), { refused: "mixed-unit", units: ["EUR", "USD"] });
	const nano = (value: number) => ({ unit: "nano-aiu", fact: { kind: "measured", value, source: "provider" } }) as const;
	deepStrictEqual(sumInUnit([nano(Number.MAX_SAFE_INTEGER), nano(1)]), { refused: "out-of-range", unit: "nano-aiu" });
	deepStrictEqual(sumInUnit([nano(-1)]), { refused: "out-of-range", unit: "nano-aiu" });
	deepStrictEqual(sumInUnit([{ unit: "percent", fact: { kind: "measured", value: 5, source: "provider" } }]), {
		refused: "non-additive-unit",
		unit: "percent",
	});
	const total = sumInUnit(moneyQuantities([usd(1), usd(0.5), { amount: notCaptured }]));
	ok("sum" in total && "unit" in total && total.unit === "USD");
	deepStrictEqual([total.sum.measured, total.sum.unknownCount], [1.5, 1]);
	deepStrictEqual(sumInUnit(moneyQuantities([{ amount: notCaptured }])), {
		sum: {
			measured: 0,
			estimated: 0,
			unknownCount: 1,
			absentCount: 0,
			coverage: { measured: 0, estimated: 0, unknown: 1 },
		},
	});
});

test("a settled breakdown keeps its measured zeros beside a larger total; only a total-only row loses them (#434)", () => {
	// Gemini's total also counts tool-use prompt tokens that Pi maps to no breakdown field.
	const gemini = callSettlementFromMessage(
		{ stopReason: "stop", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 180 } },
		"none",
	);
	deepStrictEqual(gemini.usage?.cacheRead, { kind: "measured", value: 0, source: "provider" });
	deepStrictEqual(gemini.usage?.total, { kind: "measured", value: 180, source: "provider" });
	const totalOnly = callSettlementFromMessage(
		{ stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 500 } },
		"none",
	);
	strictEqual(totalOnly.usage?.input.kind, "unknown");
	deepStrictEqual(totalOnly.usage?.total, { kind: "measured", value: 500, source: "provider" });
});

test("declared target rates price the counts of a runtime that computed no cost, and unknown stays unknown (#434)", async () => {
	// copilot-sdk marks its seeded zero total uncomputed and lists the counts it measured; rates are per million.
	const cost = { total: 0, totalUncomputed: true };
	const usage = { input: 3, output: 27, cacheRead: 9905, cacheWrite: 226, totalTokens: 10161, cost };
	const rates = { input: 2, output: 8, cacheRead: 2, cacheWrite: 0 };
	const copilot = (reportedFields: string[]) =>
		callSettlementFromMessage(
			{ stopReason: "stop", usage: { ...usage, reportedFields } },
			{ pricedBy: "target-rates", rates },
		).pricing;
	deepStrictEqual(copilot(["input", "output", "cacheRead", "cacheWrite"]), {
		usd: { kind: "measured", value: (3 * 2 + 27 * 8 + 9905 * 2) / 1_000_000, source: "local-count" },
		pricedBy: "target-rates",
	});
	// A rated count the provider never reported cannot be priced; a zero-rated one does not matter.
	strictEqual(copilot(["input", "output", "cacheWrite"]).usd.kind, "unknown");
	strictEqual(copilot(["input", "output", "cacheRead"]).usd.kind, "measured");
	// Handed no rates, an uncomputed total is never taken as the amount.
	strictEqual(
		callSettlementFromMessage(
			{ stopReason: "stop", usage: { ...usage, reportedFields: ["input", "output"] } },
			"target-rates",
		).pricing.usd.kind,
		"unknown",
	);
	// A Pi runtime computed its total from the declared rates, so it keeps that total, cache-read field omitted or not.
	const pi = (extra: Record<string, unknown>, priced = { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 0 }) =>
		callSettlementFromMessage(
			{ stopReason: "stop", usage: { input: 1000, output: 50, cacheRead: 0, cacheWrite: 0, ...extra } },
			{ pricedBy: "target-rates", rates: priced },
		).pricing;
	deepStrictEqual(pi({ cacheReadField: "omitted", cost: { total: 0.0024 } }), {
		usd: { kind: "measured", value: 0.0024, source: "local-count" },
		pricedBy: "target-rates",
	});
	// With no total at all, an undeclared cacheWrite rate is the documented $0 for 1h writes; a declared one bills 2x input.
	const longWrites = { cacheWrite: 100, cacheWrite1h: 100 };
	const undeclared = pi(longWrites).usd;
	strictEqual(undeclared.kind === "measured" && undeclared.value, (1000 * 2 + 50 * 8) / 1_000_000);
	const declared = pi(longWrites, { input: 2, output: 8, cacheRead: 2, cacheWrite: 3 }).usd;
	strictEqual(declared.kind === "measured" && declared.value, (1000 * 2 + 50 * 8 + 100 * 4) / 1_000_000);
	// A provider's own cost outranks declared rates.
	deepStrictEqual(pi({ cost: { total: 0.5, totalFromProvider: true } }), {
		usd: { kind: "measured", value: 0.5, source: "provider" },
		pricedBy: "provider",
	});
	// A side request (System One one-shot, safety judge) carries the same marks through sideQuestionUsage.
	const settled: CallSettled[] = [];
	const unsubscribe = telemetryHub().subscribe("call.settled", (payload) => {
		settled.push(payload);
	});
	try {
		const admit = createSideRequestAdmission({
			providers: {
				getTarget: () => ({ id: "side", runtime: "copilot-sdk", pricing: { input: 2, output: 8, cacheWrite: 3 } }) as never,
			},
			scheduling: { admitPaidRequest: async () => {} } as unknown as SchedulingContract,
			getCeilingUsd: () => 0,
			currentSession: () => "side-session",
			repoIdentity: () => "side-repo",
			telemetry: {
				acquireTelemetrySession: async () => ({
					journaled: true,
					context: { sessionId: "side-session", agent: { role: "system-one", id: "side-session" } },
					release: async () => {},
				}),
			} as unknown as TelemetryContract,
		});
		const side = async (raw: Record<string, unknown>) => {
			(await admit({ targetId: "side", model: "m", signal: new AbortController().signal }))(sideQuestionUsage(raw), {
				callOutcome: "success",
			});
			return settled.at(-1)?.pricing;
		};
		// copilot-sdk's placeholder cacheWrite is not promoted to measured, and its rate is declared: unknown.
		const placeholder = { ...usage, cacheWrite: 0, reportedFields: ["input", "output", "cacheRead"] };
		strictEqual((await side(placeholder))?.usd.kind, "unknown");
		ok(
			(await side({ ...placeholder, reportedFields: ["input", "output", "cacheRead", "cacheWrite"] }))?.usd.kind ===
				"measured",
		);
		deepStrictEqual(await side({ input: 1000, output: 50, cost: { total: 0.5, totalFromProvider: true } }), {
			usd: { kind: "measured", value: 0.5, source: "provider" },
			pricedBy: "provider",
		});
	} finally {
		unsubscribe();
	}
});

test("message facts preserve unknown placeholders, explicit zero, terminal errors and unsent calls", () => {
	const usage = { input: 0, output: 0, cacheRead: 0, cost: { total: 0 } };
	const omitted = callSettlementFromMessage({ stopReason: "stop", usage }, "none");
	strictEqual(omitted.disposition, "settled_no_usage");
	strictEqual(omitted.usage?.input.kind, "unknown");
	const unverified = callSettlementFromMessage(
		{ stopReason: "stop", usage: { input: 123, clioExternal: { tokenUsage: "unverified" } } },
		"none",
	);
	strictEqual(unverified.usage?.input.kind, "unknown");
	const zero = callSettlementFromMessage(
		{
			stopReason: "stop",
			usage: { ...usage, clioExternal: { tokenUsage: "provider-reported", cost: "provider-reported" } },
		},
		"target-rates",
	);
	strictEqual(zero.disposition, "settled");
	deepStrictEqual(zero.usage?.input, { kind: "measured", value: 0, source: "provider" });
	deepStrictEqual(zero.pricing.usd, { kind: "measured", value: 0, source: "provider" });
	for (const marker of [{ callInvoked: false }, { failure: { invoked: false } }, { usage: { callInvoked: false } }]) {
		const unsent = callSettlementFromMessage({ stopReason: "aborted", usage, ...marker }, "free");
		strictEqual(unsent.disposition, "never_sent");
		strictEqual(unsent.usage, null);
		strictEqual(unsent.pricing.usd.kind, "absent");
	}
	const error = callSettlementFromMessage(
		{ stopReason: "error", failure: { httpStatus: 429 }, usage: { input: 5 } },
		"none",
	);
	strictEqual(error.disposition, "settled");
	strictEqual(error.stop.failure, "rate_limited");
	const dropped = callSettlementFromMessage(
		{ stopReason: "aborted", responseId: "response", usage: { input: 5 } },
		"target-rates",
	);
	strictEqual(dropped.disposition, "sent_unsettled");
	// What the provider reported before the stream ended is a measured lower bound; its zeros stay unknown.
	deepStrictEqual(dropped.usage?.input, { kind: "measured", value: 5, source: "provider" });
	strictEqual(dropped.usage?.output.kind, "unknown");
	strictEqual(dropped.pricing.usd.kind, "unknown");
	strictEqual(dropped.stop.failure, undefined);
	// A refused connection has no HTTP status and streamed nothing, so a cost cap charges it no prompt estimate.
	const refused = { stopReason: "error", failure: { stage: "transport", invoked: true }, usage };
	const estimate = { input: 4000, output: 0, usd: 0.4 };
	strictEqual(callSettlementFromMessage(refused, "target-rates", undefined, estimate).pricing.usd.kind, "unknown");
	strictEqual(
		callSettlementFromMessage(refused, "target-rates", undefined, { ...estimate, output: 12 }).pricing.usd.kind,
		"estimated",
	);
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
			"none",
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
		"none",
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
			"none",
		).disposition,
		"sent_unsettled",
		"a legacy prose classifier is not proof of a terminal provider response",
	);
});
