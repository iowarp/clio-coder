import { deepStrictEqual, doesNotMatch, match, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { extractGlobalFlags } from "../../src/cli/argv.js";
import { validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { applyControlValue, SETTING_CONTROLS } from "../../src/core/settings-controls.js";
import { compile } from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { createDemoHints } from "../../src/interactive/footer/demo-hints.js";

test("demo ships enabled, supports validated settings and last-wins session flags", () => {
	strictEqual(DEFAULT_SETTINGS.interface.demo, true);
	const settings = structuredClone(DEFAULT_SETTINGS);
	applyControlValue(settings, "interface.demo", "false");
	strictEqual(settings.interface.demo, false);
	strictEqual(SETTING_CONTROLS.find((c) => c.path === "interface.demo")?.label, "Demo guidance");
	strictEqual(
		validateSettings({ ...settings, interface: { ...settings.interface, demo: "yes" } }).issues.some(
			(issue) => issue.path === "interface.demo",
		),
		true,
	);
	strictEqual(extractGlobalFlags([]).demo, undefined);
	strictEqual(extractGlobalFlags(["--demo", "--no-demo"]).demo, false);
	strictEqual(extractGlobalFlags(["--no-demo", "--demo"]).demo, true);
	deepStrictEqual(extractGlobalFlags(["run", "--demo"]).rest, ["run", "--demo"]);
});

test("only an explicit interactive prompt input adds guidance; disabling restores identical prompt", () => {
	const table = loadFragments();
	const base = {
		identity: "identity.clio",
		operatingContract: "operating.contract",
		safety: "safety.auto-edit",
		sessionInputs: {},
	};
	const normal = compile(table, base);
	const demo = compile(table, { ...base, sessionInputs: { demo: true } });
	match(demo.systemPrompt, /## Demo guidance/);
	match(demo.systemPrompt, /Most answers need no invitation/);
	match(demo.systemPrompt, /does not authorize extra tool calls/);
	doesNotMatch(normal.systemPrompt, /## Demo guidance/);
	strictEqual(compile(table, { ...base, sessionInputs: { demo: false } }).systemPrompt, normal.systemPrompt);
	deepStrictEqual(
		demo.sections.map((s) => s.id),
		normal.sections.map((s) => s.id),
	);
});

test("footer tips expire, have cooldown, respect custom keys, and do not repeat", () => {
	const hints = createDemoHints();
	const input = {
		enabled: true,
		now: 0,
		quiet: false,
		agentActive: false,
		toolsUsed: false,
		contextBusy: false,
		dashboardKey: "ctrl+x",
	};
	match(hints(input) ?? "", /Explore \/help/);
	strictEqual(hints({ ...input, now: 10_001 }), null);
	strictEqual(hints({ ...input, now: 59_999, agentActive: true }), null);
	match(hints({ ...input, now: 60_000, agentActive: true }) ?? "", /ctrl\+x → Activity/);
	strictEqual(hints({ ...input, now: 60_001, quiet: true }), null);
	strictEqual(hints({ ...input, now: 120_000, agentActive: true }), null);
	match(hints({ ...input, now: 120_000, toolsUsed: true }) ?? "", /\/view/);
	strictEqual(hints({ ...input, now: 120_001, enabled: false }), null);
	strictEqual(hints({ ...input, now: 180_000, toolsUsed: true }), null);
	match(hints({ ...input, now: 180_000, contextBusy: true }) ?? "", /\/context/);
	strictEqual(hints({ ...input, now: 240_000, contextBusy: true }), null);
});
