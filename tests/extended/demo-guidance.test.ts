import { deepStrictEqual, doesNotMatch, match, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { extractGlobalFlags } from "../../src/cli/argv.js";
import { validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { applyControlValue, SETTING_CONTROLS } from "../../src/core/settings-controls.js";
import { compile } from "../../src/domains/prompts/compiler.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import { createDemoHints, FOOTER_TIP_LIFETIME } from "../../src/interactive/footer/demo-hints.js";

test("demo ships enabled, supports validated settings and last-wins session flags", () => {
	strictEqual(DEFAULT_SETTINGS.interface.demo, true);
	const settings = structuredClone(DEFAULT_SETTINGS);
	applyControlValue(settings, "interface.demo", "false");
	strictEqual(settings.interface.demo, false);
	strictEqual(SETTING_CONTROLS.find((c) => c.path === "interface.demo")?.label, "Demo presentation and guidance");
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
		safety: "safety.default",
		sessionInputs: { coordinatorCapabilities: [] },
	};
	const normal = compile(table, base);
	const demo = compile(table, { ...base, sessionInputs: { ...base.sessionInputs, demo: true } });
	match(demo.systemPrompt, /## Demo guidance/);
	match(demo.systemPrompt, /do not end answers with feature tips, upsells/);
	match(demo.systemPrompt, /interface\.demo/);
	doesNotMatch(normal.systemPrompt, /## Demo guidance/);
	strictEqual(
		compile(table, { ...base, sessionInputs: { ...base.sessionInputs, demo: false } }).systemPrompt,
		normal.systemPrompt,
	);
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
	match(hints(input) ?? "", /Ask Clio how it works · \? keys · Ctrl\+G every action/);
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

test("footer tips persist their showings and retire after a few sessions", () => {
	const shown: Record<string, number> = {};
	const input = {
		enabled: true,
		now: 0,
		quiet: false,
		agentActive: false,
		toolsUsed: true,
		contextBusy: false,
		dashboardKey: "Alt+U",
		learned: (feature: string) => feature === "/help",
		shownBefore: (id: string) => shown[id] ?? 0,
		onShown: (id: string) => {
			shown[id] = (shown[id] ?? 0) + 1;
		},
	};
	for (let session = 0; session < FOOTER_TIP_LIFETIME; session++) match(createDemoHints()(input) ?? "", /\/view/);
	strictEqual(shown.tools, FOOTER_TIP_LIFETIME);
	strictEqual(createDemoHints()(input), null);
});

test("the launchpad shows only the welcome tip, and none where its own hint column teaches", () => {
	const shown: string[] = [];
	const input = {
		enabled: true,
		now: 0,
		quiet: false,
		agentActive: true,
		toolsUsed: true,
		contextBusy: false,
		dashboardKey: "Alt+U",
		launchpad: "plain" as const,
		onShown: (id: string) => shown.push(id),
	};
	const hints = createDemoHints();
	match(hints(input) ?? "", /Ask Clio how it works/);
	// It holds while the launchpad is up and counts once for the session.
	match(hints({ ...input, now: 30_000 }) ?? "", /Ask Clio how it works/);
	deepStrictEqual(shown, ["welcome"]);
	// Once the launchpad goes, the welcome is spent and a specific tip may follow.
	const { launchpad: _gone, ...after } = input;
	match(hints({ ...after, now: 60_000 }) ?? "", /Activity/);
	strictEqual(createDemoHints()({ ...input, launchpad: "hints" }), null);
	strictEqual(createDemoHints()({ ...input, learned: (feature) => feature === "/help" }), null);
});

test("a tip counted in its last session stays up when a notice interrupts it", () => {
	const shown: Record<string, number> = { welcome: FOOTER_TIP_LIFETIME - 1 };
	const input = {
		enabled: true,
		now: 0,
		quiet: false,
		agentActive: false,
		toolsUsed: false,
		contextBusy: false,
		dashboardKey: "Alt+U",
		launchpad: "plain" as const,
		shownBefore: (id: string) => shown[id] ?? 0,
		onShown: (id: string) => {
			shown[id] = (shown[id] ?? 0) + 1;
		},
	};
	const hints = createDemoHints();
	match(hints(input) ?? "", /Ask Clio how it works/);
	strictEqual(hints({ ...input, now: 1_000, quiet: true }), null);
	match(hints({ ...input, now: 20_000 }) ?? "", /Ask Clio how it works/);
	strictEqual(shown.welcome, FOOTER_TIP_LIFETIME);
	strictEqual(createDemoHints()(input), null);
});

test("a slash command with a key earns one nudge naming the key, until the key is used", () => {
	const hints = createDemoHints();
	const input = {
		enabled: true,
		now: 0,
		quiet: false,
		agentActive: false,
		toolsUsed: false,
		contextBusy: false,
		dashboardKey: "Alt+U",
		learned: () => true,
		lastCommand: "/model",
		shortcutFor: (command: string) => (command === "/model" ? "Alt+M" : null),
	};
	match(hints(input) ?? "", /Alt\+M → \/model without typing it/);
	strictEqual(hints({ ...input, now: 60_000 }), null);
	strictEqual(hints({ ...input, now: 120_000, lastCommand: "/help" }), null);
	match(hints({ ...input, now: 180_000, lastCommand: "/fleet", shortcutFor: () => "Alt+W" }) ?? "", /Alt\+W → \/fleet/);
	strictEqual(hints({ ...input, now: 240_000, lastCommand: "/fleet", shortcutFor: () => null }), null);
});

test("a live tip follows current eligibility and keybindings without a late welcome", () => {
	const hints = createDemoHints();
	const input = {
		enabled: true,
		now: 0,
		quiet: false,
		agentActive: true,
		toolsUsed: false,
		contextBusy: false,
		dashboardKey: "alt+u",
	};
	match(hints(input) ?? "", /alt\+u/);
	match(hints({ ...input, now: 100, dashboardKey: "ctrl+x" }) ?? "", /ctrl\+x/);
	strictEqual(hints({ ...input, now: 200, agentActive: false }), null);
	strictEqual(hints({ ...input, now: 60_000, agentActive: false }), null);
});

test("footer tips skip a feature the operator already uses", () => {
	const hints = createDemoHints();
	const input = {
		enabled: true,
		now: 0,
		quiet: false,
		agentActive: false,
		toolsUsed: true,
		contextBusy: false,
		dashboardKey: "alt+u",
		learned: (feature: string) => feature === "/view" || feature === "/help",
	};
	strictEqual(hints(input), null);
	match(hints({ ...input, learned: (feature: string) => feature === "/help" }) ?? "", /\/view/);
});
