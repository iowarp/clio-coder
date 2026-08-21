import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_WORKING_SET_VIEW } from "../../src/domains/context/working-set/contract.js";
import { foldWorkingSet } from "../../src/domains/context/working-set/fold.js";
import { renderMarker } from "../../src/domains/context/working-set/marker.js";
import { projectWorkingSet } from "../../src/domains/context/working-set/project.js";
import type { MessageEntry, SessionEntry } from "../../src/domains/session/entries.js";

const BODY = `${"observation line\n".repeat(60)}final secret body`;

const TOOL_MARKER = renderMarker({
	ref: { entry: "t1" },
	reason: "age_horizon",
	toolName: "read",
	text: BODY,
});

function base(
	turnId: string,
	parentTurnId: string | null,
): { turnId: string; parentTurnId: string | null; timestamp: string } {
	return { turnId, parentTurnId, timestamp: `2026-08-08T00:00:${turnId.slice(-2).padStart(2, "0")}.000Z` };
}

function user(turnId: string, parentTurnId: string | null): MessageEntry {
	return { kind: "message", ...base(turnId, parentTurnId), role: "user", payload: { text: `ask ${turnId}` } };
}

function assistant(turnId: string, parentTurnId: string, content: unknown[], usageTokens: number): MessageEntry {
	return {
		kind: "message",
		...base(turnId, parentTurnId),
		role: "assistant",
		payload: {
			content,
			thinking: "payload-level reasoning",
			stopReason: "stop",
			usage: { input: usageTokens, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: usageTokens },
		},
	};
}

function toolCall(turnId: string, parentTurnId: string): MessageEntry {
	return {
		kind: "message",
		...base(turnId, parentTurnId),
		role: "tool_call",
		payload: { toolCallId: "call-1", name: "read", args: { path: "src/huge.ts" } },
	};
}

function toolResult(turnId: string, parentTurnId: string): MessageEntry {
	return {
		kind: "message",
		...base(turnId, parentTurnId),
		role: "tool_result",
		payload: {
			toolCallId: "call-1",
			toolName: "read",
			result: { content: [{ type: "text", text: BODY }], details: { paths: ["src/huge.ts"], kind: "file" } },
			isError: false,
			resultSummary: { bytes: BODY.length, truncated: false },
		},
	};
}

function eviction(turnId: string, parentTurnId: string): SessionEntry {
	return {
		kind: "contextEviction",
		...base(turnId, parentTurnId),
		policyId: "age-horizon",
		trigger: "pressure",
		evicted: [
			{ ref: { entry: "t1" }, reason: "age_horizon", tokensFreed: 260, marker: TOOL_MARKER },
			{ ref: { entry: "a1" }, reason: "thinking_turn_closed", tokensFreed: 40, marker: "" },
		],
		tokensBefore: 1000,
		tokensAfter: 700,
		pressureBefore: 0.86,
		snapshotIdBefore: null,
	};
}

/** u1 a1 c1 t1 u2 e1 a2: the event sits between the two assistant turns. */
function ledger(): SessionEntry[] {
	return [
		user("u1", null),
		assistant(
			"a1",
			"u1",
			[
				{ type: "thinking", thinking: "long reasoning" },
				{ type: "text", text: "reading it" },
			],
			90_000,
		),
		toolCall("c1", "a1"),
		toolResult("t1", "c1"),
		user("u2", "t1"),
		eviction("e1", "u2"),
		assistant("a2", "u2", [{ type: "text", text: "done" }], 12_000),
	];
}

function payloadOf(entry: SessionEntry | undefined): Record<string, unknown> {
	assert.ok(entry && entry.kind === "message");
	return entry.payload as Record<string, unknown>;
}

test("project: an evicted tool result keeps its pairing and carries the marker", () => {
	const entries = ledger();
	const projected = projectWorkingSet(entries, foldWorkingSet(entries));
	const payload = payloadOf(projected[3]) as {
		toolCallId?: string;
		toolName?: string;
		result?: {
			content?: Array<{ text?: string }>;
			details?: { paths?: unknown; kind?: unknown; workingSet?: unknown };
		};
	};
	assert.equal(payload.toolCallId, "call-1");
	assert.equal(payload.toolName, "read");
	assert.equal(payload.result?.content?.[0]?.text, TOOL_MARKER);
	assert.deepEqual(payload.result?.details?.paths, ["src/huge.ts"]);
	assert.equal(payload.result?.details?.kind, "file");
	assert.deepEqual(payload.result?.details?.workingSet, { evicted: true, reason: "age_horizon", ref: "t1" });
	assert.equal(JSON.stringify(payload).includes("final secret body"), false);
	// The ledger entry itself is untouched: eviction is a projection.
	assert.equal(JSON.stringify(entries[3]).includes("final secret body"), true);
});

test("project: an evicted assistant loses both thinking shapes", () => {
	const entries = ledger();
	const projected = projectWorkingSet(entries, foldWorkingSet(entries));
	const payload = payloadOf(projected[1]) as { content?: unknown[]; thinking?: unknown };
	assert.deepEqual(payload.content, [{ type: "text", text: "reading it" }]);
	assert.equal(payload.thinking, undefined);
	assert.equal(payloadOf(entries[1]).thinking, "payload-level reasoning");
});

test("project: is idempotent", () => {
	const entries = ledger();
	const view = foldWorkingSet(entries);
	const once = projectWorkingSet(entries, view);
	const twice = projectWorkingSet(once, view);
	assert.deepEqual(twice, once);
	assert.equal(JSON.stringify(twice), JSON.stringify(once));
});

test("project: entries the view does not name are returned by reference", () => {
	const entries = ledger();
	const projected = projectWorkingSet(entries, foldWorkingSet(entries));
	assert.equal(projected[0], entries[0]);
	assert.equal(projected[2], entries[2]);
	assert.equal(projected[4], entries[4]);
	assert.equal(projected[5], entries[5]);
	assert.equal(projected[6], entries[6]);
});

test("project: an empty view is a no-op", () => {
	const entries = ledger();
	const projected = projectWorkingSet(entries, EMPTY_WORKING_SET_VIEW);
	assert.equal(projected.length, entries.length);
	for (let i = 0; i < entries.length; i += 1) assert.equal(projected[i], entries[i]);
});

test("project: usage recorded before the event stops anchoring the estimate", () => {
	const entries = ledger();
	const projected = projectWorkingSet(entries, foldWorkingSet(entries));
	assert.equal(payloadOf(projected[1]).contextUsageInvalidated, true);
	// The assistant turn after the event measured the projected prompt, so its
	// usage is still the honest anchor.
	assert.equal(payloadOf(projected[6]).contextUsageInvalidated, undefined);
	assert.equal(payloadOf(entries[1]).contextUsageInvalidated, undefined);
});

test("project: a recall puts the body back without touching the marker path", () => {
	const entries = ledger();
	entries.push({
		kind: "contextRecall",
		...base("r1", "u2"),
		ref: { entry: "t1" },
		trigger: "tool",
		tokensReadmitted: 260,
	});
	const projected = projectWorkingSet(entries, foldWorkingSet(entries));
	assert.equal(projected[3], entries[3]);
	assert.equal(JSON.stringify(projected[3]).includes("final secret body"), true);
	// The thinking eviction is unaffected by a recall of a different ref.
	assert.equal(payloadOf(projected[1]).thinking, undefined);
});
