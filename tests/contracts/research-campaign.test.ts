import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runResearchCommand } from "../../src/cli/research.js";
import { claimsProjectRoot, readClaims } from "../../src/domains/claims/index.js";
import {
	type AgentRunner,
	aaIsNoisy,
	budgetStop,
	costFromPricing,
	grade,
	openResearchCampaign,
	parseJournal,
	recomputeCampaign,
	runResearchCampaign,
	summarizeCampaign,
} from "../../src/domains/research/index.js";
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
					"yolo",
				]),
				2,
			);
			strictEqual(await runResearchCommand(["report", "not-an-id"]), 2);
		} finally {
			process.chdir(cwd);
		}
	});
});
