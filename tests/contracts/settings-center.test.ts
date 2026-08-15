import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { MAX_TIMER_DELAY_MS } from "../../src/core/timers.js";
import type { ProvidersContract, TargetHealth, TargetStatus } from "../../src/domains/providers/index.js";
import type { Component, OverlayHandle, TUI } from "../../src/engine/tui.js";
import {
	applySettingChange,
	buildSettingItems,
	buildSettingsSections,
	createSettingsChangePlan,
	type EditableSettingId,
	openSettingsOverlay,
	SETTINGS_LABELS_BY_ID,
	SETTINGS_SECTION_ROWS,
	SETTINGS_SECTIONS,
	SettingsCenter,
} from "../../src/interactive/overlays/settings.js";
import { clioTheme, GLYPH } from "../../src/interactive/theme/index.js";

const ESC = String.fromCharCode(27);
const ENTER = "\r";
const DOWN = `${ESC}[B`;
const SGR_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const SCOPE_NOTE = "session, global, or cancel";

/** Rows the overlay deliberately surfaces read-only; they are managed elsewhere. */
const READ_ONLY_IDS = new Set<EditableSettingId>([
	"safetyNet",
	"modelSelector.favorites",
	"theme",
	"targets",
	"keybindings",
	"delegation.agents",
]);

/** The static knob rows; per-entry profile, binding, and target rows are checked separately. */
function isStaticId(id: string): id is keyof typeof SETTINGS_LABELS_BY_ID {
	return id in SETTINGS_LABELS_BY_ID;
}

function settingsWithTargets(): ClioSettings {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [
		{ id: "target-a", runtime: "openai-compat", url: "http://localhost:1111", defaultModel: "model-a" },
		{ id: "target-b", runtime: "openai-compat", url: "http://localhost:2222", defaultModel: "model-b" },
	];
	settings.autonomy = "auto-edit";
	settings.orchestrator = { target: "target-a", model: "model-a", thinkingLevel: "off" };
	settings.background = { target: null, model: null, thinkingLevel: "off" };
	settings.workers.default = { target: "target-a", model: "model-a", thinkingLevel: "off" };
	settings.workers.profiles.fast = { target: "target-b", model: "model-b", thinkingLevel: "off" };
	settings.workers.agentBindings.scout = "fast";
	settings.scope = ["target-a/model-a", "target-b/model-b"];
	settings.budget.sessionCeilingUsd = 5;
	settings.compaction = { auto: true, threshold: 0.8, excludeLastTurns: 6 };
	settings.retry = { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxDelayMs: 60000, streamStallMs: 180000 };
	settings.terminal.showTerminalProgress = false;
	return settings;
}

function providersWithHealth(
	healthByTarget: Readonly<Record<string, TargetHealth["status"]>>,
	settings: Readonly<ClioSettings> = settingsWithTargets(),
): ProvidersContract {
	return {
		list: () =>
			settings.targets.map(
				(target) =>
					({
						target,
						runtime: null,
						available: healthByTarget[target.id] === "healthy",
						reason: healthByTarget[target.id] ?? "unknown",
						health: {
							status: healthByTarget[target.id] ?? "unknown",
							lastCheckAt: null,
							lastError: null,
							latencyMs: null,
						},
						discoveredModels: [],
						capabilities: {},
					}) as unknown as TargetStatus,
			),
	} as unknown as ProvidersContract;
}

function stripAnsi(value: string): string {
	return value.replace(SGR_PATTERN, "");
}

function noopSettingsCenter(bodyHeight: number): SettingsCenter {
	return new SettingsCenter(buildSettingItems(settingsWithTargets()), {
		getBodyHeight: () => bodyHeight,
		prepareChange: () => null,
		onApply: () => undefined,
		onCancel: () => undefined,
	});
}

interface Commit {
	id: string;
	value: string;
	scope: "session" | "global";
}

function spyingSettingsCenter(bodyHeight: number): { center: SettingsCenter; commits: Commit[] } {
	const commits: Commit[] = [];
	const settings = settingsWithTargets();
	const center = new SettingsCenter(buildSettingItems(settings), {
		getBodyHeight: () => bodyHeight,
		prepareChange: (item, value) => createSettingsChangePlan(settings, item, value),
		onApply: (plan, scope) => commits.push({ id: plan.rowId, value: plan.selectedValue, scope }),
		onCancel: () => undefined,
		requestRender: () => undefined,
	});
	return { center, commits };
}

function fakeTui(rows: number, columns: number): { tui: TUI; captured: () => Component | null; renders: () => number } {
	let overlay: Component | null = null;
	let renderCount = 0;
	const handle: OverlayHandle = {
		hide: () => undefined,
		setHidden: () => undefined,
		isHidden: () => false,
		focus: () => undefined,
		unfocus: () => undefined,
		isFocused: () => true,
	};
	const tui = {
		terminal: { rows, columns },
		requestRender: () => {
			renderCount += 1;
		},
		showOverlay: (component: Component) => {
			overlay = component;
			return handle;
		},
	} as unknown as TUI;
	return { tui, captured: () => overlay, renders: () => renderCount };
}

describe("contracts/settings center", () => {
	it("partitions every knob into sections and keeps pointer rows read-only", () => {
		const items = buildSettingItems(settingsWithTargets());
		const expectedIds = SETTINGS_SECTIONS.flatMap((section) => [...SETTINGS_SECTION_ROWS[section.id]]);
		deepStrictEqual(items.map((item) => item.id).filter(isStaticId), expectedIds);

		const sections = buildSettingsSections(items);
		deepStrictEqual(
			sections.map((section) => section.id),
			SETTINGS_SECTIONS.map((section) => section.id),
		);
		for (const section of sections) {
			deepStrictEqual(section.items.map((item) => item.id).filter(isStaticId), [...SETTINGS_SECTION_ROWS[section.id]]);
			for (const item of section.items) {
				if (!isStaticId(item.id)) continue;
				if (READ_ONLY_IDS.has(item.id)) {
					ok(item.readOnly, `${item.id} must be read-only`);
					ok(!item.values && !item.submenu, `${item.id} must not be editable`);
				} else {
					ok(!item.readOnly, `${item.id} must be editable`);
					ok(item.values || item.submenu, `${item.id} must be editable`);
				}
				strictEqual(item.configPath, item.id);
			}
		}
	});

	it("classifies restart-required knobs and treats the rest as live", () => {
		const byId = new Map(buildSettingItems(settingsWithTargets()).map((item) => [item.id, item]));
		strictEqual(byId.get("budget.concurrency")?.scope, "restart");
		strictEqual(byId.get("runtimePlugins")?.scope, "restart");
		strictEqual(byId.get("autonomy")?.scope, "live");
		strictEqual(byId.get("retry.maxRetries")?.scope, "live");
	});

	it("assigns explicit presentation kinds and independently semantic status segments", () => {
		const settings = settingsWithTargets();
		const items = buildSettingItems(settings, {
			providers: providersWithHealth({ "target-a": "healthy", "target-b": "down" }),
			getFleetNodes: () => [
				{
					id: "remote-a",
					host: "remote-a.example",
					kind: "ssh",
					state: "offline",
					stateReason: "unreachable",
					activeWorkers: 0,
					maxWorkers: 4,
					labels: [],
					lastSeenAt: null,
				},
			],
		});
		const byId = new Map(items.map((item) => [item.id, item]));
		strictEqual(byId.get("autonomy")?.presentationKind, "setting");
		strictEqual(byId.get("safetyNet")?.presentationKind, "read-only-fact");
		strictEqual(byId.get("workers.profiles")?.presentationKind, "action");
		strictEqual(byId.get("targets")?.presentationKind, "group-header");
		strictEqual(byId.get("targets.target-b")?.presentationKind, "status");
		deepStrictEqual(byId.get("targets.target-b")?.valueSegments, [{ text: "○ down", tone: "unhealthy" }]);
		strictEqual(byId.get("fleet.nodes.remote-a")?.presentationKind, "status");
		deepStrictEqual(byId.get("fleet.nodes.remote-a")?.valueSegments, [
			{ text: "○ offline", tone: "unhealthy" },
			{ text: " · 0/4 busy", tone: "neutral" },
		]);
		deepStrictEqual(
			buildSettingItems(settings, { getTargetOperation: (targetId) => (targetId === "target-b" ? "probe" : null) }).find(
				(item) => item.id === "targets.target-b",
			)?.valueSegments,
			[{ text: `${GLYPH.running} probing`, tone: "activity" }],
		);
	});

	it("marks destructive submenu actions red while preserving an explicit NO_COLOR label", () => {
		const center = noopSettingsCenter(20);
		center.setSelection("targets", 1);
		center.handleInput(ENTER);
		center.handleInput(DOWN);
		const rendered = center.render(80).join("\n");
		ok(rendered.includes(`${clioTheme().fgSequence("error")}${GLYPH.error} Remove target`));
		ok(stripAnsi(rendered).includes(`${GLYPH.error} Remove target`));
	});

	it("keeps selected focus teal while settled target and node health retain their own colors", () => {
		const settings = settingsWithTargets();
		settings.targets.push(
			{ id: "target-c", runtime: "openai-compat", url: "http://localhost:3333", defaultModel: "model-c" },
			{ id: "target-d", runtime: "openai-compat", url: "http://localhost:4444", defaultModel: "model-d" },
		);
		const items = buildSettingItems(settings, {
			providers: providersWithHealth(
				{ "target-a": "healthy", "target-b": "degraded", "target-c": "down", "target-d": "unknown" },
				settings,
			),
			getFleetNodes: () => [
				{
					id: "remote-a",
					host: "remote-a.example",
					kind: "ssh",
					state: "offline",
					stateReason: null,
					activeWorkers: 0,
					maxWorkers: 1,
					labels: [],
					lastSeenAt: null,
				},
			],
		});
		const center = new SettingsCenter(items, {
			getBodyHeight: () => 30,
			prepareChange: () => null,
			onApply: () => undefined,
			onCancel: () => undefined,
		});
		center.setSelection("targets", 3);
		const targetRender = center.render(112).join("\n");
		const theme = clioTheme();
		ok(targetRender.includes(`${theme.fgSequence("accent")}${GLYPH.cursor} `), "selection owns the teal cursor");
		ok(targetRender.includes(`${theme.fgSequence("success")}${GLYPH.running} healthy`), "healthy stays green");
		ok(targetRender.includes(`${theme.fgSequence("warning")}◐ degraded`), "degraded stays amber");
		ok(targetRender.includes(`${theme.fgSequence("error")}○ down`), "down health remains red under selection");
		ok(!targetRender.includes(`${theme.fgSequence("success")}○ down`), "selection cannot repaint down as healthy");
		ok(targetRender.includes(`${theme.fgSequence("dim")}· unknown`), "unknown remains visibly unsettled");

		center.setSelection("fleet", items.filter((item) => item.section === "fleet").length - 1);
		const nodeRender = center.render(112).join("\n");
		ok(nodeRender.includes(`${theme.fgSequence("error")}○ offline`), "offline is a red status, not a dim fact");
	});

	it("uses a teal change mark instead of the live-operation glyph for modified values", () => {
		const settings = settingsWithTargets();
		settings.retry.maxRetries = 8;
		const center = new SettingsCenter(buildSettingItems(settings), {
			getBodyHeight: () => 26,
			prepareChange: () => null,
			onApply: () => undefined,
			onCancel: () => undefined,
		});
		center.setSelection("retry", 1);
		const rendered = center.render(112).join("\n");
		const theme = clioTheme();
		ok(rendered.includes(theme.fg("accent", `${GLYPH.scoped} `)), "modified row has the change mark");
		ok(rendered.includes("changed (default: 3)"), "detail explains the change mark in text");
		ok(!rendered.includes(`${GLYPH.running} changed`), "settled modification is never presented as live work");
	});

	it("keeps semantic glyph and text fallbacks readable under NO_COLOR", () => {
		const source = `
			import { DEFAULT_SETTINGS } from "./src/core/defaults.ts";
			import { buildSettingItems, SettingsCenter } from "./src/interactive/overlays/settings.ts";
			const settings = structuredClone(DEFAULT_SETTINGS);
			settings.targets = [
				{ id: "healthy-target", runtime: "openai-compat", url: "http://healthy", defaultModel: "m" },
				{ id: "degraded-target", runtime: "openai-compat", url: "http://degraded", defaultModel: "m" },
				{ id: "down-target", runtime: "openai-compat", url: "http://down", defaultModel: "m" },
				{ id: "unknown-target", runtime: "openai-compat", url: "http://unknown", defaultModel: "m" },
			];
			settings.autonomy = "auto-edit";
			settings.retry.maxRetries = 8;
			const states = ["healthy", "degraded", "down", "unknown"];
			const providers = { list: () => settings.targets.map((target, index) => ({ target, runtime: null, available: index === 0, reason: states[index], health: { status: states[index], lastCheckAt: null, lastError: index === 2 ? "offline" : null, latencyMs: null }, capabilities: {}, discoveredModels: [] })) };
			const items = buildSettingItems(settings, { providers, getFleetNodes: () => [{ id: "remote", host: "host", kind: "ssh", state: "offline", stateReason: null, activeWorkers: 0, maxWorkers: 1, labels: [], lastSeenAt: null }] });
			const center = new SettingsCenter(items, { getBodyHeight: () => 30, prepareChange: () => null, onApply: () => {}, onCancel: () => {} });
			center.setSelection("targets", 3);
			const targetLines = center.render(112).join("\\n");
			center.setSelection("fleet", items.filter((item) => item.section === "fleet").length - 1);
			const nodeLines = center.render(112).join("\\n");
			center.setSelection("retry", 1);
			process.stdout.write(targetLines + "\\n" + nodeLines + "\\n" + center.render(112).join("\\n"));
		`;
		const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
			cwd: process.cwd(),
			env: { ...process.env, NO_COLOR: "1" },
			encoding: "utf8",
		});
		strictEqual(child.status, 0, child.stderr);
		ok(!new RegExp(`${ESC}\\[[0-9;]*38(?:;|m)`).test(child.stdout), "NO_COLOR emits no foreground color sequences");
		const plain = stripAnsi(child.stdout);
		ok(plain.includes("❯ down-target"), "focus survives without color");
		ok(plain.includes(`${GLYPH.running} healthy`), "healthy target remains explicit without color");
		ok(plain.includes("◐ degraded"), "degraded target remains explicit without color");
		ok(plain.includes("○ down"), "down target remains explicit without color");
		ok(plain.includes("· unknown"), "unknown target remains explicit without color");
		ok(plain.includes("○ offline"), "offline node remains explicit without color");
		ok(plain.includes("◇") && plain.includes("changed (default: 3)"), "modified state remains explicit without color");
	});

	it("keeps the human label to setting id mapping explicit", () => {
		const labels = Object.fromEntries(
			buildSettingItems(settingsWithTargets())
				.filter((item) => isStaticId(item.id))
				.map((item) => [item.id, item.label]),
		);
		deepStrictEqual(labels, SETTINGS_LABELS_BY_ID);
	});

	it("preserves applySettingChange behavior for every editable id", () => {
		const cases: Array<{ id: EditableSettingId; value: string; assert: (settings: ClioSettings) => void }> = [
			{ id: "autonomy", value: "full-auto", assert: (s) => strictEqual(s.autonomy, "full-auto") },
			{
				id: "workers.onPermission",
				value: "escalate",
				assert: (s) => strictEqual(s.workers.onPermission, "escalate"),
			},
			{
				id: "delegation.defaults.toolGovernance",
				value: "deny-all",
				assert: (s) => strictEqual(s.delegation.defaults.toolGovernance, "deny-all"),
			},
			{
				id: "skills.trustProjectCompatRoots",
				value: "true",
				assert: (s) => strictEqual(s.skills.trustProjectCompatRoots, true),
			},
			{
				id: "orchestrator.thinkingLevel",
				value: "high",
				assert: (s) => strictEqual(s.orchestrator.thinkingLevel, "high"),
			},
			{
				id: "orchestrator.target",
				value: "target-b",
				assert: (s) => {
					strictEqual(s.orchestrator.target, "target-b");
					strictEqual(s.orchestrator.model, "model-b");
				},
			},
			{
				id: "orchestrator.model",
				value: "model-custom",
				assert: (s) => strictEqual(s.orchestrator.model, "model-custom"),
			},
			{
				id: "background.target",
				value: "target-b",
				assert: (s) => {
					strictEqual(s.background.target, "target-b");
					strictEqual(s.background.model, "model-b");
				},
			},
			{
				id: "background.model",
				value: "memory-custom",
				assert: (s) => strictEqual(s.background.model, "memory-custom"),
			},
			{
				id: "background.thinkingLevel",
				value: "low",
				assert: (s) => strictEqual(s.background.thinkingLevel, "low"),
			},
			{
				id: "memory.intervention.enabled",
				value: "false",
				assert: (s) => strictEqual(s.memory.intervention.enabled, false),
			},
			{
				id: "memory.intervention.everyNTools",
				value: "20",
				assert: (s) => strictEqual(s.memory.intervention.everyNTools, 20),
			},
			{
				id: "memory.intervention.windowSteps",
				value: "12",
				assert: (s) => strictEqual(s.memory.intervention.windowSteps, 12),
			},
			{
				id: "memory.intervention.maxTokens",
				value: "200",
				assert: (s) => strictEqual(s.memory.intervention.maxTokens, 200),
			},
			{
				id: "memory.intervention.timeoutMs",
				value: "30000",
				assert: (s) => strictEqual(s.memory.intervention.timeoutMs, 30_000),
			},
			{
				id: "workers.default.target",
				value: "target-b",
				assert: (s) => {
					strictEqual(s.workers.default.target, "target-b");
					strictEqual(s.workers.default.model, "model-b");
				},
			},
			{
				id: "workers.default.model",
				value: "fleet-custom",
				assert: (s) => strictEqual(s.workers.default.model, "fleet-custom"),
			},
			{
				id: "workers.default.thinkingLevel",
				value: "medium",
				assert: (s) => strictEqual(s.workers.default.thinkingLevel, "medium"),
			},
			{ id: "workers.maxRetries", value: "5", assert: (s) => strictEqual(s.workers.maxRetries, 5) },
			{ id: "modelSelector.recentLimit", value: "20", assert: (s) => strictEqual(s.modelSelector.recentLimit, 20) },
			{ id: "defaults.maxTokens", value: "65536", assert: (s) => strictEqual(s.defaults.maxTokens, 65536) },
			{ id: "defaults.maxTokens", value: "0", assert: (s) => strictEqual(s.defaults.maxTokens, 0) },
			{ id: "budget.concurrency", value: "auto", assert: (s) => strictEqual(s.budget.concurrency, "auto") },
			{ id: "budget.concurrency", value: "4", assert: (s) => strictEqual(s.budget.concurrency, 4) },
			{
				id: "budget.sessionCeilingUsd",
				value: "12.5",
				assert: (s) => strictEqual(s.budget.sessionCeilingUsd, 12.5),
			},
			{
				id: "scope",
				value: "target-b/model-b, target-a/model-a",
				assert: (s) => deepStrictEqual(s.scope, ["target-b/model-b", "target-a/model-a"]),
			},
			{ id: "compaction.auto", value: "false", assert: (s) => strictEqual(s.compaction.auto, false) },
			{
				id: "compaction.excludeLastTurns",
				value: "10",
				assert: (s) => strictEqual(s.compaction.excludeLastTurns, 10),
			},
			{ id: "compaction.threshold", value: "0.9", assert: (s) => strictEqual(s.compaction.threshold, 0.9) },
			{ id: "compaction.model", value: "prov/sum", assert: (s) => strictEqual(s.compaction.model, "prov/sum") },
			{ id: "compaction.model", value: "  ", assert: (s) => strictEqual("model" in s.compaction, false) },
			{
				id: "compaction.systemPrompt",
				value: "~/p.md",
				assert: (s) => strictEqual(s.compaction.systemPrompt, "~/p.md"),
			},
			{ id: "retry.enabled", value: "false", assert: (s) => strictEqual(s.retry.enabled, false) },
			{ id: "retry.maxRetries", value: "8", assert: (s) => strictEqual(s.retry.maxRetries, 8) },
			{ id: "retry.baseDelayMs", value: "5000", assert: (s) => strictEqual(s.retry.baseDelayMs, 5000) },
			{ id: "retry.maxDelayMs", value: "120000", assert: (s) => strictEqual(s.retry.maxDelayMs, 120000) },
			{
				id: "terminal.showTerminalProgress",
				value: "true",
				assert: (s) => strictEqual(s.terminal.showTerminalProgress, true),
			},
			{
				id: "terminal.outputVerbosity",
				value: "verbose",
				assert: (s) => strictEqual(s.terminal.outputVerbosity, "verbose"),
			},
			{ id: "identity", value: "atlas", assert: (s) => strictEqual(s.identity, "atlas") },
			{
				id: "runtimePlugins",
				value: "@scope/a, @scope/b",
				assert: (s) => deepStrictEqual(s.runtimePlugins, ["@scope/a", "@scope/b"]),
			},
			{
				id: "delegation.defaults.connectTimeoutMs",
				value: "45000",
				assert: (s) => strictEqual(s.delegation.defaults.connectTimeoutMs, 45000),
			},
			{
				id: "delegation.defaults.turnTimeoutMs",
				value: "600000",
				assert: (s) => strictEqual(s.delegation.defaults.turnTimeoutMs, 600000),
			},
			{
				id: "delegation.defaults.permissionTimeoutMs",
				value: "90000",
				assert: (s) => strictEqual(s.delegation.defaults.permissionTimeoutMs, 90000),
			},
		];

		for (const testCase of cases) {
			const settings = settingsWithTargets();
			applySettingChange(settings, testCase.id, testCase.value);
			testCase.assert(settings);
		}
	});

	it("does not let the settings UI store unschedulable ACP request bounds", () => {
		for (const id of [
			"delegation.defaults.connectTimeoutMs",
			"delegation.defaults.turnTimeoutMs",
			"delegation.defaults.permissionTimeoutMs",
		] as const) {
			for (const invalid of ["0", String(MAX_TIMER_DELAY_MS + 1)]) {
				const settings = settingsWithTargets();
				const key = id.slice("delegation.defaults.".length) as keyof typeof settings.delegation.defaults;
				const before = settings.delegation.defaults[key];
				applySettingChange(settings, id, invalid);
				strictEqual(settings.delegation.defaults[key], before, `${id}=${invalid}`);
			}
		}
	});

	// Same arithmetic as the two-lane cases below: the body is the terminal
	// width less eight, so a 120-column terminal renders at 112 and a
	// 119-column one at 111. Those two widths straddle the three-column floor.
	it("renders a three-lane center at a 120-column terminal (112 inner columns)", () => {
		const center = noopSettingsCenter(26);
		const lines = center.render(112);
		const rendered = stripAnsi(lines.join("\n"));
		strictEqual(lines.length, 26);
		ok(rendered.includes("Sections"));
		ok(rendered.includes("Autonomy & Safety"));
		ok(rendered.includes("Models"));
		ok(rendered.includes("Advanced"));
		ok(rendered.includes("Autonomy level"));
		const dividers = stripAnsi(lines[0] ?? "").split("│").length - 1;
		strictEqual(dividers, 2, "112 inner columns earn the description its own column");
		ok(rendered.includes("How freely Clio acts"), "the description column carries the explanation");
		ok(rendered.includes(SCOPE_NOTE), "the description column states the live/global scope");
	});

	it("renders a two-lane center with a breadcrumb footer at a 119-column terminal (111 inner columns)", () => {
		const center = noopSettingsCenter(26);
		const lines = center.render(111);
		const rendered = stripAnsi(lines.join("\n"));
		strictEqual(lines.length, 26);
		ok(rendered.includes("Sections"));
		ok(rendered.includes("Autonomy level"));
		ok(rendered.includes("autonomy"), "config path column shows at full width");
		const dividers = stripAnsi(lines[0] ?? "").split("│").length - 1;
		strictEqual(dividers, 1, "one column short of the floor stays two-lane");
		ok(rendered.includes("How freely Clio acts"));
		ok(rendered.includes("Autonomy & Safety › Autonomy level"), "footer breadcrumb");
		ok(rendered.includes(SCOPE_NOTE), "footer states the live/global scope");
	});

	// The two nested frames above this body each cost a border and a pad, so an
	// 80-column terminal renders at 72 and a 76-column one at 68. Both cases
	// below use the width the terminal they name actually produces.
	it("renders two lanes at an 80-column terminal (72 inner columns)", () => {
		const center = noopSettingsCenter(16);
		const lines = center.render(72);
		const rendered = stripAnsi(lines.join("\n"));
		strictEqual(lines.length, 16);
		ok(rendered.includes("Sections"));
		ok(rendered.includes("Autonomy level"));
		ok(rendered.includes("│"), "an 80-column terminal gets the two-lane layout");
	});

	it("renders a stacked center below the two-lane floor (76-column terminal)", () => {
		const center = noopSettingsCenter(16);
		const lines = center.render(68);
		const rendered = stripAnsi(lines.join("\n"));
		strictEqual(lines.length, 16);
		ok(rendered.includes("Autonomy"));
		ok(rendered.includes("Autonomy level"));
		ok(!rendered.includes("│"), "narrow layout should not include the lane divider");
	});

	it("stays legible on an extremely narrow terminal by dropping the path column", () => {
		const center = noopSettingsCenter(20);
		const lines = center.render(40);
		strictEqual(lines.length, 20);
		const rendered = stripAnsi(lines.join("\n"));
		ok(rendered.includes("auto-edit"), "value stays visible when the path column is dropped");
	});

	it("never overflows a very short terminal", () => {
		const center = noopSettingsCenter(6);
		strictEqual(center.render(100).length, 6);
		strictEqual(center.render(40).length, 6);
	});

	it("Space previews a value; Enter opens a picker and an explicit destination commits it", () => {
		const { center, commits } = spyingSettingsCenter(26);
		center.setSelection("safety", 0); // autonomy = auto-edit
		center.handleInput(" "); // preview → full-auto
		strictEqual(commits.length, 0, "preview must not commit");
		const previewed = stripAnsi(center.render(112).join("\n"));
		ok(previewed.includes("full-auto"), "preview value is shown");
		center.handleInput(ENTER); // value picker preselected to the preview
		strictEqual(commits.length, 0, "opening the picker must not commit");
		center.handleInput(ENTER); // choose full-auto and open the destination prompt
		strictEqual(commits.length, 0, "choosing a value must not commit");
		center.handleInput(ENTER); // Apply this session
		deepStrictEqual(commits, [{ id: "autonomy", value: "full-auto", scope: "session" }]);
	});

	it("keeps the destination tail visible in narrow and long confirmation titles", () => {
		const live = { current: settingsWithTargets() };
		const fake = fakeTui(24, 40);
		openSettingsOverlay(fake.tui, {
			getSettings: () => live.current,
			writeSettings: (next) => {
				live.current = next;
			},
			onClose: () => undefined,
		});
		const overlay = fake.captured();
		ok(overlay);
		overlay.handleInput?.(ENTER); // value picker, preselected to auto-edit
		overlay.handleInput?.(DOWN); // full-auto
		overlay.handleInput?.(ENTER); // destination prompt
		const narrowTitle = stripAnsi(overlay.render(40).join("\n"));
		ok(narrowTitle.includes("Autonomy level: → full-auto"), narrowTitle);
		ok(!narrowTitle.includes("auto-edit →"), "the origin is dropped before the destination");

		const settings = settingsWithTargets();
		settings.orchestrator.model = "origin-model-id-that-must-drop-before-the-new-value";
		const item = buildSettingItems(settings).find((candidate) => candidate.id === "orchestrator.model");
		ok(item);
		const destination = "provider/model-with-a-long-destination-ending-in-KEEP-DESTINATION-TAIL";
		delete item.submenu;
		item.values = [destination];
		const wide = new SettingsCenter(
			buildSettingItems(settings).map((candidate) => (candidate.id === item.id ? item : candidate)),
			{
				getBodyHeight: () => 26,
				prepareChange: (candidate, value) => createSettingsChangePlan(settings, candidate, value),
				onApply: () => undefined,
				onCancel: () => undefined,
			},
		);
		wide.setSelection("orchestrator", 2);
		wide.handleInput(ENTER); // one-entry value picker
		wide.handleInput(ENTER); // destination prompt
		const wideTitle = stripAnsi(wide.render(120)[0] ?? "");
		ok(wideTitle.includes("KEEP-DESTINATION-TAIL"), wideTitle);
		ok(!wideTitle.includes("origin-model-id"), "the long origin cannot consume the destination");
	});

	it("opens provider-backed model pickers on their current values", () => {
		const settings = settingsWithTargets();
		settings.orchestrator.model = "model-25";
		settings.workers.default.model = "model-25";
		const models = Array.from({ length: 36 }, (_, index) => `model-${String(index).padStart(2, "0")}`);
		const base = providersWithHealth({ "target-a": "healthy", "target-b": "healthy" }, settings);
		const statuses = base.list().map((status) => ({
			...status,
			discoveredModels: status.target.id === "target-a" ? models : status.discoveredModels,
			discoveredModelsSource: status.target.id === "target-a" ? ("probe" as const) : status.discoveredModelsSource,
		}));
		const providers = { ...base, list: () => statuses } as ProvidersContract;
		const byId = new Map(buildSettingItems(settings, { providers }).map((item) => [item.id, item]));
		for (const id of ["orchestrator.model", "workers.default.model"] as const) {
			const item = byId.get(id);
			ok(item?.submenu);
			const picker = item.submenu(item.currentValue, () => undefined);
			const rendered = stripAnsi(picker.render(80).join("\n"));
			ok(rendered.includes(`${GLYPH.cursor} model-25`), `${id} cursor:\n${rendered}`);
		}
	});

	it("cycles worker approvals routing to escalate and persists it", () => {
		const settings = settingsWithTargets();
		const workerRouting = buildSettingItems(settings).find((item) => item.id === "workers.onPermission");
		ok(workerRouting);
		deepStrictEqual(workerRouting.values, ["deny", "fail", "escalate"]);

		const { center, commits } = spyingSettingsCenter(26);
		center.setSelection("safety", 1); // workers.onPermission = deny
		center.handleInput(" "); // preview -> fail
		center.handleInput(" "); // preview -> escalate
		const previewed = stripAnsi(center.render(112).join("\n"));
		ok(previewed.includes("escalate"), "preview reaches escalate");
		center.handleInput(ENTER); // picker preselected to escalate
		center.handleInput(ENTER); // destination prompt
		center.handleInput(ENTER); // session
		deepStrictEqual(commits, [{ id: "workers.onPermission", value: "escalate", scope: "session" }]);

		applySettingChange(settings, "workers.onPermission", "escalate");
		strictEqual(settings.workers.onPermission, "escalate");
		const reloaded = buildSettingItems(settings).find((item) => item.id === "workers.onPermission");
		strictEqual(reloaded?.currentValue, "escalate");
	});

	it("Enter opens an enum picker and global apply performs no preliminary session commit", () => {
		const { center, commits } = spyingSettingsCenter(26);
		center.setSelection("safety", 0); // autonomy
		center.handleInput(ENTER); // picker, preselected to auto-edit
		strictEqual(commits.length, 0);
		center.handleInput(DOWN); // full-auto
		center.handleInput(ENTER); // destination prompt, still unchanged
		strictEqual(commits.length, 0);
		center.handleInput(DOWN); // Apply and save globally
		center.handleInput(ENTER);
		deepStrictEqual(commits, [{ id: "autonomy", value: "full-auto", scope: "global" }]);
	});

	it("Esc cancels both the enum picker and the destination prompt without mutation", () => {
		const { center, commits } = spyingSettingsCenter(26);
		center.setSelection("safety", 0);
		center.handleInput(ENTER); // picker
		center.handleInput(ESC);
		strictEqual(commits.length, 0, "picker Esc is inert");
		center.handleInput(ENTER);
		center.handleInput(DOWN);
		center.handleInput(ENTER); // destination prompt
		center.handleInput(ESC);
		strictEqual(commits.length, 0, "destination Esc is Cancel");
	});

	it("a restart-required knob is global-only and never applies to the session", () => {
		const { center, commits } = spyingSettingsCenter(26);
		center.setSelection("budget", 2); // budget.concurrency = auto
		center.handleInput(ENTER); // value picker preselected to auto
		center.handleInput(DOWN); // 1
		center.handleInput(ENTER); // global-only destination prompt
		strictEqual(commits.length, 0, "restart knobs do not apply live");
		center.handleInput(ENTER); // choose: save globally
		deepStrictEqual(commits, [{ id: "budget.concurrency", value: "1", scope: "global" }]);
	});

	it("refreshRows keeps section and row selection across a live value change", () => {
		const live = { current: settingsWithTargets() };
		const fake = fakeTui(24, 100);
		const handle = openSettingsOverlay(fake.tui, {
			getSettings: () => live.current,
			writeSettings: (next) => {
				live.current = next;
			},
			onClose: () => undefined,
		});
		const overlay = fake.captured();
		ok(overlay, "expected settings overlay component");

		// Navigate to Retry → Max retries by driving keys through the frame.
		overlay.handleInput?.("\t"); // sections lane
		for (let i = 0; i < 7; i += 1) overlay.handleInput?.("j"); // safety→…→targets→…→retry
		overlay.handleInput?.("\t"); // rows lane
		overlay.handleInput?.("j"); // → Max retries

		live.current.retry.maxRetries = 8;
		handle.refreshRows();

		const rendered = stripAnsi(overlay.render(120).join("\n"));
		ok(rendered.includes("❯ Max retries"), rendered);
		ok(rendered.includes("retry.maxRetries"));
		ok(rendered.includes("8"));
		ok(fake.renders() > 0);
	});

	it("opens focused on the deep-linked section", () => {
		const live = { current: settingsWithTargets() };
		const fake = fakeTui(24, 100);
		openSettingsOverlay(fake.tui, {
			getSettings: () => live.current,
			writeSettings: (next) => {
				live.current = next;
			},
			section: "retry",
			onClose: () => undefined,
		});
		const overlay = fake.captured();
		ok(overlay, "expected settings overlay component");
		const rendered = stripAnsi(overlay.render(120).join("\n"));
		ok(rendered.includes("❯ Retry transien"), rendered);
		ok(rendered.includes("retry.enabled"), rendered);
	});

	it("routes one explicit global commit through commitSetting and emits a scoped notice", () => {
		const live = { current: settingsWithTargets() };
		const fake = fakeTui(24, 100);
		const calls: Array<{ id: string; scope: "session" | "global" }> = [];
		const notices: Array<{ level: string; text: string; key?: string | undefined }> = [];
		openSettingsOverlay(fake.tui, {
			getSettings: () => live.current,
			writeSettings: (next) => {
				live.current = next;
			},
			commitSetting: (id, next, scope) => {
				calls.push({ id, scope });
				live.current = next;
			},
			notice: (level, text, key) => notices.push({ level, text, key }),
			onClose: () => undefined,
		});
		const overlay = fake.captured();
		ok(overlay, "expected settings overlay component");

		overlay.handleInput?.(ENTER); // autonomy value picker
		overlay.handleInput?.(DOWN); // full-auto
		overlay.handleInput?.(ENTER); // destination prompt
		overlay.handleInput?.(DOWN); // Apply and save globally
		overlay.handleInput?.(ENTER);

		deepStrictEqual(calls, [{ id: "autonomy", scope: "global" }]);
		strictEqual(notices.length, 1);
		strictEqual(notices[0]?.text, "autonomy set to full-auto (saved globally)");
		strictEqual(notices[0]?.key, "settings:autonomy");
	});

	it("falls back to writeSettings when no scoped commit handler is wired", () => {
		const live = { current: settingsWithTargets() };
		const fake = fakeTui(24, 100);
		let writes = 0;
		openSettingsOverlay(fake.tui, {
			getSettings: () => live.current,
			writeSettings: (next) => {
				writes += 1;
				live.current = next;
			},
			onClose: () => undefined,
		});
		const overlay = fake.captured();
		ok(overlay, "expected settings overlay component");
		overlay.handleInput?.(ENTER); // picker, current value
		overlay.handleInput?.(DOWN); // full-auto
		overlay.handleInput?.(ENTER); // global-only destination prompt
		overlay.handleInput?.(ENTER); // global
		strictEqual(writes, 1, "the fallback is explicitly global and writes exactly once");
	});
	it("renders fleet profiles, agent bindings, and targets as per-entry rows in their sections", () => {
		const settings = settingsWithTargets();
		settings.workers.agentBindings.researcher = "missing";
		const sections = new Map(buildSettingsSections(buildSettingItems(settings)).map((s) => [s.id, s.items]));
		deepStrictEqual(
			sections.get("fleet")?.map((item) => item.id),
			[
				"workers.default.target",
				"workers.default.model",
				"workers.default.thinkingLevel",
				"workers.profiles",
				"workers.profiles.fast.target",
				"workers.profiles.fast.model",
				"workers.profiles.fast.thinkingLevel",
				"workers.profiles.fast.node",
				"workers.agentBindings",
				"workers.agentBindings.researcher",
				"workers.agentBindings.scout",
				"workers.maxRetries",
			],
		);
		deepStrictEqual(
			sections.get("targets")?.map((item) => item.id),
			["targets", "targets.target-a", "targets.target-b"],
		);
		const byId = new Map(buildSettingItems(settings).map((item) => [item.id, item]));
		strictEqual(byId.get("workers.profiles")?.currentValue, "1 profile(s)");
		ok(byId.get("workers.profiles")?.submenu, "the profiles row adds a profile");
		ok(byId.get("workers.agentBindings")?.submenu, "the bindings row binds an agent");
		strictEqual(byId.get("workers.profiles.fast.target")?.currentValue, "target-b");
		strictEqual(byId.get("workers.profiles.fast.model")?.currentValue, "model-b");
		strictEqual(byId.get("workers.profiles.fast.thinkingLevel")?.currentValue, "off");
		strictEqual(byId.get("workers.profiles.fast.node")?.currentValue, "(auto placement)");
		strictEqual(byId.get("workers.agentBindings.scout")?.currentValue, "fast");
		ok(byId.get("workers.agentBindings.researcher")?.description.includes("does not exist"));
		strictEqual(byId.get("targets.target-a")?.currentValue, "chat+fleet · unknown");
		strictEqual(byId.get("targets.target-b")?.currentValue, "unknown");
		ok(byId.get("targets")?.readOnly, "adding a target stays with `clio-coder targets add`");
		for (const id of ["workers.profiles.fast.target", "workers.agentBindings.scout", "targets.target-a"]) {
			const item = byId.get(id as EditableSettingId);
			ok(item?.submenu, `${id} is editable`);
			strictEqual(item?.configPath, id);
		}
	});

	it("bindings cannot be added until a profile exists", () => {
		const settings = settingsWithTargets();
		settings.workers.profiles = {};
		settings.workers.agentBindings = {};
		const row = buildSettingItems(settings).find((item) => item.id === "workers.agentBindings");
		ok(row?.readOnly);
		strictEqual(row?.affordance, "create a profile first");
	});

	it("applies per-entry changes through the shared targets/fleet mutations", () => {
		const cases: Array<{ id: string; value: string; assert: (settings: ClioSettings) => void }> = [
			{
				id: "workers.profiles",
				value: "slow -> target-a",
				assert: (s) =>
					deepStrictEqual(s.workers.profiles.slow, { target: "target-a", model: "model-a", thinkingLevel: "off" }),
			},
			{
				id: "workers.profiles.fast.target",
				value: "target-a",
				assert: (s) =>
					deepStrictEqual(s.workers.profiles.fast, { target: "target-a", model: "model-a", thinkingLevel: "off" }),
			},
			{
				id: "workers.profiles.fast.model",
				value: "model-x",
				assert: (s) => strictEqual(s.workers.profiles.fast?.model, "model-x"),
			},
			{
				id: "workers.profiles.fast.thinkingLevel",
				value: "high",
				assert: (s) => strictEqual(s.workers.profiles.fast?.thinkingLevel, "high"),
			},
			{
				id: "workers.profiles.fast.node",
				value: "local",
				assert: (s) => strictEqual(s.workers.profiles.fast?.node, "local"),
			},
			{
				id: "workers.profiles.fast.node",
				value: "(auto placement)",
				assert: (s) => strictEqual("node" in (s.workers.profiles.fast ?? {}), false),
			},
			{
				id: "workers.profiles.fast.target",
				value: "(remove profile)",
				assert: (s) => {
					strictEqual("fast" in s.workers.profiles, false);
					strictEqual("scout" in s.workers.agentBindings, false, "bindings to the removed profile go with it");
				},
			},
			{
				id: "workers.agentBindings",
				value: "researcher -> fast",
				assert: (s) => strictEqual(s.workers.agentBindings.researcher, "fast"),
			},
			{
				id: "workers.agentBindings.scout",
				value: "(unbind)",
				assert: (s) => strictEqual("scout" in s.workers.agentBindings, false),
			},
			{
				id: "targets.target-b",
				value: "use",
				assert: (s) => {
					strictEqual(s.orchestrator.target, "target-b");
					strictEqual(s.orchestrator.model, "model-b");
					strictEqual(s.workers.default.target, "target-b");
					strictEqual(s.workers.default.model, "model-b");
				},
			},
			{
				id: "targets.target-a",
				value: "remove",
				assert: (s) => {
					deepStrictEqual(
						s.targets.map((t) => t.id),
						["target-b"],
					);
					strictEqual(s.orchestrator.target, null);
					strictEqual(s.workers.default.target, null);
					deepStrictEqual(s.scope, ["target-b/model-b"]);
				},
			},
		];
		for (const testCase of cases) {
			const settings = settingsWithTargets();
			applySettingChange(settings, testCase.id, testCase.value);
			testCase.assert(settings);
		}
		const settings = settingsWithTargets();
		settings.delegation.agents = [
			{ id: "acp-agent", command: "acp", args: [], env: {}, cwd: null, description: "" } as never,
		];
		applySettingChange(settings, "workers.agentBindings", "acp-agent -> fast");
		strictEqual("acp-agent" in settings.workers.agentBindings, false, "ACP agents cannot be bound");
	});

	it("keeps dynamic target, profile, binding, and node plans immutable across session/global/cancel reopen", () => {
		type Destination = "session" | "global" | "cancel";
		interface PlanCase {
			name: string;
			id: EditableSettingId;
			value: string;
			setup?: (settings: ClioSettings) => void;
			paths: string[];
			assertApplied: (settings: ClioSettings) => void;
		}
		const cases: PlanCase[] = [
			{
				name: "target use",
				id: "targets.target-b",
				value: "use",
				paths: ["orchestrator.model", "orchestrator.target", "workers.default.model", "workers.default.target"],
				assertApplied: (settings) => {
					strictEqual(settings.orchestrator.target, "target-b");
					strictEqual(settings.workers.default.target, "target-b");
				},
			},
			{
				name: "target remove",
				id: "targets.target-a",
				value: "remove",
				paths: [
					"orchestrator.model",
					"orchestrator.target",
					"scope",
					"targets",
					"workers.default.model",
					"workers.default.target",
				],
				assertApplied: (settings) =>
					deepStrictEqual(
						settings.targets.map((target) => target.id),
						["target-b"],
					),
			},
			{
				name: "profile add",
				id: "workers.profiles",
				value: "slow -> target-a",
				paths: ["workers.profiles.slow"],
				assertApplied: (settings) => strictEqual(settings.workers.profiles.slow?.target, "target-a"),
			},
			{
				name: "profile change",
				id: "workers.profiles.fast.target",
				value: "target-a",
				paths: ["workers.profiles.fast"],
				assertApplied: (settings) => strictEqual(settings.workers.profiles.fast?.target, "target-a"),
			},
			{
				name: "profile remove",
				id: "workers.profiles.fast.target",
				value: "(remove profile)",
				paths: ["workers.agentBindings.scout", "workers.profiles.fast"],
				assertApplied: (settings) => strictEqual("fast" in settings.workers.profiles, false),
			},
			{
				name: "binding add",
				id: "workers.agentBindings",
				value: "researcher -> fast",
				paths: ["workers.agentBindings.researcher"],
				assertApplied: (settings) => strictEqual(settings.workers.agentBindings.researcher, "fast"),
			},
			{
				name: "binding change",
				id: "workers.agentBindings.scout",
				value: "slow",
				setup: (settings) => {
					settings.workers.profiles.slow = { target: "target-a", model: "model-a", thinkingLevel: "off" };
				},
				paths: ["workers.agentBindings.scout"],
				assertApplied: (settings) => strictEqual(settings.workers.agentBindings.scout, "slow"),
			},
			{
				name: "binding unbind",
				id: "workers.agentBindings.scout",
				value: "(unbind)",
				paths: ["workers.agentBindings.scout"],
				assertApplied: (settings) => strictEqual("scout" in settings.workers.agentBindings, false),
			},
			{
				name: "node pin",
				id: "workers.profiles.fast.node",
				value: "local",
				paths: ["workers.profiles.fast"],
				assertApplied: (settings) => strictEqual(settings.workers.profiles.fast?.node, "local"),
			},
			{
				name: "node auto placement",
				id: "workers.profiles.fast.node",
				value: "(auto placement)",
				setup: (settings) => {
					if (settings.workers.profiles.fast) settings.workers.profiles.fast.node = "local";
				},
				paths: ["workers.profiles.fast"],
				assertApplied: (settings) => strictEqual("node" in (settings.workers.profiles.fast ?? {}), false),
			},
		];

		for (const testCase of cases) {
			for (const destination of ["session", "global", "cancel"] as const satisfies readonly Destination[]) {
				const original = settingsWithTargets();
				testCase.setup?.(original);
				const saved = structuredClone(original);
				const item = buildSettingItems(original).find((candidate) => candidate.id === testCase.id);
				ok(item, `${testCase.name}: editable row exists`);
				const plan = createSettingsChangePlan(original, item, testCase.value);
				ok(plan, `${testCase.name}: change produces a plan`);
				deepStrictEqual(
					plan.leaves.map((leaf) => leaf.path).sort(),
					[...testCase.paths].sort(),
					`${testCase.name}: exact leaves`,
				);
				ok(Object.isFrozen(plan) && Object.isFrozen(plan.original) && Object.isFrozen(plan.proposed));

				let effective = structuredClone(original);
				let persisted = saved;
				if (destination === "session") effective = structuredClone(plan.proposed) as ClioSettings;
				if (destination === "global") {
					effective = structuredClone(plan.proposed) as ClioSettings;
					persisted = structuredClone(plan.proposed) as ClioSettings;
				}
				const reopened = destination === "session" ? effective : structuredClone(persisted);
				if (destination === "cancel") deepStrictEqual(reopened, original, `${testCase.name}: cancel is inert`);
				else testCase.assertApplied(reopened);
				if (destination === "session") deepStrictEqual(persisted, saved, `${testCase.name}: session is not saved`);
			}
		}
	});

	it("commits every leaf a per-entry action touches and refreshes the rows", () => {
		const live = { current: settingsWithTargets() };
		const fake = fakeTui(30, 120);
		const calls: Array<{ id: string; scope: "session" | "global" }> = [];
		openSettingsOverlay(fake.tui, {
			getSettings: () => live.current,
			writeSettings: (next) => {
				live.current = next;
			},
			commitSetting: (id, next, scope) => {
				calls.push({ id, scope });
				live.current = next;
			},
			section: "targets",
			onClose: () => undefined,
		});
		const overlay = fake.captured();
		ok(overlay, "expected settings overlay component");
		overlay.handleInput?.("j"); // targets.target-a
		overlay.handleInput?.("j"); // targets.target-b
		overlay.handleInput?.(ENTER); // actions
		overlay.handleInput?.(ENTER); // use (first action)
		overlay.handleInput?.(ENTER); // Apply this session
		deepStrictEqual(calls.map((call) => call.id).sort(), [
			"orchestrator.model",
			"orchestrator.target",
			"workers.default.model",
			"workers.default.target",
		]);
		ok(calls.every((call) => call.scope === "session"));
		const rendered = stripAnsi(overlay.render(120).join("\n"));
		ok(rendered.includes("target-b"), rendered);
		ok(rendered.includes("chat+fleet"), "the target row shows the roles it now serves");
		ok(rendered.includes("next dispatch"), "propagation shows inline");
	});

	it("reuses the target plan for global apply and makes confirmation Esc a true cancellation", () => {
		for (const destination of ["global", "cancel"] as const) {
			const live = { current: settingsWithTargets() };
			const original = structuredClone(live.current);
			const fake = fakeTui(30, 120);
			const calls: Array<{ id: string; scope: "session" | "global" }> = [];
			openSettingsOverlay(fake.tui, {
				getSettings: () => live.current,
				writeSettings: (next) => {
					live.current = next;
				},
				commitSetting: (id, next, scope) => {
					calls.push({ id, scope });
					live.current = next;
				},
				section: "targets",
				onClose: () => undefined,
			});
			const overlay = fake.captured();
			ok(overlay);
			overlay.handleInput?.("j");
			overlay.handleInput?.("j"); // targets.target-b
			overlay.handleInput?.(ENTER); // actions
			overlay.handleInput?.(ENTER); // use -> destination prompt
			if (destination === "global") {
				overlay.handleInput?.(DOWN);
				overlay.handleInput?.(ENTER);
				deepStrictEqual(calls.map((call) => call.id).sort(), [
					"orchestrator.model",
					"orchestrator.target",
					"workers.default.model",
					"workers.default.target",
				]);
				ok(
					calls.every((call) => call.scope === "global"),
					"no preliminary session pass",
				);
				strictEqual(live.current.orchestrator.target, "target-b");
			} else {
				overlay.handleInput?.(ESC);
				deepStrictEqual(calls, []);
				deepStrictEqual(live.current, original);
			}
		}
	});

	it("runs the connect flow from a target row without committing, then refreshes the rows", async () => {
		const live = { current: settingsWithTargets() };
		const fake = fakeTui(30, 120);
		const calls: string[] = [];
		const connected: string[] = [];
		let resolveConnect: (() => void) | undefined;
		openSettingsOverlay(fake.tui, {
			getSettings: () => live.current,
			writeSettings: (next) => {
				live.current = next;
			},
			commitSetting: (id, next) => {
				calls.push(id);
				live.current = next;
			},
			connectTarget: (targetId) => {
				connected.push(targetId);
				return new Promise<void>((resolve) => {
					resolveConnect = resolve;
				});
			},
			section: "targets",
			onClose: () => undefined,
		});
		const overlay = fake.captured();
		ok(overlay, "expected settings overlay component");
		strictEqual(
			buildSettingItems(live.current, { connectTarget: () => undefined }).find((item) => item.id === "targets.target-b")
				?.affordance,
			"Enter: use, connect, probe, remove",
		);
		overlay.handleInput?.("j"); // targets.target-a
		overlay.handleInput?.("j"); // targets.target-b
		overlay.handleInput?.(ENTER); // actions: use, connect, remove (no providers, so no probe)
		overlay.handleInput?.(DOWN);
		overlay.handleInput?.(ENTER); // connect
		deepStrictEqual(connected, ["target-b"]);
		deepStrictEqual(calls, [], "connect is an action, not a settings change");
		const running = overlay.render(120).join("\n");
		ok(
			running.includes(`${clioTheme().fgSequence("action")}${GLYPH.running} connecting`),
			"only live connect work is orange",
		);
		const renders = fake.renders();
		resolveConnect?.();
		await Promise.resolve();
		await Promise.resolve();
		ok(fake.renders() > renders, "the rows re-derive once the connect flow settles");
		ok(!overlay.render(120).join("\n").includes(`${GLYPH.running} connecting`), "settled connect clears live activity");
	});

	it("keeps newer target work visible when overlapping operations settle out of order", async () => {
		const live = { current: settingsWithTargets() };
		const fake = fakeTui(30, 120);
		let resolveConnect: (() => void) | undefined;
		let resolveProbe: (() => void) | undefined;
		const providers = {
			...providersWithHealth({ "target-a": "healthy", "target-b": "unknown" }),
			probeTarget: () =>
				new Promise<TargetStatus | null>((resolve) => {
					resolveProbe = () => resolve(null);
				}),
		} as unknown as ProvidersContract;
		openSettingsOverlay(fake.tui, {
			getSettings: () => live.current,
			writeSettings: (next) => {
				live.current = next;
			},
			providers,
			connectTarget: () =>
				new Promise<void>((resolve) => {
					resolveConnect = resolve;
				}),
			section: "targets",
			onClose: () => undefined,
		});
		const overlay = fake.captured();
		ok(overlay);
		overlay.handleInput?.("j");
		overlay.handleInput?.("j"); // target-b
		overlay.handleInput?.(ENTER); // connect, probe, remove
		overlay.handleInput?.(ENTER); // connect
		overlay.handleInput?.(ENTER); // reopen actions while connect runs
		overlay.handleInput?.(DOWN);
		overlay.handleInput?.(ENTER); // probe replaces the visible operation for this target
		ok(stripAnsi(overlay.render(120).join("\n")).includes(`${GLYPH.running} probing`));

		resolveConnect?.();
		await Promise.resolve();
		await Promise.resolve();
		ok(
			stripAnsi(overlay.render(120).join("\n")).includes(`${GLYPH.running} probing`),
			"an older connect settlement cannot clear the newer probe token",
		);
		resolveProbe?.();
		await Promise.resolve();
		await Promise.resolve();
		ok(!stripAnsi(overlay.render(120).join("\n")).includes(`${GLYPH.running} probing`));
	});

	it("clears probe activity when a provider throws before returning a promise", () => {
		const live = { current: settingsWithTargets() };
		const fake = fakeTui(30, 120);
		const providers = {
			...providersWithHealth({ "target-a": "healthy", "target-b": "unknown" }),
			probeTarget: () => {
				throw new Error("synchronous probe failure");
			},
		} as unknown as ProvidersContract;
		openSettingsOverlay(fake.tui, {
			getSettings: () => live.current,
			writeSettings: (next) => {
				live.current = next;
			},
			providers,
			section: "targets",
			onClose: () => undefined,
		});
		const overlay = fake.captured();
		ok(overlay);
		overlay.handleInput?.("j");
		overlay.handleInput?.("j"); // target-b
		overlay.handleInput?.(ENTER); // probe, remove
		overlay.handleInput?.(ENTER); // probe throws synchronously but the UI settles
		ok(!stripAnsi(overlay.render(120).join("\n")).includes(`${GLYPH.running} probing`));
	});

	it("removing a profile through its row also drops its bindings on refresh", () => {
		const live = { current: settingsWithTargets() };
		const fake = fakeTui(30, 120);
		const calls: string[] = [];
		openSettingsOverlay(fake.tui, {
			getSettings: () => live.current,
			writeSettings: (next) => {
				live.current = next;
			},
			commitSetting: (id, next) => {
				calls.push(id);
				live.current = next;
			},
			section: "fleet",
			onClose: () => undefined,
		});
		const overlay = fake.captured();
		ok(overlay, "expected settings overlay component");
		for (let i = 0; i < 4; i += 1) overlay.handleInput?.("j"); // workers.profiles.fast.target
		overlay.handleInput?.(ENTER); // picker preselected to target-b: target-a, target-b, (remove profile)
		overlay.handleInput?.(DOWN);
		overlay.handleInput?.(ENTER); // (remove profile)
		overlay.handleInput?.(ENTER); // Apply this session
		deepStrictEqual(calls.sort(), ["workers.agentBindings.scout", "workers.profiles.fast"]);
		const rendered = stripAnsi(overlay.render(120).join("\n"));
		ok(!rendered.includes("fast · target"), rendered);
		ok(rendered.includes("(none)"), "the profiles row is back to none");
	});
	it("adds a profile and a binding through the chained name-then-picker flows", () => {
		const live = { current: settingsWithTargets() };
		const fake = fakeTui(30, 120);
		const calls: string[] = [];
		openSettingsOverlay(fake.tui, {
			getSettings: () => live.current,
			writeSettings: (next) => {
				live.current = next;
			},
			commitSetting: (id, next) => {
				calls.push(id);
				live.current = next;
			},
			section: "fleet",
			onClose: () => undefined,
		});
		const overlay = fake.captured();
		ok(overlay, "expected settings overlay component");
		for (let i = 0; i < 3; i += 1) overlay.handleInput?.("j"); // workers.profiles
		overlay.handleInput?.(ENTER); // name input, seeded empty rather than with the row's count
		for (const ch of "slow") overlay.handleInput?.(ch);
		overlay.handleInput?.(ENTER); // target picker
		overlay.handleInput?.(ENTER); // target-a
		overlay.handleInput?.(ENTER); // Apply this session
		deepStrictEqual(calls, ["workers.profiles.slow"]);
		deepStrictEqual(live.current.workers.profiles.slow, { target: "target-a", model: "model-a", thinkingLevel: "off" });
		let rendered = stripAnsi(overlay.render(120).join("\n"));
		ok(rendered.includes("slow · target"), rendered);

		for (let i = 0; i < 9; i += 1) overlay.handleInput?.("j"); // past the fast and slow rows to workers.agentBindings
		overlay.handleInput?.(ENTER); // agent id input
		for (const ch of "researcher") overlay.handleInput?.(ch);
		overlay.handleInput?.(ENTER); // profile picker: fast, slow
		overlay.handleInput?.(DOWN);
		overlay.handleInput?.(ENTER); // slow
		overlay.handleInput?.(ENTER); // Apply this session
		deepStrictEqual(calls, ["workers.profiles.slow", "workers.agentBindings.researcher"]);
		strictEqual(live.current.workers.agentBindings.researcher, "slow");
		rendered = stripAnsi(overlay.render(120).join("\n"));
		ok(rendered.includes("researcher · p"), rendered);
	});
});
