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

/** A read-model quantity as the CLI emits it; `known: false` is a fact with no measured part. */
const quantity = (display: string, measured: number, unknownCount = 0, known = true) => ({
	fact: {
		measured,
		estimated: 0,
		unknownCount,
		absentCount: 0,
		coverage: { measured: known ? 1 : 0, estimated: 0, unknown: unknownCount },
	},
	display,
	ref: "repo:all-30d#total",
});
const pricedBy = { provider: 0, "target-rates": 2, catalog: 0, free: 0, none: 0 };
const tokens = {
	name: "telemetry-tokens",
	values: {
		tokens: {
			input: quantity("700", 700),
			output: quantity("500", 500),
			cacheRead: quantity("1,000", 1000),
			cacheWrite: quantity("0", 0),
			cacheWrite1h: quantity("0", 0),
			reasoning: quantity("250", 250),
			prompt: quantity("1,700", 1700),
			total: quantity("2,200", 2200),
		},
	},
};
const cost = (groupBy: "label" | "model", total: Record<string, unknown>, groups: Record<string, unknown>[] = []) => ({
	name: "telemetry-cost",
	values: { groupBy, report: { kind: "cost", scope: { repo: "all", days: 30 }, groupBy, total, groups } },
});
const exactTotal = {
	calls: quantity("12", 12),
	tokens: quantity("2,200", 2200),
	usd: quantity("$0.02", 0.02),
	pricedBy,
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

test("five token bars compare the read model's fields with one another and carry the caveat", () => {
	const view = usageView(report([tokens]));
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

test("a field with nothing observed shows the server's word, and a lower bound draws its known part", () => {
	const view = usageView(
		report([
			{
				name: "telemetry-tokens",
				values: {
					tokens: {
						...tokens.values.tokens,
						cacheRead: quantity("≥1,000 (1 call unknown)", 1000, 1),
						reasoning: quantity("unknown (2 calls unknown)", 0, 2, false),
					},
				},
			},
		]),
	);
	const by = new Map(view.bars.map((bar) => [bar.label, bar]));
	assert.equal(by.get("Cache write")?.value, "0");
	assert.equal(by.get("Reasoning")?.value, "unknown (2 calls unknown)");
	assert.equal(by.get("Reasoning")?.share, 0);
	assert.equal(by.get("Cache read")?.share, 1);
	assert.match(view.barsCaveat, /known subtotals/u);
});

test("the headline reads the read model's window totals and names an unpriced remainder", () => {
	const view = usageView(
		report([
			cost("label", {
				calls: quantity("≥14 (1 call unknown)", 14, 1),
				tokens: quantity("≥2,850 (1 call unknown)", 2850, 1),
				usd: quantity("$0.03 +?", 0.03, 1),
				pricedBy: { ...pricedBy, none: 1 },
			}),
		]),
	);
	const by = new Map(view.headline.map((figure) => [figure.label, figure]));
	assert.equal(by.get("Tokens")?.value, "≥2,850 (1 call unknown)");
	assert.equal(by.get("Tokens")?.note, "API calls: ≥14 (1 call unknown)");
	assert.equal(by.get("Cost")?.value, "$0.03 +?");
	assert.equal(by.get("Cost")?.note, "Known subtotal; some calls are unpriced");
	assert.match(view.knownSubtotals ?? "", /known subtotals/u);
	assert.equal(usageView(report([cost("label", exactTotal)])).knownSubtotals, null);
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

test("call origins are the label report's groups, in the server's words", () => {
	assert.match(usageView(report([])).originsNote, /were not recorded/u);
	const view = usageView(
		report([
			cost("label", exactTotal, [
				{ key: "btw", calls: quantity("1", 1), tokens: quantity("40", 40), usd: quantity("$0.00", 0), pricedBy },
				{ key: "main", calls: quantity("9", 9), tokens: quantity("2,000", 2000), usd: quantity("$0.02", 0.02), pricedBy },
				{
					key: "worker",
					calls: quantity("≥2 (1 call unknown)", 2, 1),
					tokens: quantity("160", 160),
					usd: quantity("$0.00", 0),
					pricedBy,
				},
			]),
		]),
	);
	assert.deepEqual(
		view.origins.map((origin) => `${origin.label}:${origin.value}`),
		["Side questions:1", "Conversation calls:9", "Worker run calls:≥2 (1 call unknown)"],
	);
	assert.match(view.originsNote, /sealed receipt/u);
});

test("skills keep the report's order, the read model's rows are claimed, and nothing else is dropped", () => {
	const view = usageView(
		report([
			tokens,
			cost("label", exactTotal),
			cost("model", exactTotal),
			{ name: "skill-activated", values: { skill: "map-codebase", activations: 2 } },
			{ name: "skill-never-activated", values: { skill: "slurm-jobs" } },
			{ name: "memory", values: { approved: 1, pending: 0 } },
		]),
	);
	assert.equal(view.skillsActivated.length, 1);
	assert.deepEqual(view.skillsDormant, ["slurm-jobs"]);
	assert.deepEqual(
		view.rest.map((fact) => fact.label),
		["Memory"],
	);
	assert.deepEqual(view.tables, []);
});

test("an unknown fact still reads as words", () => {
	assert.equal(usageLabel("bash-shape"), "Bash shape");
	assert.equal(usageLabel("permission-approval"), "Permission approval");
	assert.equal(usageLabel("unverifiedSuccesses"), "Unverified successes");
});

test("a fact recorded many times is one bounded table, and one recorded once stays a card", () => {
	const fact = (name: string, values: Record<string, unknown>) => ({ name, values });
	const view = usageView({
		workspaceId: "w",
		schema: "experimental",
		windowDays: 30,
		from: "2026-01-01T00:00:00.000Z",
		to: "2026-01-31T00:00:00.000Z",
		facts: [
			fact("memory", { approved: 0, pending: 2 }),
			...Array.from({ length: 30 }, (_, index) =>
				fact("session-recall", {
					sessionId: `s${index}`,
					readmittedTokens: null,
					recalls: { tool: 0, operator: index },
				}),
			),
			fact("top-tool", { tool: "read", count: 173, a: 1, b: 2, c: 3, d: 4, e: 5 }),
			fact("top-tool", { tool: "bash", count: 9, a: 1, b: 2, c: 3, d: 4, e: 5 }),
		],
		opportunities: [],
	});
	assert.deepEqual(
		view.rest.map((row) => row.name),
		["memory"],
	);
	const recall = view.tables.find((table) => table.name === "session-recall");
	assert.deepEqual(recall?.columns, ["Session ID", "Readmitted tokens", "Recalls"]);
	assert.deepEqual([recall?.total, recall?.rows.length, recall?.omitted], [30, 24, 6]);
	// Absent is not zero, and a nested record reads as words rather than JSON.
	assert.deepEqual(recall?.rows[3], ["s3", "Not recorded", "tool 0 · operator 3"]);
	const tools = view.tables.find((table) => table.name === "top-tool");
	assert.deepEqual([tools?.columns.length, tools?.omittedColumns, tools?.omitted], [6, 1, 0]);
});
