import assert from "node:assert/strict";
import { test } from "node:test";
import { BARS_CAVEAT, usageLabel, usageView } from "../client/pages/usage-model.js";
import type { UsageReport } from "../contracts/reports.js";

const report = (facts: UsageReport["facts"], opportunities: UsageReport["opportunities"] = []): UsageReport => ({
	schema: "experimental",
	workspaceId: "0".repeat(32),
	windowDays: 30,
	from: "2026-08-21",
	to: "2026-09-20",
	facts,
	opportunities,
});

const tokens = {
	apiCalls: 12,
	input: 700,
	output: 500,
	cacheRead: 1000,
	cacheWrite: 0,
	reasoningTokens: 250,
	totalTokens: 2450,
	costUsd: 0.02,
};

test("the window is stated as the report's own two dates", () => {
	assert.equal(usageView(report([])).window, "from 2026-08-21 through 2026-09-20");
	// The CLI sends instants; a window boundary reads as the day, without the clock digits.
	const instants = usageView({
		...report([]),
		from: "2026-08-21T19:08:49.333Z",
		to: "2026-09-20T19:08:49.333Z",
	});
	assert.match(instants.window, /^from \d{4}-\d{2}-\d{2} through \d{4}-\d{2}-\d{2}$/u);
});

test("five token bars compare with one another and carry the caveat", () => {
	const view = usageView(report([{ name: "tokens", values: tokens }]));
	assert.deepEqual(
		view.bars.map((bar) => bar.label),
		["Input", "Output", "Cache read", "Cache write", "Reasoning"],
	);
	assert.deepEqual(
		view.bars.map((bar) => bar.value),
		["700", "500", "1,000", "0", "250"],
	);
	// Widths are shares of the largest field, never of the total: these fields overlap.
	assert.deepEqual(
		view.bars.map((bar) => bar.share),
		[0.7, 0.5, 1, 0, 0.25],
	);
	assert.equal(view.barsCaveat, BARS_CAVEAT);
	assert.match(view.barsCaveat, /not additive percentages/u);
});

test("a field with nothing observed reads as not recorded, and zero reads as zero", () => {
	const view = usageView(
		report([{ name: "tokens", values: { ...tokens, cacheWrite: 0, reasoningTokens: null, knownSubtotals: true } }]),
	);
	const by = new Map(view.bars.map((bar) => [bar.label, bar.value]));
	assert.equal(by.get("Cache write"), "0");
	assert.equal(by.get("Reasoning"), "not recorded");
	assert.match(String(view.knownSubtotals), /known contributions only/u);
});

test("the headline names the cost as recorded, never as an estimate", () => {
	const view = usageView(report([{ name: "tokens", values: tokens }]));
	const by = new Map(view.headline.map((figure) => [figure.label, figure]));
	assert.equal(by.get("Tokens")?.value, "2,450");
	assert.equal(by.get("Tokens")?.note, "12 API calls");
	assert.equal(by.get("Cost")?.value, "$0.02");
	assert.equal(by.get("Cost")?.note, "Recorded cost, never a GUI estimate");
});

test("a missing store reads as a dash and says what a dash means", () => {
	const view = usageView(
		report([
			{ name: "session-store-missing", values: { path: "/home/clio/state/sessions" } },
			{ name: "dispatch-runs", values: { value: 3 } },
		]),
	);
	const by = new Map(view.headline.map((figure) => [figure.label, figure]));
	assert.equal(by.get("Sessions")?.value, "—");
	assert.match(String(by.get("Sessions")?.note), /does not mean zero activity/u);
	assert.equal(by.get("Dispatch runs")?.value, "3");
	assert.equal(view.missingStores.length, 1);
	assert.match(view.missingStores[0] as string, /no session history store at all/u);
	assert.match(view.missingStores[0] as string, /\/home\/clio\/state\/sessions/u);
});

test("the origin split appears only when something out of turn was recorded", () => {
	const plain = usageView(report([{ name: "tokens", values: tokens }]));
	assert.deepEqual(plain.origins, []);
	assert.match(plain.originsNote, /every recorded call belongs to a turn/u);

	const split = usageView(report([{ name: "tokens", values: { ...tokens, turns: 9, sideQuestions: 2, handoffs: 1 } }]));
	assert.deepEqual(
		split.origins.map((origin) => `${origin.label}:${origin.value}`),
		["Turns:9", "Side questions:2", "Handoffs:1"],
	);
	assert.match(split.originsNote, /A turn is ordinary conversation/u);
});

test("models and skills keep the report's order and nothing else is dropped", () => {
	const view = usageView(
		report([
			{ name: "tokens", values: tokens },
			{ name: "model-usage", values: { attributedModelId: "big", totalTokens: 2000 } },
			{ name: "model-usage", values: { attributedModelId: "small", totalTokens: 400 } },
			{ name: "skill-activated", values: { skill: "archify", activations: 2 } },
			{ name: "skill-never-activated", values: { skill: "slurm-jobs" } },
			{ name: "memory", values: { approved: 1, pending: 0 } },
		]),
	);
	assert.deepEqual(
		view.models.map((model) => model.values.attributedModelId),
		["big", "small"],
	);
	assert.equal(view.skillsActivated.length, 1);
	assert.deepEqual(view.skillsDormant, ["slurm-jobs"]);
	assert.deepEqual(
		view.rest.map((fact) => fact.label),
		["Memory"],
	);
});

test("an unknown fact still reads as words", () => {
	assert.equal(usageLabel("bash-shape"), "Bash shape");
	assert.equal(usageLabel("permission-approval"), "Permission approval");
	assert.equal(usageLabel("unverifiedSuccesses"), "Unverified successes");
});
