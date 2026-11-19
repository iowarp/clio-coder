import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import {
	buildCacheCallObservation,
	type CacheCallBaseline,
	type CacheRequestStructure,
} from "../../src/core/cache-telemetry.js";
import type { CallSettled, CallUsage } from "../../src/core/telemetry/schemas.js";
import { clioStateDir } from "../../src/core/xdg.js";
import type {
	ContinuityCheckpointPayload,
	HandoffEvent,
	HandoffIdentity,
	HandoffPolicy,
} from "../../src/domains/session/continuity/contract.js";
import { validateContinuityNote } from "../../src/domains/session/continuity/note.js";
import { resolveContinuityProjection } from "../../src/domains/session/continuity/projection.js";
import type { SessionEntryInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import {
	cachePhysics,
	firstDivergentSection,
	journaledStructure,
	serverTimedUsage,
} from "../../src/domains/telemetry/cache-physics.js";
import { callSettlementFromMessage } from "../../src/domains/telemetry/call-facts.js";
import { readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import type { TelemetryContract } from "../../src/domains/telemetry/contract.js";
import { telemetrySessionDirectory } from "../../src/domains/telemetry/paths.js";
import { createSessionJournals } from "../../src/domains/telemetry/session-journals.js";
import {
	type AttemptReceipt,
	type ReceiptJournalRecord,
	verifyAttemptReceipts,
} from "../../src/session-control/attempt-receipt.js";
import type { ToolSpec } from "../../src/tools/registry.js";
import { type CaptureScript, chatHarness, startCaptureServer, wireElements } from "../harness/context-capture.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

// #423: a break the host cannot name is attributed to the route lifetime it outlived, or to a continuation
// the transport rebuilt, before it is left unknown.

const broken = { input: 10_000, cacheRead: 0, cacheWrite: 0 };
const baseline: CacheCallBaseline = { inclusiveInputTokens: 10_000, endedAt: 0, transportRequest: "delta" };
const websocket = (request: "full" | "delta") => ({ mode: "websocket" as const, request });

test("a break after the route lifetime is idle expiry, and the lifetime is recorded", () => {
	const idle = buildCacheCallObservation(broken, baseline, [], 300_000, undefined, {
		ttlMs: 300_000,
		transport: websocket("delta"),
	});
	strictEqual(idle.cause, "idle_expiry");
	strictEqual(idle.causeBasis, "inferred");
	strictEqual(idle.idleMs, 300_000);
	deepStrictEqual(idle.ttl, { ms: 300_000, source: "declared" });
	deepStrictEqual(idle.transport, websocket("delta"));
	const unknownLifetime = buildCacheCallObservation(broken, baseline, [], 300_000, undefined, { ttlMs: null });
	strictEqual(unknownLifetime.cause, "unknown");
	deepStrictEqual(unknownLifetime.ttl, { ms: null, source: "unknown" });
});

test("a full frame after a delta, or after a transport recovery, is a transport reset", () => {
	const afterDelta = buildCacheCallObservation(broken, baseline, [], 60_000, undefined, {
		ttlMs: 300_000,
		transport: websocket("full"),
	});
	strictEqual(afterDelta.cause, "transport_reset");
	strictEqual(afterDelta.causeBasis, "host");
	const recovered = buildCacheCallObservation(broken, { ...baseline, transportRequest: "full" }, [], 60_000, undefined, {
		ttlMs: 300_000,
		transport: { mode: "sse", request: "full", reason: "transport_failure", recovery: true },
	});
	strictEqual(recovered.cause, "transport_reset");
	deepStrictEqual(recovered.transport, { mode: "sse", request: "full", reason: "transport_failure" });
	const plainFull = buildCacheCallObservation(broken, { ...baseline, transportRequest: "full" }, [], 60_000, undefined, {
		ttlMs: 300_000,
		transport: websocket("full"),
	});
	strictEqual(plainFull.cause, "unknown");
});

test("a host-known change outranks both, and a healthy read is never a break", () => {
	const recompiled = buildCacheCallObservation(broken, baseline, ["prompt_recompiled"], 600_000, undefined, {
		ttlMs: 300_000,
		transport: websocket("full"),
	});
	strictEqual(recompiled.cause, "prompt_recompiled");
	const healthy = buildCacheCallObservation({ ...broken, cacheRead: 9_900 }, baseline, [], 600_000, undefined, {
		ttlMs: 300_000,
		transport: websocket("full"),
	});
	strictEqual(healthy.cause, "none");
	strictEqual(healthy.idleMs, 600_000);
});

test("the journal names the first divergence in request order and leaves an unreported read unknown (#434)", () => {
	const structure: CacheRequestStructure = { system: "s", tools: "t", entries: ["a", "b"], answered: true };
	strictEqual(firstDivergentSection(structure, { ...structure, entries: ["a", "b", "c"] }), null);
	strictEqual(firstDivergentSection(structure, { ...structure, tools: "u", entries: ["x"] }), "tools");
	strictEqual(firstDivergentSection(structure, { ...structure, entries: ["a", "x", "c"] }), "messages");
	strictEqual(firstDivergentSection(structure, { ...structure, entries: ["a"] }), "messages");
	strictEqual(firstDivergentSection(structure, { ...structure, system: "r" }), "system-prompt");
	const measured = (value: number) => ({ kind: "measured", value, source: "provider" }) as const;
	const usage = (cacheRead: CallUsage["cacheRead"]): CallUsage => ({
		input: measured(4_000),
		output: measured(10),
		cacheRead,
		cacheWrite: measured(0),
		cacheWrite1h: measured(0),
		reasoning: measured(0),
	});
	const pricing = { rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 }, pricedBy: "target-rates" } as const;
	const previous = { structure, promptTokens: 10_000 };
	const broke = cachePhysics({
		settlement: { disposition: "settled", usage: usage(measured(7_000)) },
		structure,
		previous,
		pricing,
	});
	deepStrictEqual(broke.cache.rePrefilledTokens, { kind: "measured", value: 3_000, source: "local-count" });
	strictEqual(broke.baseline?.promptTokens, 11_000);
	const omitted = cachePhysics({
		settlement: { disposition: "settled", usage: usage({ kind: "unknown", reason: "provider-omitted" }) },
		structure,
		previous,
		pricing,
	});
	deepStrictEqual(omitted.cache.rePrefilledTokens, { kind: "unknown", reason: "provider-omitted" });
	deepStrictEqual(omitted.cache.bill, { usd: { kind: "unknown", reason: "provider-omitted" }, pricedBy: "none" });
	strictEqual(omitted.baseline?.promptTokens, null);
	// A request carrying an earlier reply that this process never saw has no baseline to compare with.
	const resumed = cachePhysics({
		settlement: { disposition: "settled", usage: usage(measured(0)) },
		structure,
		previous: undefined,
		pricing,
	});
	deepStrictEqual(resumed.cache.rePrefilledTokens, { kind: "unknown", reason: "not-observed" });
});

test("a server whose usage omits cache reads is judged by its own cache_n, and its usage facts stand (#434)", () => {
	const settlement = callSettlementFromMessage(
		{
			role: "assistant",
			stopReason: "stop",
			usage: { input: 10_000, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10_005, cacheReadField: "omitted" },
		},
		"free",
	);
	// The usage's input is the whole prompt, so it is no uncached prefill without a measured read beside it.
	deepStrictEqual(settlement.usage?.input, { kind: "measured", value: 10_000, source: "provider" });
	deepStrictEqual(settlement.usage?.cacheRead, { kind: "unknown", reason: "provider-omitted" });
	deepStrictEqual(settlement.cache.uncachedPrefillTokens, { kind: "unknown", reason: "provider-omitted" });
	const backend = {
		promptTokens: 10_000,
		cachedTokens: 6_000,
		predictedTokens: 5,
		promptMs: 120,
		predictedMs: 40,
		source: "llamacpp-timings",
	} as const;
	const timed = serverTimedUsage(settlement, backend);
	deepStrictEqual(
		[timed?.input, timed?.cacheRead, timed?.cacheWrite],
		[4_000, 6_000, 0].map((value) => ({ kind: "measured", value, source: "provider" })),
	);
	const structure: CacheRequestStructure = { system: "s", tools: "t", entries: ["a", "b"], answered: true };
	const physics = cachePhysics({
		settlement: { ...settlement, usage: timed ?? null },
		structure,
		previous: { structure, promptTokens: 9_000 },
		pricing: { rates: null, pricedBy: "free" },
	});
	deepStrictEqual(physics.cache.rePrefilledTokens, { kind: "measured", value: 3_000, source: "local-count" });
	strictEqual(physics.baseline?.promptTokens, 10_000);
	strictEqual(serverTimedUsage(settlement, { ...backend, cachedTokens: null }), undefined);
	strictEqual(serverTimedUsage({ ...settlement, disposition: "sent_unsettled" }, backend), undefined);
	const read = { ...settlement, usage: timed ?? null };
	strictEqual(serverTimedUsage(read, backend), undefined, "a measured read is the provider's and stands");
});

test("an omitted cache read leaves the shortfall unknown and is never a break (#434)", () => {
	const omitted = buildCacheCallObservation({ input: 10_000, cacheRead: null, cacheWrite: 0 }, baseline, [], 60_000);
	strictEqual(omitted.shortfallTokens, null);
	strictEqual(omitted.cacheReadTokens, null);
	strictEqual(omitted.cause, "none");
});

test("a request's structure is journaled whole once per process and route, then as what it appended", () => {
	const hex = (c: string) => c.repeat(64);
	const structure = (entries: string[]) => ({
		system: hex("a"),
		tools: hex("b"),
		entries: entries.map(hex),
		roles: entries.map((_, index) => (index % 2 === 0 ? "user" : "assistant")),
		answered: entries.length > 1,
	});
	const first = structure(["1", "2", "3"]);
	deepStrictEqual(journaledStructure(first, undefined), {
		system: "a".repeat(16),
		tools: "b".repeat(16),
		entries: [`user:${"1".repeat(16)}`, `assistant:${"2".repeat(16)}`, `user:${"3".repeat(16)}`],
	});
	// An append carries only its new entries; a rewrite restarts where the transcripts part.
	deepStrictEqual(journaledStructure(structure(["1", "2", "3", "4"]), first).entries, [`assistant:${"4".repeat(16)}`]);
	deepStrictEqual(journaledStructure(structure(["1", "9", "3"]), first), {
		system: "a".repeat(16),
		tools: "b".repeat(16),
		base: 1,
		entries: [`assistant:${"9".repeat(16)}`, `user:${"3".repeat(16)}`],
	});
});

/** A chat harness whose calls journal to the session's telemetry, read back as `context working-set --verify` reads it. */
async function journaledSession(
	script: CaptureScript,
	drive: (harness: ReturnType<typeof chatHarness>) => Promise<void>,
	options: Omit<Parameters<typeof chatHarness>[0], "server" | "telemetry"> = {},
	bind?: (harness: ReturnType<typeof chatHarness>) => void,
): Promise<{ entries: ReadonlyArray<SessionEntry>; records: ReceiptJournalRecord[] }> {
	const env = await isolateClioEnv("attempt-receipt-");
	const server = await startCaptureServer(script);
	const journals = createSessionJournals(clioStateDir(), () => {});
	const telemetry = { acquireTelemetrySession: journals.acquire } as unknown as TelemetryContract;
	const harness = chatHarness({ ...options, server, telemetry });
	bind?.(harness);
	try {
		const id = harness.session.create({ cwd: process.cwd() }).id;
		await drive(harness);
		await journals.flush();
		const journal = await readCallJournal(telemetrySessionDirectory(clioStateDir(), id));
		return { entries: harness.session.readEntries(), records: journal.records.map(({ record }) => record) };
	} finally {
		await harness.close();
		await journals.closeAll();
		await server.close();
		env.restore();
	}
}

const settledCalls = (records: ReadonlyArray<ReceiptJournalRecord>): CallSettled[] =>
	records.flatMap((record) => (record.k === "call.settled" ? [record.data as CallSettled] : []));

test("a hidden #426 retry verifies against its own attempt, and the next request names what it changed (ContextFold CF-9, F14)", {
	timeout: 30_000,
}, async () => {
	let lock: () => void = () => {};
	const locker: ToolSpec = {
		name: "probe" as ToolSpec["name"],
		description: "Repeats the same failing call until the loop guard locks the run",
		parameters: Type.Object({}),
		baseActionClass: "read",
		run: async () => {
			lock();
			return { kind: "ok", output: "probe result" };
		},
	};
	const { entries, records } = await journaledSession(
		(request) =>
			wireElements(request).at(-1) === "user:lock this round"
				? { calls: [{ id: "call-probe", name: "probe", arguments: {} }] }
				: request.body.tool_choice === "none"
					? { status: 400, error: "400 tool_choice none is not supported" }
					: { text: "answered" },
		async (harness) => {
			await harness.submit("lock this round");
			await harness.submit("and continue");
		},
		{ tools: [locker] },
		(harness) => {
			lock = () =>
				harness.context.bus.emit("safety.loop_blocked", {
					disposition: "lockout",
					tool: "probe",
					priorFailure: "the same call failed again",
					repeatCount: 3,
					blocksThisTurn: 1,
					budget: 3,
					interrupted: false,
					at: Date.now(),
				});
		},
	);
	const [opening, rejected, retry, next] = settledCalls(records);
	ok(opening && rejected && retry && next);
	strictEqual(retry.callId, rejected.callId, "the retry is the same call");
	strictEqual(retry.attempt, 1);
	deepStrictEqual(
		[rejected, retry].map((call) => [call.cache.receipt?.toolChoice, call.cache.receipt?.tail]),
		[
			['"none"', "synthesis_directive"],
			['"auto"', "synthesis_directive"],
		],
		"each attempt took its own receipt at send",
	);
	strictEqual(retry.cache.structure?.baseAttempt, rejected.attemptId);
	const verdicts = verifyAttemptReceipts({ entries, records }).attempts;
	deepStrictEqual(
		verdicts.map((verdict) => [verdict.attemptId, verdict.status]),
		[opening, rejected, retry, next].map((call) => [call.attemptId, "verified"]),
	);
	// The next request drops the directive the locked round's tool result carried: its first changed element.
	deepStrictEqual(next.cache.firstChangedElement, { index: 2, role: "toolResult" });
});

test("the receipt verifier reports each attempt kind and reconciles fold decisions by record id (ContextFold CF-9, F14)", {
	timeout: 30_000,
}, async () => {
	// cf-q2 R7: the checkpoint append writes and then throws; its decision still names the record it wrote.
	const { entries, records } = await journaledSession(
		(_request, index) => ({ text: index < 2 ? "old ".repeat(25_000) : "answered" }),
		async (harness) => {
			await harness.submit("first");
			await harness.submit("second");
			const append = harness.session.appendEntry;
			harness.session.appendEntry = (entry) => {
				const written = append(entry);
				if (entry.kind === "compactionSummary") throw new Error("post-append failure");
				return written;
			};
			await harness.loop.compact();
			await harness.loop.whenSettled();
			harness.session.appendEntry = append;
			await harness.submit("third");
		},
		{ autoCompact: true },
	);
	const checkpoint = entries.find((entry) => entry.kind === "compactionSummary");
	ok(checkpoint, "the append wrote its checkpoint");
	const fold = records.find((record) => record.k === "context.fold");
	ok(fold);
	const calls = settledCalls(records);
	const last = calls.at(-1);
	ok(last, "the post-checkpoint attempt settled");
	ok(last.cache.receipt?.records.includes(checkpoint.turnId), "the post-checkpoint attempt's view names the record");
	const statuses = (input: Partial<Parameters<typeof verifyAttemptReceipts>[0]>) =>
		verifyAttemptReceipts({ entries, records, ...input }).attempts.map((verdict) =>
			verdict.reason ? `${verdict.status} (${verdict.reason})` : verdict.status,
		);
	/** The journal with the last attempt's records rewritten, as another writer or an older build would journal them. */
	const rewritten = (change: (record: ReceiptJournalRecord) => ReceiptJournalRecord | null) =>
		records.flatMap((record) => {
			const data = record.data as { callId?: string };
			if (data.callId !== last.callId) return [record];
			const changed = change(record);
			return changed ? [changed] : [];
		});
	const relabelled = (role: string) =>
		rewritten((record) =>
			record.ctx
				? { ...record, ctx: { ...record.ctx, agent: { ...record.ctx.agent, role } } as typeof record.ctx }
				: record,
		);
	const earlier = calls.slice(0, -1).map(() => "verified");
	// Codex: an effort baseline and a change sit on the path just before the last user turn, which carries the update.
	const third = [...entries].reverse().find((entry) => entry.kind === "message" && entry.role === "user");
	ok(third);
	const effort = (turnId: string, parentTurnId: string | null, level: string, initial: boolean): SessionEntry =>
		({
			kind: "thinkingLevelChange",
			turnId,
			parentTurnId,
			timestamp: third.timestamp,
			thinkingLevel: level,
			effectiveEffort: level,
			...(initial ? { configurationInitial: true } : {}),
		}) as SessionEntry;
	const efforted = entries.flatMap((entry) =>
		entry === third
			? [
					effort("effort-base", third.parentTurnId, "high", true),
					effort("effort-low", "effort-base", "low", false),
					{ ...third, parentTurnId: "effort-low" },
				]
			: [entry],
	);
	const withCodex = (codex: NonNullable<AttemptReceipt["codex"]>) =>
		rewritten((record) =>
			record.k === "call.settled"
				? { ...record, data: { ...last, cache: { ...last.cache, receipt: { ...last.cache.receipt, codex } } } }
				: record,
		);
	const lowered = { initialEffort: "high", updates: [{ position: third.turnId, effort: "low" }] };
	const table: ReadonlyArray<[string, Partial<Parameters<typeof verifyAttemptReceipts>[0]>, string[]]> = [
		["every main attempt matches the receipt taken at its send", {}, [...earlier, "verified"]],
		["a prewarm", { records: relabelled("prewarm") }, [...earlier, "not-verifiable (prewarm)"]],
		["a summary call", { records: relabelled("compaction") }, [...earlier, "not-verifiable (summary call)"]],
		["a v6 attempt", { formatVersion: 6 }, calls.map(() => "not-verifiable (v6 session)")],
		[
			"a worker history",
			{ runRecords: records.filter((record) => record.k === "call.settled").slice(0, 1) },
			[...earlier, "verified", "not-verifiable (worker history)"],
		],
		[
			"a native checkpoint the ledger cannot supply",
			{
				records: rewritten((record) =>
					record.k === "call.settled"
						? {
								...record,
								data: {
									...last,
									cache: { ...last.cache, receipt: { ...last.cache.receipt, checkpoints: ["0123456789abcdef"] } },
								},
							}
						: record,
				),
			},
			[...earlier, "not-verifiable (native checkpoint unavailable)"],
		],
		[
			"a Codex effort the ledger re-derives",
			{ entries: efforted, records: withCodex(lowered) },
			[...earlier, "verified"],
		],
		[
			"a Codex effort the ledger does not imply",
			{ entries: efforted, records: withCodex({ ...lowered, updates: [] }) },
			[...earlier, "mismatch (codex effort differs)"],
		],
		[
			"a Codex effort the ledger does not name",
			{ records: withCodex(lowered) },
			[...earlier, "not-verifiable (codex effort not on the ledger)"],
		],
		[
			"a peer-owned call",
			{ records: rewritten((record) => (record.k === "call.started" ? null : record)) },
			[...earlier, "external"],
		],
		[
			"a ledger that no longer renders what was sent",
			{
				entries: entries.map((entry) =>
					entry.turnId === checkpoint.turnId && entry.kind === "compactionSummary"
						? { ...entry, summary: `${entry.summary} (edited)` }
						: entry,
				),
			},
			[...earlier, "mismatch (element 0 (user) differs)"],
		],
	];
	for (const [label, input, expected] of table) deepStrictEqual(statuses(input), expected, label);
	// R7: the one committed stage names the record the append wrote; missing and duplicate decisions are reported.
	strictEqual(
		(fold.data as { stages: Array<{ recordId?: string }> }).stages.find((stage) => stage.recordId)?.recordId,
		checkpoint.turnId,
	);
	const decisions = (input: Partial<Parameters<typeof verifyAttemptReceipts>[0]>) =>
		verifyAttemptReceipts({ entries, records, ...input }).decisions;
	deepStrictEqual(decisions({}), { missing: [], duplicate: [], orphan: [] }, "reconciled by record id");
	deepStrictEqual(decisions({ records: records.filter((record) => record !== fold) }).missing, [checkpoint.turnId]);
	deepStrictEqual(decisions({ records: [...records, fold] }).duplicate, [checkpoint.turnId]);
	const stages = (fold.data as { stages: Array<{ recordId?: string }> }).stages;
	const combined = { ...fold, data: { ...(fold.data as object), stages: [...stages, ...stages] } };
	const oneEvent = records.map((record) => (record === fold ? combined : record));
	deepStrictEqual(decisions({ records: oneEvent }).duplicate, [], "two stages of one event name one decision");
});

test("a late verify renders a continuity note at the clock its attempt rendered it, not its own (ContextFold CF-9, F14)", {
	timeout: 30_000,
}, async () => {
	const preparedAtMs = Date.now() - 1_000;
	const deadline = preparedAtMs + 60_000;
	const admitted = validateContinuityNote("A: finish the parser rewrite; the failing case is a nested fence");
	ok(admitted.ok);
	const at = new Date(preparedAtMs).toISOString();
	const policy: HandoffPolicy = {
		preparedAtMs,
		automaticDeadlineAtMs: deadline,
		maxAttempts: 2,
		maxSummaryCallsPerAttempt: 2,
		additionalSummaryRetriesPerCall: 0,
		maxSummaryStreamInvocations: 4,
		flushRetryLimit: 3,
	};
	// A ready handoff whose automatic window is still open when the attempt renders it.
	const handoff = (sessionId: string): SessionEntryInput[] => {
		const identity: HandoffIdentity = {
			handoffId: "h",
			preparedEntryId: "prep",
			commitId: "commit",
			commitEntryId: "commit-entry",
			originSessionId: sessionId,
			branchAnchorTurnId: "m2",
			initiatingTurnId: "m1",
			toolCallId: "tc",
			sourceRevision: "lb-1-00000000000000ff",
		};
		const step = (entryId: string, prevEntryId: string | null, sequence: number, attempt: number, event: HandoffEvent) =>
			({
				kind: "handoffTransaction",
				turnId: entryId,
				parentTurnId: "m2",
				timestamp: at,
				schemaVersion: 1,
				identity,
				transition: { entryId, prevEntryId, sequence, attempt },
				event,
			}) as unknown as SessionEntryInput;
		const transition = { entryId: "commit-entry", prevEntryId: "reduce", sequence: 2, attempt: 1 };
		const continuity = {
			schemaVersion: 1,
			identity,
			accepted: admitted.accepted,
			policy,
			commit: {
				outcome: "summarized",
				entry: { turnId: "commit-entry", parentTurnId: "m2", timestamp: at },
				transition,
				summaryRef: "summary",
				tokensBefore: 30_000,
				tokensAfter: 9_000,
			},
			state: { transition, event: { phase: "ready" }, activeResume: null, delivery: null },
		} as unknown as ContinuityCheckpointPayload;
		return [
			step("prep", null, 0, 0, { phase: "prepared", accepted: admitted.accepted, policy }),
			step("reduce", "prep", 1, 1, { phase: "reducing" }),
			{
				kind: "compactionSummary",
				turnId: "summary",
				parentTurnId: "m2",
				timestamp: at,
				summary: "earlier work summarized",
				tokensBefore: 30_000,
				firstKeptTurnId: "m2",
				continuity,
			} as unknown as SessionEntryInput,
			{ kind: "continuityCommit", turnId: "commit-entry", parentTurnId: "m2", timestamp: at, continuity },
		] as SessionEntryInput[];
	};
	const { entries, records } = await journaledSession(
		() => ({ text: "answered" }),
		async (harness) => {
			const id = harness.session.current()?.id;
			ok(id);
			harness.session.append({ id: "m1", parentId: null, at, kind: "user", payload: { text: "first" } });
			harness.session.append({ id: "m2", parentId: "m1", at, kind: "assistant", payload: { text: "second" } });
			for (const entry of handoff(id)) harness.session.appendEntry(entry);
			// A restore renders the ledger, the note's text with it, and installs that history.
			harness.reopen(id);
			await harness.submit("carry on");
		},
	);
	const [sent] = settledCalls(records);
	const renderedAt = sent?.cache.receipt?.continuityAtMs;
	ok(renderedAt !== undefined && renderedAt >= preparedAtMs && renderedAt < deadline, "the receipt names its clock");
	const realNow = Date.now;
	Date.now = () => deadline + 1;
	try {
		const late = (input: Partial<Parameters<typeof verifyAttemptReceipts>[0]>) =>
			verifyAttemptReceipts({ entries, records, ...input }).attempts.map((verdict) => verdict.status);
		deepStrictEqual(late({}), ["verified"], "past the deadline, the attempt verifies at the clock it rendered at");
		// The row is late: at the verify's own clock the fold has failed the window the attempt rendered as open.
		const sessionId = sent?.cache.receipt?.owner?.sessionId;
		ok(sessionId);
		const action = (nowMs: number) => resolveContinuityProjection({ entries, sessionId, nowMs }).current?.action;
		deepStrictEqual(action(Date.now()), { kind: "fail", reason: "deadline_exceeded" });
		deepStrictEqual(action(renderedAt), { kind: "none" });
	} finally {
		Date.now = realNow;
	}
});
