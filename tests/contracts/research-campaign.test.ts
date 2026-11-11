import { deepStrictEqual, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { installResearchStopSignals, runResearchCommand } from "../../src/cli/research.js";
import { readSettings, settingsPath } from "../../src/core/config.js";
import {
	appendHypotheses,
	claimsProjectRoot,
	HYPOTHESIS_SLATE_SCHEMA,
	hypothesesFromSlate,
	readClaims,
} from "../../src/domains/claims/index.js";
import { cleanWorktree, environmentEntries } from "../../src/domains/research/git.js";
import {
	type AgentRunner,
	type AgentRunResult,
	aaIsNoisy,
	aaLabel,
	agentRunArgv,
	budgetStop,
	campaignStatusLines,
	costFromPricing,
	createSpawnAgentRunner,
	describeGrade,
	grade,
	inScope,
	type ObjectiveValue,
	openResearchCampaign,
	parseAgentRunFrames,
	parseJournal,
	type ResearchCampaign,
	ResearchResumeError,
	readJournal,
	recomputeCampaign,
	researchElapsedMs,
	resumeResearchCampaign,
	runResearchCampaign,
	summarizeCampaign,
} from "../../src/domains/research/index.js";
import { runObjective } from "../../src/domains/research/measure.js";
import { effectiveYoloConfinement, YOLO_CONFINEMENT_PIN_ENV } from "../../src/domains/safety/autonomy.js";
import type { DeclaredCheck } from "../../src/tools/verify/catalog.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args],
		{ encoding: "utf8" },
	).trim();
}

/** A repository one level below the scratch root, so the root never holds a `.git`. */
function scratchRepo(files: Record<string, string>): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-research-")));
	roots.push(root);
	const repo = join(root, "repo");
	mkdirSync(repo);
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(repo, path, ".."), { recursive: true });
		writeFileSync(join(repo, path), text);
	}
	git(repo, "init", "-q", "-b", "main");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "base");
	return repo;
}

const base = { direction: "min" as const, minImprovement: 0.05, seed: 7, resamples: 2000 };

describe("research scope", () => {
	it("lets scope wildcards cross dot segments while literal names stay exact", () => {
		ok(inScope(".github/workflows/ci.yml", ["**"]));
		ok(inScope(".github/workflows/ci.yml", ["**/*.yml"]));
		ok(inScope("src/.cache/a.ts", ["src/**/*.ts"]));
		ok(inScope(".env", ["*"]));
		ok(inScope(".github/workflows/ci.yml", [".github/**"]));
		ok(inScope("src/a.ts", []));
		ok(!inScope(".github/workflows/ci.yml", ["src/**"]));
		ok(!inScope(".github/x.yml", [".gitlab/**"]));
		ok(!inScope("src/a.ts", ["src/*.js"]));
		ok(inScope(".github/.cache/ci.yml", ["{.github,src}/**/*.yml"]));
		ok(inScope(".github/.cache/ci.yml", ["[.]github/**/*.yml"]));
		ok(!inScope(".env", ["[!.]*"]));
		ok(inScope("env", ["[!.]*"]));
		ok(!inScope(".github/ci.yml", ["!(.github)/**"]));
		ok(!inScope("src/../x", ["src/**"]));
		ok(inScope("src-other/a.ts", ["!(src)/**"]));
		ok(!inScope("src/unrelated.ts", ["!important.ts"]));
		ok(inScope("!notes.txt", ["[[!]*"]));
		ok(!inScope("^notes.txt", ["[[!]*"]));
		ok(inScope("src/a.ts", ["src\\*.ts"]));
		ok(!inScope("foo*", ["foo\\*"]));
	});
});

describe("research grading", () => {
	it("calls a clear drop improved, the same samples unchanged, and repeats itself under one seed", () => {
		const before = [100, 101, 99, 100, 102];
		const after = [50, 51, 49, 50, 52];
		const improved = grade({ ...base, base: before, candidate: after });
		strictEqual(improved.verdict, "improved");
		ok(improved.ci !== null && improved.ci.high < 0);
		deepStrictEqual(grade({ ...base, base: before, candidate: after }), improved);
		const same = grade({ ...base, base: before, candidate: before });
		strictEqual(same.verdict, "unchanged");
		strictEqual(aaIsNoisy(same), false);
		strictEqual(grade({ ...base, direction: "max", base: before, candidate: after }).verdict, "regressed");
	});

	it("does not call a delta past the threshold improved when the interval straddles zero", () => {
		const verdict = grade({ ...base, base: [100, 100, 100, 100], candidate: [10, 200, 10, 200] }).verdict;
		ok(verdict === "inconclusive" || verdict === "regressed", verdict);
	});

	it("reads an A/A check whose delta passes the threshold with an interval spanning zero as inconclusive, not quiet", () => {
		const underpowered = grade({ ...base, base: [100, 90, 110, 95, 105], candidate: [100, 250, 90, 160, 141] });
		strictEqual(underpowered.verdict, "inconclusive");
		ok(underpowered.ci !== null && underpowered.ci.low < 0 && underpowered.ci.high > 0);
		strictEqual(aaIsNoisy(underpowered), false);
		ok(aaLabel(underpowered).startsWith("inconclusive (too few trials"), aaLabel(underpowered));
		const before = [100, 101, 99, 100, 102];
		strictEqual(aaLabel(grade({ ...base, base: before, candidate: before })), "quiet");
		strictEqual(aaLabel(grade({ ...base, base: before, candidate: [50, 51, 49, 50, 52] })), "noisy");
	});

	it("labels a sure move inside the threshold below threshold or a small regression, and still unchanged", () => {
		const before = [100, 100.2, 99.8, 100.1, 99.9];
		const lower = grade({ ...base, base: before, candidate: [96, 96.2, 95.8, 96.1, 95.9] });
		strictEqual(lower.verdict, "unchanged");
		ok(lower.ci !== null && lower.ci.high < 0);
		ok(
			describeGrade(lower, base).startsWith("below threshold (-4.00% vs required -5.00%), "),
			describeGrade(lower, base),
		);
		const higher = grade({ ...base, base: before, candidate: [103, 103.2, 102.8, 103.1, 102.9] });
		strictEqual(higher.verdict, "unchanged");
		ok(
			describeGrade(higher, base).startsWith("small regression (+3.00%, inside the ±5.00% threshold), "),
			describeGrade(higher, base),
		);
		strictEqual(describeGrade(grade({ ...base, base: before, candidate: before }), base).split(",")[0], "unchanged");
	});
});

describe("research budget", () => {
	it("never counts unknown spend as zero against a cost cap", () => {
		const unknown = costFromPricing([]);
		strictEqual(unknown.kind, "unknown");
		const capped = { maxIterations: 9, maxCostUsd: 1, allowUnpriced: false };
		strictEqual(budgetStop(capped, { iterations: 1, elapsedMs: 0, costs: [unknown] })?.reason, "budget-unenforceable");
		strictEqual(budgetStop({ ...capped, allowUnpriced: true }, { iterations: 1, elapsedMs: 0, costs: [unknown] }), null);
		strictEqual(
			budgetStop({ maxIterations: 9, allowUnpriced: false }, { iterations: 1, elapsedMs: 0, costs: [unknown] }),
			null,
		);
		strictEqual(
			budgetStop(capped, { iterations: 1, elapsedMs: 0, costs: [{ kind: "measured", usd: 1.5 }] })?.reason,
			"max-cost-usd",
		);
		strictEqual(budgetStop(capped, { iterations: 9, elapsedMs: 0, costs: [] })?.reason, "max-iterations");
	});
});

describe("research journal", () => {
	it("keeps every whole event and counts a torn last line as unreadable", () => {
		const read = parseJournal(
			`${JSON.stringify({ type: "stopped", at: "x", reason: "max-iterations", detail: "d", best: "b" })}\n{"type":"agent-fin`,
		);
		strictEqual(read.events.length, 1);
		strictEqual(read.unreadable, 1);
	});
});

describe("research campaign", () => {
	it("ratchets a measured improvement, archives protected and no-op changes, and regrades to the same verdicts", async (t) => {
		const env = await isolateClioEnv("clio-coder-research-home-");
		t.after(() => env.restore());
		const repo = scratchRepo({
			"value.txt": "100\n",
			"score.js": "process.stdout.write(JSON.stringify({score:Number(require('fs').readFileSync('value.txt','utf8'))}))\n",
			"sane.js": "process.stdout.write(JSON.stringify({ok:1}))\n",
			"ref.json": '{"ok":1}\n',
			".clio-coder/verifiers.yaml": JSON.stringify({
				version: 2,
				checks: [
					{
						id: "score",
						description: "Score to minimize",
						kind: "command",
						command: ["node", "score.js"],
						cwd: ".",
						timeoutMs: 30_000,
						tags: [],
					},
					{
						id: "sane",
						description: "Sanity gate",
						kind: "numeric-compare",
						command: ["node", "sane.js"],
						reference: "ref.json",
						tolerance: { absolute: 0 },
						cwd: ".",
						timeoutMs: 30_000,
						tags: [],
					},
				],
			}),
		});
		const userHead = git(repo, "rev-parse", "HEAD");
		const campaign = openResearchCampaign({
			cwd: repo,
			objective: { check: "score", metric: "score", direction: "min", minImprovement: 0.05, trials: 3 },
			gates: ["sane"],
			scope: [],
			budget: { maxIterations: 3, allowUnpriced: false },
			allowNoisy: false,
			keep: false,
			agent: {},
		});
		ok(campaign.protected.includes("score.js"));
		ok(!campaign.protected.includes("value.txt"));
		const edits: Array<(worktree: string) => void> = [
			(worktree) => writeFileSync(join(worktree, "value.txt"), "50\n"),
			(worktree) => writeFileSync(join(worktree, "score.js"), "process.stdout.write('{\"score\":0}')\n"),
			() => {},
		];
		let calls = 0;
		const agent: AgentRunner = async (request) => {
			edits[calls++]?.(request.worktree);
			return {
				exitCode: 0,
				sessionId: null,
				outcome: "completed",
				summary: "Hypothesis: a smaller value lowers the score\nPrediction: score halves",
				cost: { kind: "free" },
			};
		};
		const outcome = await runResearchCampaign(campaign, { agent });
		strictEqual(outcome.reason, "max-iterations");
		strictEqual(calls, 3);

		const view = summarizeCampaign(campaign.project, campaign.id);
		strictEqual(view.aa?.noisy, false);
		deepStrictEqual(
			view.iterations.map((iteration) => iteration.outcome),
			["ratcheted", "protected", "no-op"],
		);
		strictEqual(view.iterations[0]?.grade?.verdict, "improved");
		strictEqual(view.ratchets, 1);
		const best = git(repo, "rev-parse", campaign.ref);
		strictEqual(best, view.best);
		strictEqual(git(repo, "show", `${best}:value.txt`), "50");
		strictEqual(git(repo, "rev-parse", "HEAD"), userHead);
		strictEqual(readFileSync(join(repo, "value.txt"), "utf8"), "100\n");
		strictEqual(
			git(repo, "worktree", "list", "--porcelain")
				.split("\n")
				.filter((line) => line.startsWith("worktree ")).length,
			1,
		);

		const report = recomputeCampaign(campaign.project, campaign.id);
		strictEqual(report.agrees, true);
		strictEqual(report.grades.length, 2);

		const claims = readClaims(claimsProjectRoot(repo));
		ok(claims.records.some((claim) => claim.keys.check === "sane"));
		strictEqual(claims.hypotheses.length, 1);
		strictEqual(claims.hypothesisTests.length, 1);
		strictEqual(claims.hypothesisTests[0]?.outcome, "tested");
		strictEqual(view.iterations[0]?.hypothesisVerdict, "supported");

		const out: string[] = [];
		t.mock.method(console, "log", (line: unknown) => out.push(String(line)));
		t.mock.method(console, "error", () => {});
		const cwd = process.cwd();
		process.chdir(repo);
		try {
			strictEqual(await runResearchCommand(["report", campaign.id, "--json"]), 0);
			strictEqual(JSON.parse(out.pop() ?? "{}").agrees, true);
			strictEqual(await runResearchCommand(["list", "--json"]), 0);
			deepStrictEqual(
				JSON.parse(out.pop() ?? "{}").campaigns.map((entry: { id: string }) => entry.id),
				[campaign.id],
			);
			strictEqual(await runResearchCommand(["start", "--metric", "score"]), 2);
			strictEqual(
				await runResearchCommand([
					"start",
					"--check",
					"score",
					"--metric",
					"score",
					"--direction",
					"min",
					"--max-iterations",
					"1",
					"--autonomy",
					"bogus",
				]),
				2,
			);
			strictEqual(await runResearchCommand(["report", "not-an-id"]), 2);
		} finally {
			process.chdir(cwd);
		}
	});
});

const done: AgentRunResult = {
	exitCode: 0,
	sessionId: null,
	outcome: "completed",
	summary: "Hypothesis: a smaller value lowers the score",
	cost: { kind: "free" },
};

function worktreeCount(repo: string): number {
	return git(repo, "worktree", "list", "--porcelain")
		.split("\n")
		.filter((line) => line.startsWith("worktree ")).length;
}

function commandCheck(id: string, command: string[]): Record<string, unknown> {
	return { id, description: id, kind: "command", command, cwd: ".", timeoutMs: 30_000, tags: [] };
}

const scoreJs =
	"process.stdout.write(JSON.stringify({score:Number(require('fs').readFileSync('value.txt','utf8'))}))\n";

function openScore(repo: string, budget: ResearchCampaign["budget"], gates: string[] = []): ResearchCampaign {
	return openResearchCampaign({
		cwd: repo,
		objective: { check: "score", metric: "score", direction: "min", minImprovement: 0.05, trials: 3 },
		gates,
		scope: [],
		budget,
		allowNoisy: false,
		keep: false,
		agent: {},
	});
}

describe("research yolo", () => {
	it("pins each yolo agent run to contained, so settings turned unconfined mid-campaign cannot reach it", async (t) => {
		const env = await isolateClioEnv("clio-coder-research-pin-");
		t.after(() => env.restore());
		writeFileSync(settingsPath(), "safety:\n  yoloConfinement: unconfined\n  yoloUnconfinedAccepted: true\n");
		strictEqual(effectiveYoloConfinement(readSettings().safety), "unconfined");
		const dir = mkdtempSync(join(tmpdir(), "clio-coder-research-pin-"));
		const entry = join(dir, "fake-run.cjs");
		writeFileSync(
			entry,
			`process.stdout.write(JSON.stringify({ type: "turn_end", exitCode: 0, text: process.env.${YOLO_CONFINEMENT_PIN_ENV} ?? "unpinned" }) + "\\n");\n`,
		);
		const runner = createSpawnAgentRunner(entry, []);
		strictEqual((await runner({ worktree: dir, prompt: "p", autonomy: "yolo" })).summary, "contained");
		strictEqual((await runner({ worktree: dir, prompt: "p", autonomy: "default" })).summary, "unpinned");
		const saved = process.env[YOLO_CONFINEMENT_PIN_ENV];
		process.env[YOLO_CONFINEMENT_PIN_ENV] = "contained";
		try {
			strictEqual(effectiveYoloConfinement(readSettings().safety), "contained", "the pinned run ignores settings");
		} finally {
			if (saved === undefined) delete process.env[YOLO_CONFINEMENT_PIN_ENV];
			else process.env[YOLO_CONFINEMENT_PIN_ENV] = saved;
		}
	});

	it("runs the agent at contained yolo, records its open decisions, and refuses unconfined yolo", async (t) => {
		const env = await isolateClioEnv("clio-coder-research-home-");
		t.after(() => env.restore());
		const repo = scratchRepo({
			"value.txt": "100\n",
			"score.js": scoreJs,
			".clio-coder/verifiers.yaml": JSON.stringify({ version: 2, checks: [commandCheck("score", ["node", "score.js"])] }),
		});
		const campaign = openResearchCampaign({
			cwd: repo,
			objective: { check: "score", metric: "score", direction: "min", minImprovement: 0.05, trials: 3 },
			gates: [],
			scope: [],
			budget: { maxIterations: 1, allowUnpriced: false },
			allowNoisy: false,
			keep: false,
			agent: { autonomy: "yolo" },
		});
		strictEqual(campaign.agent.autonomy, "yolo");
		const argv = agentRunArgv({ worktree: "/w", prompt: "p", autonomy: "yolo" });
		strictEqual(argv[argv.indexOf("--autonomy") + 1], "yolo");
		// The terminal frame a contained yolo `run --json --json-events terminal` writes.
		const stream = [
			JSON.stringify({ type: "session", id: "s1" }),
			JSON.stringify({
				type: "turn_end",
				exitCode: 0,
				outcome: "completed",
				text: "Hypothesis: a smaller value lowers the score",
				autonomy: {
					confinement: "contained",
					usage: { toolCalls: 4, activeMs: 10, tokens: 100 },
					halted: null,
					openDecisions: [{ seq: 3, tool: "bash", command: "git push origin main", kind: "ask", rule: "git-push" }],
					openDecisionsOmitted: 0,
				},
			}),
		].join("\n");
		const runs: string[] = [];
		const outcome = await runResearchCampaign(campaign, {
			agent: async (request) => {
				runs.push(request.autonomy);
				writeFileSync(join(request.worktree, "value.txt"), "50\n");
				return parseAgentRunFrames(stream, 0, "");
			},
		});
		strictEqual(outcome.reason, "max-iterations");
		deepStrictEqual(runs, ["yolo"]);
		const view = summarizeCampaign(campaign.project, campaign.id);
		strictEqual(view.iterations[0]?.outcome, "ratcheted");
		deepStrictEqual(view.iterations[0]?.autonomy?.openDecisions, [
			{ tool: "bash", kind: "ask", rule: "git-push", command: "git push origin main" },
		]);
		const lines = campaignStatusLines(view).join("\n");
		ok(lines.includes("agent: autonomy yolo (contained"), lines);
		ok(lines.includes("git push origin main"), lines);

		writeFileSync(settingsPath(), "safety:\n  yoloConfinement: unconfined\n  yoloUnconfinedAccepted: true\n");
		const errors: string[] = [];
		t.mock.method(process.stderr, "write", (chunk: unknown) => {
			errors.push(String(chunk));
			return true;
		});
		const cwd = process.cwd();
		process.chdir(repo);
		try {
			const args = [
				"start",
				"--check",
				"score",
				"--metric",
				"score",
				"--direction",
				"min",
				"--max-iterations",
				"1",
				"--autonomy",
				"yolo",
			];
			strictEqual(await runResearchCommand(args), 2);
		} finally {
			process.chdir(cwd);
		}
		ok(errors.join("\n").includes("contained only"), errors.join("\n"));
	});
});

describe("research review fixes", () => {
	it("stops at the wall deadline inside the agent run and while measuring, and never ratchets after it", async (t) => {
		const env = await isolateClioEnv("clio-coder-research-home-");
		t.after(() => env.restore());
		const repo = scratchRepo({
			"value.txt": "100\n",
			"score.js": scoreJs,
			".clio-coder/verifiers.yaml": JSON.stringify({ version: 2, checks: [commandCheck("score", ["node", "score.js"])] }),
		});
		const measure =
			(calls: { n: number }, jumpAt: number, time: { ms: number }) =>
			async (_check: unknown, _metric: string, worktree: string): Promise<ObjectiveValue> => {
				calls.n += 1;
				if (calls.n === jumpAt) time.ms = 61_000;
				return { ok: true, value: worktree.endsWith("-base") ? 100 : 50 };
			};
		for (const phase of ["agent", "measure"] as const) {
			const campaign = openScore(repo, { maxIterations: 3, maxWallMinutes: 1, allowUnpriced: false });
			const time = { ms: 0 };
			const calls = { n: 0 };
			const outcome = await runResearchCampaign(campaign, {
				agent: async (request) => {
					writeFileSync(join(request.worktree, "value.txt"), "50\n");
					if (phase === "agent") time.ms = 61_000;
					return done;
				},
				// Six A/A runs, then the deadline passes on the second candidate pair.
				measure: measure(calls, phase === "measure" ? 9 : -1, time),
				clock: () => time.ms,
			});
			strictEqual(outcome.reason, "max-wall-minutes", phase);
			strictEqual(calls.n, phase === "agent" ? 6 : 9, phase);
			const view = summarizeCampaign(campaign.project, campaign.id);
			deepStrictEqual(
				view.iterations.map((iteration) => iteration.outcome),
				["deadline"],
				phase,
			);
			strictEqual(view.ratchets, 0, phase);
			strictEqual(git(repo, "rev-parse", campaign.ref), campaign.base, phase);
			strictEqual(worktreeCount(repo), 1, phase);
		}
	});

	it("protects a repo-local executable, the target of a named symlink, and symlinks that reach either", async (t) => {
		const env = await isolateClioEnv("clio-coder-research-home-");
		t.after(() => env.restore());
		const repo = scratchRepo({
			"value.txt": "100\n",
			"tools/impl.js": `#!/usr/bin/env node\n${scoreJs}`,
			".clio-coder/verifiers.yaml": JSON.stringify({ version: 2, checks: [commandCheck("score", ["./score.js"])] }),
		});
		chmodSync(join(repo, "tools/impl.js"), 0o755);
		symlinkSync("tools/impl.js", join(repo, "score.js"));
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "bench");
		const campaign = openScore(repo, { maxIterations: 4, allowUnpriced: false });
		ok(campaign.protected.includes("score.js"), campaign.protected.join(","));
		ok(campaign.protected.includes("tools/impl.js"), campaign.protected.join(","));
		const edits: Array<(worktree: string) => void> = [
			(worktree) => writeFileSync(join(worktree, "tools/impl.js"), "process.stdout.write('{\"score\":0}')\n"),
			(worktree) => symlinkSync("tools/impl.js", join(worktree, "alias.js")),
			(worktree) => symlinkSync("tools", join(worktree, "toolbox")),
			(worktree) => symlinkSync("../../outside.js", join(worktree, "escape.js")),
		];
		let calls = 0;
		const outcome = await runResearchCampaign(campaign, {
			agent: async (request) => {
				edits[calls++]?.(request.worktree);
				return done;
			},
		});
		strictEqual(outcome.reason, "max-iterations");
		deepStrictEqual(
			summarizeCampaign(campaign.project, campaign.id).iterations.map((iteration) => iteration.outcome),
			["protected", "protected", "protected", "protected"],
		);
	});

	it("keeps a judged objective as a gate and judges the hypothesis by the grade, not reference agreement", async (t) => {
		const env = await isolateClioEnv("clio-coder-research-home-");
		t.after(() => env.restore());
		const repo = scratchRepo({
			"value.txt": "100\n",
			"score.js": scoreJs,
			"ref.json": '{"score":100}\n',
			".clio-coder/verifiers.yaml": JSON.stringify({
				version: 2,
				checks: [
					{
						...commandCheck("score", ["node", "score.js"]),
						kind: "numeric-compare",
						reference: "ref.json",
						tolerance: { absolute: 5 },
					},
				],
			}),
		});
		const campaign = openScore(repo, { maxIterations: 2, allowUnpriced: false }, ["score"]);
		deepStrictEqual(campaign.gates, ["score"]);
		strictEqual(campaign.checks.length, 1);
		// Iteration 1 improves the metric but leaves the reference; iteration 2 matches it without improving.
		const values = ["50\n", "99\n"];
		let calls = 0;
		const outcome = await runResearchCampaign(campaign, {
			agent: async (request) => {
				writeFileSync(join(request.worktree, "value.txt"), values[calls++] ?? "100\n");
				return done;
			},
		});
		strictEqual(outcome.reason, "max-iterations");
		const view = summarizeCampaign(campaign.project, campaign.id);
		deepStrictEqual(
			view.iterations.map((iteration) => iteration.outcome),
			["gate-failed", "not-improved"],
		);
		strictEqual(view.iterations[0]?.grade?.verdict, "improved");
		strictEqual(view.iterations[0]?.gates[0]?.check, "score");
		strictEqual(view.iterations[0]?.gates[0]?.passed, false);
		strictEqual(git(repo, "rev-parse", campaign.ref), campaign.base);
		const claims = readClaims(claimsProjectRoot(repo));
		const agreeing = claims.records.find((claim) => claim.verdict === "agrees");
		ok(agreeing !== undefined, "iteration 2's reference comparison agrees");
		// Every bound hypothesis is only marked tested; the agreeing claim supports none of them.
		ok(claims.hypothesisTests.length >= 2);
		ok(claims.hypothesisTests.every((test) => test.outcome === "tested"));
		deepStrictEqual(
			view.iterations.map((iteration) => iteration.hypothesisVerdict),
			["supported", "inconclusive"],
		);
	});

	it("stops on SIGTERM and SIGHUP like Ctrl-C: the child run ends, the stop is journaled, the worktrees go", async (t) => {
		const env = await isolateClioEnv("clio-coder-research-home-");
		t.after(() => env.restore());
		for (const [name, code] of [
			["SIGTERM", 143],
			["SIGHUP", 129],
			["SIGINT", 130],
		] as const) {
			const before = process.listenerCount(name);
			const controller = new AbortController();
			const stops = installResearchStopSignals(controller, () => {});
			strictEqual(process.listenerCount(name), before + 1);
			process.emit(name, name);
			ok(controller.signal.aborted, name);
			strictEqual(stops.received(), name);
			strictEqual(stops.exitCode(), code);
			stops.dispose();
			strictEqual(process.listenerCount(name), before);
		}

		const repo = scratchRepo({
			"value.txt": "100\n",
			"score.js": scoreJs,
			".clio-coder/verifiers.yaml": JSON.stringify({ version: 2, checks: [commandCheck("score", ["node", "score.js"])] }),
		});
		const campaign = openScore(repo, { maxIterations: 3, allowUnpriced: false });
		const controller = new AbortController();
		const stops = installResearchStopSignals(controller, () => {});
		t.after(() => stops.dispose());
		let childEnded = false;
		const outcome = await runResearchCampaign(campaign, {
			signal: controller.signal,
			agent: (request) =>
				new Promise((resolve) => {
					request.signal?.addEventListener("abort", () => {
						childEnded = true;
						resolve({ ...done, exitCode: 130, outcome: "interrupted" });
					});
					process.emit("SIGTERM", "SIGTERM");
				}),
		});
		strictEqual(outcome.reason, "stopped");
		ok(childEnded);
		strictEqual(stops.exitCode(), 143);
		const view = summarizeCampaign(campaign.project, campaign.id);
		strictEqual(view.stop?.reason, "stopped");
		deepStrictEqual(
			view.iterations.map((iteration) => iteration.outcome),
			["interrupted"],
		);
		strictEqual(worktreeCount(repo), 1);
	});

	it("protects symlinked parent directories and judges deletions, renames and replacements by their base path", async (t) => {
		const env = await isolateClioEnv("clio-coder-research-home-");
		t.after(() => env.restore());
		const repo = scratchRepo({
			"value.txt": "100\n",
			"tools/run.js": scoreJs,
			".clio-coder/verifiers.yaml": JSON.stringify({
				version: 2,
				checks: [commandCheck("score", ["node", "bench/run.js"])],
			}),
		});
		symlinkSync("tools", join(repo, "bench"));
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "bench link");
		const campaign = openScore(repo, { maxIterations: 4, allowUnpriced: false });
		for (const path of ["bench", "bench/run.js", "tools/run.js"])
			ok(campaign.protected.includes(path), `${path} in ${campaign.protected.join(",")}`);
		const fake = "process.stdout.write('{\"score\":0}')\n";
		const edits: Array<(worktree: string) => void> = [
			// Retarget the link at a fake bench.
			(worktree) => {
				rmSync(join(worktree, "bench"));
				symlinkSync("fake", join(worktree, "bench"));
				mkdirSync(join(worktree, "fake"));
				writeFileSync(join(worktree, "fake/run.js"), fake);
			},
			// Replace the link with a real directory.
			(worktree) => {
				rmSync(join(worktree, "bench"));
				mkdirSync(join(worktree, "bench"));
				writeFileSync(join(worktree, "bench/run.js"), fake);
			},
			// Rename the protected target away.
			(worktree) => renameSync(join(worktree, "tools/run.js"), join(worktree, "tools/old.js")),
			// Replace the target's parent directory with a link.
			(worktree) => {
				rmSync(join(worktree, "tools"), { recursive: true });
				mkdirSync(join(worktree, "fake"));
				writeFileSync(join(worktree, "fake/run.js"), fake);
				symlinkSync("fake", join(worktree, "tools"));
			},
		];
		let calls = 0;
		await runResearchCampaign(campaign, {
			agent: async (request) => {
				edits[calls++]?.(request.worktree);
				return done;
			},
		});
		deepStrictEqual(
			summarizeCampaign(campaign.project, campaign.id).iterations.map((iteration) => iteration.outcome),
			["protected", "protected", "protected", "protected"],
		);
	});

	it("keeps claim evidence for project hypotheses bound to a gate, and only the research hypothesis goes without", async (t) => {
		const env = await isolateClioEnv("clio-coder-research-home-");
		t.after(() => env.restore());
		const repo = scratchRepo({
			"value.txt": "100\n",
			"score.js": scoreJs,
			"sane.js": "process.stdout.write(JSON.stringify({v:Number(require('fs').readFileSync('value.txt','utf8'))}))\n",
			"ref.json": '{"v":100}\n',
			".clio-coder/verifiers.yaml": JSON.stringify({
				version: 2,
				checks: [
					commandCheck("score", ["node", "score.js"]),
					{
						...commandCheck("sane", ["node", "sane.js"]),
						kind: "numeric-compare",
						reference: "ref.json",
						tolerance: { absolute: 0 },
					},
				],
			}),
		});
		const project = claimsProjectRoot(repo);
		const slateText = `${JSON.stringify({
			schema: HYPOTHESIS_SLATE_SCHEMA,
			hypotheses: [
				{
					id: "H1",
					statement: "value.txt stays at its reference",
					prediction: "sane agrees",
					status: "proposed",
					experiment: { successCriterion: { kind: "verify", verifyId: "sane", statement: "sane agrees" } },
				},
			],
		})}\n`;
		const slate = join(repo, "hypotheses.json");
		writeFileSync(slate, slateText);
		const drafts =
			hypothesesFromSlate({
				text: slateText,
				slateSha256: "0".repeat(64),
				path: slate,
				project,
				at: new Date().toISOString(),
				source: { channel: "slate", sessionId: null, toolCallId: null },
			}) ?? [];
		const [project1] = (await appendHypotheses(project, drafts)) ?? [];
		ok(project1 !== undefined);
		const campaign = openScore(repo, { maxIterations: 1, allowUnpriced: false }, ["sane"]);
		await runResearchCampaign(campaign, {
			agent: async (request) => {
				writeFileSync(join(request.worktree, "value.txt"), "50\n");
				return done;
			},
		});
		const view = summarizeCampaign(campaign.project, campaign.id);
		deepStrictEqual(
			view.iterations.map((iteration) => iteration.outcome),
			["gate-failed"],
		);
		const claims = readClaims(project);
		const disagreeing = claims.records.find((claim) => claim.keys.check === "sane" && claim.verdict === "disagrees");
		ok(disagreeing !== undefined);
		const projectTest = claims.hypothesisTests.find((test) => test.hypothesis === project1.id);
		strictEqual(projectTest?.outcome, "refuted");
		strictEqual(projectTest?.claim, disagreeing.id);
		const researchTests = claims.hypothesisTests.filter((test) => test.hypothesis !== project1.id);
		ok(researchTests.length > 0);
		ok(researchTests.every((test) => test.outcome === "tested" && test.claim === undefined));
		strictEqual(view.iterations[0]?.hypothesisVerdict, "supported");
		strictEqual(claims.unlinked, 0);
	});

	it("protects every link in a chained symlink resolution", async (t) => {
		const env = await isolateClioEnv("clio-coder-research-home-");
		t.after(() => env.restore());
		const repo = scratchRepo({
			"value.txt": "100\n",
			"tools/run.js": scoreJs,
			".clio-coder/verifiers.yaml": JSON.stringify({
				version: 2,
				checks: [commandCheck("score", ["node", "bench/run.js"])],
			}),
		});
		mkdirSync(join(repo, "aliases"));
		symlinkSync("../tools", join(repo, "aliases/next"));
		symlinkSync("aliases/next", join(repo, "bench"));
		git(repo, "add", "-A");
		git(repo, "commit", "-q", "-m", "chained links");
		const campaign = openScore(repo, { maxIterations: 1, allowUnpriced: false });
		for (const path of ["bench", "aliases/next", "bench/run.js", "tools/run.js"])
			ok(campaign.protected.includes(path), `${path} in ${campaign.protected.join(",")}`);
		await runResearchCampaign(campaign, {
			agent: async (request) => {
				rmSync(join(request.worktree, "aliases/next"));
				symlinkSync("../fake", join(request.worktree, "aliases/next"));
				mkdirSync(join(request.worktree, "fake"));
				writeFileSync(join(request.worktree, "fake/run.js"), "process.stdout.write('{\"score\":0}')\n");
				return done;
			},
		});
		deepStrictEqual(
			summarizeCampaign(campaign.project, campaign.id).iterations.map((iteration) => iteration.outcome),
			["protected"],
		);
	});

	// R1: an agent that ran the checks itself left their cache (Python's __pycache__) beside its edit, the
	// iteration commit took it, and the scope test archived a good change as out of scope.
	it("leaves files the checks create out of the commit and scope test, and still archives an agent's out-of-scope file", async (t) => {
		const env = await isolateClioEnv("clio-coder-research-home-");
		t.after(() => env.restore());
		const cachingScore = `require('fs').mkdirSync('.cache',{recursive:true});require('fs').writeFileSync('.cache/score.bin',String(Date.now()));${scoreJs}`;
		const repo = scratchRepo({
			"value.txt": "100\n",
			"score.js": cachingScore,
			".clio-coder/verifiers.yaml": JSON.stringify({ version: 2, checks: [commandCheck("score", ["node", "score.js"])] }),
		});
		const campaign = openResearchCampaign({
			cwd: repo,
			objective: { check: "score", metric: "score", direction: "min", minImprovement: 0.05, trials: 3 },
			gates: [],
			scope: ["value.txt"],
			budget: { maxIterations: 2, allowUnpriced: false },
			allowNoisy: false,
			keep: false,
			agent: {},
		});
		const edits: Array<(worktree: string) => void> = [
			(worktree) => {
				writeFileSync(join(worktree, "value.txt"), "50\n");
				execFileSync(process.execPath, ["score.js"], { cwd: worktree, stdio: "ignore" });
			},
			(worktree) => {
				writeFileSync(join(worktree, "value.txt"), "20\n");
				writeFileSync(join(worktree, "notes.txt"), "out of scope\n");
			},
		];
		let calls = 0;
		await runResearchCampaign(campaign, {
			agent: async (request) => {
				edits[calls++]?.(request.worktree);
				return done;
			},
		});
		const view = summarizeCampaign(campaign.project, campaign.id);
		deepStrictEqual(
			view.iterations.map((iteration) => iteration.outcome),
			["ratcheted", "out-of-scope"],
		);
		deepStrictEqual(view.iterations[0]?.changed, ["value.txt"]);
		strictEqual(git(repo, "ls-tree", "-r", "--name-only", campaign.ref).includes(".cache"), false);
		ok(view.iterations[1]?.detail?.includes("notes.txt"), view.iterations[1]?.detail);
	});

	// A learned check-output directory left planted files out of the commit, yet they stayed for measurement.
	it("measures only the committed tree, so a file planted in a check's output or an ignored directory earns nothing", async (t) => {
		const env = await isolateClioEnv("clio-coder-research-home-");
		t.after(() => env.restore());
		const plantableScore =
			"const fs=require('fs');fs.mkdirSync('.cache',{recursive:true});fs.writeFileSync('.cache/score.bin','x');" +
			"for(const f of ['.cache/override.json','build/override.json'])if(fs.existsSync(f)){process.stdout.write(fs.readFileSync(f,'utf8'));process.exit(0)}" +
			scoreJs;
		const repo = scratchRepo({
			"value.txt": "100\n",
			"score.js": plantableScore,
			".gitignore": "build/\n",
			".clio-coder/verifiers.yaml": JSON.stringify({ version: 2, checks: [commandCheck("score", ["node", "score.js"])] }),
		});
		const campaign = openResearchCampaign({
			cwd: repo,
			objective: { check: "score", metric: "score", direction: "min", minImprovement: 0.05, trials: 3 },
			gates: [],
			scope: ["value.txt"],
			budget: { maxIterations: 2, allowUnpriced: false },
			allowNoisy: false,
			keep: false,
			agent: {},
		});
		const plant = (worktree: string, dir: string): void => {
			mkdirSync(join(worktree, dir), { recursive: true });
			writeFileSync(join(worktree, dir, "override.json"), JSON.stringify({ score: 1 }));
		};
		const edits: Array<(worktree: string) => void> = [
			(worktree) => {
				writeFileSync(join(worktree, "value.txt"), "99\n");
				plant(worktree, ".cache");
			},
			(worktree) => {
				writeFileSync(join(worktree, "value.txt"), "98\n");
				plant(worktree, "build");
			},
		];
		let calls = 0;
		await runResearchCampaign(campaign, {
			agent: async (request) => {
				edits[calls++]?.(request.worktree);
				return done;
			},
		});
		const view = summarizeCampaign(campaign.project, campaign.id);
		deepStrictEqual(
			view.iterations.map((iteration) => iteration.outcome),
			["not-improved", "not-improved"],
		);
		strictEqual(git(repo, "rev-parse", campaign.ref), campaign.base);
	});

	it("ratchets a candidate whose gate needs the project's installed, ignored node_modules", async (t) => {
		const env = await isolateClioEnv("clio-coder-research-home-");
		t.after(() => env.restore());
		const repo = scratchRepo({
			"value.txt": "100\n",
			"score.js": scoreJs,
			".gitignore": "node_modules/\n",
			".clio-coder/verifiers.yaml": JSON.stringify({
				version: 2,
				checks: [commandCheck("score", ["node", "score.js"]), commandCheck("dep", ["node", "-e", "require('dep')"])],
			}),
		});
		mkdirSync(join(repo, "node_modules/dep"), { recursive: true });
		writeFileSync(join(repo, "node_modules/dep/index.js"), "module.exports = 1;\n");
		const campaign = openScore(repo, { maxIterations: 1, allowUnpriced: false }, ["dep"]);
		await runResearchCampaign(campaign, {
			agent: async (request) => {
				writeFileSync(join(request.worktree, "value.txt"), "50\n");
				return done;
			},
		});
		const view = summarizeCampaign(campaign.project, campaign.id);
		deepStrictEqual(
			view.iterations.map((iteration) => iteration.outcome),
			["ratcheted"],
		);
	});

	it("rejects a candidate whose agent changed the pre-agent environment, and ratchets one that left it alone", async (t) => {
		const env = await isolateClioEnv("clio-coder-research-home-");
		t.after(() => env.restore());
		const overridableScore =
			"const fs=require('fs');if(fs.existsSync('build/override.json')){process.stdout.write(fs.readFileSync('build/override.json','utf8'));process.exit(0)}" +
			scoreJs;
		const repo = scratchRepo({
			"value.txt": "100\n",
			"score.js": overridableScore,
			".gitignore": "build/\n",
			".clio-coder/verifiers.yaml": JSON.stringify({
				version: 2,
				checks: [
					commandCheck("score", ["node", "score.js"]),
					commandCheck("dep", ["node", "-e", "require('fs').readFileSync('build/dep.txt')"]),
				],
			}),
		});
		// A setup step: every worktree checkout installs an ignored build/ the gate needs.
		const hook = join(repo, ".git/hooks/post-checkout");
		writeFileSync(hook, "#!/bin/sh\nmkdir -p build && echo dep > build/dep.txt\n");
		chmodSync(hook, 0o755);
		const campaign = openScore(repo, { maxIterations: 3, allowUnpriced: false }, ["dep"]);
		const edits: Array<(worktree: string) => void> = [
			(worktree) => {
				writeFileSync(join(worktree, "value.txt"), "99\n");
				writeFileSync(join(worktree, "build/override.json"), JSON.stringify({ score: 1 }));
			},
			(worktree) => {
				writeFileSync(join(worktree, "value.txt"), "98\n");
				writeFileSync(join(worktree, "build/dep.txt"), "changed\n");
			},
			(worktree) => {
				ok(existsSync(join(worktree, "build/dep.txt")), "the setup step ran before the agent");
				writeFileSync(join(worktree, "value.txt"), "50\n");
			},
		];
		let calls = 0;
		await runResearchCampaign(campaign, {
			agent: async (request) => {
				edits[calls++]?.(request.worktree);
				return done;
			},
		});
		const view = summarizeCampaign(campaign.project, campaign.id);
		deepStrictEqual(
			view.iterations.map((iteration) => iteration.outcome),
			["protected", "protected", "ratcheted"],
		);
		ok(view.iterations[0]?.detail?.includes("changed the pre-agent environment: build/override.json"));
		ok(view.iterations[1]?.detail?.includes("changed the pre-agent environment: build/dep.txt"));
	});

	it("cleans a candidate back to its commit plus the environment it had before the agent ran", () => {
		const repo = scratchRepo({ "value.txt": "1\n", ".gitignore": "node_modules/\nbuild/\n" });
		mkdirSync(join(repo, "node_modules/dep"), { recursive: true });
		writeFileSync(join(repo, "node_modules/dep/index.js"), "1\n");
		mkdirSync(join(repo, "odd[1]*"), { recursive: true });
		writeFileSync(join(repo, "odd[1]*/kept.txt"), "1\n");
		const environment = environmentEntries(repo);
		deepStrictEqual([...environment].sort(), ["node_modules/", "odd[1]*/"]);
		// What the agent leaves: a new ignored install, a planted file, and a file beside the kept environment.
		mkdirSync(join(repo, "build"));
		writeFileSync(join(repo, "build/override.json"), "{}");
		mkdirSync(join(repo, ".cache"));
		writeFileSync(join(repo, ".cache/override.json"), "{}");
		// Unescaped, the kept `odd[1]*/` would be a glob that also keeps this directory.
		mkdirSync(join(repo, "odd1x"));
		writeFileSync(join(repo, "odd1x/planted.txt"), "planted\n");
		cleanWorktree(repo, environment);
		ok(existsSync(join(repo, "node_modules/dep/index.js")));
		ok(existsSync(join(repo, "odd[1]*/kept.txt")));
		for (const gone of ["build", ".cache", "odd1x"]) strictEqual(existsSync(join(repo, gone)), false, gone);
	});

	it("withholds reference-agreement claims from research hypotheses of earlier campaigns on the same check", async (t) => {
		const env = await isolateClioEnv("clio-coder-research-home-");
		t.after(() => env.restore());
		const repo = scratchRepo({
			"value.txt": "100\n",
			"score.js": scoreJs,
			"ref.json": '{"score":100}\n',
			".clio-coder/verifiers.yaml": JSON.stringify({
				version: 2,
				checks: [
					{
						...commandCheck("score", ["node", "score.js"]),
						kind: "numeric-compare",
						reference: "ref.json",
						tolerance: { absolute: 5 },
					},
				],
			}),
		});
		// Each campaign's change matches the reference without improving: the claim agrees, the grade does not.
		const ids: string[] = [];
		for (const value of ["99\n", "98\n"]) {
			const campaign = openScore(repo, { maxIterations: 1, allowUnpriced: false });
			ids.push(campaign.id);
			await runResearchCampaign(campaign, {
				agent: async (request) => {
					writeFileSync(join(request.worktree, "value.txt"), value);
					return done;
				},
			});
		}
		const claims = readClaims(claimsProjectRoot(repo));
		ok(claims.records.filter((claim) => claim.verdict === "agrees").length >= 2);
		const first = claims.hypotheses.find((record) => record.slate.includes(ids[0] as string));
		ok(first !== undefined);
		const firstTests = claims.hypothesisTests.filter((test) => test.hypothesis === first.id);
		ok(firstTests.length >= 2, "the second campaign's run is bound to the first campaign's hypothesis");
		ok(claims.hypothesisTests.every((test) => test.outcome === "tested" && test.claim === undefined));
	});
});

describe("research sweeps", () => {
	const sweepFiles = {
		"value.txt": "100\n",
		"score.js":
			"const fs=require('fs');process.stdout.write(JSON.stringify({score:Number(fs.readFileSync(process.argv[2]+'/w.txt','utf8'))*Number(fs.readFileSync('value.txt','utf8'))}))\n",
		"ok.js": "process.exit(require('fs').existsSync(process.argv[2]+'/ok')?0:1)\n",
		"runs/a/w.txt": "1\n",
		"runs/a/ok": "",
		"runs/b/w.txt": "2\n",
		"runs/b/ok": "",
		".clio-coder/verifiers.yaml": JSON.stringify({
			version: 2,
			checks: [
				{ ...commandCheck("score", ["node", "score.js"]), runs: "runs" },
				{ ...commandCheck("ok", ["node", "ok.js"]), runs: "runs" },
			],
		}),
	};
	const open = (repo: string, check: string, gates: string[]): ResearchCampaign =>
		openResearchCampaign({
			cwd: repo,
			objective: { check, metric: "score", direction: "min", minImprovement: 0.05, trials: 3 },
			gates,
			scope: [],
			budget: { maxIterations: 1, allowUnpriced: false },
			allowNoisy: false,
			keep: false,
			agent: {},
		});

	it("optimizes one run of a sweep and gates on every run of another, each run's directory on its argv", async (t) => {
		const env = await isolateClioEnv("clio-coder-research-home-");
		t.after(() => env.restore());
		const repo = scratchRepo(sweepFiles);
		const campaign = open(repo, "score/b", ["ok"]);
		strictEqual(campaign.objective.check, "score/b");
		deepStrictEqual(campaign.gates, ["ok/a", "ok/b"]);
		deepStrictEqual(
			campaign.checks.map((check) => [check.id, check.command.at(-1), "runs" in check]),
			[
				["score/b", "runs/b", false],
				["ok/a", "runs/a", false],
				["ok/b", "runs/b", false],
			],
		);
		ok(campaign.protected.includes("runs/a") && campaign.protected.includes("runs/b"));
		deepStrictEqual(open(repo, "score/a", ["ok/b"]).gates, ["ok/b"]);

		const outcome = await runResearchCampaign(campaign, {
			agent: async (request) => {
				writeFileSync(join(request.worktree, "value.txt"), "50\n");
				return done;
			},
		});
		strictEqual(outcome.reason, "max-iterations");
		const view = summarizeCampaign(campaign.project, campaign.id);
		deepStrictEqual(
			view.iterations.map((iteration) => iteration.outcome),
			["ratcheted"],
		);
		deepStrictEqual(
			view.iterations[0]?.gates.map((gate) => [gate.check, gate.passed]),
			[
				["ok/a", true],
				["ok/b", true],
			],
		);
	});

	it("refuses a bare sweep objective, an unknown run, and a run directory the campaign's HEAD does not hold", async (t) => {
		const env = await isolateClioEnv("clio-coder-research-home-");
		t.after(() => env.restore());
		const repo = scratchRepo(sweepFiles);
		throws(() => open(repo, "score", []), /'score' is a sweep over runs; name one run as score\/<run> \(runs: a, b\)/);
		throws(() => open(repo, "score/c", []), /run directory runs\/c is not a directory inside the workspace/);
		throws(() => open(repo, "score/..", []), /must be one directory name under runs/);
		throws(() => open(repo, "score/a", ["sane/a"]), /check 'sane\/a' is not declared/);
		mkdirSync(join(repo, "runs", "c"));
		writeFileSync(join(repo, "runs", "c", "w.txt"), "3\n");
		throws(() => open(repo, "score/c", []), /run directory runs\/c is not committed/);
		throws(() => open(repo, "score/a", ["ok"]), /run directory runs\/c is not committed/);
		git(repo, "add", "runs/c");
		git(repo, "commit", "-q", "-m", "run c");
		writeFileSync(join(repo, "runs", "a", "w.txt"), "9\n");
		throws(() => open(repo, "score/a", []), /run directory runs\/a has uncommitted changes/);
	});
});

describe("research resume", () => {
	const scoreRepo = (): string =>
		scratchRepo({
			"value.txt": "100\n",
			"score.js": scoreJs,
			".clio-coder/verifiers.yaml": JSON.stringify({ version: 2, checks: [commandCheck("score", ["node", "score.js"])] }),
		});
	const counting = (counter: { runs: number }) => (check: DeclaredCheck, metric: string, worktree: string) => {
		counter.runs += 1;
		return runObjective(check, metric, worktree);
	};

	it("counts wall time from each start to its stop, or to the last event of a run that died", () => {
		const t0 = Date.parse("2026-01-01T00:00:00.000Z");
		const at = (seconds: number): string => new Date(t0 + seconds * 1000).toISOString();
		strictEqual(
			researchElapsedMs([
				{ type: "opened", at: at(0), base: "b", ref: "r" },
				{ type: "stopped", at: at(60), reason: "stopped", detail: "", best: "b" },
				{ type: "resumed", at: at(120), best: "b", iterations: 1, elapsedMs: 60_000, interrupted: [] },
				{ type: "iteration-started", at: at(150), iteration: 2, parent: "b", worktree: "w" },
				{ type: "resumed", at: at(300), best: "b", iterations: 2, elapsedMs: 90_000, interrupted: [2] },
				{ type: "stopped", at: at(310), reason: "max-iterations", detail: "", best: "b" },
			]),
			100_000,
		);
	});

	it("continues a stopped campaign at its next iteration from the kept commit, without a second A/A check", async (t) => {
		const env = await isolateClioEnv("clio-coder-research-home-");
		t.after(() => env.restore());
		const repo = scoreRepo();
		const campaign = openScore(repo, { maxIterations: 3, allowUnpriced: false });
		const controller = new AbortController();
		const first = { runs: 0 };
		let calls = 0;
		const outcome = await runResearchCampaign(campaign, {
			signal: controller.signal,
			measure: counting(first),
			agent: async (request) => {
				calls += 1;
				if (calls === 1) {
					writeFileSync(join(request.worktree, "value.txt"), "50\n");
					return done;
				}
				controller.abort();
				return { ...done, exitCode: 130, outcome: "interrupted" };
			},
		});
		strictEqual(outcome.reason, "stopped");
		const kept = summarizeCampaign(campaign.project, campaign.id).best;
		strictEqual(git(repo, "show", `${kept}:value.txt`), "50");

		const second = { runs: 0 };
		const parents: string[] = [];
		const resumed = await resumeResearchCampaign(campaign, {
			measure: counting(second),
			agent: async (request) => {
				parents.push(git(request.worktree, "rev-parse", "HEAD"));
				writeFileSync(join(request.worktree, "value.txt"), "20\n");
				return done;
			},
		});
		strictEqual(resumed.reason, "max-iterations");
		deepStrictEqual(parents, [kept]);
		// One run on the best commit to learn the check output, then the iteration's pairs; no A/A pairs.
		strictEqual(second.runs, 1 + 2 * campaign.objective.trials);
		const view = summarizeCampaign(campaign.project, campaign.id);
		deepStrictEqual(
			view.iterations.map((iteration) => iteration.outcome),
			["ratcheted", "interrupted", "ratcheted"],
		);
		strictEqual(view.stop?.reason, "max-iterations");
		strictEqual(git(repo, "show", `${view.best}:value.txt`), "20");
		const events = readJournal(campaign.project, campaign.id).events;
		strictEqual(events.filter((event) => event.type === "aa").length, 1);
		strictEqual(events.filter((event) => event.type === "resumed").length, 1);
		strictEqual(worktreeCount(repo), 1);

		await rejects(
			resumeResearchCampaign(campaign, { agent: async () => done }),
			(error: Error) => error instanceof ResearchResumeError && /budget is spent \(max-iterations/u.test(error.message),
		);
	});

	it("refuses a campaign another process holds, then recovers one whose process died mid-iteration", async (t) => {
		const env = await isolateClioEnv("clio-coder-research-home-");
		t.after(() => env.restore());
		const repo = scoreRepo();
		const campaign = openScore(repo, { maxIterations: 2, allowUnpriced: false });
		const controller = new AbortController();
		await runResearchCampaign(campaign, {
			signal: controller.signal,
			agent: async () => {
				controller.abort();
				return { ...done, exitCode: 130, outcome: "interrupted" };
			},
		});
		// What a killed process leaves: no archive or stop for the iteration in flight, and its worktrees on disk.
		const dir = join(campaign.project, ".clio-coder", "research", campaign.id);
		const journalPath = join(dir, "journal.jsonl");
		const lines = readFileSync(journalPath, "utf8").trim().split("\n");
		writeFileSync(journalPath, `${lines.filter((line) => !/"type":"(archived|stopped)"/u.test(line)).join("\n")}\n`);
		const leftover = join(repo, ".clio-coder", "worktrees", `research-${campaign.id}-base`);
		git(repo, "worktree", "add", "--detach", "--quiet", leftover, campaign.base);
		strictEqual(summarizeCampaign(campaign.project, campaign.id).state, "running");

		const lockPath = join(dir, "run.lock");
		writeFileSync(lockPath, `${JSON.stringify({ host: hostname(), pid: process.pid, birthToken: null })}\n`);
		const cwd = process.cwd();
		const errors: string[] = [];
		t.mock.method(process.stderr, "write", (chunk: unknown) => {
			errors.push(String(chunk));
			return true;
		});
		process.chdir(repo);
		try {
			strictEqual(await runResearchCommand(["resume", campaign.id]), 1);
			strictEqual(await runResearchCommand(["resume"]), 2);
		} finally {
			process.chdir(cwd);
		}
		ok(
			errors.some((line) => line.includes(`is already running in process ${process.pid}`)),
			errors.join("\n"),
		);
		rmSync(lockPath);

		const outcome = await resumeResearchCampaign(campaign, { agent: async () => done });
		strictEqual(outcome.reason, "max-iterations");
		const view = summarizeCampaign(campaign.project, campaign.id);
		deepStrictEqual(
			view.iterations.map((iteration) => iteration.outcome),
			["interrupted", "no-op"],
		);
		ok(!existsSync(lockPath));
		strictEqual(worktreeCount(repo), 1);
	});

	it("refuses when something else moved the research branch", async (t) => {
		const env = await isolateClioEnv("clio-coder-research-home-");
		t.after(() => env.restore());
		const repo = scoreRepo();
		const campaign = openScore(repo, { maxIterations: 2, allowUnpriced: false });
		const controller = new AbortController();
		await runResearchCampaign(campaign, {
			signal: controller.signal,
			agent: async () => {
				controller.abort();
				return { ...done, exitCode: 130, outcome: "interrupted" };
			},
		});
		writeFileSync(join(repo, "value.txt"), "1\n");
		git(repo, "commit", "-qam", "elsewhere");
		git(repo, "update-ref", campaign.ref, "HEAD");
		await rejects(
			resumeResearchCampaign(campaign, { agent: async () => done }),
			(error: Error) => error instanceof ResearchResumeError && /something else moved it/u.test(error.message),
		);
	});
});
