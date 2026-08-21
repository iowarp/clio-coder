import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntryInput } from "../../src/domains/session/contract.js";
import type { MessageEntry, SessionEntry } from "../../src/domains/session/entries.js";
import { type ContextSessionDeps, createContextTool } from "../../src/tools/context/index.js";

let clock = 0;
function stamp(): string {
	clock += 1;
	return new Date(1_700_000_000_000 + clock * 1000).toISOString();
}

function user(turnId: string, parentTurnId: string | null): SessionEntry {
	return { kind: "message", turnId, parentTurnId, timestamp: stamp(), role: "user", payload: { text: turnId } };
}

function toolResult(turnId: string, parentTurnId: string, text: string): MessageEntry {
	return {
		kind: "message",
		turnId,
		parentTurnId,
		timestamp: stamp(),
		role: "tool_result",
		payload: {
			toolCallId: `call-${turnId}`,
			toolName: "read",
			result: { content: [{ type: "text", text }], details: { resultSize: { bytes: text.length, truncated: false } } },
			isError: false,
			resultSummary: { bytes: text.length, truncated: false },
		},
	};
}

function eviction(turnId: string, parentTurnId: string, refs: string[]): SessionEntry {
	return {
		kind: "contextEviction",
		turnId,
		parentTurnId,
		timestamp: stamp(),
		policyId: "age-horizon",
		trigger: "pressure",
		evicted: refs.map((entry) => ({
			ref: { entry },
			reason: "age_horizon",
			tokensFreed: 50,
			marker: `[evicted ref=${entry}]`,
		})),
		tokensBefore: 1000,
		tokensAfter: 900,
		pressureBefore: 0.85,
		snapshotIdBefore: null,
	};
}

const BODY = "alpha\n\tbeta  \nγάμμα\n";

function fakeSession(entries: SessionEntry[]): {
	deps: ContextSessionDeps;
	entries: SessionEntry[];
	recalled: Array<{ ref: string; trigger: string; tokensReadmitted: number }>;
} {
	const recalled: Array<{ ref: string; trigger: string; tokensReadmitted: number }> = [];
	const deps: ContextSessionDeps = {
		hasSession: () => true,
		readEntries: () => entries,
		activeLeafTurnId: () => undefined,
		appendEntry(input: SessionEntryInput): SessionEntry {
			const entry = { ...input, turnId: input.turnId ?? `gen-${entries.length}`, timestamp: stamp() } as SessionEntry;
			entries.push(entry);
			return entry;
		},
		onRecalled: (payload) => {
			recalled.push({ ref: payload.ref, trigger: payload.trigger, tokensReadmitted: payload.tokensReadmitted });
		},
	};
	return { deps, entries, recalled };
}

function baseEntries(): SessionEntry[] {
	return [
		user("u1", null),
		toolResult("t1", "u1", BODY),
		toolResult("t2", "t1", "other"),
		user("u2", "t2"),
		eviction("e1", "u2", ["t1"]),
	];
}

describe("contracts/context recall scope", () => {
	it("returns the body byte-exact and appends a contextRecall entry with the tool call id", async () => {
		const { deps, entries, recalled } = fakeSession(baseEntries());
		const tool = createContextTool({ session: deps });
		const result = await tool.run(
			{ scope: "recall", ref: "t1" },
			{ toolCallId: "call-recall", turnId: "turn-9", sessionId: "s1" },
		);
		assert.equal(result.kind, "ok");
		if (result.kind !== "ok") return;
		assert.equal(result.output, BODY);
		const details = result.details as { recall: Record<string, unknown>; observation: Record<string, unknown> };
		assert.equal(details.recall.ref, "t1");
		assert.equal(details.recall.tokensReadmitted, Math.ceil(BODY.length / 4));
		assert.equal(details.recall.reason, "age_horizon");
		assert.equal(details.recall.evictedAtTurnId, "e1");
		assert.equal(details.observation.truncated, false);

		const appended = entries[entries.length - 1];
		assert.ok(appended && appended.kind === "contextRecall");
		if (appended?.kind !== "contextRecall") return;
		assert.deepEqual(appended.ref, { entry: "t1" });
		assert.equal(appended.trigger, "tool");
		assert.equal(appended.toolCallId, "call-recall");
		assert.equal(appended.tokensReadmitted, Math.ceil(BODY.length / 4));
		// Parents onto the last message on the active path, so the fold sees it on this branch.
		assert.equal(appended.parentTurnId, "u2");
		assert.equal(details.recall.recallTurnId, appended.turnId);

		// The ref stays evicted after a recall; a second recall is churn, not an error.
		const again = await tool.run({ scope: "recall", ref: "t1" }, { toolCallId: "call-2" });
		assert.equal(again.kind, "ok");
		// Each successful recall is published once for the bus.
		assert.deepEqual(
			recalled.map((r) => r.ref),
			["t1", "t1"],
		);
		assert.equal(recalled[0]?.trigger, "tool");
		assert.equal(recalled[0]?.tokensReadmitted, Math.ceil(BODY.length / 4));
	});

	it("errors list the refs that can be recalled", async () => {
		const { deps } = fakeSession(baseEntries());
		const tool = createContextTool({ session: deps });
		const notEvicted = await tool.run({ scope: "recall", ref: "t2" }, undefined);
		assert.equal(notEvicted.kind, "error");
		if (notEvicted.kind === "error")
			assert.match(notEvicted.message, /not evicted.*Evicted refs on the active path: t1\.$/);
		const offPath = await tool.run({ scope: "recall", ref: "nope" }, undefined);
		assert.equal(offPath.kind, "error");
		if (offPath.kind === "error")
			assert.match(offPath.message, /not on the active path.*Evicted refs on the active path: t1\./);
		const missing = await tool.run({ scope: "recall" }, undefined);
		assert.equal(missing.kind, "error");
		if (missing.kind === "error") assert.match(missing.message, /requires ref=<turnId>/);
		const invalid = await tool.run({ scope: "recall", ref: "a b" }, undefined);
		assert.equal(invalid.kind, "error");
		if (invalid.kind === "error") assert.match(invalid.message, /single turnId/);
	});

	it("a registry without a session errors cleanly like workspace", async () => {
		const bare = createContextTool();
		const result = await bare.run({ scope: "recall", ref: "t1" }, undefined);
		assert.equal(result.kind, "error");
		if (result.kind === "error") assert.match(result.message, /requires a bound session/);
		const unbound = createContextTool({
			session: {
				hasSession: () => false,
				readEntries: () => [],
				activeLeafTurnId: () => undefined,
				appendEntry: () => {
					throw new Error("unreachable");
				},
			},
		});
		const unboundResult = await unbound.run({ scope: "recall", ref: "t1" }, undefined);
		assert.equal(unboundResult.kind, "error");
	});

	it("an oversize body goes through the envelope: truncated, offloaded, pointer in the notice, never inlined whole", async () => {
		const big = `${"x".repeat(70_000)}\nEND`;
		const { deps, entries } = fakeSession([
			user("u1", null),
			toolResult("t1", "u1", big),
			user("u2", "t1"),
			eviction("e1", "u2", ["t1"]),
		]);
		const tool = createContextTool({ session: deps });
		const result = await tool.run({ scope: "recall", ref: "t1" }, { toolCallId: "call-big", sessionId: "s-big" });
		assert.equal(result.kind, "ok");
		if (result.kind !== "ok") return;
		assert.ok(result.output.length < big.length);
		assert.ok(!result.output.includes("\nEND"));
		const observation = (result.details as { observation: Record<string, unknown> }).observation;
		assert.equal(observation.truncated, true);
		assert.equal(typeof observation.offloadPath, "string");
		assert.match(result.output, /full: .* \(overflow copy, read-only; not the workspace\)/);
		// The recall is still recorded with the full token count.
		const appended = entries[entries.length - 1];
		assert.ok(appended && appended.kind === "contextRecall");
		if (appended && appended.kind === "contextRecall") assert.equal(appended.tokensReadmitted, Math.ceil(big.length / 4));
	});

	it("an unknown scope lists recall among the accepted scopes", async () => {
		const tool = createContextTool();
		const result = await tool.run({ scope: "bogus" }, undefined);
		assert.equal(result.kind, "error");
		if (result.kind === "error") assert.match(result.message, /workspace, docs, skills, or recall/);
	});
});
