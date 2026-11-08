import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { runArenaCommand } from "../../src/cli/arena.js";
import { parseRunCliArgs } from "../../src/cli/args.js";
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

describe("arena blind diagnostics", () => {
	it("redacts contender identities, sessions and worktrees from errors before a vote and keeps them raw after", () => {
		const root = join(mkdtempSync(join(tmpdir(), "clio-coder-arena-")), "arena");
		const id = "20260101-000000-feed";
		const raw =
			"target t2 not found in settings.targets; model gpt-6-luna. session sess-abc at /r/.clio-coder/worktrees/arena-x/candidate-2 on clio-coder/compete/arena-x/2 (contender 2)";
		const failed = match(
			id,
			[
				["t1", "m1"],
				["t2", "gpt-6-luna"],
			],
			{ order: [1, 0], error: "contender 2 failed: target t2 not found" },
		);
		const second = failed.contenders[1];
		if (second?.facts) {
			second.facts.sessionId = "sess-abc";
			second.facts.error = raw;
			second.facts.check = { id: "unit", exitCode: 1, tail: `fail in ${raw}` };
		}
		const answer =
			"Fixed /repo/.clio-coder/worktrees/compete/arena-x/candidate-2/src/foo.ts; log in /state/sessions/sess-abc.json, model gpt-6-luna";
		if (second?.facts) second.facts.finalText = answer;
		writeMatch(root, failed);
		mkdirSync(join(root, id), { recursive: true });
		writeFileSync(join(root, id, "contender-2.diff"), "+// tuned for gpt-6-luna via t2/gpt-6-luna\n");
		const blind = arenaMatchView(root, failed, null);
		assert.equal(
			blind.entries[0]?.finalText,
			"Fixed [worktree]/src/foo.ts; log in /state/sessions/[hidden].json, model [hidden]",
		);
		assert.equal(blind.entries[0]?.diff, "+// tuned for [hidden] via [hidden]\n");
		const text = JSON.stringify([
			blind.error,
			...blind.entries.map((entry) => [entry.error, entry.check, entry.finalText, entry.diff]),
		]);
		assert.doesNotMatch(text, /\bt2\b|gpt-6-luna|sess-abc|candidate-2|arena-x|contender 2/);
		assert.match(blind.entries[0]?.error ?? "", /target \[hidden\] not found .*model \[hidden\]\./);
		const shown = arenaMatchView(root, failed, vote("A"), { reveal: true });
		assert.equal(shown.entries[0]?.error, raw);
		assert.equal(shown.entries[0]?.finalText, answer);
		assert.match(shown.entries[0]?.diff ?? "", /gpt-6-luna via t2\/gpt-6-luna/);
		assert.equal(shown.error, "contender 2 failed: target t2 not found");
	});
});

describe("arena vote lock", () => {
	it("lets exactly one of several concurrent processes land a first vote", async () => {
		const base = mkdtempSync(join(tmpdir(), "clio-coder-arena-lock-"));
		const root = join(base, "arena");
		const id = "20260101-000000-1111";
		writeMatch(
			root,
			match(id, [
				["t1", "m1"],
				["t2", "m2"],
			]),
		);
		const go = join(base, "go");
		const script = join(base, "voter.mjs");
		const store = resolve("src/domains/arena/store.ts");
		writeFileSync(
			script,
			`import { existsSync } from "node:fs";
const { recordVote } = await import(${JSON.stringify(store)});
while (!existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 5));
try { recordVote(${JSON.stringify(root)}, ${JSON.stringify(id)}, { choice: process.argv[2], note: null, replace: false }); console.log("ok"); }
catch (error) { console.log("refused " + error.message); }
`,
		);
		const voters = ["A", "B", "tie", "A", "B", "both-bad"].map(
			(choice) =>
				new Promise<string>((done, fail) => {
					const child = spawn(process.execPath, ["--import", "tsx", script, choice], {
						stdio: ["ignore", "pipe", "inherit"],
					});
					let out = "";
					child.stdout.on("data", (chunk) => {
						out += chunk;
					});
					child.on("error", fail);
					child.on("close", () => done(out.trim()));
				}),
		);
		await new Promise((r) => setTimeout(r, 1500));
		writeFileSync(go, "");
		const outcomes = await Promise.all(voters);
		assert.equal(outcomes.filter((line) => line === "ok").length, 1, outcomes.join("\n"));
		assert.ok(
			outcomes.every((line) => line === "ok" || /already has a vote/.test(line)),
			outcomes.join("\n"),
		);
		assert.equal(readFileSync(join(root, "votes.jsonl"), "utf8").trim().split("\n").length, 1);
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
	it("rates by Elo, replayed in match order whatever order the records arrive in", () => {
		const duel = (n: number, choice: string) => ({
			match: match(`20260101-00000${n}-0000`, [
				["x", "strong"],
				["y", "weak"],
			]),
			vote: vote(choice),
		});
		// x wins five, then y wins the sixth: 1067/933 after the streak, 1045/955 after the upset.
		const entries = [duel(0, "A"), duel(1, "A"), duel(2, "A"), duel(3, "A"), duel(4, "A"), duel(5, "B")];
		for (const order of [entries, [...entries].reverse()]) {
			const scores = Object.fromEntries(computeStandings(order).standings.map((s) => [s.identity, s.score]));
			assert.deepEqual(scores, { "x/strong": 1045, "y/weak": 955 });
		}
		const streak = (wins: number) =>
			computeStandings(
				Array.from({ length: wins }, (_, n) => ({
					match: match(`20260101-000000-${String(n).padStart(4, "0")}`, [
						["x", "strong"],
						["y", "weak"],
					]),
					vote: vote("A"),
				})),
			).standings.map((s) => s.score as number);
		const [ten, hundred] = [streak(10), streak(100)];
		assert.equal((ten[0] as number) + (ten[1] as number), 2000, "Elo moves points between the two, never creates them");
		assert.ok((ten[0] as number) < (hundred[0] as number), `10-0 ${ten} vs 100-0 ${hundred}`);
	});
	it("splits K across a many-way match and leaves ratings alone on both-bad", () => {
		const four = (n: number, choice: string) => ({
			match: match(`20260101-00000${n}-0000`, [
				["x", "a"],
				["x", "b"],
				["x", "c"],
				["x", "d"],
			]),
			vote: vote(choice),
		});
		const won = computeStandings([0, 1, 2, 3, 4].map((n) => four(n, "A"))).standings;
		assert.equal(won[0]?.identity, "x/a");
		// K 32 is split three ways: the first win is +16 for x/a and -16/3 for each of the others.
		assert.deepEqual(
			won.map((s) => s.score),
			[1071, 976, 976, 976],
		);
		const bad = computeStandings([0, 1, 2, 3, 4].map((n) => four(n, "both-bad"))).standings;
		assert.ok(bad.every((s) => s.score === 1000 && s.bad === 5));
		const tied = computeStandings([0, 1, 2, 3, 4].map((n) => four(n, "tie"))).standings;
		assert.ok(tied.every((s) => s.score === 1000 && s.ties === 5));
	});
});

const FAKE_CLIO = `
const { unlinkSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "verifiers") { console.log("check " + args[2] + ": pass"); process.exit(0); }
const cwd = args[args.indexOf("--cwd") + 1];
const model = args[args.indexOf("--model") + 1];
const end = args.indexOf("--");
const prompt = end === -1 ? null : args.slice(end + 1).join(" ");
if (process.env.ARENA_PID_DIR) writeFileSync(join(process.env.ARENA_PID_DIR, model + ".pid"), String(process.pid));
writeFileSync(join(cwd, "answer.txt"), model + "\\n");
const out = (f) => process.stdout.write(JSON.stringify(f) + "\\n");
out({ type: "session", id: "fake-" + model });
out({ type: "tool_execution_end", actionClass: "write", outcome: "ok", isError: false });
out({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "wrote " + model + " for " + JSON.stringify(prompt) + " in " + cwd }] } });
if (model === "slow") setTimeout(() => {}, 60_000);
if (model === "breaker") setTimeout(() => unlinkSync(process.env.ARENA_BREAK), 800);
`;

function scratchRepo(): { base: string; repo: string; fake: string; gitIn: (...args: string[]) => Buffer } {
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
	return { base, repo, fake, gitIn };
}

describe("arena runner", () => {
	it("stops every contender on abort and still removes the worktrees", async () => {
		const { repo, fake, gitIn } = scratchRepo();
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 1500);
		const result = await runArenaMatch({
			cwd: repo,
			prompt: "hang",
			contenders: [
				{ target: "t", model: "slow" },
				{ target: "t", model: "m2" },
			],
			timeoutSeconds: 120,
			clio: { file: process.execPath, args: [fake] },
			env: {},
			signal: controller.signal,
		});
		assert.equal(result.status, "failed");
		assert.match(result.error ?? "", /canceled/);
		assert.equal(gitIn("worktree", "list").toString().trim().split("\n").length, 1);
	});

	it("runs contenders in separate worktrees, keeps their diffs, and cleans up", async () => {
		const { repo, fake, gitIn } = scratchRepo();
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
		// Worktrees are numbered by blind slot, so a path an answer quotes repeats only its label.
		for (const contender of result.contenders) {
			const slot = result.order.indexOf(contender.index) + 1;
			assert.ok(contender.facts?.finalText.endsWith(`candidate-${slot}`), contender.facts?.finalText);
		}
		const root = arenaRoot(repo);
		const blindView = arenaMatchView(root, result, null);
		for (const entry of blindView.entries) {
			assert.match(entry.finalText, / in \[worktree\]$/);
			assert.doesNotMatch(`${entry.finalText}\n${entry.diff}`, /\bm[12]\b|fake-m/);
		}
		assert.match(readFileSync(join(root, result.id, "contender-2.diff"), "utf8"), /\+m2/);
		assert.equal(existsSync(join(repo, "answer.txt")), false, "the main checkout is untouched");
		assert.equal(gitIn("worktree", "list").toString().trim().split("\n").length, 1);
		assert.equal(gitIn("branch", "--list", "clio-coder/compete/*").toString().trim(), "");
	});
	it("stops the other contenders when one fails outright and cleans up only after both settle", async () => {
		const { base, repo, fake, gitIn } = scratchRepo();
		const pids = join(base, "pids");
		mkdirSync(pids);
		const env: Record<string, string> = { ARENA_PID_DIR: pids };
		const started = Date.now();
		const result = await runArenaMatch({
			cwd: repo,
			prompt: "hang",
			contenders: [
				{ target: "t", model: "slow" },
				{ target: "t", model: "breaker" },
			],
			timeoutSeconds: 120,
			clio: { file: process.execPath, args: [fake] },
			env,
			// The breaker removes its own stream file, so reading it back throws while "slow" still runs.
			onStarted: (begun) => {
				env.ARENA_BREAK = join(arenaRoot(repo), begun.id, "contender-2.ndjson");
			},
		});
		assert.equal(result.status, "failed");
		assert.match(result.error ?? "", /ENOENT/);
		assert.ok(Date.now() - started < 30_000, "the slow sibling was stopped, not waited out");
		assert.ok(result.contenders.every((contender) => contender.status !== "running" && contender.status !== "pending"));
		const slow = Number(readFileSync(join(pids, "slow.pid"), "utf8"));
		assert.throws(() => process.kill(slow, 0), /ESRCH/);
		assert.equal(gitIn("worktree", "list").toString().trim().split("\n").length, 1);
	});

	it("passes a prompt that looks like a flag as text and names only blind labels in progress", async () => {
		const { repo, fake } = scratchRepo();
		const progress: string[] = [];
		const result = await runArenaMatch({
			cwd: repo,
			prompt: "--help",
			contenders: [
				{ target: "t", model: "m1" },
				{ target: "t", model: "m2" },
				{ target: "t", model: "m3" },
			],
			// A seed whose order is not the input order, so a label and an input position differ.
			seed: Array.from({ length: 50 }, (_, n) => n).find((n) => blindOrder(3, n).join("") !== "012") as number,
			timeoutSeconds: 30,
			readOnly: true,
			clio: { file: process.execPath, args: [fake] },
			env: {},
			onProgress: (line) => progress.push(line),
		});
		assert.equal(result.status, "complete", result.error ?? "");
		for (const contender of result.contenders) {
			assert.ok(
				contender.facts?.finalText.startsWith(`wrote ${contender.model} for "--help" in `),
				contender.facts?.finalText,
			);
		}
		const finished = progress.filter((line) => line.startsWith("contender "));
		assert.equal(finished.length, 3);
		for (const line of finished) assert.match(line, /^contender [A-D] \w+$/);
		const labels = finished.map((line) => line.split(" ")[1]).sort();
		assert.deepEqual(labels, ["A", "B", "C"]);
	});
});

describe("prompts that start with a dash", () => {
	it("run reads everything after -- as task text", () => {
		const parsed = parseRunCliArgs(["--target", "t", "--", "--read-only", "--continue", "@notes.md"]);
		assert.deepEqual(parsed.messages, ["--read-only", "--continue", "@notes.md"]);
		assert.notEqual(parsed.readOnly, true);
		assert.notEqual(parsed.help, true);
		assert.deepEqual(parseRunCliArgs(["--", "- fix bug"]).messages, ["- fix bug"]);
	});

	it("arena does not read --help after -- as a request for help", async () => {
		const write = process.stdout.write;
		let out = "";
		process.stdout.write = ((chunk: string) => {
			out += chunk;
			return true;
		}) as typeof process.stdout.write;
		const errWrite = process.stderr.write;
		process.stderr.write = (() => true) as typeof process.stderr.write;
		try {
			const code = await runArenaCommand(["show", "--", "--help"]);
			assert.notEqual(code, 0);
			assert.doesNotMatch(out, /Usage:/);
			assert.equal(await runArenaCommand(["show", "--help", "--", "x"]), 0);
			assert.match(out, /Usage:/);
		} finally {
			process.stdout.write = write;
			process.stderr.write = errWrite;
		}
	});
});
