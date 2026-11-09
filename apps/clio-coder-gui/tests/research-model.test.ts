import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	aaLine,
	bestCurve,
	campaignFacts,
	campaignFromProgress,
	curveChart,
	describeGrade,
	emptyResearchDraft,
	followedOperation,
	iterationRows,
	logLine,
	regradeLines,
	researchRequest,
	summaryMeta,
} from "../client/pages/research-model.js";
import type { ResearchCampaign, ResearchReport } from "../contracts/research.js";
import { renderUsdLimit, renderUsdSpend } from "../server/clio/http-shims.js";
import { summarizeCampaigns, withDisplay } from "../server/services/research.js";

const captured = <T>(name: string): T =>
	JSON.parse(readFileSync(new URL(`./fixtures/research/${name}.json`, import.meta.url), "utf8")) as T;
const list = captured<{ project: string; campaigns: ResearchCampaign[] }>("list");
const byId = (id: string) => list.campaigns.find((view) => view.id === id) as ResearchCampaign;

test("the best-so-far curve starts at the A/A base and moves only on a ratchet", () => {
	const view = byId("r20261108-123812-bacf");
	const points = bestCurve(view);
	assert.deepEqual(
		points.map((point) => [point.iteration, point.ratcheted]),
		[
			[0, false],
			[1, true],
			[2, false],
		],
	);
	assert.equal(points[0]?.value, view.aa?.grade.baseMedian);
	assert.equal(points[1]?.value, view.iterations[0]?.grade?.candidateMedian);
	assert.equal(points[2]?.value, points[1]?.value, "an archived iteration kept the best so far");

	const chart = curveChart(points, 560, 160);
	assert.ok(chart);
	assert.match(chart.path, /^M8 8H280V152H552V152$/);
	assert.deepEqual(
		chart.dots.map((dot) => dot.ratcheted),
		[false, true, false],
	);
	assert.equal(curveChart(points.slice(0, 1), 560, 160), null);
	assert.deepEqual(bestCurve({ ...view, aa: null, iterations: [] }), []);
});

test("timeline rows, the A/A line and summaries say what happened in words", () => {
	const rows = iterationRows(byId("r20261108-123812-bacf"));
	assert.deepEqual(
		rows.map((row) => [row.label, row.outcome, row.ratcheted]),
		[
			["it-0001", "ratcheted", true],
			["it-0002", "archived: not improved", false],
		],
	);
	assert.match(rows[0]?.commit ?? "", /^[0-9a-f]{12} → [0-9a-f]{12}$/);
	assert.match(rows[0]?.grade ?? "", /^improved/);
	assert.equal(iterationRows(byId("r20261108-123902-22f8"))[1]?.outcome, "archived: interrupted");
	assert.match(aaLine(byId("r20261108-120739-d20d").aa), /^A\/A quiet: inconclusive/);
	assert.equal(aaLine(null), "The A/A check has not run yet.");

	const summaries = summarizeCampaigns(list).campaigns;
	assert.equal(summaries[0]?.id, "r20261108-123902-22f8", "newest first");
	assert.match(summaryMeta(summaries[0] as never), /· 1 of 2 kept$/);
	assert.equal(summaryMeta({ id: "r20261108-000000-0000", error: "bad journal" }), "unreadable: bad journal");
});

test("an unchanged grade outside zero reads as the CLI names it: below threshold or a small regression", () => {
	const grade = (low: number, high: number) => ({
		verdict: "unchanged" as const,
		delta: (low + high) / 2,
		ci: { low, high },
	});
	const cases = [
		[
			grade(-0.03, -0.01),
			{ direction: "min" as const, minImprovement: 0.05 },
			/^below threshold \(-2\.00% vs required -5\.00%\)/,
		],
		[
			grade(0.01, 0.03),
			{ direction: "min" as const, minImprovement: 0.05 },
			/^small regression \(\+2\.00%, inside the ±5\.00% threshold\)/,
		],
		[
			grade(0.01, 0.03),
			{ direction: "max" as const, minImprovement: 0.05 },
			/^below threshold \(\+2\.00% vs required \+5\.00%\)/,
		],
		[grade(-0.01, 0.03), { direction: "min" as const, minImprovement: 0.05 }, /^unchanged, /],
	] as const;
	for (const [g, objective, label] of cases) {
		assert.match(describeGrade(g, objective), label);
	}
	const view = byId("r20261108-123812-bacf");
	const objective = { ...view.campaign.objective, direction: "min" as const, minImprovement: 0.05 };
	const row = iterationRows({
		...view,
		campaign: { ...view.campaign, objective },
		iterations: view.iterations.map((it) => (it.grade ? { ...it, grade: { ...it.grade, ...grade(-0.03, -0.01) } } : it)),
	})[0];
	assert.match(row?.grade ?? "", /^below threshold/);
});

test("money on the page is what the server rendered with Clio's own renderer", () => {
	const view = byId("r20261108-120921-31df");
	const shown = withDisplay(view);
	const fact = (label: string) => campaignFacts(shown).find((row) => row.label === label)?.value ?? "";
	assert.equal(fact("Spend"), `${renderUsdSpend(0, { estimated: false, unpriced: true })}; 1 run had unknown spend`);
	assert.ok(fact("Budget").includes(`${renderUsdLimit(0.5)} cap`), fact("Budget"));
	assert.equal(iterationRows(shown)[0]?.cost, "unknown");

	const priced = withDisplay({
		...view,
		spend: { usd: 0.0123, unknownRuns: 0, estimated: true },
		iterations: view.iterations.map((row) => ({ ...row, cost: { kind: "estimated" as const, usd: 0.0123 } })),
	});
	assert.equal(priced.display?.spend, renderUsdSpend(0.0123, { estimated: true, unpriced: false }));
	assert.deepEqual(priced.display?.costs, [renderUsdSpend(0.0123, { estimated: true, unpriced: false })]);
	assert.equal(iterationRows(view)[0]?.cost, "not rendered", "the page never formats a raw amount");
});

test("regrade lines and live progress lines come from the CLI's own output", () => {
	const report = captured<ResearchReport>("report");
	assert.deepEqual(
		regradeLines(report).map((line) => [line.of, line.agrees]),
		[
			["A/A", true],
			["it-0001", true],
		],
	);
	const progress = [
		"research r20261108-123812-bacf: opened at 6af8f20fdee1",
		"research r20261108-123812-bacf: A/A unchanged",
	];
	assert.equal(campaignFromProgress(["starting", ...progress]), "r20261108-123812-bacf");
	assert.equal(campaignFromProgress(["clio-coder: research start: no such check"]), null);
	assert.equal(logLine(progress[1] as string), "A/A unchanged");
});

test("the form sends only a request the contract accepts", () => {
	const draft = { ...emptyResearchDraft(), check: "bench", metric: " wall_ms ", gates: ["bench", "correct"] };
	assert.deepEqual(researchRequest(draft), {
		request: {
			check: "bench",
			metric: "wall_ms",
			direction: "min",
			maxIterations: 3,
			minImprovement: 0.05,
			trials: 5,
			gates: ["bench", "correct"],
			scope: [],
			maxWallMinutes: 30,
			allowUnpriced: false,
		},
	});
	const full = researchRequest({
		...draft,
		scope: "src/**/*.{ts,tsx}\n  lib/*.py\n\n",
		maxCostUsd: "2",
		goal: "  make\n it   faster ",
		target: "litellm",
		model: "mini/qwen3.8-27b-iq4r-v4",
	});
	assert.ok("request" in full);
	// One glob per line: a comma belongs to a brace glob, never splits it.
	assert.deepEqual(full.request.scope, ["src/**/*.{ts,tsx}", "lib/*.py"]);
	assert.equal(full.request.goal, "make it faster");
	assert.equal(full.request.model, "mini/qwen3.8-27b-iq4r-v4");

	const refused: [Partial<typeof draft>, RegExp][] = [
		[{ check: "" }, /Pick the check/],
		[{ metric: "1x" }, /Name the metric/],
		[{ maxIterations: "0" }, /Max iterations/],
		[{ maxIterations: "1.5" }, /Max iterations/],
		[{ minImprovement: "1" }, /cannot fall by 100%/],
		[{ trials: "1" }, /Trials/],
		[{ scope: "--all" }, /cannot start with a dash/],
		[{ maxWallMinutes: "-3" }, /Max wall minutes/],
		[{ goal: "--yolo" }, /goal cannot start with a dash/],
		[{ model: "m" }, /Pick the target/],
		[{ target: "litellm", model: "bad model" }, /characters/],
	];
	for (const [change, problem] of refused) {
		const result = researchRequest({ ...draft, ...change });
		assert.ok("problem" in result, JSON.stringify(change));
		assert.match(result.problem, problem);
	}
	assert.ok("request" in researchRequest({ ...draft, direction: "max", minImprovement: "1.5" }));
});

test("the page follows the workspace's running campaign over one this window started earlier", () => {
	const mine = { workspaceId: "w1", operationId: "op-a" };
	// Just started here: the list has not caught up yet.
	assert.equal(followedOperation(mine, "w1", undefined), "op-a");
	// Campaign A settled and campaign B was started elsewhere: follow B so Stop and the disabled form apply to it.
	assert.equal(followedOperation(mine, "w1", "op-b"), "op-b");
	// Another workspace never shows this window's campaign.
	assert.equal(followedOperation(mine, "w2", undefined), null);
	assert.equal(followedOperation(mine, "w2", "op-c"), "op-c");
	assert.equal(followedOperation(null, "w1", undefined), null);
});
