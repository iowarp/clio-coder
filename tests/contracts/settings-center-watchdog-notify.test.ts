/**
 * Settings Center rows for `terminal.notify` and the `watchdog` block.
 *
 * Both knobs shipped yaml-only: the settings template documented them and the
 * config validator accepted them, but the Settings Center had no row, so the
 * only way to turn on desktop notifications or the turn-end watchdog was to
 * hand-edit settings.yaml. These contracts pin the rows down on both halves:
 * the rows exist in the right sections with the right presentation kinds, and
 * an edit committed through the ordinary write path lands in the file the way
 * the validator expects, including clearing an optional key by submitting an
 * empty value.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import type { ClioSettings } from "../../src/core/config.js";
import { readSettings, settingsPath, updateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS, DEFAULT_SETTINGS_YAML } from "../../src/core/defaults.js";
import {
	applySettingChange,
	buildSettingItems,
	buildSettingsSections,
	SETTINGS_SECTION_ROWS,
	SETTINGS_SECTIONS,
} from "../../src/interactive/overlays/settings.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

const ORIGINAL_ENV = { ...process.env };

const MINIMAL_FILE = `targets:
  - id: target-a
    runtime: openai-compat
    url: http://localhost:1111
    defaultModel: model-a
orchestrator:
  target: target-a
  model: model-a
`;

function baseSettings(): ClioSettings {
	const value = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
	value.targets = [{ id: "target-a", runtime: "openai-compat", url: "http://localhost:1111", defaultModel: "model-a" }];
	value.orchestrator.target = "target-a";
	value.orchestrator.model = "model-a";
	return value;
}

function itemsById(settings: ClioSettings) {
	return new Map(buildSettingItems(settings).map((item) => [item.id, item]));
}

describe("contracts/settings-center watchdog and notify rows", () => {
	it("puts terminal.notify under Terminal and the watchdog block under its own EXPERIENCE section", () => {
		const sections = buildSettingsSections(buildSettingItems(baseSettings()));
		const watchdog = SETTINGS_SECTIONS.find((section) => section.id === "watchdog");
		ok(watchdog, "a watchdog section exists");
		strictEqual(watchdog?.group, "EXPERIENCE");

		const terminalRows = sections.find((section) => section.id === "terminal")?.items.map((item) => item.id) ?? [];
		ok(terminalRows.includes("terminal.notify"), `terminal rows: ${terminalRows.join(", ")}`);

		const watchdogRows = sections.find((section) => section.id === "watchdog")?.items.map((item) => item.id) ?? [];
		deepStrictEqual(watchdogRows, ["watchdog.enabled", "watchdog.target", "watchdog.cadenceToolCalls"]);
		deepStrictEqual(
			[...SETTINGS_SECTION_ROWS.watchdog],
			["watchdog.enabled", "watchdog.target", "watchdog.cadenceToolCalls"],
		);
	});

	it("renders the two booleans as cycles and the two optional keys as editable text", () => {
		const byId = itemsById(baseSettings());

		for (const id of ["terminal.notify", "watchdog.enabled"] as const) {
			const row = byId.get(id);
			ok(row, `${id} has a row`);
			strictEqual(row?.presentationKind, "setting");
			strictEqual(row?.readOnly, false);
			deepStrictEqual(row?.values, ["false", "true"]);
			strictEqual(row?.currentValue, "false", "both ship off");
			strictEqual(row?.defaultValue, "false");
			strictEqual(row?.scope, "live");
		}

		const target = byId.get("watchdog.target");
		ok(target);
		strictEqual(target?.presentationKind, "setting");
		strictEqual(target?.affordance, "free text");
		strictEqual(target?.values, undefined, "a target id is typed, not cycled");
		ok(target?.submenu, "the row opens a text editor");
		// Absent rather than fabricated: an unset target means the session's own.
		strictEqual(target?.currentValue, "(session target)");
		strictEqual(target?.defaultValue, undefined, "an absent key has no shipped default to show");

		const cadence = byId.get("watchdog.cadenceToolCalls");
		ok(cadence);
		strictEqual(cadence?.presentationKind, "setting");
		strictEqual(cadence?.affordance, "free text");
		strictEqual(cadence?.currentValue, "(turn end only)");
		strictEqual(cadence?.defaultValue, undefined);
	});

	it("describes both knobs in the words the settings template already uses", () => {
		const byId = itemsById(baseSettings());
		const template = DEFAULT_SETTINGS_YAML.replace(/^\s*#\s?/gm, "").replace(/\s+/g, " ");
		const overlaps = [
			"Content-free desktop notification",
			"when a turn ends, a detached batch settles, or an approval parks",
			"Interactive TTY runs only; the body never carries prompt text, file paths, or model output",
			"When enabled, a turn that changed the tree is reviewed by one read-only verifier run",
			"briefed with the turn's coalesced diff and the task board's current scope; its blockers become one transcript notice and nothing else",
			"Headless and ACP runs never fire it",
			"Set target to route the run at a cheap local model",
			"fire every N tool calls inside a turn",
		];
		const overlaySurface = ["terminal.notify", "watchdog.enabled", "watchdog.target", "watchdog.cadenceToolCalls"]
			.flatMap((id) => {
				const row = byId.get(id as never);
				return [row?.description ?? "", row?.help ?? ""];
			})
			.join(" ")
			.replace(/\s+/g, " ");
		for (const phrase of overlaps) {
			ok(template.includes(phrase), `the settings template no longer contains: ${phrase}`);
			ok(overlaySurface.includes(phrase), `the Settings Center wording drifted from the template: ${phrase}`);
		}
	});
});

describe("contracts/settings-center watchdog and notify writes", () => {
	let scratch = "";

	beforeEach(async () => {
		scratch = await newScratchClioHome("clio-settings-watchdog-");
		writeFileSync(settingsPath(), MINIMAL_FILE, "utf8");
	});

	afterEach(() => {
		for (const k of Object.keys(process.env)) {
			if (!(k in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
			if (v !== undefined) process.env[k] = v;
		}
		clearScratchClioHome(scratch);
	});

	/** Commit one Settings Center edit through the write path the overlay uses. */
	function commit(id: string, value: string): void {
		updateSettings((settings) => {
			applySettingChange(settings, id, value);
		});
	}

	it("writes terminal.notify and watchdog.cadenceToolCalls as the validator reads them back", () => {
		commit("terminal.notify", "true");
		commit("watchdog.enabled", "true");
		commit("watchdog.cadenceToolCalls", "20");

		const doc = parseYaml(readFileSync(settingsPath(), "utf8")) as Record<string, Record<string, unknown>>;
		deepStrictEqual(doc.terminal, { notify: true });
		deepStrictEqual(doc.watchdog, { enabled: true, cadenceToolCalls: 20 });

		const reloaded = readSettings();
		strictEqual(reloaded.terminal.notify, true);
		strictEqual(reloaded.watchdog.enabled, true);
		strictEqual(reloaded.watchdog.cadenceToolCalls, 20);
	});

	it("removes watchdog.target from the file when the row is cleared", () => {
		commit("watchdog.target", "local-lmstudio");
		strictEqual(readSettings().watchdog.target, "local-lmstudio");
		ok(readFileSync(settingsPath(), "utf8").includes("local-lmstudio"));

		commit("watchdog.target", "   ");

		const raw = readFileSync(settingsPath(), "utf8");
		ok(!raw.includes("local-lmstudio"), `target survived the clear:\n${raw}`);
		const doc = parseYaml(raw) as Record<string, Record<string, unknown>>;
		ok(!(doc.watchdog && "target" in doc.watchdog), `the key survived the clear: ${JSON.stringify(doc.watchdog)}`);
		strictEqual("target" in readSettings().watchdog, false);
	});

	it("clears watchdog.cadenceToolCalls on an empty submission and rejects a value below one", () => {
		commit("watchdog.cadenceToolCalls", "5");
		strictEqual(readSettings().watchdog.cadenceToolCalls, 5);

		const rejected = structuredClone(DEFAULT_SETTINGS) as ClioSettings;
		rejected.watchdog.cadenceToolCalls = 5;
		applySettingChange(rejected, "watchdog.cadenceToolCalls", "0");
		strictEqual(rejected.watchdog.cadenceToolCalls, 5, "a cadence below one leaves the previous value alone");

		commit("watchdog.cadenceToolCalls", "");
		strictEqual("cadenceToolCalls" in readSettings().watchdog, false);
		const doc = parseYaml(readFileSync(settingsPath(), "utf8")) as Record<string, Record<string, unknown>>;
		ok(!(doc.watchdog && "cadenceToolCalls" in doc.watchdog), JSON.stringify(doc.watchdog));
	});
});
