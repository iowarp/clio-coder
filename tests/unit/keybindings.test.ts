import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CLIO_APP_KEYBINDING_IDS,
	CLIO_APP_KEYBINDINGS,
	CLIO_KEYBINDINGS,
} from "../../src/domains/config/keybindings.js";
import {
	createKeybindingManagerForTesting,
	detectPlatformKeybindingWarnings,
	detectTerminalKeySupport,
	formatInvalidKeybindingNotice,
	formatPlatformKeybindingNotice,
	isValidKeyId,
	keyRequiresCsiU,
	validateKeybindings,
} from "../../src/interactive/keybinding-manager.js";

describe("domains/config/keybindings schema", () => {
	it("every Clio action declares at least one default key", () => {
		for (const id of CLIO_APP_KEYBINDING_IDS) {
			const def = CLIO_APP_KEYBINDINGS[id];
			const keys = Array.isArray(def.defaultKeys) ? def.defaultKeys : [def.defaultKeys];
			ok(keys.length > 0 && keys.every((k) => k.length > 0), `${id} has empty defaultKeys`);
			ok(def.description && def.description.length > 0, `${id} has empty description`);
		}
	});

	it("CLIO_KEYBINDINGS merges pi-tui defaults with the app table", () => {
		// Sanity check that TUI defaults are present (editor/select) and app ids too.
		ok("tui.editor.cursorUp" in CLIO_KEYBINDINGS);
		ok("tui.select.confirm" in CLIO_KEYBINDINGS);
		for (const id of CLIO_APP_KEYBINDING_IDS) {
			ok(id in CLIO_KEYBINDINGS, `${id} missing from merged table`);
		}
	});

	it("app id list is exactly 12 entries (matches the routed set in interactive/index.ts)", () => {
		strictEqual(CLIO_APP_KEYBINDING_IDS.length, 12);
	});

	it("registers clio.thinking.expand with default ctrl+t", () => {
		ok("clio.thinking.expand" in CLIO_APP_KEYBINDINGS);
		const def = CLIO_APP_KEYBINDINGS["clio.thinking.expand"];
		strictEqual(def.defaultKeys, "ctrl+t");
		strictEqual(def.description, "Toggle thinking blocks between hidden marker and full body");
	});
});

describe("interactive/keybinding-manager defaults", () => {
	const manager = createKeybindingManagerForTesting();

	it("matches Shift+Tab against clio.thinking.cycle", () => {
		strictEqual(manager.matches("\x1b[Z", "clio.thinking.cycle"), true);
	});

	it("matches Ctrl+D against clio.exit", () => {
		strictEqual(manager.matches("\x04", "clio.exit"), true);
	});

	it("matches Ctrl+L against clio.model.select", () => {
		strictEqual(manager.matches("\x0c", "clio.model.select"), true);
	});

	it("matches Ctrl+P against clio.model.cycleForward", () => {
		strictEqual(manager.matches("\x10", "clio.model.cycleForward"), true);
	});

	it("matches Alt+M against clio.mode.cycle", () => {
		strictEqual(manager.matches("\x1bm", "clio.mode.cycle"), true);
	});

	it("matches Alt+S against clio.super.request", () => {
		strictEqual(manager.matches("\x1bs", "clio.super.request"), true);
	});

	it("matches Alt+T against clio.session.tree", () => {
		strictEqual(manager.matches("\x1bt", "clio.session.tree"), true);
	});

	it("matches Ctrl+B against clio.dispatchBoard.toggle", () => {
		strictEqual(manager.matches("\x02", "clio.dispatchBoard.toggle"), true);
	});

	it("matches Ctrl+R against clio.harness.restart", () => {
		strictEqual(manager.matches("\x12", "clio.harness.restart"), true);
	});

	it("matches Ctrl+T against clio.thinking.expand", () => {
		strictEqual(manager.matches("\x14", "clio.thinking.expand"), true);
	});

	it("rejects unrelated keystrokes for a specific binding", () => {
		strictEqual(manager.matches("\x0c", "clio.super.request"), false);
		strictEqual(manager.matches("\x1bs", "clio.exit"), false);
	});

	it("returns the configured keys for /hotkeys rendering", () => {
		const entries = manager.hotkeyEntries();
		strictEqual(entries.length, CLIO_APP_KEYBINDING_IDS.length);
		const thinking = entries.find((e) => e.id === "clio.thinking.cycle");
		ok(thinking);
		strictEqual(thinking.keys, "shift+tab");
		strictEqual(thinking.description, "Cycle orchestrator thinking level");
		strictEqual(thinking.source, "default");
	});

	it("reports zero overrides when no user keybindings are configured", () => {
		strictEqual(manager.overrideCount(), 0);
	});
});

describe("interactive/keybinding-manager platform warnings", () => {
	it("detects CSI-u capable and legacy terminals from env", () => {
		strictEqual(detectTerminalKeySupport({ KITTY_WINDOW_ID: "1", TERM: "xterm-kitty" }).supportsCsiU, true);
		strictEqual(detectTerminalKeySupport({ TERM_PROGRAM: "WezTerm" }).supportsCsiU, true);
		const legacy = detectTerminalKeySupport({ TERM: "xterm-256color" });
		strictEqual(legacy.supportsCsiU, false);
		ok(legacy.reason.includes("CSI-u"));
	});

	it("identifies shift+ctrl printable bindings as CSI-u dependent", () => {
		strictEqual(keyRequiresCsiU("shift+ctrl+p"), true);
		strictEqual(keyRequiresCsiU("ctrl+shift+1"), true);
		strictEqual(keyRequiresCsiU("shift+tab"), false);
		strictEqual(keyRequiresCsiU("ctrl+p"), false);
	});

	it("warns only for user bindings that cannot fire on legacy terminals", () => {
		const { valid } = validateKeybindings({
			"clio.model.cycleBackward": "shift+ctrl+p",
			"clio.exit": "ctrl+d",
		});
		const warnings = detectPlatformKeybindingWarnings(valid, {
			name: "xterm-256color",
			supportsCsiU: false,
			reason: "CSI-u support not detected",
		});
		strictEqual(warnings.length, 1);
		strictEqual(warnings[0]?.id, "clio.model.cycleBackward");
		deepStrictEqual([...(warnings[0]?.keys ?? [])], ["shift+ctrl+p"]);
	});

	it("does not warn on CSI-u capable terminals", () => {
		const manager = createKeybindingManagerForTesting(
			{ "clio.model.cycleBackward": "shift+ctrl+p" },
			{ KITTY_WINDOW_ID: "1" },
		);
		strictEqual(manager.platformWarnings().length, 0);
		const entry = manager.hotkeyEntries().find((row) => row.id === "clio.model.cycleBackward");
		strictEqual(entry?.source, "user");
	});

	it("formats platform warnings as one boot diagnostic", () => {
		const notice = formatPlatformKeybindingNotice([
			{
				id: "clio.model.cycleBackward",
				keys: ["shift+ctrl+p"],
				terminal: "xterm-256color",
				reason: "CSI-u support not detected",
			},
		]);
		ok(notice.startsWith("Clio Coder: 1 keybinding may not fire"), notice);
		ok(notice.includes(`clio.model.cycleBackward="shift+ctrl+p"`), notice);
		ok(notice.includes("/hotkeys"), notice);
		ok(notice.endsWith("\n"));
	});
});

describe("interactive/keybinding-manager overrides + conflicts", () => {
	it("user override replaces the default for the same action", () => {
		// alt+h is unused anywhere in CLIO_KEYBINDINGS by default. Sanity-check
		// that it is unmatched for clio.exit when we override exit to alt+h.
		const manager = createKeybindingManagerForTesting({
			"clio.exit": "alt+h",
		});
		// Default Ctrl+D no longer fires exit, alt+h does.
		strictEqual(manager.matches("\x04", "clio.exit"), false);
		strictEqual(manager.matches("\x1bh", "clio.exit"), true);
		strictEqual(manager.overrideCount(), 1);
	});

	it("supports KeyId[] overrides so two chords bind to one action", () => {
		const manager = createKeybindingManagerForTesting({
			"clio.session.tree": ["alt+t", "alt+g"],
		});
		strictEqual(manager.matches("\x1bt", "clio.session.tree"), true);
		strictEqual(manager.matches("\x1bg", "clio.session.tree"), true);
	});

	it("reports conflicts when two user overrides resolve to the same key", () => {
		// pi-tui's KeybindingsManager only diagnoses conflicts across user
		// bindings (default-vs-user intentionally silent because overriding
		// is the normal case). Two user overrides claiming the same chord is
		// a duplicate the user likely didn't mean.
		const manager = createKeybindingManagerForTesting({
			"clio.exit": "alt+x",
			"clio.super.request": "alt+x",
		});
		const conflicts = manager.getConflicts();
		ok(conflicts.length >= 1, "expected at least one conflict");
		const altX = conflicts.find((c) => c.key === "alt+x");
		ok(altX, "expected a conflict on alt+x");
		ok(altX.keybindings.includes("clio.exit") && altX.keybindings.includes("clio.super.request"));
	});

	it("an empty override for a binding leaves defaults in place", () => {
		// normalizeConfig drops empty strings, so the input is a no-op. This
		// is the code path the loader hits when a user writes `clio.exit: ""`.
		const manager = createKeybindingManagerForTesting({ "clio.exit": "" });
		strictEqual(manager.matches("\x04", "clio.exit"), true);
		strictEqual(manager.overrideCount(), 0);
	});

	it("deep-equal check on resolved defaults is deterministic", () => {
		const a = createKeybindingManagerForTesting().hotkeyEntries();
		const b = createKeybindingManagerForTesting().hotkeyEntries();
		deepStrictEqual(a, b);
	});
});

describe("interactive/keybinding-manager validation", () => {
	it("isValidKeyId accepts single letters, digits, symbols, and special keys", () => {
		for (const id of ["a", "z", "0", "9", "escape", "tab", "pageUp", "f10", "-", "]"]) {
			strictEqual(isValidKeyId(id), true, `expected ${id} to validate`);
		}
	});

	it("isValidKeyId accepts modifier combinations (case-insensitive)", () => {
		for (const id of ["ctrl+d", "alt+t", "shift+tab", "ctrl+shift+p", "Ctrl+Alt+X"]) {
			strictEqual(isValidKeyId(id), true, `expected ${id} to validate`);
		}
	});

	it("isValidKeyId rejects unmappable identifiers", () => {
		for (const id of ["banana", "ctrl+banana", "ctrl+ctrl+a", "", "++", "ctrl+"]) {
			strictEqual(isValidKeyId(id), false, `expected ${id} to be rejected`);
		}
	});

	it("validateKeybindings splits a raw block into valid + invalid buckets", () => {
		const { valid, invalid } = validateKeybindings({
			"clio.exit": "banana",
			"clio.session.tree": "alt+t",
			"clio.dispatchBoard.toggle": ["ctrl+b", "wasabi"],
		});
		deepStrictEqual(valid["clio.session.tree"], "alt+t");
		deepStrictEqual(valid["clio.dispatchBoard.toggle"], ["ctrl+b"]);
		strictEqual("clio.exit" in valid, false, "invalid string override must be dropped");
		const flat = invalid.flatMap((entry) => entry.keys.map((key) => `${entry.id}=${key}`));
		ok(flat.includes("clio.exit=banana"));
		ok(flat.includes("clio.dispatchBoard.toggle=wasabi"));
	});

	it("invalid overrides do not silently replace the default binding", () => {
		const manager = createKeybindingManagerForTesting({ "clio.exit": "banana" });
		// Ctrl+D still fires exit because the invalid override was dropped.
		strictEqual(manager.matches("\x04", "clio.exit"), true);
		strictEqual(manager.overrideCount(), 0);
		strictEqual(manager.invalidCount(), 1);
		const invalid = manager.invalidBindings();
		strictEqual(invalid.length, 1);
		strictEqual(invalid[0]?.id, "clio.exit");
		deepStrictEqual([...(invalid[0]?.keys ?? [])], ["banana"]);
	});

	it("formatInvalidKeybindingNotice renders a single actionable stderr line", () => {
		const notice = formatInvalidKeybindingNotice([
			{ id: "clio.exit", keys: ["banana"] },
			{ id: "clio.session.tree", keys: ["wasabi"] },
		]);
		ok(notice.startsWith("Clio Coder: 2 invalid keybindings"), notice);
		ok(notice.includes(`clio.exit="banana"`), notice);
		ok(notice.includes(`clio.session.tree="wasabi"`), notice);
		ok(notice.includes("settings.yaml"), notice);
		ok(notice.includes("clio doctor"), notice);
		ok(notice.endsWith("\n"));
	});
});
