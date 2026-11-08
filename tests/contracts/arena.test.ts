import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	type ArenaMatch,
	ArenaRevealRefused,
	ArenaVoteError,
	arenaMatchView,
	arenaRoot,
	blindOrder,
	computeStandings,
	listMatches,
	readArenaStream,
	readVote,
	recordVote,
	runArenaMatch,
} from "../../src/domains/arena/index.js";
import { writeMatch } from "../../src/domains/arena/store.js";

const sum = (measured: number, unknownCount = 0) => ({
	measured,
	estimated: 0,
	unknownCount,
	absentCount: 0,
	coverage: { measured: unknownCount > 0 ? 0 : 1, estimated: 0, unknown: unknownCount },
});

function frames(...values: unknown[]): string {
	return values.map((value) => JSON.stringify(value)).join("\n");
}

function match(id: string, contenders: Array<[string, string]>, overrides: Partial<ArenaMatch> = {}): ArenaMatch {
	return {
		schemaVersion: 1,
		id,
		createdAt: "2026-01-01T00:00:00.000Z",
		completedAt: "2026-01-01T00:01:00.000Z",
		status: "complete",
		prompt: "fix it",
		suite: null,
		root: "/nowhere",
		baselineSha: null,
		isolation: "read-only",
		seed: 1,
		order: contenders.map((_, index) => index),
		timeoutSeconds: 60,
		maxCostUsd: null,
		check: null,
		contenders: contenders.map(([target, model], index) => ({
			target,
			model,
			index,
			status: "done",
			facts: {
				exitCode: 0,
				timedOut: false,
				durationMs: 1000,
				sessionId: `s${index}`,
				turns: 1,
				toolCalls: 0,
				toolErrors: 0,
				writes: 0,
				blocks: 0,
				totalTokens: sum(100),
				cost: { usd: sum(0, 1), free: false },
				finalText: `answer ${index}`,
				diff: null,
				check: null,
				error: null,
			},
		})),
		error: null,
		...overrides,
	};
}

function vote(choice: string) {
	return { schemaVersion: 1 as const, matchId: "x", choice: choice as "A", note: null, votedAt: "t", replaced: false };
}

describe("arena stream facts", () => {
	it("counts writes, blocks and errors and keeps unpriced cost unmeasured", () => {
		const facts = readArenaStream(
			frames(
				{ type: "session", id: "sess1" },
				{ type: "tool_execution_end", actionClass: "write", outcome: "ok", isError: false },
				{ type: "tool_execution_end", actionClass: "write", outcome: "blocked", decision: "blocked", isError: true },
				{ type: "tool_execution_end", actionClass: "read", outcome: "error", isError: true },
				{ type: "tool_execution_end", actionClass: "read", outcome: "ok", decision: "denied" },
				{ type: "turn_end", message: { role: "assistant", content: [{ type: "toolCall" }] } },
				{ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "done here" }] } },
				{ type: "agent_end", usage: { totalTokens: sum(10), cost: { usd: sum(0, 2), free: false } } },
				{ type: "agent_end", usage: { totalTokens: sum(5), cost: { usd: sum(0, 1), free: false } } },
				"not json",
			),
		);
		assert.equal(facts.sessionId, "sess1");
		assert.deepEqual([facts.toolCalls, facts.writes, facts.blocks, facts.toolErrors, facts.turns], [4, 1, 2, 1, 2]);
		assert.equal(facts.finalText, "done here");
		assert.equal(facts.totalTokens?.measured, 15);
		assert.equal(facts.cost?.usd.unknownCount, 3);
		assert.equal(facts.cost?.usd.measured, 0);
	});
});

describe("arena blind order", () => {
	it("is a seeded permutation", () => {
		assert.deepEqual(blindOrder(4, 7), blindOrder(4, 7));
		assert.deepEqual([...blindOrder(4, 7)].sort(), [0, 1, 2, 3]);
		const seen = new Set<string>();
		for (let seed = 0; seed < 50; seed++) seen.add(blindOrder(3, seed).join(""));
		assert.ok(seen.size > 3, "different seeds give different orders");
	});
});

describe("arena votes and reveal", () => {
	it("hides identity until a vote, refuses early reveal, and journals replacements", () => {
		const root = join(mkdtempSync(join(tmpdir(), "clio-coder-arena-")), "arena");
		const id = "20260101-000000-abcd";
		writeMatch(
			root,
			match(
				id,
				[
					["t1", "m1"],
					["t2", "m2"],
				],
				{ order: [1, 0] },
			),
		);
		const blind = arenaMatchView(
			root,
			match(
				id,
				[
					["t1", "m1"],
					["t2", "m2"],
				],
				{ order: [1, 0] },
			),
			null,
		);
		assert.equal(blind.revealed, false);
		assert.ok(blind.entries.every((entry) => entry.reveal === null));
		assert.equal(blind.entries[0]?.finalText, "answer 1");
		assert.doesNotMatch(JSON.stringify(blind), /t1|m2|"tokens"|"cost"|durationMs/);
		assert.throws(
			() =>
				arenaMatchView(
					root,
					match(id, [
						["t1", "m1"],
						["t2", "m2"],
					]),
					null,
					{ reveal: true },
				),
			ArenaRevealRefused,
		);

		assert.throws(() => recordVote(root, id, { choice: "C", note: null, replace: false }), ArenaVoteError);
		recordVote(root, id, { choice: "A", note: "cleaner", replace: false });
		assert.throws(() => recordVote(root, id, { choice: "B", note: null, replace: false }), /--replace/);
		const replaced = recordVote(root, id, { choice: "B", note: null, replace: true });
		assert.equal(replaced.replaced, true);
		assert.equal(readVote(root, id)?.choice, "B");
		assert.equal(readFileSync(join(root, "votes.jsonl"), "utf8").trim().split("\n").length, 2);

		const listed = listMatches(root);
		const shown = arenaMatchView(root, listed[0]?.match as ArenaMatch, listed[0]?.vote ?? null, { reveal: true });
		assert.equal(shown.entries[0]?.reveal?.target, "t2");
		assert.equal(shown.entries[0]?.reveal?.cost, "not measured");
	});

	it("refuses a vote on a match that has not completed", () => {
		const root = join(mkdtempSync(join(tmpdir(), "clio-coder-arena-")), "arena");
		const id = "20260101-000000-0001";
		writeMatch(
			root,
			match(
				id,
				[
					["t1", "m1"],
					["t2", "m2"],
				],
				{ status: "running" },
			),
		);
		assert.throws(() => recordVote(root, id, { choice: "A", note: null, replace: false }), /running/);
	});
});

describe("arena standings", () => {
	it("tallies wins, ties and both-bad, and scores only past the vote floor", () => {
		const pair = (n: number) =>
			match(`20260101-00000${n}-0000`, [
				["x", "strong"],
				["y", "weak"],
			]);
		const entries = [
			...[0, 1, 2, 3].map((n) => ({ match: pair(n), vote: vote("A") })),
			{ match: pair(4), vote: vote("tie") },
			{ match: pair(5), vote: vote("both-bad") },
			{ match: pair(6), vote: null },
			{
				match: match("20260101-000007-0000", [
					["x", "strong"],
					["x", "strong"],
				]),
				vote: vote("A"),
			},
		];
		const result = computeStandings(entries);
		assert.equal(result.matches, 8);
		assert.equal(result.votedMatches, 6);
		const [first, second] = result.standings;
		assert.equal(first?.identity, "x/strong");
		assert.deepEqual([first?.wins, first?.losses, first?.ties, first?.bad, first?.votes], [4, 0, 1, 1, 6]);
		assert.deepEqual([second?.wins, second?.losses], [0, 4]);
		assert.ok((first?.score ?? 0) > 1000 && (second?.score ?? 2000) < 1000);

		const few = computeStandings(entries.slice(0, 2));
		assert.ok(few.standings.every((s) => s.score === null));
		assert.equal(computeStandings(entries, "other").standings.length, 0);
	});
});

const FAKE_CLIO = `
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "verifiers") { console.log("check " + args[2] + ": pass"); process.exit(0); }
const cwd = args[args.indexOf("--cwd") + 1];
const model = args[args.indexOf("--model") + 1];
writeFileSync(join(cwd, "answer.txt"), model + "\\n");
const out = (f) => process.stdout.write(JSON.stringify(f) + "\\n");
out({ type: "session", id: "fake-" + model });
out({ type: "tool_execution_end", actionClass: "write", outcome: "ok", isError: false });
out({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "wrote " + model }] } });
`;

describe("arena runner", () => {
	it("runs contenders in separate worktrees, keeps their diffs, and cleans up", async () => {
		const base = mkdtempSync(join(tmpdir(), "clio-coder-arena-run-"));
		const repo = join(base, "repo");
		mkdirSync(repo);
		const gitIn = (...args: string[]) =>
			execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "pipe" });
		gitIn("init", "-q", "-b", "main");
		writeFileSync(join(repo, "README"), "x\n");
		gitIn("add", "-A");
		gitIn("commit", "-qm", "init");
		const fake = join(base, "fake-clio.cjs");
		writeFileSync(fake, FAKE_CLIO);
		const result = await runArenaMatch({
			cwd: repo,
			prompt: "write your model name",
			contenders: [
				{ target: "t", model: "m1" },
				{ target: "t", model: "m2" },
			],
			seed: 3,
			timeoutSeconds: 30,
			check: "unit",
			clio: { file: process.execPath, args: [fake] },
			env: {},
		});
		assert.equal(result.status, "complete", result.error ?? "");
		assert.equal(result.isolation, "worktree");
		for (const contender of result.contenders) {
			assert.equal(contender.status, "done");
			assert.equal(contender.facts?.writes, 1);
			assert.deepEqual(contender.facts?.diff, { files: 1, insertions: 1, deletions: 0 });
			assert.match(contender.facts?.check?.tail ?? "", /check unit: pass/);
		}
		const root = arenaRoot(repo);
		assert.match(readFileSync(join(root, result.id, "contender-2.diff"), "utf8"), /\+m2/);
		assert.equal(existsSync(join(repo, "answer.txt")), false, "the main checkout is untouched");
		assert.equal(gitIn("worktree", "list").toString().trim().split("\n").length, 1);
		assert.equal(gitIn("branch", "--list", "clio-coder/compete/*").toString().trim(), "");
	});
});
