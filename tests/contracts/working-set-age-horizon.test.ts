import assert from "node:assert/strict";
import { test } from "node:test";
import type { PolicyInput, WorkingSetSettings } from "../../src/domains/context/working-set/contract.js";
import { EMPTY_WORKING_SET_VIEW } from "../../src/domains/context/working-set/contract.js";
import { DEFAULT_WORKING_SET_SETTINGS } from "../../src/domains/context/working-set/defaults.js";
import { buildEvictionFields, planEviction } from "../../src/domains/context/working-set/engine.js";
import { foldWorkingSet } from "../../src/domains/context/working-set/fold.js";
import { resolveWorkingSetPolicy } from "../../src/domains/context/working-set/policies/index.js";
import { maskStaleObservations } from "../../src/domains/session/compaction/mask-observations.js";
import { estimateTokens } from "../../src/domains/session/compaction/tokens.js";
import type { MessageEntry, SessionEntry } from "../../src/domains/session/entries.js";

const PROTECT_LAST_TURNS = 3;
const TURNS = 12;

function base(
	turnId: string,
	parentTurnId: string | null,
): { turnId: string; parentTurnId: string | null; timestamp: string } {
	return { turnId, parentTurnId, timestamp: "2026-08-08T00:00:00.000Z" };
}

function body(turn: number): string {
	if (turn === 3) return "ok";
	return `${`turn ${turn} observation line\n`.repeat(40)}tail ${turn}`;
}

/**
 * Twelve turns of user / assistant / tool_call / tool_result. Even turns carry
 * thinking, turn 3 returns a result too small to be worth a marker, and turn 5
 * was already rewritten by the legacy destructive mask.
 */
function ledger(): SessionEntry[] {
	const entries: SessionEntry[] = [];
	let parent: string | null = null;
	for (let turn = 1; turn <= TURNS; turn += 1) {
		const user: MessageEntry = {
			kind: "message",
			...base(`u${turn}`, parent),
			role: "user",
			payload: { text: `question ${turn}` },
		};
		entries.push(user);
		const content: unknown[] = [{ type: "text", text: `answer ${turn}` }];
		if (turn % 2 === 0) content.unshift({ type: "thinking", thinking: `reasoning about turn ${turn}` });
		const assistant: MessageEntry = {
			kind: "message",
			...base(`a${turn}`, `u${turn}`),
			role: "assistant",
			payload: {
				content,
				stopReason: "stop",
				usage: { input: 1000 * turn, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 1000 * turn },
			},
		};
		entries.push(assistant);
		entries.push({
			kind: "message",
			...base(`c${turn}`, `a${turn}`),
			role: "tool_call",
			payload: { toolCallId: `call-${turn}`, name: "read", args: { path: `src/f${turn}.ts` } },
		});
		const text = body(turn);
		entries.push({
			kind: "message",
			...base(`t${turn}`, `c${turn}`),
			role: "tool_result",
			payload: {
				toolCallId: `call-${turn}`,
				toolName: "read",
				result: { content: [{ type: "text", text }], details: { paths: [`src/f${turn}.ts`] } },
				isError: false,
				resultSummary:
					turn === 5
						? { bytes: 0, truncated: true, contextCompaction: { stage: "mask_observations" } }
						: { bytes: text.length, truncated: false },
			},
		});
		parent = `t${turn}`;
	}
	return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function resultText(entry: SessionEntry): string {
	if (entry.kind !== "message") return "";
	const payload = isRecord(entry.payload) ? entry.payload : {};
	const result = isRecord(payload.result) ? payload.result : {};
	const content = Array.isArray(result.content) ? result.content : [];
	return content.map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : "")).join("");
}

function hasThinking(entry: SessionEntry): boolean {
	if (entry.kind !== "message") return false;
	const payload = isRecord(entry.payload) ? entry.payload : {};
	const content = Array.isArray(payload.content) ? payload.content : [];
	return content.some((block) => isRecord(block) && block.type === "thinking");
}

/**
 * Refs the destructive stage actually rewrote: a tool result whose body text
 * changed, or an assistant that lost its thinking. Compared this way rather
 * than by object identity because `maskStaleObservations` also stamps
 * `contextUsageInvalidated` on assistant turns it did not otherwise touch.
 */
function maskedRefs(entries: ReadonlyArray<SessionEntry>, protectLastTurns: number): Set<string> {
	const masked = maskStaleObservations(entries, protectLastTurns).entries;
	const refs = new Set<string>();
	for (let i = 0; i < entries.length; i += 1) {
		const before = entries[i];
		const after = masked[i];
		if (before === undefined || after === undefined || before.kind !== "message") continue;
		if (before.role === "tool_result" && resultText(before) !== resultText(after)) refs.add(before.turnId);
		if (before.role === "assistant" && hasThinking(before) && !hasThinking(after)) refs.add(before.turnId);
	}
	return refs;
}

function policyInput(entries: ReadonlyArray<SessionEntry>, overrides: Partial<WorkingSetSettings> = {}): PolicyInput {
	return {
		entries,
		view: EMPTY_WORKING_SET_VIEW,
		settings: { ...DEFAULT_WORKING_SET_SETTINGS, protectLastTurns: PROTECT_LAST_TURNS, ...overrides },
		pressure: { tokens: 90_000, contextWindow: 100_000, threshold: 0.8, target: 0.6 },
		estimateTokens,
	};
}

const agePolicy = resolveWorkingSetPolicy("age-horizon");

test("age-horizon: selection is token-identical to the destructive mask", () => {
	const entries = ledger();
	const selected = agePolicy.select(policyInput(entries, { minEvictableTokens: 0 })).map((c) => c.ref.entry);
	assert.deepEqual(new Set(selected), maskedRefs(entries, PROTECT_LAST_TURNS));
	assert.equal(new Set(selected).size, selected.length, "no ref selected twice");
});

test("age-horizon: reasons split tool results from closed thinking turns", () => {
	const entries = ledger();
	const byRef = new Map(agePolicy.select(policyInput(entries, { minEvictableTokens: 0 })).map((c) => [c.ref.entry, c]));
	assert.equal(byRef.get("t1")?.reason, "age_horizon");
	assert.equal(byRef.get("a2")?.reason, "thinking_turn_closed");
	// Odd turns carry no thinking, so there is nothing to evict on them.
	assert.equal(byRef.has("a1"), false);
	// A body the legacy stage already replaced is never re-marked.
	assert.equal(byRef.has("t5"), false);
	// Nothing inside the protected horizon: turns 10-12 are the recent window.
	for (const turn of [10, 11, 12]) {
		assert.equal(byRef.has(`t${turn}`), false);
		assert.equal(byRef.has(`a${turn}`), false);
	}
});

test("age-horizon: candidates arrive newest-safe-first", () => {
	const entries = ledger();
	const selected = agePolicy.select(policyInput(entries, { minEvictableTokens: 0 })).map((c) => c.ref.entry);
	// Turn 9 carries no thinking, so its assistant turn is not a candidate.
	assert.deepEqual(selected.slice(0, 4), ["t9", "t8", "a8", "t7"]);
	assert.equal(selected[selected.length - 1], "t1");
});

test("age-horizon: the default floor keeps a result too small to be worth a marker", () => {
	const entries = ledger();
	const selected = new Set(agePolicy.select(policyInput(entries)).map((c) => c.ref.entry));
	assert.equal(selected.has("t3"), false, "a two-byte result costs more as a marker than as a body");
	assert.equal(selected.has("t1"), true);
	// Thinking has no floor: it is dropped without a marker, so it is free.
	assert.equal(selected.has("a2"), true);
	assert.equal(selected.size + 1, maskedRefs(entries, PROTECT_LAST_TURNS).size);
});

test("age-horizon: units already out of the working set are never re-selected", () => {
	const entries = ledger();
	entries.push({
		kind: "contextEviction",
		...base("e1", "t12"),
		policyId: "age-horizon",
		trigger: "pressure",
		evicted: [{ ref: { entry: "t1" }, reason: "age_horizon", tokensFreed: 100, marker: "[evicted ref=t1]" }],
		tokensBefore: 1000,
		tokensAfter: 900,
		pressureBefore: 0.85,
		snapshotIdBefore: null,
	});
	const input = { ...policyInput(entries, { minEvictableTokens: 0 }), view: foldWorkingSet(entries) };
	assert.equal(
		agePolicy.select(input).some((c) => c.ref.entry === "t1"),
		false,
	);
});

test("age-horizon: an all-protected ledger selects nothing and plans nothing", () => {
	const entries = ledger();
	const input = policyInput(entries, { protectLastTurns: 100 });
	assert.deepEqual(agePolicy.select(input), []);
	assert.equal(planEviction(agePolicy, input), null);
});

test("policies: every settings id resolves to the policy that owns it", () => {
	assert.equal(resolveWorkingSetPolicy("age-horizon").id, "age-horizon");
	assert.equal(resolveWorkingSetPolicy("structural-v1").id, "structural-v1");
});

test("planEviction: materializes markers, prices them, and shrinks the working set", () => {
	const entries = ledger();
	const plan = planEviction(agePolicy, policyInput(entries));
	assert.ok(plan);
	assert.equal(plan.policyId, "age-horizon");
	assert.ok(plan.tokensAfter < plan.tokensBefore);

	const toolItem = plan.items.find((item) => item.ref.entry === "t1");
	assert.ok(toolItem);
	assert.equal(toolItem.reason, "age_horizon");
	assert.match(toolItem.marker, /^\[evicted ref=t1 reason=age_horizon tool=read path=src\/f1\.ts size=41 lines\//);
	assert.ok(toolItem.tokensFreed > 0);

	const thinkingItem = plan.items.find((item) => item.ref.entry === "a2");
	assert.ok(thinkingItem);
	assert.equal(thinkingItem.reason, "thinking_turn_closed");
	assert.equal(thinkingItem.marker, "", "thinking leaves without a marker");
	assert.ok(thinkingItem.tokensFreed > 0);

	// The freed totals agree with the projection the model will receive.
	const freed = plan.items.reduce((sum, item) => sum + item.tokensFreed, 0);
	assert.equal(plan.tokensBefore - plan.tokensAfter, freed);
});

test("buildEvictionFields: carries the plan plus the trigger facts", () => {
	const entries = ledger();
	const plan = planEviction(agePolicy, policyInput(entries));
	assert.ok(plan);
	const fields = buildEvictionFields(plan, { trigger: "pressure", pressureBefore: 0.87, snapshotIdBefore: "snap-1" });
	assert.equal(fields.kind, "contextEviction");
	assert.equal(fields.policyId, "age-horizon");
	assert.equal(fields.trigger, "pressure");
	assert.equal(fields.evicted, plan.items);
	assert.equal(fields.tokensBefore, plan.tokensBefore);
	assert.equal(fields.tokensAfter, plan.tokensAfter);
	assert.equal(fields.pressureBefore, 0.87);
	assert.equal(fields.snapshotIdBefore, "snap-1");
});
