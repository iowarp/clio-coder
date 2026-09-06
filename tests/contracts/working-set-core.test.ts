import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { foldWorkingSet } from "../../src/domains/context/working-set/fold.js";
import { projectWorkingSet } from "../../src/domains/context/working-set/project.js";
import {
	buildRecallFields,
	recallableRefListing,
	recallErrorMessage,
	resolveRecall,
} from "../../src/domains/context/working-set/recall.js";
import { selectVisibleEntries } from "../../src/domains/context/working-set/visible.js";
import type { MessageEntry, SessionEntry } from "../../src/domains/session/entries.js";
import { createContextTool } from "../../src/tools/context/index.js";

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
	it("recalls summarized persisted bodies without eviction while respecting the selected branch", () => {
		const entries: SessionEntry[] = [
			...trunk(),
			{
				kind: "compactionSummary",
				turnId: "summary",
				parentTurnId: "u2",
				timestamp: TS,
				summary: "A prose checkpoint, not the original result.",
				tokensBefore: 100,
				firstKeptTurnId: "u2",
			},
			message("other", "u1", "assistant"),
		];
		const original = structuredClone(entries);
		const view = foldWorkingSet(entries, "u2");
		strictEqual(
			selectVisibleEntries(entries, "u2").some((entry) => entry.turnId === "r1"),
			false,
		);
		const recalled = resolveRecall(entries, view, "r1", "u2");
		ok(recalled.ok);
		strictEqual(recalled.result.body, BODY);
		strictEqual(recalled.result.state, "summarized");
		strictEqual(view.evicted.size, 0);
		deepStrictEqual(resolveRecall(trunk(), foldWorkingSet(trunk()), "r1"), {
			ok: false,
			error: { kind: "visible", ref: "r1" },
		});
		const otherView = foldWorkingSet(entries, "other");
		const refused = resolveRecall(entries, otherView, "r1", "other");
		ok(!refused.ok);
		strictEqual(refused.error.kind, "not_on_active_path");
		strictEqual(recallableRefListing(entries, otherView, { activeLeafTurnId: "other" }).total, 0);
		doesNotMatch(recallErrorMessage(refused.error, entries, otherView, "other"), /src\/a.ts/);
		const thinking = resolveRecall(entries, otherView, "other", "other");
		ok(!thinking.ok);
		match(recallErrorMessage(thinking.error, entries, otherView, "other"), /thinking is not recallable/);
		const legacy = result("legacy", "u2");
		legacy.payload = { result: "old marker", contextCompaction: {} };
		const withLegacy = [...entries, legacy];
		deepStrictEqual(resolveRecall(withLegacy, foldWorkingSet(withLegacy, "legacy"), "legacy", "legacy"), {
			ok: false,
			error: { kind: "unavailable", ref: "legacy" },
		});
		deepStrictEqual(entries, original);
	});

	it("discovers beyond eight refs by bounded query pages through the production recall tool", async () => {
		const entries: SessionEntry[] = [message("u1", null, "user")];
		for (let i = 1; i <= 14; i += 1) {
			const entry = result(`r${i}`, i === 1 ? "u1" : `r${i - 1}`);
			entry.payload = { toolName: "read", result: { text: BODY, details: { paths: [`src/file${i}.ts`] } } };
			entries.push(entry);
		}
		entries.push({
			kind: "compactionSummary",
			turnId: "s",
			parentTurnId: "r14",
			timestamp: TS,
			summary: "checkpoint",
			tokensBefore: 1000,
			firstKeptTurnId: "",
		});
		const recorded: SessionEntry[] = [];
		const tool = createContextTool({
			session: {
				hasSession: () => true,
				readEntries: () => entries,
				activeLeafTurnId: () => "r14",
				appendEntry: (fields) => {
					const entry = {
						...fields,
						turnId: "recalled",
						parentTurnId: fields.parentTurnId ?? null,
						timestamp: TS,
					} as SessionEntry;
					recorded.push(entry);
					return entry;
				},
			},
		});
		const first = await tool.run({ scope: "recall" });
		ok(first.kind === "ok");
		match(first.output, /offset=8/);
		doesNotMatch(first.output, /r9 \(|line one/);
		const second = await tool.run({ scope: "recall", offset: 8 });
		ok(second.kind === "ok");
		match(second.output, /r9 \(read src\/file9.ts\)/);
		match(second.output, /r14 \(/);
		match(second.output, /End of matching/);
		const query = await tool.run({ scope: "recall", query: "READ file9.ts", limit: 1 });
		ok(query.kind === "ok");
		match(query.output, /r9 \(/);
		doesNotMatch(query.output, /r1 \(/);
		strictEqual(recorded.length, 0, "discovery must not create churn records");
		strictEqual(recallableRefListing(entries, foldWorkingSet(entries), { limit: 100 }).refs.length, 12);
		const recalled = await tool.run({ scope: "recall", ref: "r9" });
		ok(recalled.kind === "ok");
		ok(recalled.output.includes(BODY));
		strictEqual(recorded[0]?.kind, "contextRecall");
		strictEqual(recorded[0]?.parentTurnId, "r14");
		strictEqual((recalled.details?.recall as { state: string }).state, "summarized");
	});
});
