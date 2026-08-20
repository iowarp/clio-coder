import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { MAX_TIMER_DELAY_MS } from "../../src/core/timers.js";
import type {
	CapabilityFlags,
	ProvidersContract,
	TargetHealth,
	TargetStatus,
} from "../../src/domains/providers/index.js";
import {
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
	visibleWidth,
} from "../../src/engine/tui.js";
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
	type SettingsChangePlan,
} from "../../src/interactive/overlays/settings.js";
import { clioTheme, GLYPH } from "../../src/interactive/theme/index.js";

const ESC = String.fromCharCode(27);
const KITTY_ESC = `${ESC}[27u`;
const KITTY_ESC_RELEASE = `${ESC}[27;1:3u`;
const MODIFY_OTHER_ESC = `${ESC}[27;1;27~`;
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
		{
			id: "target-a",
			runtime: "openai-compat",
			url: "http://localhost:1111",
			defaultModel: "model-a",
		},
		{
			id: "target-b",
			runtime: "openai-compat",
			url: "http://localhost:2222",
			defaultModel: "model-b",
		},
	];
	settings.autonomy = "auto-edit";
	settings.orchestrator = {
		target: "target-a",
		model: "model-a",
		thinkingLevel: "off",
	};
	settings.background = { target: null, model: null, thinkingLevel: "off" };
	settings.workers.default = {
		target: "target-a",
		model: "model-a",
		thinkingLevel: "off",
	};
	settings.workers.profiles.fast = {
		target: "target-b",
		model: "model-b",
		thinkingLevel: "off",
	};
	settings.workers.agentBindings.scout = "fast";
	settings.scope = ["target-a/model-a", "target-b/model-b"];
	settings.budget.sessionCeilingUsd = 5;
	settings.compaction = { auto: true, threshold: 0.8, excludeLastTurns: 6 };
	settings.retry = {
		enabled: true,
		maxRetries: 3,
		baseDelayMs: 2000,
		maxDelayMs: 60000,
		streamStallMs: 180000,
	};
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

function providersWithCatalog(settings: Readonly<ClioSettings>): ProvidersContract {
	const capabilities: CapabilityFlags = {
		chat: true,
		tools: true,
		reasoning: true,
		vision: false,
		audio: false,
		embeddings: false,
		rerank: false,
		fim: false,
		contextWindow: 131_072,
		maxTokens: 8192,
	};
	const base = providersWithHealth({ "target-a": "healthy", "target-b": "healthy" }, settings);
	const statuses = base.list().map((status) => ({
		...status,
		capabilities,
		discoveredModels:
			status.target.id === "target-a" ? ["model-a", "model-new"] : [status.target.defaultModel ?? "model-b"],
		discoveredModelsSource: "probe" as const,
	}));
	return { ...base, list: () => statuses } as ProvidersContract;
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

function spyingSettingsCenter(bodyHeight: number): {
	center: SettingsCenter;
	commits: Commit[];
} {
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

/** Open the filter editor, type a query, and commit it. */
function applyFilter(center: SettingsCenter, query: string): void {
	center.handleInput("/");
	for (let index = 0; index < 64; index += 1) center.handleInput("\x7f");
	for (const character of query) center.handleInput(character);
	center.handleInput(ENTER);
}

function fakeTui(
	rows: number,
	columns: number,
): {
	tui: TUI;
	captured: () => Component | null;
	options: () => OverlayOptions | null;
	renders: () => number;
} {
	let overlay: Component | null = null;
	let overlayOptions: OverlayOptions | null = null;
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
		showOverlay: (component: Component, options?: OverlayOptions) => {
			overlay = component;
			overlayOptions = options ?? null;
			return handle;
		},
	} as unknown as TUI;
	return { tui, captured: () => overlay, options: () => overlayOptions, renders: () => renderCount };
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
		strictEqual(byId.get("terminal.tuiMode")?.scope, "restart");
		strictEqual(byId.get("terminal.fullscreenScrollbar")?.scope, "restart");
		strictEqual(byId.get("terminal.smoothStreaming")?.scope, "live");
		strictEqual(byId.get("attribution.gitCommits")?.scope, "live");
		strictEqual(byId.get("autonomy")?.scope, "live");
		strictEqual(byId.get("retry.maxRetries")?.scope, "live");
	});

	it("shows Clio commit provenance in Advanced and applies enable/disable immediately", () => {
		const settings = settingsWithTargets();
		const row = buildSettingItems(settings).find((item) => item.id === "attribution.gitCommits");
		ok(row !== undefined);
		strictEqual(row.section, "advanced");
		strictEqual(row.label, "Clio commit provenance");
		strictEqual(row.currentValue, "enabled");
		deepStrictEqual(row.values, ["enabled", "disabled"]);
		strictEqual(
			row.description,
			"Add evidence-backed assistance, testing, review, and contributor trailers to commits created through Clio.",
		);
		applySettingChange(settings, row.id, "disabled");
		strictEqual(settings.attribution.gitCommits, false);
		applySettingChange(settings, row.id, "enabled");
		strictEqual(settings.attribution.gitCommits, true);
	});

	it("assigns explicit presentation kinds and independently semantic status segments", () => {
		const settings = settingsWithTargets();
		const items = buildSettingItems(settings, {
			providers: providersWithHealth({
				"target-a": "healthy",
				"target-b": "down",
			}),
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
		strictEqual(byId.get("fleet.group.defaults")?.presentationKind, "group-header");
		strictEqual(byId.get("fleet.group.profiles")?.presentationKind, "group-header");
		strictEqual(byId.get("fleet.group.agent-routes")?.presentationKind, "group-header");
		strictEqual(byId.get("fleet.group.placement")?.presentationKind, "group-header");
		strictEqual(byId.get("workers.profiles.fast")?.presentationKind, "setting");
		deepStrictEqual(byId.get("workers.profiles.fast")?.valueSegments, [
			{ text: "target-b/model…", tone: "neutral" },
			{ text: "  off", tone: "neutral" },
			{ text: "  auto", tone: "neutral" },
		]);
		strictEqual(byId.get("targets")?.presentationKind, "group-header");
		strictEqual(byId.get("targets.target-b")?.presentationKind, "status");
		deepStrictEqual(byId.get("targets.target-b")?.valueSegments, [
			{ text: "○ down", tone: "unhealthy" },
			{ text: "  target-b", tone: "neutral" },
			{ text: "  —", tone: "neutral" },
			{ text: "  openai-compat", tone: "neutral" },
			{ text: "  —", tone: "neutral" },
		]);
		strictEqual(byId.get("fleet.nodes.remote-a")?.presentationKind, "status");
		deepStrictEqual(byId.get("fleet.nodes.remote-a")?.valueSegments, [
			{ text: "○ offline", tone: "unhealthy" },
			{ text: " · 0/4 busy", tone: "neutral" },
		]);
		deepStrictEqual(
			buildSettingItems(settings, {
				getTargetOperation: (targetId) => (targetId === "target-b" ? "probe" : null),
			}).find((item) => item.id === "targets.target-b")?.valueSegments,
			[
				{ text: `${GLYPH.running} probing`, tone: "activity" },
				{ text: "  target-b", tone: "neutral" },
				{ text: "  —", tone: "neutral" },
				{ text: "  openai-compat", tone: "neutral" },
				{ text: "  —", tone: "neutral" },
			],
		);
	});

	it("joins every status row without doubled separators", () => {
		const items = buildSettingItems(settingsWithTargets(), {
			providers: providersWithHealth({
				"target-a": "unknown",
				"target-b": "down",
			}),
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
		for (const item of items.filter((candidate) => candidate.presentationKind === "status")) {
			ok(
				!item.valueSegments
					.map((segment) => segment.text)
					.join("")
					.includes("· ·"),
				item.id,
			);
		}
	});

	it("renders target health, id, roles, runtime, and latency with a labeled operational drawer", () => {
		const settings = settingsWithTargets();
		settings.background = { target: "target-a", model: "memory-model", thinkingLevel: "off" };
		const checkedAt = "2026-08-15T16:30:00.000Z";
		const providers = {
			...providersWithHealth({ "target-a": "healthy", "target-b": "down" }, settings),
			list: () =>
				providersWithHealth({ "target-a": "healthy", "target-b": "down" }, settings)
					.list()
					.map((status) =>
						status.target.id === "target-a"
							? {
									...status,
									health: { ...status.health, lastCheckAt: checkedAt, latencyMs: 42 },
								}
							: { ...status, reason: "connection refused", health: { ...status.health, lastError: "ECONNREFUSED" } },
					),
		} as unknown as ProvidersContract;
		const items = buildSettingItems(settings, { providers });
		const row = items.find((item) => item.id === "targets.target-a");
		deepStrictEqual(row?.targetConsole, {
			health: { text: `${GLYPH.running} healthy`, tone: "healthy" },
			id: "target-a",
			roles: "chat+fleet+memory",
			runtime: "openai-compat",
			latency: "42 ms",
			url: "http://localhost:1111",
			defaultModel: "model-a",
			lastProbe: row?.targetConsole?.lastProbe,
			failureReason: "none",
		});
		ok(row?.targetConsole?.lastProbe !== "never");
		strictEqual(row?.description, "URL: http://localhost:1111 · Default model: model-a");
		ok(row?.help?.includes("Last probe:"));
		ok(row?.help?.includes("Failure reason: none"));

		const center = new SettingsCenter(items, {
			getBodyHeight: () => 24,
			prepareChange: () => null,
			onApply: () => undefined,
			onCancel: () => undefined,
		});
		center.setSelection("targets", 1);
		const rendered = stripAnsi(center.render(72).join("\n"));
		for (const value of ["HEALTH", "TARGET", "ROLES", "RUNTI", "LATENCY", "chat+", "42 ms", "URL:"]) {
			ok(rendered.includes(value), `${value} missing from:\n${rendered}`);
		}
		ok(rendered.includes("Enter opens actions"), rendered);
		ok(!rendered.includes("Enter chooses a value"), rendered);
		center.handleInput(ENTER);
		const actions = stripAnsi(center.render(72).join("\n"));
		for (const detail of [
			"Target target-a",
			"URL: http://localhost:1111",
			"Default model: model-a",
			"Last probe:",
			"Failure reason: none",
		]) {
			ok(actions.includes(detail), `${detail} missing from action drawer:\n${actions}`);
		}
	});

	it("never truncates the target-console runtime header at the 120-column center budget", () => {
		const settings = settingsWithTargets();
		const [targetA, targetB] = settings.targets;
		ok(targetA);
		ok(targetB);
		settings.targets[0] = { ...targetA, runtime: "llamacpp" };
		settings.targets[1] = { ...targetB, runtime: "lmstudio" };
		const center = new SettingsCenter(
			buildSettingItems(settings, {
				providers: providersWithHealth({ "target-a": "healthy", "target-b": "healthy" }, settings),
			}),
			{
				getBodyHeight: () => 24,
				prepareChange: () => null,
				onApply: () => undefined,
				onCancel: () => undefined,
			},
		);
		center.setSelection("targets", 1);
		const terminal120 = stripAnsi(center.render(112).join("\n"));
		const compactHeader = terminal120.split("\n").find((line) => line.includes("HEALTH") && line.includes("TARGET"));
		ok(compactHeader);
		ok(!compactHeader.includes("RUNTI"), compactHeader);

		const roomier = stripAnsi(center.render(128).join("\n"));
		const roomierHeader = roomier.split("\n").find((line) => line.includes("HEALTH") && line.includes("TARGET"));
		ok(roomierHeader?.includes("RUNTIME"), roomierHeader);
		ok(roomier.includes("llamacpp"), roomier);
		ok(roomier.includes("lmstudio"), roomier);
		ok(!roomier.includes("RUNTI…"), roomier);
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
			{
				id: "target-c",
				runtime: "openai-compat",
				url: "http://localhost:3333",
				defaultModel: "model-c",
			},
			{
				id: "target-d",
				runtime: "openai-compat",
				url: "http://localhost:4444",
				defaultModel: "model-d",
			},
		);
		const items = buildSettingItems(settings, {
			providers: providersWithHealth(
				{
					"target-a": "healthy",
					"target-b": "degraded",
					"target-c": "down",
					"target-d": "unknown",
				},
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
		ok(targetRender.includes(`${theme.fgSequence("dim")}? unknown`), "unknown remains visibly unsettled");

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
			const fleetItems = items.filter((item) => item.section === "fleet");
			center.setSelection("fleet", fleetItems.findIndex((item) => item.id === "workers.agentBindings"));
			const readOnlyLines = center.render(112).join("\\n");
			center.setSelection("fleet", fleetItems.findIndex((item) => item.id === "workers.maxRetries"));
			const editableLines = center.render(112).join("\\n");
			center.setSelection("retry", 1);
			process.stdout.write(targetLines + "\\n" + nodeLines + "\\n" + readOnlyLines + "\\n" + editableLines + "\\n" + center.render(112).join("\\n"));
		`;
		const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
			cwd: process.cwd(),
			env: { ...process.env, NO_COLOR: "1" },
			encoding: "utf8",
		});
		strictEqual(child.status, 0, child.stderr);
		ok(!new RegExp(`${ESC}\\[[0-9;]*38(?:;|m)`).test(child.stdout), "NO_COLOR emits no foreground color sequences");
		const plain = stripAnsi(child.stdout);
		ok(
			plain.split("\n").some((line) => line.includes("❯") && line.includes("○ down")),
			"focus survives without color",
		);
		ok(plain.includes(`${GLYPH.running} healthy`), "healthy target remains explicit without color");
		ok(plain.includes("◐ degraded"), "degraded target remains explicit without color");
		ok(plain.includes("○ down"), "down target remains explicit without color");
		ok(plain.includes("? unknown"), "unknown target remains explicit without color");
		ok(plain.includes("○ offline"), "offline node remains explicit without color");
		const plainLines = plain.split("\n");
		ok(
			plainLines.some((line) => line.includes("Add agent route") && line.includes("—")),
			"glyph-less read-only facts retain an explicit fallback",
		);
		ok(
			plainLines.some((line) => line.includes("Fleet retries") && line.includes("2") && !line.includes("— ")),
			"editable rows do not carry the read-only mark",
		);
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
		const cases: Array<{
			id: EditableSettingId;
			value: string;
			assert: (settings: ClioSettings) => void;
		}> = [
			{
				id: "autonomy",
				value: "full-auto",
				assert: (s) => strictEqual(s.autonomy, "full-auto"),
			},
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
				id: "attribution.gitCommits",
				value: "disabled",
				assert: (s) => strictEqual(s.attribution.gitCommits, false),
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
			{
				id: "workers.maxRetries",
				value: "5",
				assert: (s) => strictEqual(s.workers.maxRetries, 5),
			},
			{
				id: "modelSelector.recentLimit",
				value: "20",
				assert: (s) => strictEqual(s.modelSelector.recentLimit, 20),
			},
			{
				id: "defaults.maxTokens",
				value: "65536",
				assert: (s) => strictEqual(s.defaults.maxTokens, 65536),
			},
			{
				id: "defaults.maxTokens",
				value: "0",
				assert: (s) => strictEqual(s.defaults.maxTokens, 0),
			},
			{
				id: "budget.concurrency",
				value: "auto",
				assert: (s) => strictEqual(s.budget.concurrency, "auto"),
			},
			{
				id: "budget.concurrency",
				value: "4",
				assert: (s) => strictEqual(s.budget.concurrency, 4),
			},
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
			{
				id: "compaction.auto",
				value: "false",
				assert: (s) => strictEqual(s.compaction.auto, false),
			},
			{
				id: "compaction.excludeLastTurns",
				value: "10",
				assert: (s) => strictEqual(s.compaction.excludeLastTurns, 10),
			},
			{
				id: "compaction.threshold",
				value: "0.9",
				assert: (s) => strictEqual(s.compaction.threshold, 0.9),
			},
			{
				id: "compaction.model",
				value: "prov/sum",
				assert: (s) => strictEqual(s.compaction.model, "prov/sum"),
			},
			{
				id: "compaction.model",
				value: "  ",
				assert: (s) => strictEqual("model" in s.compaction, false),
			},
			{
				id: "compaction.systemPrompt",
				value: "~/p.md",
				assert: (s) => strictEqual(s.compaction.systemPrompt, "~/p.md"),
			},
			{
				id: "retry.enabled",
				value: "false",
				assert: (s) => strictEqual(s.retry.enabled, false),
			},
			{
				id: "retry.maxRetries",
				value: "8",
				assert: (s) => strictEqual(s.retry.maxRetries, 8),
			},
			{
				id: "retry.baseDelayMs",
				value: "5000",
				assert: (s) => strictEqual(s.retry.baseDelayMs, 5000),
			},
			{
				id: "retry.maxDelayMs",
				value: "120000",
				assert: (s) => strictEqual(s.retry.maxDelayMs, 120000),
			},
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
			{
				id: "terminal.tuiMode",
				value: "fullscreen",
				assert: (s) => strictEqual(s.terminal.tuiMode, "fullscreen"),
			},
			{
				id: "terminal.fullscreenScrollbar",
				value: "always",
				assert: (s) => strictEqual(s.terminal.fullscreenScrollbar, "always"),
			},
			{
				id: "terminal.smoothStreaming",
				value: "on",
				assert: (s) => strictEqual(s.terminal.smoothStreaming, "on"),
			},
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

	it("drills down instead of flattening below the two-lane floor (76-column terminal)", () => {
		const center = noopSettingsCenter(16);
		const lines = center.render(68);
		const rendered = stripAnsi(lines.join("\n"));
		strictEqual(lines.length, 16);
		ok(rendered.includes("Settings › Autonomy & Safety"), rendered);
		ok(rendered.includes("Autonomy level"));
		ok(!rendered.includes("│"), "narrow layout should not include the lane divider");
		ok(!rendered.includes("Max retries"), "another section's rows must not share the page");
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

	it("picks one layout per width and never renders two stack levels at once", () => {
		for (const { width, dividers, narrow } of [
			{ width: 40, dividers: 0, narrow: true },
			{ width: 71, dividers: 0, narrow: true },
			{ width: 72, dividers: 1, narrow: false },
			{ width: 111, dividers: 1, narrow: false },
			{ width: 112, dividers: 2, narrow: false },
			{ width: 160, dividers: 2, narrow: false },
		]) {
			const center = noopSettingsCenter(26);
			const lines = center.render(width);
			strictEqual(lines.length, 26, `${width} keeps the body budget`);
			const first = stripAnsi(lines[0] ?? "");
			strictEqual(first.split("│").length - 1, dividers, `${width} lane dividers:\n${first}`);
			const rendered = stripAnsi(lines.join("\n"));
			if (!narrow) {
				ok(rendered.includes("Sections"), `${width} keeps the section lane`);
				continue;
			}
			ok(rendered.includes("Settings › Autonomy & Safety"), `${width} breadcrumb:\n${rendered}`);
			ok(rendered.includes("Autonomy level"), `${width} rows page`);
			ok(!rendered.includes("Compaction threshold"), `${width} must not flatten other sections`);
			center.handleInput(ESC);
			const sectionsPage = stripAnsi(center.render(width).join("\n"));
			ok(sectionsPage.includes("Settings › Sections"), sectionsPage);
			ok(sectionsPage.includes("Autonomy & Safety") && sectionsPage.includes("CORE"), sectionsPage);
			ok(!sectionsPage.includes("Autonomy level"), `${width} section list must carry no setting rows`);
		}
	});

	it("moves sections to rows on Enter or Right and keeps narrow row motion inside the section", () => {
		const center = noopSettingsCenter(20);
		center.render(40);
		center.handleInput(ESC); // rows → sections
		strictEqual(center.getSelection().depth, "sections");
		center.handleInput(ENTER);
		strictEqual(center.getSelection().depth, "rows");
		center.handleInput(ESC);
		center.handleInput(`${ESC}[C`); // right
		strictEqual(center.getSelection().depth, "rows");

		center.setSelection("fleet", 0);
		const visited: string[] = [];
		for (let index = 0; index < 24; index += 1) {
			const selection = center.getSelection();
			strictEqual(selection.section, "fleet", "narrow row motion stays in the opened section");
			ok(!String(selection.rowId).startsWith("fleet.group."), "group headers are never a stop");
			visited.push(String(selection.rowId));
			center.handleInput("j");
		}
		ok(new Set(visited).size > 1, "rows cycle within the section");
	});

	it("gives a narrow detail page the whole work area and leaves read-only leaves inert", () => {
		const center = noopSettingsCenter(20);
		center.setSelection("targets", 0);
		strictEqual(center.getSelection().rowId, "targets.target-a");
		center.handleInput(ENTER);
		strictEqual(center.getSelection().depth, "detail");
		const detail = stripAnsi(center.render(40).join("\n"));
		ok(detail.includes("Settings › Targets › target-a"), detail);
		ok(detail.includes("Remove target"), detail);
		ok(!detail.includes("Autonomy level"), "the catalog must not render behind the detail page");

		center.handleInput(ESC);
		const terminalItems = buildSettingsSections(buildSettingItems(settingsWithTargets())).find(
			(section) => section.id === "terminal",
		)?.items;
		const themeIndex = terminalItems?.findIndex((item) => item.id === "theme") ?? -1;
		ok(themeIndex >= 0, "terminal section exposes the read-only theme row");
		center.setSelection("terminal", themeIndex);
		strictEqual(center.getSelection().rowId, "theme");
		center.handleInput(ENTER);
		strictEqual(center.getSelection().depth, "rows", "a read-only leaf opens nothing");
	});

	it("keeps the narrow inspector inside its height budget and gives the rest to the list", () => {
		for (const { bodyHeight, inspectorRows } of [
			{ bodyHeight: 20, inspectorRows: 2 },
			{ bodyHeight: 12, inspectorRows: 1 },
			{ bodyHeight: 8, inspectorRows: 0 },
		]) {
			const center = noopSettingsCenter(bodyHeight);
			const lines = center.render(40).map(stripAnsi);
			strictEqual(lines.length, bodyHeight);
			const prose = lines.filter((line) => line.includes("How freely Clio acts") || line.includes("safety net"));
			ok(prose.length <= inspectorRows, `${bodyHeight} rows kept ${prose.length} inspector rows:\n${lines.join("\n")}`);
			const rows = lines.filter((line) => line.includes("❯") || line.includes("Autonomy level"));
			ok(rows.length > 0, "the list keeps the rest of the body");
		}
	});

	it("caps the two-lane footer so the list keeps its rows", () => {
		for (const { bodyHeight, footerMax } of [
			{ bodyHeight: 26, footerMax: 4 },
			{ bodyHeight: 8, footerMax: 2 },
			{ bodyHeight: 6, footerMax: 0 },
		]) {
			const center = noopSettingsCenter(bodyHeight);
			const lines = center.render(100).map(stripAnsi);
			strictEqual(lines.length, bodyHeight);
			const footerStart = lines.findIndex((line) => !line.includes("│"));
			const footerRows = footerStart < 0 ? 0 : lines.length - footerStart;
			ok(footerRows <= footerMax, `${bodyHeight} rows spent ${footerRows} footer rows:\n${lines.join("\n")}`);
			const listRows = footerStart < 0 ? lines.length : footerStart;
			ok(listRows >= Math.min(6, bodyHeight), `${bodyHeight} rows left ${listRows} list rows`);
		}
	});

	it("suppresses the ordinary inspector while a detail page is open at every width", () => {
		for (const width of [40, 72, 112, 160]) {
			const center = noopSettingsCenter(26);
			center.setSelection("safety", 0);
			center.handleInput(ENTER);
			const rendered = stripAnsi(center.render(width).join("\n"));
			ok(rendered.includes("Select Autonomy level"), `${width}:\n${rendered}`);
			ok(!rendered.includes(SCOPE_NOTE), `${width} still rendered the row footer:\n${rendered}`);
		}
	});

	it("walks Esc up exactly one level from every submenu kind, at 40 and 160 inner columns", () => {
		const submenus: Array<{ name: string; section: Parameters<SettingsCenter["setSelection"]>[0]; row: number }> = [
			{ name: "enum picker", section: "safety", row: 0 },
			{ name: "text editor", section: "advanced", row: 0 },
			{ name: "number editor", section: "budget", row: 0 },
			{ name: "target actions", section: "targets", row: 0 },
			{ name: "profile workbench", section: "fleet", row: 4 },
		];
		for (const width of [40, 160]) {
			for (const submenu of submenus) {
				const settings = settingsWithTargets();
				const commits: Commit[] = [];
				let closed = 0;
				const center = new SettingsCenter(buildSettingItems(settings), {
					getBodyHeight: () => 24,
					prepareChange: (item, value) => createSettingsChangePlan(settings, item, value),
					onApply: (plan, scope) => commits.push({ id: plan.rowId, value: plan.selectedValue, scope }),
					onCancel: () => {
						closed += 1;
					},
				});
				center.setSelection(submenu.section, submenu.row);
				const rowId = center.getSelection().rowId;
				center.handleInput(ENTER);
				strictEqual(center.getSelection().depth, "detail", `${submenu.name} at ${width} opens a detail page`);
				center.render(width);

				center.handleInput(ESC);
				strictEqual(center.getSelection().depth, "rows", `${submenu.name} at ${width}: first Esc returns to the row`);
				strictEqual(center.getSelection().rowId, rowId, "the originating row keeps the cursor");
				strictEqual(closed, 0);

				center.handleInput(ESC);
				strictEqual(center.getSelection().depth, "sections", `${submenu.name} at ${width}: second Esc reaches sections`);
				strictEqual(closed, 0);

				center.handleInput(ESC);
				strictEqual(closed, 1, `${submenu.name} at ${width}: third Esc closes exactly once`);
				deepStrictEqual(commits, [], `${submenu.name} cancelled without mutation`);
				deepStrictEqual(settings, settingsWithTargets(), `${submenu.name} left settings untouched`);
			}
		}
	});

	it("treats the destination prompt as one more level and cancels it without committing", () => {
		const { center, commits } = spyingSettingsCenter(24);
		center.setSelection("safety", 0);
		center.handleInput(ENTER); // value picker
		center.handleInput(DOWN);
		center.handleInput(ENTER); // destination prompt
		strictEqual(center.getSelection().depth, "detail");
		center.handleInput(ESC);
		strictEqual(center.getSelection().depth, "rows", "cancelling the destination returns to the row");
		deepStrictEqual(commits, []);
	});

	it("accepts every Escape encoding, ignores releases, and drops a pending preview on the way out", () => {
		for (const escapeKey of [ESC, KITTY_ESC, MODIFY_OTHER_ESC]) {
			const { center, commits } = spyingSettingsCenter(24);
			center.setSelection("safety", 0);
			center.handleInput(" "); // preview full-auto
			ok(stripAnsi(center.render(112).join("\n")).includes("full-auto"));
			center.handleInput(KITTY_ESC_RELEASE);
			strictEqual(center.getSelection().depth, "rows", "a key release is not a press");
			center.handleInput(escapeKey);
			strictEqual(center.getSelection().depth, "sections", "one Esc leaves the row context");
			const afterBack = stripAnsi(center.render(112).join("\n"));
			ok(!afterBack.includes("❯ Autonomy level  autonomy  ⊙ full-auto"), afterBack);
			deepStrictEqual(commits, [], "an abandoned preview never commits");
		}
	});

	it("drives the whole back chain through the framed overlay without closing early", () => {
		for (const columns of [44, 164]) {
			let closes = 0;
			const fake = fakeTui(24, columns);
			openSettingsOverlay(fake.tui, {
				getSettings: settingsWithTargets,
				writeSettings: () => undefined,
				onClose: () => {
					closes += 1;
				},
			});
			const overlay = fake.captured();
			ok(overlay);
			overlay.handleInput?.(ENTER); // autonomy picker
			overlay.handleInput?.(ESC);
			strictEqual(closes, 0, `${columns}: the picker Esc stayed inside Settings`);
			overlay.handleInput?.(ESC);
			strictEqual(closes, 0, `${columns}: the rows Esc stayed inside Settings`);
			overlay.handleInput?.(ESC);
			strictEqual(closes, 1, `${columns}: the sections Esc closed once`);
		}
	});

	it("filters the catalog by label, path, and description across widths", () => {
		for (const width of [40, 71, 72, 160]) {
			const center = noopSettingsCenter(24);
			applyFilter(center, "trustproject"); // configPath only; the path column is dropped at 40
			let rendered = stripAnsi(center.render(width).join("\n"));
			ok(rendered.includes("Trust project"), `${width} path match:\n${rendered}`);
			ok(!rendered.includes("Autonomy level"), `${width} kept a non-match:\n${rendered}`);

			applyFilter(center, "masks stale"); // description only
			rendered = stripAnsi(center.render(width).join("\n"));
			ok(rendered.includes("Compaction thresh"), `${width} description match:\n${rendered}`);

			applyFilter(center, "MAX RETRIES"); // case-insensitive label
			rendered = stripAnsi(center.render(width).join("\n"));
			ok(rendered.includes("Max retries"), `${width} case-insensitive match:\n${rendered}`);

			applyFilter(center, "zzzznotasetting");
			rendered = stripAnsi(center.render(width).join("\n"));
			ok(rendered.includes("No settings match"), `${width} empty state:\n${rendered}`);
			ok(rendered.includes("empty Enter clears"), rendered);
		}
	});

	it("keeps section context, headers, and counts honest while filtering", () => {
		const center = noopSettingsCenter(24);
		applyFilter(center, "retry");
		strictEqual(center.getSelection().filter, "retry");
		center.handleInput(ESC); // sections page
		const sections = stripAnsi(center.render(40).join("\n"));
		ok(sections.includes("Retry"), sections);
		ok(!sections.includes("Compaction"), `a section with no match must disappear:\n${sections}`);
		ok(/Retry\s+\d/.test(sections), `filtered sections carry a match count:\n${sections}`);

		center.setSelection("fleet", 0);
		applyFilter(center, "profile");
		const rows = stripAnsi(center.render(40).join("\n")).split("\n");
		ok(
			rows.some((line) => line.trim() === "Profiles"),
			`the matching group header stays as context:\n${rows.join("\n")}`,
		);
		ok(!rows.some((line) => line.trim() === "Placement"), "a header with no matching row below it is dropped");
		for (let index = 0; index < 6; index += 1) {
			ok(!String(center.getSelection().rowId).startsWith("fleet.group."), "headers are never navigation stops");
			center.handleInput("j");
		}
	});

	it("keeps a committed filter across drilling and clears it on an empty submit", () => {
		const center = noopSettingsCenter(24);
		applyFilter(center, "retry");
		center.setSelection("retry", 0);
		center.handleInput(ENTER); // detail page for the matched row
		strictEqual(center.getSelection().depth, "detail");
		center.handleInput(ESC);
		center.handleInput(ESC);
		strictEqual(center.getSelection().filter, "retry", "inspecting a result must not change the result set");

		applyFilter(center, "");
		strictEqual(center.getSelection().filter, "");
		ok(stripAnsi(center.render(40).join("\n")).includes("Autonomy"), "an empty submit restores the catalog");
	});

	it("narrows the catalog per keystroke while the filter editor is open (#135)", () => {
		let renders = 0;
		const center = new SettingsCenter(buildSettingItems(settingsWithTargets()), {
			getBodyHeight: () => 24,
			prepareChange: () => null,
			onApply: () => undefined,
			onCancel: () => undefined,
			requestRender: () => {
				renders += 1;
			},
		});
		center.handleInput("/");
		const rendersBeforeTyping = renders;
		for (const character of "max retries") center.handleInput(character);
		ok(renders >= rendersBeforeTyping + "max retries".length, "every keystroke requests a repaint");
		// No Enter yet: the draft alone must already narrow the catalog.
		let rendered = stripAnsi(center.render(120).join("\n"));
		ok(rendered.includes("Max retries"), `draft match visible before Enter:\n${rendered}`);
		ok(!rendered.includes("Autonomy level"), `non-match hidden before Enter:\n${rendered}`);
		strictEqual(center.getSelection().filter, "", "the query is not committed until Enter");

		// Backspacing the draft widens the catalog again, still before Enter.
		for (let index = 0; index < "max retries".length; index += 1) center.handleInput("\x7f");
		rendered = stripAnsi(center.render(120).join("\n"));
		ok(rendered.includes("Autonomy & Safety"), `an emptied draft restores the catalog:\n${rendered}`);

		// A draft that matches nothing shows the empty state live.
		for (const character of "zzzznotasetting") center.handleInput(character);
		rendered = stripAnsi(center.render(120).join("\n"));
		ok(rendered.includes("No settings match “zzzznotasetting”"), `live empty state:\n${rendered}`);
	});

	it("restores the previous query when filter editing is cancelled", () => {
		const center = noopSettingsCenter(24);
		applyFilter(center, "retry");
		center.handleInput("/");
		for (const character of "xyz") center.handleInput(character);
		ok(stripAnsi(center.render(40).join("\n")).includes("Filter settings: retryxyz"));
		center.handleInput(ESC);
		strictEqual(center.getSelection().filter, "retry", "Esc while editing restores the committed query");
		strictEqual(center.getSelection().depth, "rows", "cancelling the editor is not a navigation level");
	});

	it("starts a reopened Settings overlay unfiltered", () => {
		const first = noopSettingsCenter(24);
		applyFilter(first, "retry");
		strictEqual(first.getSelection().filter, "retry");
		strictEqual(noopSettingsCenter(24).getSelection().filter, "", "a fresh instance carries no filter");
	});

	it("normalizes a filtered selection when a refresh removes the matching row", () => {
		const settings = settingsWithTargets();
		const items = buildSettingItems(settings);
		const center = new SettingsCenter(items, {
			getBodyHeight: () => 24,
			prepareChange: () => null,
			onApply: () => undefined,
			onCancel: () => undefined,
		});
		applyFilter(center, "fast");
		center.setSelection("fleet", 0);
		strictEqual(center.getSelection().rowId, "workers.profiles.fast");
		delete settings.workers.profiles.fast;
		items.splice(0, items.length, ...buildSettingItems(settings));
		center.refreshItems();
		const rendered = stripAnsi(center.render(40).join("\n"));
		ok(rendered.includes("No settings match") || center.getSelection().rowId !== "workers.profiles.fast", rendered);
	});

	it("carries section, row, filter, and depth across every resize boundary", () => {
		for (const widths of [
			[71, 72, 71],
			[111, 112, 111],
			[40, 160, 40],
		]) {
			const center = noopSettingsCenter(24);
			applyFilter(center, "retry");
			center.setSelection("retry", 1);
			const before = center.getSelection();
			for (const width of widths) center.render(width);
			const after = center.getSelection();
			strictEqual(after.section, before.section, `${widths.join("→")} kept the section`);
			strictEqual(after.rowId, before.rowId, `${widths.join("→")} kept the row`);
			strictEqual(after.filter, "retry", `${widths.join("→")} kept the filter`);
			strictEqual(after.depth, before.depth, `${widths.join("→")} kept the depth`);
		}
	});

	it("keeps an open submenu and its unsaved state alive across a resize, then unwinds one level at a time", () => {
		for (const widths of [
			[71, 72, 71],
			[111, 112, 111],
			[40, 160, 40],
		]) {
			const settings = settingsWithTargets();
			let closed = 0;
			const center = new SettingsCenter(buildSettingItems(settings), {
				getBodyHeight: () => 24,
				prepareChange: (item, value) => createSettingsChangePlan(settings, item, value),
				onApply: () => undefined,
				onCancel: () => {
					closed += 1;
				},
			});
			center.setSelection("advanced", 0); // runtime plugins, a text editor
			center.handleInput(ENTER);
			for (const character of "draft") center.handleInput(character);
			for (const width of widths) {
				const rendered = stripAnsi(center.render(width).join("\n"));
				ok(rendered.includes("draft"), `${widths.join("→")} lost the unsaved text at ${width}:\n${rendered}`);
				strictEqual(center.getSelection().depth, "detail", `${widths.join("→")} kept the submenu open at ${width}`);
			}
			center.handleInput(ESC);
			strictEqual(center.getSelection().depth, "rows");
			strictEqual(center.getSelection().rowId, "runtimePlugins");
			center.handleInput(ESC);
			strictEqual(center.getSelection().depth, "sections");
			center.handleInput(ESC);
			strictEqual(closed, 1, `${widths.join("→")} closed exactly once`);
		}
	});

	it("claims every terminal row it covers, with no side margin at ultra-narrow widths", () => {
		for (const { columns, sideMargin } of [
			{ columns: 40, sideMargin: 0 },
			{ columns: 100, sideMargin: 2 },
		]) {
			const fake = fakeTui(24, columns);
			openSettingsOverlay(fake.tui, {
				getSettings: settingsWithTargets,
				writeSettings: () => undefined,
				onClose: () => undefined,
			});
			const options = fake.options();
			ok(options?.visible);
			options.visible(columns, 24);
			const margin = options.margin as { left: number; right: number };
			strictEqual(margin.left, sideMargin, `${columns} columns left margin`);
			strictEqual(margin.right, sideMargin, `${columns} columns right margin`);

			const overlay = fake.captured();
			ok(overlay);
			const inner = columns - sideMargin * 2;
			for (const line of overlay.render(inner)) {
				strictEqual(visibleWidth(line), inner, `every covered row is opaque: ${JSON.stringify(stripAnsi(line))}`);
			}
		}
	});

	it("keeps the way out on screen on short terminals at every width", () => {
		for (const rows of [24, 12]) {
			for (const columns of [40, 75, 76, 116, 164]) {
				const fake = fakeTui(rows, columns);
				openSettingsOverlay(fake.tui, {
					getSettings: settingsWithTargets,
					writeSettings: () => undefined,
					onClose: () => undefined,
				});
				const overlay = fake.captured();
				ok(overlay);
				const lines = overlay.render(columns - 4).map(stripAnsi);
				ok(lines.length <= rows, `${columns}x${rows} rendered ${lines.length} rows`);
				ok(lines.at(-1)?.includes("Esc"), `${columns}x${rows} lost the frame hint:\n${lines.at(-1) ?? "(no rows)"}`);
			}
		}
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

	it("edits the scoped model set as one provider-backed plan while preserving stale catalog refs", () => {
		const settings = settingsWithTargets();
		settings.scope = ["target-a/model-a", "target-a/stale-model", "retired,Legacy@2025"];
		const providers = providersWithCatalog(settings);
		const prepared: SettingsChangePlan[] = [];
		const applied: Array<{ plan: SettingsChangePlan; scope: "session" | "global" }> = [];
		const items = buildSettingItems(settings, { providers });
		const center = new SettingsCenter(items, {
			getBodyHeight: () => 30,
			prepareChange: (item, value) => {
				const plan = createSettingsChangePlan(settings, item, value);
				if (plan) prepared.push(plan);
				return plan;
			},
			onApply: (plan, scope) => applied.push({ plan, scope }),
			onCancel: () => undefined,
		});
		center.setSelection("models", 0);
		center.handleInput(ENTER);
		const checklist = stripAnsi(center.render(112).join("\n"));
		ok(checklist.includes("Target · target-a"), checklist);
		ok(checklist.includes("[x] target-a/model-a"), checklist);
		ok(checklist.includes("Unavailable"), checklist);
		ok(checklist.includes("[x] target-a/stale-model"), checklist);
		ok(checklist.includes("[x] retired,Legacy@2025"), checklist);
		ok(checklist.includes("Capabilities: chat, tools, reasoning"), checklist);
		ok(checklist.includes("default model when switching targets"), checklist);

		center.handleInput(" "); // add target-level target-a
		center.handleInput(DOWN); // target-a/model-a
		center.handleInput(" "); // remove the exact model
		center.handleInput(DOWN); // target-a/model-new
		center.handleInput(" "); // add the newly cataloged model
		strictEqual(prepared.length, 0, "Space toggles stay local to the checklist session");
		center.handleInput(ENTER); // one plan, then destination prompt
		strictEqual(prepared.length, 1, "all checklist toggles feed one SettingsChangePlan");
		deepStrictEqual(prepared[0]?.proposed.scope, [
			"target-a/stale-model",
			"retired,Legacy@2025",
			"target-a",
			"target-a/model-new",
		]);
		deepStrictEqual(settings.scope, ["target-a/model-a", "target-a/stale-model", "retired,Legacy@2025"]);
		center.handleInput(ENTER); // Apply this session
		strictEqual(applied.length, 1);
		strictEqual(applied[0]?.scope, "session");
		strictEqual(applied[0]?.plan, prepared[0], "destination applies the same immutable plan");

		const roundTrip = buildSettingItems(prepared[0]?.proposed as ClioSettings, { providers }).find(
			(item) => item.id === "scope",
		);
		ok(roundTrip?.submenu);
		const reopened = stripAnsi(
			roundTrip
				.submenu(roundTrip.currentValue, () => undefined)
				.render(112)
				.join("\n"),
		);
		ok(reopened.includes("Unavailable"), reopened);
		ok(reopened.includes("[x] target-a/stale-model"), reopened);
		ok(reopened.includes("[x] retired,Legacy@2025"), reopened);
	});

	/**
	 * SubmenuWrapper spends two columns indenting its child, so the child must be
	 * rendered at what is left. It was rendered at the full width, so every
	 * checklist entry (which pads itself) arrived two columns over budget, lost
	 * its last two columns, and wore a trailing marker it had not earned.
	 */
	it("keeps checklist entries inside the submenu's indent instead of marking every row as cut", () => {
		const settings = settingsWithTargets();
		const longModel = "Qwen3.8-27B-Instruct-IQ4_NL-262K-TAIL";
		settings.targets = [{ id: "mini", runtime: "openai-compat", url: "http://localhost:3333", defaultModel: longModel }];
		settings.scope = [`mini/${longModel}`];
		const providers = providersWithCatalog(settings);
		const item = buildSettingItems(settings, { providers }).find((candidate) => candidate.id === "scope");
		ok(item?.submenu);
		const checklist = item.submenu(item.currentValue, () => undefined);
		for (const width of [120, 72]) {
			const lines = stripAnsi(checklist.render(width).join("\n")).split("\n");
			for (const line of lines) {
				ok(visibleWidth(line) <= width, `${width}: a row ran past the panel: ${JSON.stringify(line)}`);
			}
			const entries = lines.filter((line) => line.includes("[x]") || line.includes("[ ]"));
			ok(entries.length > 0, `${width} rendered no entries:\n${lines.join("\n")}`);
			for (const entry of entries) {
				const fits = visibleWidth(`${entry.replace(/…\s*$/u, "").trimEnd()}`) + 2 <= width;
				if (fits) ok(!entry.includes("…"), `${width}: an entry that fits was marked as cut: ${JSON.stringify(entry)}`);
			}
			const longEntry = entries.find((entry) => entry.includes("mini/Qwen3.8"));
			ok(longEntry, `${width} lost the long entry:\n${lines.join("\n")}`);
			if (visibleWidth(longEntry) + 2 <= width) {
				ok(longEntry.includes("TAIL"), `${width}: the long label lost its final columns: ${JSON.stringify(longEntry)}`);
			}
		}
	});

	it("marks the capability detail when it outruns its three lines", () => {
		const settings = settingsWithTargets();
		settings.scope = ["target-a/model-a"];
		const providers = providersWithCatalog(settings);
		const item = buildSettingItems(settings, { providers }).find((candidate) => candidate.id === "scope");
		ok(item?.submenu);
		for (const width of [28, 40]) {
			const lines = stripAnsi(
				item
					.submenu(item.currentValue, () => undefined)
					.render(width)
					.join("\n"),
			).split("\n");
			const detailStart = lines.findIndex((line) => line.includes("Capabilities:"));
			ok(detailStart >= 0, `${width}: no capability detail:\n${lines.join("\n")}`);
			const detailLines: string[] = [];
			for (const line of lines.slice(detailStart)) {
				if (line.trim().length === 0) break;
				detailLines.push(line);
			}
			const detail = detailLines.join(" ").replace(/\s+/gu, " ").trim();
			// The selected row is the target-level entry, whose sentence ends here.
			if (!detail.includes("when switching targets")) {
				ok(detail.endsWith("…"), `${width}: the capability sentence stopped without a marker: ${JSON.stringify(detail)}`);
			}
		}
	});

	/**
	 * A multi-reference selection is a set, not a destination. Spelling every ref
	 * into the title produced `…_K_M-262K, mini/Gemma-…`: a left-chopped dump with
	 * the row label pushed off the front, so the operator could not see which row
	 * they were about to change.
	 */
	it("summarizes a multi-reference scope confirmation by count and keeps a single ref verbatim", () => {
		const settings = settingsWithTargets();
		settings.scope = ["target-a/model-a"];
		const item = buildSettingItems(settings).find((candidate) => candidate.id === "scope");
		ok(item);
		const titleFor = (refs: readonly string[], width: number): string => {
			const encoded = `__clio_scope_v1__:${JSON.stringify(refs)}`;
			const titled = { ...item, values: [encoded] };
			delete titled.submenu;
			const center = new SettingsCenter(
				buildSettingItems(settings).map((candidate) => (candidate.id === item.id ? titled : candidate)),
				{
					getBodyHeight: () => 26,
					prepareChange: (candidate, value) => createSettingsChangePlan(settings, candidate, value),
					onApply: () => undefined,
					onCancel: () => undefined,
				},
			);
			center.setSelection("models", 0);
			center.handleInput(ENTER); // one-entry value picker
			center.handleInput(ENTER); // destination prompt
			return stripAnsi(center.render(width).join("\n"));
		};

		const single = titleFor(["target-b/model-b"], 120);
		ok(single.includes("target-b/model-b"), `a single ref stays verbatim:\n${single}`);
		ok(!single.includes("changes"), single);

		for (const width of [120, 40]) {
			const many = titleFor(["target-a", "target-a/model-a", "target-b/model-b"], width);
			const title = many.split("\n").find((line) => line.includes("Model cycle set:")) ?? "";
			ok(title.includes("Model cycle set"), `${width} lost the row label:\n${many}`);
			ok(title.includes("3 changes"), `${width} lost the count:\n${many}`);
			ok(!title.includes("target-b/model-b"), `${width} still dumps the refs into the title:\n${many}`);
			ok(many.includes("Affects scope"), `${width} lost the leaf detail beneath the title:\n${many}`);
		}
	});

	it("cancels scoped checklist edits and only drops an unavailable ref when explicitly unchecked", () => {
		const settings = settingsWithTargets();
		settings.scope = ["target-a/model-a", "target-a/stale-model", "retired,Legacy@2025"];
		const providers = providersWithCatalog(settings);
		const plans: SettingsChangePlan[] = [];
		const applied: SettingsChangePlan[] = [];
		const makeCenter = (): SettingsCenter => {
			const center = new SettingsCenter(buildSettingItems(settings, { providers }), {
				getBodyHeight: () => 30,
				prepareChange: (item, value) => {
					const plan = createSettingsChangePlan(settings, item, value);
					if (plan) plans.push(plan);
					return plan;
				},
				onApply: (plan) => applied.push(plan),
				onCancel: () => undefined,
			});
			center.setSelection("models", 0);
			return center;
		};

		const checklistCancel = makeCenter();
		checklistCancel.handleInput(ENTER);
		checklistCancel.handleInput(" ");
		checklistCancel.handleInput(ESC);
		strictEqual(plans.length, 0, "Esc leaves the checklist without preparing a mutation");
		deepStrictEqual(settings.scope, ["target-a/model-a", "target-a/stale-model", "retired,Legacy@2025"]);

		const destinationCancel = makeCenter();
		destinationCancel.handleInput(ENTER);
		for (let index = 0; index < 5; index += 1) destinationCancel.handleInput(DOWN);
		const staleSelected = stripAnsi(destinationCancel.render(112).join("\n"));
		ok(staleSelected.includes(`${GLYPH.cursor} [x] target-a/stale-model`), staleSelected);
		destinationCancel.handleInput(" ");
		destinationCancel.handleInput(ENTER);
		strictEqual(plans.length, 1);
		deepStrictEqual(plans[0]?.proposed.scope, ["target-a/model-a", "retired,Legacy@2025"]);
		destinationCancel.handleInput(ESC);
		strictEqual(applied.length, 0, "Esc at the destination prompt cancels the prepared plan");
		deepStrictEqual(settings.scope, ["target-a/model-a", "target-a/stale-model", "retired,Legacy@2025"]);
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

	it("renders non-selectable sidebar tags without adding navigation stops", () => {
		const center = noopSettingsCenter(30);
		const rendered = stripAnsi(center.render(112).join("\n"));
		const tags = ["CORE", "ROUTING", "RUNTIME", "EXPERIENCE"];
		let previous = -1;
		for (const tag of tags) {
			const position = rendered.indexOf(tag);
			ok(position > previous, `${tag} is rendered in sidebar order`);
			previous = position;
		}
		center.handleInput("\t");
		const visited: string[] = [];
		for (let index = 0; index < SETTINGS_SECTIONS.length; index += 1) {
			visited.push(center.getSelection().section);
			center.handleInput("j");
		}
		deepStrictEqual(
			visited,
			SETTINGS_SECTIONS.map((section) => section.id),
		);
	});

	it("skips Fleet group headers and preserves entity plus drilled-field identity across shape refreshes", () => {
		const settings = settingsWithTargets();
		const items = buildSettingItems(settings);
		const center = new SettingsCenter(items, {
			getBodyHeight: () => 30,
			prepareChange: () => null,
			onApply: () => undefined,
			onCancel: () => undefined,
		});
		const fleetItems = (): typeof items => items.filter((item) => item.section === "fleet");
		center.setSelection(
			"fleet",
			fleetItems().findIndex((item) => item.id === "fleet.group.profiles"),
		);
		strictEqual(center.getSelection().rowId, "workers.profiles.fast", "a group header resolves to its first entity");

		center.handleInput(ENTER);
		center.handleInput(DOWN); // Edit model
		settings.workers.profiles.alpha = {
			target: "target-a",
			model: "model-a",
			thinkingLevel: "off",
		};
		items.splice(0, items.length, ...buildSettingItems(settings));
		center.refreshItems();
		strictEqual(center.getSelection().section, "fleet");
		strictEqual(center.getSelection().rowId, "workers.profiles.fast", "profile identity survives an earlier insertion");
		ok(
			stripAnsi(center.render(112).join("\n")).includes(`❯ ${GLYPH.active} Edit model`),
			"drilled field identity survives refresh",
		);

		center.handleInput(ESC);
		const scoutIndex = fleetItems().findIndex((item) => item.id === "workers.agentBindings.scout");
		center.setSelection("fleet", scoutIndex);
		settings.workers.agentBindings.alpha = "alpha";
		items.splice(0, items.length, ...buildSettingItems(settings));
		center.refreshItems();
		strictEqual(
			center.getSelection().rowId,
			"workers.agentBindings.scout",
			"route identity survives an earlier insertion",
		);
		delete settings.workers.agentBindings.alpha;
		items.splice(0, items.length, ...buildSettingItems(settings));
		center.refreshItems();
		strictEqual(center.getSelection().rowId, "workers.agentBindings.scout", "route identity survives a removal");
	});

	it("renders clean confirmation titles for profile adds, bindings, and every workbench field", () => {
		const settings = settingsWithTargets();
		const confirmation = (id: EditableSettingId, value: string): string => {
			const items = buildSettingItems(settings);
			const originalItem = items.find((item) => item.id === id);
			ok(originalItem, `${id} exists`);
			const titleItem = { ...originalItem, values: [value] };
			delete titleItem.submenu;
			const titleItems = items.map((item) => (item.id === id ? titleItem : item));
			const center = new SettingsCenter(titleItems, {
				getBodyHeight: () => 24,
				prepareChange: (item, selectedValue) => createSettingsChangePlan(settings, item, selectedValue),
				onApply: () => undefined,
				onCancel: () => undefined,
			});
			const sectionItems = titleItems.filter((item) => item.section === originalItem.section);
			center.setSelection(
				originalItem.section,
				sectionItems.findIndex((item) => item.id === id),
			);
			center.handleInput(ENTER);
			center.handleInput(ENTER);
			// Two-lane width: wide enough for a clean title, narrow enough that the
			// origin still has to give way to the destination.
			return stripAnsi(center.render(72).join("\n"));
		};

		const cases = [
			{ id: "workers.profiles" as const, value: "tester-tmp -> target-a", title: "Add profile: tester-tmp → target-a" },
			{
				id: "workers.agentBindings" as const,
				value: "researcher -> fast",
				title: "Add agent route: researcher → fast",
			},
			{ id: "workers.profiles.fast" as const, value: "target -> target-a", title: "fast: → target → target-a" },
			{ id: "workers.profiles.fast" as const, value: "model -> model-next", title: "fast: → model → model-next" },
			{ id: "workers.profiles.fast" as const, value: "thinkingLevel -> on", title: "fast: → thinking → on" },
			{ id: "workers.profiles.fast" as const, value: "node -> local", title: "fast: → placement → local" },
		];
		for (const testCase of cases) {
			const rendered = confirmation(testCase.id, testCase.value);
			ok(rendered.includes(testCase.title), `${testCase.title} missing from:\n${rendered}`);
			ok(!rendered.includes(" -> "), `internal separator leaked into:\n${rendered}`);
		}
	});

	it("budgets a realistic profile summary so target, model, thinking, and placement all remain visible", () => {
		const settings = settingsWithTargets();
		settings.targets.push({
			id: "mini",
			runtime: "openai-compat",
			url: "http://localhost:3333",
			defaultModel: "Qwen3.8-27B-IQ4_NL-262K",
		});
		settings.workers.profiles.realistic = {
			target: "mini",
			model: "Qwen3.8-27B-IQ4_NL-262K",
			thinkingLevel: "low",
			node: "local",
		};
		const row = buildSettingItems(settings).find((item) => item.id === "workers.profiles.realistic");
		ok(row);
		const compact = row.valueSegments.map((segment) => segment.text).join("");
		ok(Array.from(compact).length <= 26, `profile summary exceeded 26 cells: ${compact}`);
		for (const fact of ["mini/", "Qwen3.8", "low", "local", "…"])
			ok(compact.includes(fact), `${fact} missing from ${compact}`);
		strictEqual(row.currentValue, "mini/Qwen3.8-27B-IQ4_NL-262K  low  local");
	});

	it("marks every profile workbench edit as an action", () => {
		const items = buildSettingItems(settingsWithTargets());
		const center = new SettingsCenter(items, {
			getBodyHeight: () => 24,
			prepareChange: () => null,
			onApply: () => undefined,
			onCancel: () => undefined,
		});
		const fleetItems = items.filter((item) => item.section === "fleet");
		center.setSelection(
			"fleet",
			fleetItems.findIndex((item) => item.id === "workers.profiles.fast"),
		);
		center.handleInput(ENTER);
		const rendered = stripAnsi(center.render(112).join("\n"));
		for (const label of ["Edit target", "Edit model", "Edit thinking level", "Edit placement"]) {
			ok(rendered.includes(`${GLYPH.active} ${label}`), `${label} lacks the action glyph:\n${rendered}`);
		}
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

	it("lands command deep links on exact rows and Targets on the first actionable row or empty CTA", () => {
		for (const deepLink of [
			{ section: "orchestrator" as const, rowId: "orchestrator.thinkingLevel" as const, label: "Thinking level" },
			{ section: "terminal" as const, rowId: "terminal.outputVerbosity" as const, label: "Output detail" },
			{ section: "models" as const, rowId: "scope" as const, label: "Model cycle set" },
		]) {
			const fake = fakeTui(24, 100);
			openSettingsOverlay(fake.tui, {
				getSettings: settingsWithTargets,
				writeSettings: () => undefined,
				section: deepLink.section,
				rowId: deepLink.rowId,
				onClose: () => undefined,
			});
			const overlay = fake.captured();
			ok(overlay);
			const rendered = stripAnsi(overlay.render(120).join("\n"));
			ok(
				rendered.split("\n").some((line) => line.includes("❯") && line.includes(deepLink.label)),
				rendered,
			);
		}

		const configured = new SettingsCenter(buildSettingItems(settingsWithTargets()), {
			getBodyHeight: () => 30,
			prepareChange: () => null,
			onApply: () => undefined,
			onCancel: () => undefined,
		});
		configured.setSelection("targets", 0);
		strictEqual(configured.getSelection().rowId, "targets.target-a");

		const emptySettings = settingsWithTargets();
		emptySettings.targets = [];
		const empty = new SettingsCenter(buildSettingItems(emptySettings), {
			getBodyHeight: () => 30,
			prepareChange: () => null,
			onApply: () => undefined,
			onCancel: () => undefined,
		});
		empty.setSelection("targets", 0);
		strictEqual(empty.getSelection().rowId, "targets.add-cta");
		const emptyRender = stripAnsi(empty.render(112).join("\n"));
		strictEqual(emptyRender.split("clio-coder targets add").length - 1, 1, "the accepted add command appears once");
		ok(emptyRender.includes("Run the command shown"));
		ok(emptyRender.includes("accepted add wizard"));
		ok(!emptyRender.includes("use: chat now"), emptyRender);
		ok(!emptyRender.includes("remove: next dispatch"), emptyRender);
	});

	it("routes one explicit global commit through commitSetting and emits a scoped notice", () => {
		const live = { current: settingsWithTargets() };
		const fake = fakeTui(24, 100);
		const calls: Array<{ id: string; scope: "session" | "global" }> = [];
		const notices: Array<{
			level: string;
			text: string;
			key?: string | undefined;
		}> = [];
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
	it("renders Fleet as grouped one-row entities with explicit add actions", () => {
		const settings = settingsWithTargets();
		settings.workers.agentBindings.researcher = "missing";
		const sections = new Map(buildSettingsSections(buildSettingItems(settings)).map((s) => [s.id, s.items]));
		deepStrictEqual(
			sections.get("fleet")?.map((item) => item.id),
			[
				"fleet.group.defaults",
				"workers.default.target",
				"workers.default.model",
				"workers.default.thinkingLevel",
				"workers.maxRetries",
				"fleet.group.profiles",
				"workers.profiles.fast",
				"workers.profiles",
				"fleet.group.agent-routes",
				"workers.agentBindings.researcher",
				"workers.agentBindings.scout",
				"workers.agentBindings",
				"fleet.group.placement",
			],
		);
		deepStrictEqual(
			sections.get("targets")?.map((item) => item.id),
			["targets", "targets.target-a", "targets.target-b", "targets.add-cta"],
		);
		const byId = new Map(buildSettingItems(settings).map((item) => [item.id, item]));
		strictEqual(byId.get("workers.profiles")?.label, "Add profile");
		deepStrictEqual(byId.get("workers.profiles")?.valueSegments, []);
		ok(byId.get("workers.profiles")?.submenu, "the profiles row adds a profile");
		ok(byId.get("workers.agentBindings")?.submenu, "the bindings row binds an agent");
		strictEqual(byId.get("workers.profiles.fast")?.currentValue, "target-b/model-b  off  auto");
		strictEqual(byId.get("workers.profiles.fast")?.configPath, "workers.profiles.fast");
		strictEqual(
			byId.get("workers.profiles.fast")?.help,
			"workers.profiles.fast.target · workers.profiles.fast.model · workers.profiles.fast.thinkingLevel · workers.profiles.fast.node",
		);
		strictEqual(byId.get("workers.agentBindings.scout")?.currentValue, "fast");
		ok(byId.get("workers.agentBindings.researcher")?.description.includes("does not exist"));
		strictEqual(byId.get("targets.target-a")?.currentValue, "unknown · target-a · chat+fleet · openai-compat · —");
		strictEqual(byId.get("targets.target-b")?.currentValue, "unknown · target-b · — · openai-compat · —");
		ok(byId.get("targets")?.readOnly, "adding a target stays with `clio-coder targets add`");
		strictEqual(byId.get("targets.add-cta")?.currentValue, "`clio-coder targets add`");
		for (const id of ["workers.profiles.fast", "workers.agentBindings.scout", "targets.target-a"]) {
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
		const cases: Array<{
			id: string;
			value: string;
			assert: (settings: ClioSettings) => void;
		}> = [
			{
				id: "workers.profiles",
				value: "slow -> target-a",
				assert: (s) =>
					deepStrictEqual(s.workers.profiles.slow, {
						target: "target-a",
						model: "model-a",
						thinkingLevel: "off",
					}),
			},
			{
				id: "workers.profiles.fast.target",
				value: "target-a",
				assert: (s) =>
					deepStrictEqual(s.workers.profiles.fast, {
						target: "target-a",
						model: "model-a",
						thinkingLevel: "off",
					}),
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
			{
				id: "acp-agent",
				command: "acp",
				args: [],
				env: {},
				cwd: null,
				description: "",
			} as never,
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
				id: "workers.profiles.fast",
				value: "target -> target-a",
				paths: ["workers.profiles.fast"],
				assertApplied: (settings) => strictEqual(settings.workers.profiles.fast?.target, "target-a"),
			},
			{
				name: "profile remove",
				id: "workers.profiles.fast",
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
					settings.workers.profiles.slow = {
						target: "target-a",
						model: "model-a",
						thinkingLevel: "off",
					};
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
				id: "workers.profiles.fast",
				value: "node -> local",
				paths: ["workers.profiles.fast"],
				assertApplied: (settings) => strictEqual(settings.workers.profiles.fast?.node, "local"),
			},
			{
				name: "node auto placement",
				id: "workers.profiles.fast",
				value: "node -> (auto placement)",
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
		overlay.handleInput?.("j"); // targets.target-b (the group header is non-selectable)
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
		strictEqual(
			buildSettingItems(live.current).find((item) => item.id === "targets.target-b")?.targetConsole?.roles,
			"chat+fleet",
			"the target row derives the roles it now serves",
		);
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
		overlay.handleInput?.("j"); // target-b
		overlay.handleInput?.(ENTER); // probe, remove
		overlay.handleInput?.(ENTER); // probe throws synchronously but the UI settles
		ok(!stripAnsi(overlay.render(120).join("\n")).includes(`${GLYPH.running} probing`));
	});

	it("shows target removal preflight from exact change-plan leaves", () => {
		const live = { current: settingsWithTargets() };
		live.current.background = { target: "target-a", model: "memory-model", thinkingLevel: "off" };
		live.current.workers.profiles.local = {
			target: "target-a",
			model: "model-a",
			thinkingLevel: "off",
		};
		const fake = fakeTui(30, 120);
		openSettingsOverlay(fake.tui, {
			getSettings: () => live.current,
			writeSettings: (next) => {
				live.current = next;
			},
			commitSetting: () => undefined,
			section: "targets",
			onClose: () => undefined,
		});
		const overlay = fake.captured();
		ok(overlay);
		overlay.handleInput?.(ENTER); // target-a actions: use, remove
		overlay.handleInput?.(DOWN);
		overlay.handleInput?.(ENTER); // removal preflight
		const preflight = stripAnsi(overlay.render(120).join("\n")).replace(/\s+/g, " ");
		for (const expected of [
			"Affected chat route:",
			"orchestrator.target",
			"orchestrator.model",
			"Affected fleet route:",
			"workers.default.target",
			"workers.default.model",
			"Affected memory route:",
			"background.target",
			"background.model",
			"Affected profiles: local",
		]) {
			ok(preflight.includes(expected), `${expected} missing from:\n${preflight}`);
		}
	});

	it("shows exactly one live target indicator across overlapping targets", async () => {
		const live = { current: settingsWithTargets() };
		const fake = fakeTui(30, 120);
		const settles = new Map<string, () => void>();
		openSettingsOverlay(fake.tui, {
			getSettings: () => live.current,
			writeSettings: (next) => {
				live.current = next;
			},
			connectTarget: (targetId) =>
				new Promise<void>((resolve) => {
					settles.set(targetId, resolve);
				}),
			section: "targets",
			onClose: () => undefined,
		});
		const overlay = fake.captured();
		ok(overlay);
		overlay.handleInput?.(ENTER); // target-a actions
		overlay.handleInput?.(DOWN);
		overlay.handleInput?.(ENTER); // connect target-a
		overlay.handleInput?.("j"); // target-b
		overlay.handleInput?.(ENTER);
		overlay.handleInput?.(DOWN);
		overlay.handleInput?.(ENTER); // connect target-b
		let rendered = stripAnsi(overlay.render(120).join("\n"));
		strictEqual(rendered.split(`${GLYPH.running} connecting`).length - 1, 1, rendered);
		settles.get("target-a")?.();
		await Promise.resolve();
		await Promise.resolve();
		rendered = stripAnsi(overlay.render(120).join("\n"));
		strictEqual(rendered.split(`${GLYPH.running} connecting`).length - 1, 1, rendered);
		settles.get("target-b")?.();
		await Promise.resolve();
		await Promise.resolve();
		ok(!stripAnsi(overlay.render(120).join("\n")).includes(`${GLYPH.running} connecting`));
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
		for (let i = 0; i < 4; i += 1) overlay.handleInput?.("j"); // one-row fast profile summary
		overlay.handleInput?.(ENTER); // profile field workbench
		for (let i = 0; i < 4; i += 1) overlay.handleInput?.(DOWN);
		const destructive = overlay.render(120).join("\n");
		ok(destructive.includes(`${clioTheme().fgSequence("error")}${GLYPH.error} Remove profile`));
		overlay.handleInput?.(ENTER); // named destructive action -> preflight
		const preflight = stripAnsi(overlay.render(120).join("\n"));
		ok(preflight.includes("Affected agent routes: scout"), preflight);
		ok(preflight.includes("workers.agentBindings.scout"), preflight);
		overlay.handleInput?.(ENTER); // Apply this session
		deepStrictEqual(calls.sort(), ["workers.agentBindings.scout", "workers.profiles.fast"]);
		const rendered = stripAnsi(overlay.render(120).join("\n"));
		ok(!rendered.includes("target-b/model-b"), rendered);
		ok(rendered.includes("Add profile"), "the explicit add action remains after removal");
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
		for (let i = 0; i < 5; i += 1) overlay.handleInput?.("j"); // Add profile
		overlay.handleInput?.(ENTER); // name input, seeded empty rather than with the row's count
		for (const ch of "slow") overlay.handleInput?.(ch);
		overlay.handleInput?.(ENTER); // target picker
		overlay.handleInput?.(ENTER); // target-a
		overlay.handleInput?.(ENTER); // Apply this session
		deepStrictEqual(calls, ["workers.profiles.slow"]);
		deepStrictEqual(live.current.workers.profiles.slow, {
			target: "target-a",
			model: "model-a",
			thinkingLevel: "off",
		});
		let rendered = stripAnsi(overlay.render(120).join("\n"));
		ok(rendered.includes("slow"), rendered);
		strictEqual(
			buildSettingItems(live.current).find((item) => item.id === "workers.profiles.slow")?.currentValue,
			"target-a/model-a  off  auto",
		);

		for (let i = 0; i < 2; i += 1) overlay.handleInput?.("j"); // scout route, then Add agent route
		overlay.handleInput?.(ENTER); // agent id input
		for (const ch of "researcher") overlay.handleInput?.(ch);
		overlay.handleInput?.(ENTER); // profile picker: fast, slow
		overlay.handleInput?.(DOWN);
		overlay.handleInput?.(ENTER); // slow
		overlay.handleInput?.(ENTER); // Apply this session
		deepStrictEqual(calls, ["workers.profiles.slow", "workers.agentBindings.researcher"]);
		strictEqual(live.current.workers.agentBindings.researcher, "slow");
		rendered = stripAnsi(overlay.render(120).join("\n"));
		ok(rendered.includes("researcher"), rendered);
	});
});
