import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CATEGORY_ORDER,
	configMap,
	entrySource,
	settingFamilies,
	settingFamily,
	settingValue,
} from "../client/pages/config-map-model.js";
import type { ConfigGraph, SettingRow, SettingsReport } from "../contracts/settings.js";

const entry = (over: Partial<ConfigGraph["entries"][number]>): ConfigGraph["entries"][number] => ({
	category: "hook",
	id: "fixture",
	scope: "project",
	reloadClass: "next-turn",
	facts: {},
	...over,
});
const row = (key: string, source: SettingRow["source"] = "user", value: SettingRow["value"] = "x"): SettingRow => ({
	key,
	source,
	value,
	redacted: false,
});
const report = (rows: SettingRow[]): SettingsReport => ({ rows, layers: [], issues: [] });

test("the map leads with four figures and keeps an unread report apart from an empty one", () => {
	const graph: ConfigGraph = {
		categories: ["hook", "clio-md"],
		entries: [
			entry({ category: "clio-md", id: "CLIO-CODER.md", contextCostTokens: 1200 }),
			entry({ id: "a", reloadClass: "restart", contextCostTokens: 300 }),
			entry({ id: "b", scope: "user" }),
		],
		issues: [{ category: "hooks", count: 2, message: "x" }],
	};
	const unread = configMap(graph, null);
	assert.deepEqual(
		unread.figures.map((figure) => figure.label),
		["Effective setting facts", "Customization surfaces", "Estimated context cost", "Needs a restart"],
	);
	assert.equal(unread.figures[0]?.value, "—");
	assert.match(unread.figures[0]?.note ?? "", /not been read/u);
	const read = configMap(graph, report([row("chat.model"), row("chat.target", "project")]));
	assert.deepEqual(
		read.figures.map((figure) => [figure.value, figure.note]),
		[
			["2", "reported in this snapshot"],
			["3", "2 represented categories"],
			["~1,500", "tokens across 2 costed entries"],
			["1", "2 reported issues"],
		],
	);
});

test("no costed surface reads as a dash, and a costed zero reads as zero", () => {
	const none = configMap({ categories: [], entries: [entry({})], issues: [] }, null);
	assert.deepEqual([none.figures[2]?.value, none.figures[2]?.note], ["—", "no surface reported a cost"]);
	const zero = configMap({ categories: [], entries: [entry({ contextCostTokens: 0 })], issues: [] }, null);
	assert.deepEqual([zero.figures[2]?.value, zero.figures[2]?.note], ["~0", "tokens across 1 costed entry"]);
	assert.equal(none.figures[3]?.note, "no reported inspection issues");
});

test("sources merge scopes with setting layers, sort by count then name, and say what the top eight dropped", () => {
	const graph: ConfigGraph = {
		categories: [],
		entries: [entry({ scope: "project" }), entry({ scope: "project" }), entry({ scope: "user" })],
		issues: [],
	};
	const view = configMap(graph, report([row("a", "user"), row("b", "built-in"), row("c", "built-in")]));
	assert.deepEqual(
		view.sources.map((source) => [source.label, source.count]),
		[
			["Built in", 2],
			["Project", 2],
			["User", 2],
		],
	);
	assert.equal(view.sourcesOmitted, 0);
	// `builtin` on an entry and `built-in` on a setting row are the same source.
	const merged = configMap(
		{ categories: [], entries: [entry({ scope: "builtin" })], issues: [] },
		report([row("a", "built-in")]),
	);
	assert.deepEqual(merged.sources, [{ label: "Built in", count: 2 }]);
	const many = configMap(
		{ categories: [], entries: Array.from({ length: 11 }, (_, index) => entry({ scope: `scope-${index}` })), issues: [] },
		null,
	);
	assert.equal(many.sources.length, 8);
	assert.equal(many.sourcesOmitted, 3);
});

test("layers follow the category order, drop empty categories, and timing keeps only observed classes", () => {
	const view = configMap(
		{
			categories: [],
			entries: [entry({ category: "memory", reloadClass: "n/a" }), entry({ category: "settings", reloadClass: "hot" })],
			issues: [],
		},
		null,
	);
	assert.deepEqual(
		view.layers.map((layer) => [layer.short, layer.label, layer.count]),
		[
			["SET", "Settings", 1],
			["MEM", "Memory", 1],
		],
	);
	assert.deepEqual(
		view.timing.map((timing) => timing.label),
		["Now", "Informational"],
	);
	assert.ok(CATEGORY_ORDER.indexOf("settings") < CATEGORY_ORDER.indexOf("memory"));
});

test("an entry names its path, the project root, or its scope alone", () => {
	assert.equal(entrySource({ scope: "project", sourcePath: ".clio-coder/hooks.yaml" }), ".clio-coder/hooks.yaml");
	assert.equal(entrySource({ scope: "project", sourcePath: "/" }), "project root");
	assert.equal(entrySource({ scope: "user" }), "user scope");
});

test("settings group by family, families sort alphabetically, and the filter folds case", () => {
	assert.equal(settingFamily("chat.model"), "chat");
	assert.equal(settingFamily("targets[0].id"), "targets");
	assert.equal(settingFamily("theme"), "theme");
	const rows = [row("targets.0.id"), row("chat.model"), row("theme"), row("chat.target")];
	assert.deepEqual(
		settingFamilies(rows).map((group) => [group.family, group.rows.map((item) => item.key)]),
		[
			["chat", ["chat.model", "chat.target"]],
			["targets", ["targets.0.id"]],
			["theme", ["theme"]],
		],
	);
	assert.deepEqual(
		settingFamilies(rows, " CHAT.M ").map((group) => group.rows.map((item) => item.key)),
		[["chat.model"]],
	);
	assert.deepEqual(settingFamilies(rows, "absent"), []);
});

test("an effective value stays exact and never prints JSON punctuation", () => {
	assert.equal(settingValue(row("a", "user", "fixture-local-model")), "fixture-local-model");
	assert.equal(settingValue(row("a", "user", 4317)), "4317");
	assert.equal(settingValue(row("a", "user", false)), "false");
	assert.equal(settingValue(row("a", "user", null)), "Not set");
	assert.equal(settingValue(row("a", "user", "")), "Empty");
	assert.equal(settingValue(row("a", "user", [])), "Empty list");
	assert.equal(settingValue(row("a", "user", {})), "Empty map");
});
