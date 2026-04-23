import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	CLIO_APP_KEYBINDING_IDS,
	CLIO_APP_KEYBINDINGS,
	CLIO_KEYBINDINGS,
} from "../../src/domains/config/keybindings.js";
import { createKeybindingManagerForTesting } from "../../src/interactive/keybinding-manager.js";

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

	it("app id list is exactly 10 entries (matches the routed set in interactive/index.ts)", () => {
		strictEqual(CLIO_APP_KEYBINDING_IDS.length, 10);
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
	});

	it("reports zero overrides when no user keybindings are configured", () => {
		strictEqual(manager.overrideCount(), 0);
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
