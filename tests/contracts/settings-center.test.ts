import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { MAX_TIMER_DELAY_MS } from "../../src/core/timers.js";
import type { Component, OverlayHandle, TUI } from "../../src/engine/tui.js";
import {
	applySettingChange,
	buildSettingItems,
	buildSettingsSections,
	type EditableSettingId,
	openSettingsOverlay,
	SETTINGS_LABELS_BY_ID,
	SETTINGS_SECTION_ROWS,
	SETTINGS_SECTIONS,
	SettingsCenter,
} from "../../src/interactive/overlays/settings.js";

const ESC = String.fromCharCode(27);
const ENTER = "\r";
const DOWN = `${ESC}[B`;
const SGR_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
const SCOPE_NOTE = "this session";

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

function stripAnsi(value: string): string {
	return value.replace(SGR_PATTERN, "");
}

function noopSettingsCenter(bodyHeight: number): SettingsCenter {
	return new SettingsCenter(buildSettingItems(settingsWithTargets()), {
		getBodyHeight: () => bodyHeight,
		onCommit: () => undefined,
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
	const center = new SettingsCenter(buildSettingItems(settingsWithTargets()), {
		getBodyHeight: () => bodyHeight,
		onCommit: (id, value, scope) => commits.push({ id, value, scope }),
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

	it("Space previews a value without committing; Enter commits it", () => {
		const { center, commits } = spyingSettingsCenter(26);
		center.setSelection("safety", 0); // autonomy = auto-edit
		center.handleInput(" "); // preview → full-auto
		strictEqual(commits.length, 0, "preview must not commit");
		const previewed = stripAnsi(center.render(112).join("\n"));
		ok(previewed.includes("full-auto"), "preview value is shown");
		center.handleInput(ENTER); // commit pending → applies to session, opens scope confirm
		deepStrictEqual(commits, [{ id: "autonomy", value: "full-auto", scope: "session" }]);
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
		center.handleInput(ENTER);
		deepStrictEqual(commits, [{ id: "workers.onPermission", value: "escalate", scope: "session" }]);

		applySettingChange(settings, "workers.onPermission", "escalate");
		strictEqual(settings.workers.onPermission, "escalate");
		const reloaded = buildSettingItems(settings).find((item) => item.id === "workers.onPermission");
		strictEqual(reloaded?.currentValue, "escalate");
	});

	it("a live knob applies to the session immediately, then offers a global save", () => {
		const { center, commits } = spyingSettingsCenter(26);
		center.setSelection("safety", 0); // autonomy
		center.handleInput(ENTER); // advance one + commit session + open confirm
		deepStrictEqual(commits, [{ id: "autonomy", value: "full-auto", scope: "session" }]);
		center.handleInput(ENTER); // choose the default option: save globally
		deepStrictEqual(commits, [
			{ id: "autonomy", value: "full-auto", scope: "session" },
			{ id: "autonomy", value: "full-auto", scope: "global" },
		]);
	});

	it("Esc on the confirm dialog keeps a live edit session-only", () => {
		const { center, commits } = spyingSettingsCenter(26);
		center.setSelection("safety", 0);
		center.handleInput(ENTER); // session apply + confirm
		center.handleInput(ESC); // decline global
		deepStrictEqual(commits, [{ id: "autonomy", value: "full-auto", scope: "session" }]);
	});

	it("a restart-required knob is global-only and never applies to the session", () => {
		const { center, commits } = spyingSettingsCenter(26);
		center.setSelection("budget", 2); // budget.concurrency = auto
		center.handleInput(ENTER); // open confirm; no session apply for restart knobs
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

	it("routes session vs global commits through commitSetting and emits a scoped notice", () => {
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

		overlay.handleInput?.(ENTER); // autonomy: session apply + confirm
		overlay.handleInput?.(ENTER); // save globally

		deepStrictEqual(calls, [
			{ id: "autonomy", scope: "session" },
			{ id: "autonomy", scope: "global" },
		]);
		strictEqual(notices.length, 2);
		strictEqual(notices[1]?.text, "autonomy set to full-auto (saved globally)");
		strictEqual(notices[1]?.key, "settings:autonomy");
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
		overlay.handleInput?.(ENTER); // commit (session → writeSettings fallback)
		overlay.handleInput?.(ENTER); // global → writeSettings
		ok(writes >= 1, "edits persist through writeSettings when commitSetting is absent");
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
		overlay.handleInput?.(ESC); // session only
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
		overlay.handleInput?.(ENTER); // target picker: target-a, target-b, (remove profile)
		overlay.handleInput?.(DOWN);
		overlay.handleInput?.(DOWN);
		overlay.handleInput?.(ENTER); // (remove profile)
		overlay.handleInput?.(ESC); // session only
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
		overlay.handleInput?.(ESC); // session only
		deepStrictEqual(calls, ["workers.profiles.slow"]);
		deepStrictEqual(live.current.workers.profiles.slow, { target: "target-a", model: "model-a", thinkingLevel: "off" });
		let rendered = stripAnsi(overlay.render(120).join("\n"));
		ok(rendered.includes("slow · target"), rendered);

		for (let i = 0; i < 7; i += 1) overlay.handleInput?.("j"); // past the fast and slow rows to workers.agentBindings
		overlay.handleInput?.(ENTER); // agent id input
		for (const ch of "researcher") overlay.handleInput?.(ch);
		overlay.handleInput?.(ENTER); // profile picker: fast, slow
		overlay.handleInput?.(DOWN);
		overlay.handleInput?.(ENTER); // slow
		overlay.handleInput?.(ESC);
		deepStrictEqual(calls, ["workers.profiles.slow", "workers.agentBindings.researcher"]);
		strictEqual(live.current.workers.agentBindings.researcher, "slow");
		rendered = stripAnsi(overlay.render(120).join("\n"));
		ok(rendered.includes("researcher · p"), rendered);
	});
});
