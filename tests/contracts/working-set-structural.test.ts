import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	EvictionCandidate,
	PolicyInput,
	WorkingSetSettings,
} from "../../src/domains/context/working-set/contract.js";
import { EMPTY_WORKING_SET_VIEW } from "../../src/domains/context/working-set/contract.js";
import { DEFAULT_WORKING_SET_SETTINGS } from "../../src/domains/context/working-set/defaults.js";
import { buildEvictionFields, planEviction } from "../../src/domains/context/working-set/engine.js";
import { protectionCutoffIndex } from "../../src/domains/context/working-set/horizon.js";
import { buildPathIndex } from "../../src/domains/context/working-set/path-index.js";
import { structuralPolicy } from "../../src/domains/context/working-set/policies/index.js";
import { isProtected } from "../../src/domains/context/working-set/protect.js";
import { estimateTokens } from "../../src/domains/session/compaction/tokens.js";
import { isSessionEntry, type SessionEntry } from "../../src/domains/session/entries.js";

const CWD = "/repo";
const TS = "2026-08-21T00:00:00.000Z";

/** Big enough to clear the default 200-token floor. */
function body(label: string, lines = 100): string {
	return Array.from({ length: lines }, (_, i) => `${label} observation line ${i}`).join("\n");
}

/**
 * A ledger under construction. Every call appends the tool_call/tool_result
 * pair the session would have written and hands back the result's turnId, which
 * is the ref a policy names.
 */
class Ledger {
	readonly entries: SessionEntry[] = [];
	private seq = 0;

	private id(prefix: string): string {
		this.seq += 1;
		return `${prefix}${this.seq}`;
	}

	user(text = "go"): this {
		this.entries.push({
			kind: "message",
			turnId: this.id("u"),
			parentTurnId: null,
			timestamp: TS,
			role: "user",
			payload: { text },
		});
		return this;
	}

	thinking(text = "reasoning"): string {
		const turnId = this.id("a");
		this.entries.push({
			kind: "message",
			turnId,
			parentTurnId: null,
			timestamp: TS,
			role: "assistant",
			payload: {
				content: [
					{ type: "thinking", thinking: text },
					{ type: "text", text: "answer" },
				],
			},
		});
		return turnId;
	}

	call(toolName: string, args: unknown, text: string, options: { isError?: boolean; blocked?: boolean } = {}): string {
		const callId = this.id("call-");
		this.entries.push({
			kind: "message",
			turnId: this.id("c"),
			parentTurnId: null,
			timestamp: TS,
			role: "tool_call",
			payload: { toolCallId: callId, name: toolName, args },
		});
		const turnId = this.id("r");
		this.entries.push({
			kind: "message",
			turnId,
			parentTurnId: null,
			timestamp: TS,
			role: "tool_result",
			payload: {
				toolCallId: callId,
				toolName,
				result: { content: [{ type: "text", text }] },
				isError: options.isError === true,
				...(options.blocked === true ? { outcome: "blocked", blockReason: "safety net" } : {}),
			},
		});
		return turnId;
	}

	read(path: string, range: { offset?: number; limit?: number; tail?: number } = {}, text = body(path)): string {
		return this.call("read", { path, ...range }, text);
	}

	edit(path: string): string {
		return this.call("edit", { path, edits: [{ oldText: "a", newText: "b" }] }, body(`edited ${path}`));
	}

	find(path: string, surfaced: ReadonlyArray<string>): string {
		return this.call(
			"find",
			{ pattern: "**/*.ts", path },
			[...surfaced, `[find: ${surfaced.length} paths shown]`].join("\n"),
		);
	}

	bash(command: string, text: string, options: { isError?: boolean } = {}): string {
		return this.call("bash", { command }, text, options);
	}

	/** Turn starts that push everything before them past the protection horizon. */
	pad(turns = 3): this {
		for (let i = 0; i < turns; i += 1) this.user(`pad ${i}`);
		return this;
	}
}

function policyInput(entries: ReadonlyArray<SessionEntry>, overrides: Partial<PolicyInput> = {}): PolicyInput {
	const settings: WorkingSetSettings = { ...DEFAULT_WORKING_SET_SETTINGS, protectLastTurns: 2 };
	return {
		entries,
		view: EMPTY_WORKING_SET_VIEW,
		// The live ledger readers strip the JSONL header; the cwd arrives explicitly.
		cwd: CWD,
		settings,
		// Far below threshold: rungs 1-5 run, rung 6 does not.
		pressure: { tokens: 1_000, contextWindow: 100_000, threshold: 0.8, target: 0.6 },
		estimateTokens,
		...overrides,
	};
}

function select(entries: ReadonlyArray<SessionEntry>, overrides: Partial<PolicyInput> = {}): EvictionCandidate[] {
	return [...structuralPolicy.select(policyInput(entries, overrides))];
}

function byRef(candidates: ReadonlyArray<EvictionCandidate>): Map<string, EvictionCandidate> {
	return new Map(candidates.map((candidate) => [candidate.ref.entry, candidate]));
}

test("structural: a later full read supersedes the earlier one (charter scenario 3)", () => {
	const ledger = new Ledger();
	ledger.user();
	const first = ledger.read("src/a.ts");
	ledger.user();
	const second = ledger.read("src/a.ts");
	ledger.pad();

	const candidates = byRef(select(ledger.entries));
	assert.equal(candidates.get(first)?.reason, "superseded_read");
	assert.equal(candidates.get(first)?.by, second);
	assert.equal(candidates.has(second), false, "the live copy stays");
});

test("structural: an edit makes the earlier read stale and names the mutation (charter scenario 4)", () => {
	const ledger = new Ledger();
	ledger.user();
	const stale = ledger.read("src/b.ts");
	ledger.user();
	const edit = ledger.edit("src/b.ts");
	ledger.user();
	const fresh = ledger.read("src/b.ts");
	ledger.pad();

	const candidates = byRef(select(ledger.entries));
	assert.equal(candidates.get(stale)?.reason, "stale_after_mutation");
	assert.equal(candidates.get(stale)?.by, edit);
	// The read after the edit is a fresh observation of the current file.
	assert.equal(candidates.has(fresh), false);
	// The mutation itself is not redundant: nothing rewrote the file after it.
	assert.equal(candidates.has(edit), false);
});

test("structural: a failed edit changes nothing, so the read it targeted is not stale", () => {
	const ledger = new Ledger();
	ledger.user();
	const read = ledger.read("src/b.ts");
	ledger.user();
	ledger.call("edit", { path: "src/b.ts", edits: [{ oldText: "missing", newText: "b" }] }, "edit: oldText not found", {
		isError: true,
	});
	ledger.pad();
	assert.equal(byRef(select(ledger.entries)).has(read), false, "the failed edit is not a mutation");

	ledger.user();
	const edit = ledger.edit("src/b.ts");
	ledger.pad();
	assert.equal(byRef(select(ledger.entries)).get(read)?.by, edit, "the first successful edit names the staleness");
});

test("structural: staleness outranks supersession when both apply", () => {
	const ledger = new Ledger();
	ledger.user();
	const first = ledger.read("src/c.ts");
	ledger.user();
	ledger.edit("src/c.ts");
	ledger.user();
	ledger.read("src/c.ts");
	ledger.pad();

	assert.equal(byRef(select(ledger.entries)).get(first)?.reason, "stale_after_mutation");
});

test("structural: a listing with unread surfaced paths stays (charter scenario 5)", () => {
	// Long enough that the listing body itself clears the minEvictableTokens floor.
	const surfaced = Array.from({ length: 16 }, (_, i) => `domains/context/working-set/generated/component_${i}/index.ts`);
	const ledger = new Ledger();
	ledger.user();
	const listing = ledger.find("src", surfaced);
	for (const path of surfaced.slice(0, 5)) {
		ledger.user();
		ledger.read(`src/${path}`);
	}
	ledger.pad();

	assert.equal(byRef(select(ledger.entries)).has(listing), false, "11 surfaced paths are still unread");
});

test("structural: a listing whose surfaced paths were all read is consumed", () => {
	// Long enough that the listing body itself clears the minEvictableTokens floor.
	const surfaced = Array.from({ length: 16 }, (_, i) => `domains/context/working-set/generated/component_${i}/index.ts`);
	const ledger = new Ledger();
	ledger.user();
	const listing = ledger.find("src", surfaced);
	for (const path of surfaced) {
		ledger.user();
		ledger.read(`src/${path}`);
	}
	ledger.pad();

	assert.equal(byRef(select(ledger.entries)).get(listing)?.reason, "listing_consumed");
});

test("structural: a listing under a relative root is consumed without any cwd at all (live shape)", () => {
	// find prints paths relative to the directory it searched; the model then
	// reads them relative to the workspace. Before the join-onto-root fix this
	// never matched unless the root was ".", so listing_consumed was dead live.
	const surfaced = Array.from({ length: 16 }, (_, i) => `domains/context/working-set/generated/component_${i}/index.ts`);
	const ledger = new Ledger();
	ledger.user();
	const listing = ledger.find("src", surfaced);
	for (const path of surfaced) {
		ledger.user();
		ledger.read(`./src/${path}`);
	}
	ledger.pad();

	assert.equal(byRef(select(ledger.entries, { cwd: null })).get(listing)?.reason, "listing_consumed");
});

test("structural: a listing that surfaced nothing is never consumed", () => {
	const ledger = new Ledger();
	ledger.user();
	const empty = ledger.find("src", []);
	ledger.pad();
	assert.equal(byRef(select(ledger.entries)).has(empty), false);
});

test("structural: a resolved failure is evicted and keeps its first line in the marker", () => {
	const ledger = new Ledger();
	ledger.user();
	const failure = ledger.bash("npm test", `make: *** No rule to make target\n${body("stack")}`, { isError: true });
	ledger.user();
	const success = ledger.bash("npm test", body("passing"));
	ledger.pad();

	const candidates = select(ledger.entries);
	const resolved = byRef(candidates).get(failure);
	assert.equal(resolved?.reason, "failure_resolved");
	assert.equal(resolved?.by, success);

	const plan = planEviction(structuralPolicy, policyInput(ledger.entries));
	assert.ok(plan);
	const item = plan.items.find((entry) => entry.ref.entry === failure);
	assert.ok(item);
	assert.equal(item.marker.includes('first_line="make: *** No rule to make target"'), true, item.marker);
	assert.equal(item.marker.includes("preview="), false, "a failure marker carries evidence, not a preview");
	assert.equal(item.marker.includes(`by=${success}`), true, item.marker);
});

test("structural: an unresolved failure is protected", () => {
	const ledger = new Ledger();
	ledger.user();
	const failure = ledger.bash("npm test", `make: *** No rule to make target\n${body("stack")}`, { isError: true });
	ledger.user();
	// A different command succeeding does not resolve this one.
	ledger.bash("npm run lint", body("lint ok"));
	ledger.pad();

	assert.equal(byRef(select(ledger.entries)).has(failure), false);
});

test("structural: a blocked repeat of a failed call does not resolve the failure", () => {
	const ledger = new Ledger();
	ledger.user();
	const failure = ledger.bash("rm -rf build", `rm: cannot remove 'build': Permission denied\n${body("stack")}`, {
		isError: true,
	});
	ledger.user();
	ledger.call("bash", { command: "rm -rf build" }, body("refused"), { blocked: true });
	ledger.pad();

	assert.equal(byRef(select(ledger.entries)).has(failure), false, "a refusal is a verdict, not a success");
});

test("structural: range reads only supersede ranges they contain", () => {
	// A property sweep over deterministic offset/limit pairs: an earlier read is
	// evicted only when the later read's lines contain it.
	const spans: ReadonlyArray<[number, number | null]> = [
		[1, 50],
		[20, 50],
		[40, 10],
		[1, null],
		[100, 20],
		[45, 5],
	];
	for (const [earlyOffset, earlyLimit] of spans) {
		for (const [lateOffset, lateLimit] of spans) {
			const ledger = new Ledger();
			ledger.user();
			const early = ledger.read("src/r.ts", {
				offset: earlyOffset,
				...(earlyLimit === null ? {} : { limit: earlyLimit }),
			});
			ledger.user();
			ledger.read("src/r.ts", { offset: lateOffset, ...(lateLimit === null ? {} : { limit: lateLimit }) });
			ledger.pad();

			const earlyStart = earlyOffset - 1;
			const lateStart = lateOffset - 1;
			const earlyEnd = earlyLimit === null ? Number.POSITIVE_INFINITY : earlyStart + earlyLimit;
			const lateEnd = lateLimit === null ? Number.POSITIVE_INFINITY : lateStart + lateLimit;
			const contains = lateStart <= earlyStart && lateEnd >= earlyEnd;
			assert.equal(
				byRef(select(ledger.entries)).has(early),
				contains,
				`later [${lateOffset},${lateLimit}] vs earlier [${earlyOffset},${earlyLimit}]`,
			);
		}
	}
});

test("structural: a tail read supersedes nothing and only a full read supersedes it", () => {
	const tailThenRange = new Ledger();
	tailThenRange.user();
	const tail = tailThenRange.read("src/t.ts", { tail: 40 });
	tailThenRange.user();
	tailThenRange.read("src/t.ts", { offset: 1, limit: 500 });
	tailThenRange.pad();
	assert.equal(
		byRef(select(tailThenRange.entries)).has(tail),
		false,
		"an unknown range is not covered by a bounded read",
	);

	const tailThenFull = new Ledger();
	tailThenFull.user();
	const covered = tailThenFull.read("src/t.ts", { tail: 40 });
	tailThenFull.user();
	tailThenFull.read("src/t.ts");
	tailThenFull.pad();
	assert.equal(byRef(select(tailThenFull.entries)).get(covered)?.reason, "superseded_read");

	const rangeThenTail = new Ledger();
	rangeThenTail.user();
	const ranged = rangeThenTail.read("src/t.ts", { offset: 10, limit: 5 });
	rangeThenTail.user();
	rangeThenTail.read("src/t.ts", { tail: 500 });
	rangeThenTail.pad();
	assert.equal(byRef(select(rangeThenTail.entries)).has(ranged), false, "a tail read covers nothing");
});

test("structural: closed thinking goes, open thinking stays", () => {
	const ledger = new Ledger();
	ledger.user();
	const closed = ledger.thinking("old reasoning");
	ledger.pad();
	const open = ledger.thinking("current reasoning");

	const candidates = byRef(select(ledger.entries));
	assert.equal(candidates.get(closed)?.reason, "thinking_turn_closed");
	assert.equal(candidates.has(open), false);
});

test("structural: protection keeps the recent window, small results, and blocked rows", () => {
	const ledger = new Ledger();
	ledger.user();
	const tiny = ledger.read("src/tiny.ts", {}, "ok");
	ledger.user();
	ledger.read("src/tiny.ts");
	ledger.user();
	const blocked = ledger.call("bash", { command: "rm -rf /" }, body("refused"), { blocked: true });
	ledger.user();
	ledger.bash("rm -rf /", body("refused again"));
	ledger.user();
	const recent = ledger.read("src/recent.ts");
	ledger.user();
	ledger.read("src/recent.ts");

	const candidates = byRef(select(ledger.entries));
	assert.equal(candidates.has(tiny), false, "below the floor the marker costs more than the body");
	assert.equal(candidates.has(blocked), false, "an admission verdict is a decision, not an observation");
	assert.equal(candidates.has(recent), false, "inside the protection horizon");
});

test("structural: a mutation in the active turn is protected even without the horizon", () => {
	const ledger = new Ledger();
	ledger.user();
	const edit = ledger.edit("src/live.ts");
	const entries = ledger.entries;
	const entryIndex = entries.findIndex((entry) => entry.turnId === edit);
	const entry = entries[entryIndex];
	assert.ok(entry);

	const input = policyInput(entries);
	const index = buildPathIndex(entries, { cwd: CWD });
	// cutoffIndex past the end takes the horizon out of the answer, leaving the
	// active-turn predicate as the only thing that can protect this write.
	assert.equal(isProtected(entry, { entryIndex, cutoffIndex: entries.length, input, index }), true);
	assert.equal(protectionCutoffIndex(entries, input.settings.protectLastTurns) <= entryIndex, true);
});

test("structural: nothing but a message body ever becomes a candidate", () => {
	const ledger = new Ledger();
	ledger.user("operator words");
	ledger.entries.push({
		kind: "bashExecution",
		turnId: "b1",
		parentTurnId: null,
		timestamp: TS,
		command: "ls",
		output: body("local bash"),
		exitCode: 0,
		cancelled: false,
		truncated: false,
	});
	ledger.entries.push({
		kind: "compactionSummary",
		turnId: "s1",
		parentTurnId: null,
		timestamp: TS,
		summary: body("summary"),
		firstKeptTurnId: "",
		trigger: "auto",
		tokensBefore: 1_000,
	});
	ledger.pad();

	for (const candidate of select(ledger.entries)) {
		const entry = ledger.entries.find((item) => item.turnId === candidate.ref.entry);
		assert.equal(entry?.kind, "message");
	}
});

test("structural: rung 6 never runs below threshold", () => {
	const ledger = new Ledger();
	ledger.user();
	ledger.read("src/keep.ts");
	ledger.user();
	ledger.read("src/other.ts");
	ledger.pad();

	// Nothing is redundant here, so a policy that fired the age rung would be
	// the only source of candidates.
	assert.deepEqual(select(ledger.entries), []);
});

test("structural: rung 6 fires above threshold and stops at target", () => {
	const ledger = new Ledger();
	for (let i = 0; i < 5; i += 1) {
		ledger.user();
		ledger.read(`src/f${i}.ts`);
	}
	ledger.pad();

	const perResult = estimateTokens(
		ledger.entries.find((entry) => entry.kind === "message" && entry.role === "tool_result") as SessionEntry,
	);
	const window = 1_000;
	const candidates = select(ledger.entries, {
		pressure: { tokens: 900, contextWindow: window, threshold: 0.8, target: 0.6 },
	});
	assert.ok(candidates.length > 0, "above threshold the age rung has to run");
	assert.equal(
		candidates.every((candidate) => candidate.reason === "age_horizon"),
		true,
	);
	// Enough to cross 600, and not one more than that.
	const needed = Math.ceil((900 - 600) / perResult);
	assert.equal(candidates.length, needed, `freed ${perResult} per result`);

	// Newest-safe-first: the youngest evictable result goes first.
	const evictableResults = ledger.entries
		.filter((entry) => entry.kind === "message" && entry.role === "tool_result")
		.map((entry) => entry.turnId);
	assert.equal(candidates[0]?.ref.entry, evictableResults[evictableResults.length - 1]);
});

test("structural: rung 6 leaves protected units alone", () => {
	const ledger = new Ledger();
	ledger.user();
	const failure = ledger.bash("npm test", body("boom"), { isError: true });
	ledger.user();
	const tiny = ledger.read("src/tiny.ts", {}, "ok");
	ledger.user();
	ledger.read("src/big.ts");
	ledger.pad();

	const candidates = byRef(
		select(ledger.entries, { pressure: { tokens: 100_000, contextWindow: 1_000, threshold: 0.8, target: 0.6 } }),
	);
	assert.equal(candidates.has(failure), false);
	assert.equal(candidates.has(tiny), false);
});

test("structural: units already out of the working set are never re-selected", () => {
	const ledger = new Ledger();
	ledger.user();
	const first = ledger.read("src/a.ts");
	ledger.user();
	ledger.read("src/a.ts");
	ledger.pad();
	ledger.entries.push({
		kind: "contextEviction",
		turnId: "e1",
		parentTurnId: null,
		timestamp: TS,
		policyId: "structural-v1",
		trigger: "pressure",
		evicted: [{ ref: { entry: first }, reason: "superseded_read", tokensFreed: 100, marker: "[evicted]" }],
		tokensBefore: 1_000,
		tokensAfter: 900,
		pressureBefore: 0.9,
		snapshotIdBefore: null,
	});

	const entries = ledger.entries;
	const view = {
		evicted: new Map([
			[
				first,
				{
					reason: "superseded_read" as const,
					marker: "[evicted]",
					tokensFreed: 100,
					evictedAtTurnId: "e1",
					policyId: "structural-v1",
				},
			],
		]),
		evictionEvents: 1,
		itemsEvicted: 1,
		recalls: 0,
		lastPolicyId: "structural-v1",
		lastEvictionTurnId: "e1",
	};
	assert.equal(
		select(entries, { view }).some((candidate) => candidate.ref.entry === first),
		false,
	);
});

test("structural: the same ledger selects identically twice", () => {
	const ledger = new Ledger();
	ledger.user();
	const read = ledger.read("src/a.ts");
	ledger.user();
	ledger.edit("src/a.ts");
	ledger.user();
	ledger.thinking();
	ledger.user();
	ledger.bash("npm test", body("boom"), { isError: true });
	ledger.user();
	ledger.bash("npm test", body("ok"));
	ledger.pad();

	const first = select(ledger.entries);
	const second = select(ledger.entries);
	assert.deepEqual(second, first);
	assert.ok(first.some((candidate) => candidate.ref.entry === read));
});

test("structural: planEviction turns a mixed selection into a valid ledger entry", () => {
	const surfaced = Array.from({ length: 16 }, (_, i) => `domains/context/working-set/generated/surfaced_${i}/index.ts`);
	const ledger = new Ledger();
	ledger.user();
	const staleRead = ledger.read("src/m.ts");
	ledger.user();
	ledger.edit("src/m.ts");
	ledger.user();
	const listing = ledger.find("src", surfaced);
	for (const path of surfaced) {
		ledger.user();
		ledger.read(`src/${path}`);
	}
	ledger.user();
	const failure = ledger.bash("npm test", `boom: it broke\n${body("stack")}`, { isError: true });
	ledger.user();
	ledger.bash("npm test", body("ok"));
	ledger.user();
	const closedThinking = ledger.thinking("old reasoning");
	ledger.pad();

	const plan = planEviction(structuralPolicy, policyInput(ledger.entries));
	assert.ok(plan);
	assert.equal(plan.policyId, "structural-v1");
	assert.ok(plan.tokensAfter < plan.tokensBefore);

	const reasons = new Map(plan.items.map((item) => [item.ref.entry, item.reason]));
	assert.equal(reasons.get(staleRead), "stale_after_mutation");
	assert.equal(reasons.get(listing), "listing_consumed");
	assert.equal(reasons.get(failure), "failure_resolved");
	assert.equal(reasons.get(closedThinking), "thinking_turn_closed");

	for (const item of plan.items) {
		if (item.reason === "thinking_turn_closed") {
			assert.equal(item.marker, "", "thinking leaves without a marker");
			continue;
		}
		assert.match(item.marker, /^\[evicted ref=/);
		assert.equal(item.marker.split("\n").length, 1);
		assert.ok(item.tokensFreed > 0);
	}

	const fields = buildEvictionFields(plan, { trigger: "pressure", pressureBefore: 0.91, snapshotIdBefore: "snap-1" });
	const entry = { ...fields, turnId: "e1", parentTurnId: "u1", timestamp: TS };
	assert.equal(isSessionEntry(entry), true, "the plan must round-trip through the ledger validator");
	assert.equal(
		plan.tokensBefore - plan.tokensAfter,
		plan.items.reduce((sum, item) => sum + item.tokensFreed, 0),
	);
});
