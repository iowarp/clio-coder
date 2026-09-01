import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { foldWorkingSet } from "../../src/domains/context/working-set/fold.js";
import { projectWorkingSet } from "../../src/domains/context/working-set/project.js";
import { buildRecallFields, resolveRecall } from "../../src/domains/context/working-set/recall.js";
import type { MessageEntry, SessionEntry } from "../../src/domains/session/entries.js";

const BODY = "line one  \n\tline two\r\nüñîçødé\nend without newline";
const TS = "2026-08-21T00:00:00.000Z";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function message(turnId: string, parentTurnId: string | null, role: "user" | "assistant"): MessageEntry {
	return { kind: "message", turnId, parentTurnId, timestamp: TS, role, payload: { text: turnId } };
}

function result(turnId: string, parentTurnId: string): MessageEntry {
	return {
		kind: "message",
		turnId,
		parentTurnId,
		timestamp: TS,
		role: "tool_result",
		payload: {
			toolCallId: "call-1",
			toolName: "read",
			result: { content: [{ type: "text", text: BODY }], details: { paths: ["src/a.ts"] } },
			isError: false,
		},
	};
}

function eviction(turnId: string, parentTurnId: string): SessionEntry {
	return {
		kind: "contextEviction",
		turnId,
		parentTurnId,
		timestamp: TS,
		policyId: "age-horizon",
		trigger: "pressure",
		evicted: [
			{
				ref: { entry: "r1" },
				reason: "age_horizon",
				tokensFreed: 40,
				marker: "[evicted ref=r1 reason=age_horizon tool=read path=src/a.ts]",
			},
		],
		tokensBefore: 100,
		tokensAfter: 60,
		pressureBefore: 0.9,
		snapshotIdBefore: null,
	};
}

function trunk(): SessionEntry[] {
	return [message("u1", null, "user"), result("r1", "u1"), message("u2", "r1", "user")];
}

function resultBody(entry: SessionEntry | undefined): string | undefined {
	if (entry?.kind !== "message" || entry.role !== "tool_result") return undefined;
	const payload = entry.payload as { result?: { content?: Array<{ text?: string }> } };
	return payload.result?.content?.[0]?.text;
}

describe("working-set ledger boundary", () => {
	it("keeps bodies in the ledger and projects markers only for the model", () => {
		const entries = [...trunk(), eviction("e1", "u2")];
		const projected = projectWorkingSet(entries, foldWorkingSet(entries, "e1"));
		strictEqual(resultBody(entries[1]), BODY);
		strictEqual(resultBody(projected[1])?.includes(BODY), false);
		ok(JSON.stringify(projected[1]).includes("[evicted ref=r1"));
		const projectedResult = projected[1];
		if (projectedResult?.kind !== "message" || !isRecord(projectedResult.payload)) {
			throw new TypeError("projected tool result must be a message with an object payload");
		}
		strictEqual(projectedResult.payload.toolCallId, "call-1");
		deepStrictEqual(projectedResult.payload.result, {
			content: [{ type: "text", text: "[evicted ref=r1 reason=age_horizon tool=read path=src/a.ts]" }],
			details: { paths: ["src/a.ts"], workingSet: { evicted: true, reason: "age_horizon", ref: "r1" } },
		});
		deepStrictEqual(projectWorkingSet(projected, foldWorkingSet(entries, "e1")), projected);
	});

	it("recalls the original bytes at the tail without readmitting the prefix", () => {
		const entries = [...trunk(), eviction("e1", "u2")];
		const recalled = resolveRecall(entries, foldWorkingSet(entries, "e1"), "r1");
		ok(recalled.ok);
		strictEqual(recalled.result.body, BODY);
		const fields = buildRecallFields(recalled.result, { trigger: "tool", toolCallId: "recall-call" });
		const next: SessionEntry[] = [...entries, { ...fields, turnId: "recall-1", parentTurnId: "e1", timestamp: TS }];
		const view = foldWorkingSet(next, "recall-1");
		strictEqual(view.evicted.has("r1"), true);
		strictEqual(view.recalls, 1);
		strictEqual(resolveRecall(next, view, "r1").ok, true);
	});

	it("applies eviction state only along the selected branch", () => {
		const entries: SessionEntry[] = [
			...trunk(),
			message("branch-a", "u2", "user"),
			eviction("evict-a", "branch-a"),
			message("branch-b", "u2", "user"),
		];
		strictEqual(foldWorkingSet(entries, "evict-a").evicted.has("r1"), true);
		strictEqual(foldWorkingSet(entries, "branch-b").evicted.size, 0);
		strictEqual(resultBody(projectWorkingSet(entries, foldWorkingSet(entries, "branch-b"))[1]), BODY);
	});
});
