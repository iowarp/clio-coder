import assert from "node:assert/strict";
import { test } from "node:test";
import type { PolicyInput } from "../../src/domains/context/working-set/contract.js";
import { DEFAULT_WORKING_SET_SETTINGS } from "../../src/domains/context/working-set/defaults.js";
import { planEviction } from "../../src/domains/context/working-set/engine.js";
import { foldWorkingSet } from "../../src/domains/context/working-set/fold.js";
import { ageHorizonPolicy, structuralPolicy } from "../../src/domains/context/working-set/policies/index.js";
import { selectVisibleEntries } from "../../src/domains/context/working-set/visible.js";
import { estimateAgentMessageTokens } from "../../src/domains/session/context-accounting.js";
import { estimateTokens } from "../../src/domains/session/compaction/tokens.js";
import type { ContextEvictionEntry, SessionEntry } from "../../src/domains/session/entries.js";
import { buildModelReplayAgentMessagesFromTurns } from "../../src/interactive/model-session-replay.js";

const TS = "2026-08-21T00:00:00.000Z";

function body(label: string, lines = 100): string {
	return Array.from({ length: lines }, (_, i) => `${label} observation line ${i}`).join("\n");
}

/** Linear ledger builder: every message parents onto the previous one. */
class Ledger {
	readonly entries: SessionEntry[] = [];
	private seq = 0;
	private last: string | null = null;

	private id(prefix: string): string {
		this.seq += 1;
		return `${prefix}${this.seq}`;
	}

	private push(entry: SessionEntry): string {
		this.entries.push(entry);
		if (entry.kind === "message") this.last = entry.turnId;
		return entry.turnId;
	}

	user(text = "go"): string {
		return this.push({
			kind: "message",
			turnId: this.id("u"),
			parentTurnId: this.last,
			timestamp: TS,
			role: "user",
			payload: { text },
		});
	}

	read(path: string): string {
		const callId = this.id("call-");
		this.push({
			kind: "message",
			turnId: this.id("c"),
			parentTurnId: this.last,
			timestamp: TS,
			role: "tool_call",
			payload: { toolCallId: callId, name: "read", args: { path } },
		});
		return this.push({
			kind: "message",
			turnId: this.id("r"),
			parentTurnId: this.last,
			timestamp: TS,
			role: "tool_result",
			payload: { toolCallId: callId, toolName: "read", result: { content: [{ type: "text", text: body(path) }] }, isError: false },
		});
	}

	compaction(firstKeptTurnId: string): string {
		return this.push({
			kind: "compactionSummary",
			turnId: this.id("cs"),
			parentTurnId: this.last,
			timestamp: TS,
			summary: "summary of everything before the kept turn",
			firstKeptTurnId,
			trigger: "auto",
			tokensBefore: 50_000,
		});
	}

	leaf(): string | undefined {
		return this.last ?? undefined;
	}
}

function input(ledger: Ledger, protectLastTurns: number): PolicyInput {
	return {
		entries: selectVisibleEntries(ledger.entries, ledger.leaf()),
		view: foldWorkingSet(ledger.entries, ledger.leaf()),
		settings: { ...DEFAULT_WORKING_SET_SETTINGS, protectLastTurns },
		pressure: { tokens: 90_000, contextWindow: 100_000, threshold: 0.8, target: 0.6 },
		estimateTokens,
	};
}

function replayTokens(entries: ReadonlyArray<SessionEntry>): number {
	return buildModelReplayAgentMessagesFromTurns(entries).reduce((sum, message) => sum + estimateAgentMessageTokens(message), 0);
}

function withEvent(ledger: Ledger, plan: NonNullable<ReturnType<typeof planEviction>>): SessionEntry[] {
	const event: ContextEvictionEntry = {
		kind: "contextEviction",
		turnId: "e1",
		parentTurnId: ledger.leaf() ?? null,
		timestamp: TS,
		policyId: plan.policyId,
		trigger: "pressure",
		evicted: plan.items,
		tokensBefore: plan.tokensBefore,
		tokensAfter: plan.tokensAfter,
		pressureBefore: 0.9,
		snapshotIdBefore: null,
	};
	return [...ledger.entries, event];
}

/** user, read(old1), user, read(old2), user K, compaction{firstKept: K}, read(new), user, user. */
function compactedLedger(): { ledger: Ledger; old: string[]; fresh: string } {
	const ledger = new Ledger();
	ledger.user("first");
	const old1 = ledger.read("src/old1.ts");
	ledger.user("second");
	const old2 = ledger.read("src/old2.ts");
	const kept = ledger.user("after summary");
	ledger.compaction(kept);
	const fresh = ledger.read("src/new.ts");
	ledger.user("pad1");
	ledger.user("pad2");
	return { ledger, old: [old1, old2], fresh };
}

test("visible: the compaction cut removes everything before firstKeptTurnId and the summary itself", () => {
	const { ledger, old, fresh } = compactedLedger();
	const visible = selectVisibleEntries(ledger.entries, ledger.leaf());
	const ids = new Set(visible.map((entry) => entry.turnId));
	for (const ref of old) assert.equal(ids.has(ref), false, `${ref} is behind the cut`);
	assert.equal(ids.has(fresh), true);
	assert.equal(
		visible.some((entry) => entry.kind === "compactionSummary"),
		false,
	);
	assert.equal(visible[0]?.payload && (visible[0].payload as { text?: string }).text, "after summary");
});

test("visible: a ledger without a compaction is the active path unchanged", () => {
	const ledger = new Ledger();
	ledger.user();
	ledger.read("src/a.ts");
	ledger.user();
	assert.deepEqual(selectVisibleEntries(ledger.entries, ledger.leaf()), ledger.entries);
});

test("visible: both policies plan nothing when the only evictable results are behind the cut", () => {
	const { ledger } = compactedLedger();
	// Horizon 3 protects the kept user turn and both pads, so `fresh` is inside
	// the window and only old1/old2 could have been selected.
	for (const policy of [ageHorizonPolicy, structuralPolicy]) {
		assert.equal(planEviction(policy, input(ledger, 3)), null, policy.id);
	}
});

test("visible: with one post-cut result past the horizon, it is the only item and the plan prices exactly what the replay loses", () => {
	const { ledger, fresh } = compactedLedger();
	for (const policy of [ageHorizonPolicy, structuralPolicy]) {
		const plan = planEviction(policy, input(ledger, 2));
		assert.ok(plan, policy.id);
		assert.deepEqual(
			plan.items.map((item) => item.ref.entry),
			[fresh],
			policy.id,
		);
		const before = replayTokens(ledger.entries);
		const after = replayTokens(withEvent(ledger, plan));
		assert.ok(before > after, policy.id);
		// The plan prices ledger entries (payload JSON, including the
		// `details.workingSet` stamp the projection adds); the replay estimator
		// prices the message content the model receives. The two differ only by
		// that stamp, a handful of tokens, never by a body behind the cut.
		const claimed = plan.tokensBefore - plan.tokensAfter;
		assert.ok(Math.abs(claimed - (before - after)) <= 8, `${policy.id}: claimed ${claimed}, replay lost ${before - after}`);
	}
});
