import assert from "node:assert/strict";
import { test } from "node:test";
import {
	arenaGridTemplate,
	arenaRequest,
	entryFacts,
	standingRows,
	voteOptions,
	voteState,
} from "../client/pages/arena-model.js";
import type { ArenaMatch } from "../contracts/arena.js";
import { commandPlan } from "../server/cli-commands.js";
import { AppProblem } from "../server/services/problem.js";

const entry = (label: "A" | "B", reveal: boolean): ArenaMatch["entries"][number] => ({
	label,
	status: "done",
	exitCode: 0,
	timedOut: false,
	turns: 2,
	toolCalls: 3,
	toolErrors: 0,
	writes: 1,
	blocks: 0,
	diffStat: { files: 1, insertions: 1, deletions: 1 },
	check: null,
	finalText: "Fixed.",
	diff: "diff --git",
	diffTruncated: false,
	error: null,
	reveal: reveal
		? { index: 1, target: "mini", model: "qwen", durationMs: 1500, sessionId: null, tokens: "1.2k", cost: "not measured" }
		: null,
});

test("arena: a blind entry shows work facts only; a revealed one adds identity, time, tokens and cost", () => {
	const blind = entryFacts(entry("A", false)).map((fact) => fact.label);
	for (const hidden of ["Contender", "Duration", "Tokens", "Cost"]) assert.equal(blind.includes(hidden), false);
	const shown = Object.fromEntries(entryFacts(entry("A", true)).map((fact) => [fact.label, fact.value]));
	assert.equal(shown.Contender, "mini/qwen");
	assert.equal(shown.Duration, "1.5 s");
	assert.equal(shown.Cost, "not measured");
	assert.equal(shown.Diff, "1 files, +1 -1");
});

test("arena: votes open only on a finished, unvoted match and offer only its own labels", () => {
	assert.equal(voteState({ status: "running", vote: null }).kind, "waiting");
	assert.equal(voteState({ status: "failed", vote: null }).kind, "waiting");
	assert.equal(voteState({ status: "complete", vote: null }).kind, "open");
	assert.deepEqual(voteState({ status: "complete", vote: { choice: "B", note: null, votedAt: "t" } }), {
		kind: "recorded",
		choice: "B",
		note: null,
	});
	assert.deepEqual(
		voteOptions(["A", "B"]).map((option) => option.choice),
		["A", "B", "tie", "both-bad"],
	);
});

test("arena: the form sends a request only when every field is valid", () => {
	const draft = {
		prompt: "  fix the bug  ",
		contenders: [
			{ target: "mini", model: "qwen3.8-27b-iq4r-v4" },
			{ target: "copilot", model: "claude-haiku-5.5" },
			{ target: "", model: "" },
		],
		timeoutSeconds: "300",
		suite: "",
		check: "",
	};
	assert.deepEqual(arenaRequest(draft), {
		request: {
			prompt: "fix the bug",
			contenders: [
				{ target: "mini", model: "qwen3.8-27b-iq4r-v4" },
				{ target: "copilot", model: "claude-haiku-5.5" },
			],
			timeoutSeconds: 300,
		},
	});
	assert.ok("problem" in arenaRequest({ ...draft, prompt: " " }));
	assert.ok("problem" in arenaRequest({ ...draft, contenders: draft.contenders.slice(0, 1) }));
	assert.ok("problem" in arenaRequest({ ...draft, timeoutSeconds: "10" }));
	assert.ok("problem" in arenaRequest({ ...draft, suite: "a b" }));
	assert.ok(
		"problem" in
			arenaRequest({
				...draft,
				contenders: [
					{ target: "mini", model: "-x" },
					{ target: "copilot", model: "claude-haiku-5.5" },
				],
			}),
	);
});

test("arena: columns size from their grips and standings name the votes a score still needs", () => {
	assert.equal(arenaGridTemplate(2), "var(--arena-col-0, minmax(240px, 1fr)) minmax(240px, 1fr)");
	const rows = standingRows({
		suite: null,
		matches: 3,
		votedMatches: 3,
		minVotesForScore: 5,
		standings: [
			{ identity: "a/x", target: "a", model: "x", votes: 4, wins: 2, losses: 1, ties: 1, bad: 0, score: null },
			{ identity: "b/y", target: "b", model: "y", votes: 5, wins: 3, losses: 2, ties: 0, bad: 0, score: 1042 },
		],
	});
	assert.deepEqual(
		rows.map((row) => [row.record, row.score]),
		[
			["2-1-1", "needs 1 more vote"],
			["3-2-0", "1042"],
		],
	);
});

test("arena: CLI commands are fixed argv, the prompt follows --, and nothing else passes through", () => {
	const matchId = "20261108-115256-7967";
	assert.deepEqual(commandPlan({ kind: "arena.list" }).argv, ["arena", "list", "--json"]);
	assert.deepEqual(commandPlan({ kind: "arena.show", matchId }).argv, ["arena", "show", matchId, "--json"]);
	assert.deepEqual(commandPlan({ kind: "arena.standings", suite: "bugs" }).argv, [
		"arena",
		"standings",
		"--json",
		"--suite",
		"bugs",
	]);
	assert.deepEqual(commandPlan({ kind: "arena.vote", matchId, choice: "tie", note: "close", replace: true }).argv, [
		"arena",
		"vote",
		matchId,
		"tie",
		"--json",
		"--note",
		"close",
		"--replace",
	]);
	const run = {
		kind: "arena.run",
		request: {
			prompt: "--help me",
			contenders: [
				{ target: "mini", model: "qwen3.8-27b-iq4r-v4" },
				{ target: "copilot", model: "claude-haiku-5.5" },
			],
			timeoutSeconds: 120,
			check: "unit",
		},
	} as const;
	assert.deepEqual(commandPlan(run).argv, [
		"arena",
		"run",
		"--json",
		"--timeout",
		"120",
		"--contender",
		"mini/qwen3.8-27b-iq4r-v4",
		"--contender",
		"copilot/claude-haiku-5.5",
		"--check",
		"unit",
		"--",
		"--help me",
	]);
	for (const input of [
		{ kind: "arena.show", matchId: "../x" },
		{ kind: "arena.vote", matchId, choice: "E", replace: false },
		{ kind: "arena.vote", matchId, choice: "A", replace: false, note: "a\nb" },
		{ kind: "arena.list", extra: "--cwd" },
		{ ...run, request: { ...run.request, contenders: run.request.contenders.slice(0, 1) } },
		{ ...run, request: { ...run.request, contenders: [{ target: "--cwd", model: "x" }, run.request.contenders[1]] } },
		{ ...run, request: { ...run.request, timeoutSeconds: 5 } },
		{ ...run, request: { ...run.request, readOnly: true } },
	])
		assert.throws(() => commandPlan(input), AppProblem);
});
