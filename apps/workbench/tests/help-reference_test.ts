import { deepEqual, equal, ok } from "node:assert/strict";
import {
	formatKeybinding,
	HELP_SECTIONS,
	KEYBINDING_ORDER,
	KEYBINDINGS,
	type KeyEventLike,
	matchesKeybinding,
	searchHelp,
	VIEW_GUIDE,
} from "../src/help-reference.ts";

function key(overrides: Partial<KeyEventLike> & Pick<KeyEventLike, "key">): KeyEventLike {
	return { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...overrides };
}

Deno.test("every keybinding is declared once and no two chords collide", () => {
	const chords = KEYBINDING_ORDER.map(formatKeybinding);
	equal(new Set(chords).size, chords.length, "two bindings print the same chord");
	const ids = KEYBINDING_ORDER.map((binding) => binding.id);
	equal(new Set(ids).size, ids.length);
	deepEqual(ids, Object.keys(KEYBINDINGS));
	// No binding is a bare letter, and no two bindings answer the same event.
	for (const binding of KEYBINDING_ORDER) {
		ok(binding.key.length > 1 || binding.modifiers.length > 0, `${binding.id} would fire on plain typing`);
		const event = key({
			key: binding.key,
			altKey: binding.modifiers.includes("alt"),
			ctrlKey: binding.modifiers.includes("primary"),
			shiftKey: binding.modifiers.includes("shift"),
		});
		const matched = KEYBINDING_ORDER.filter((candidate) => matchesKeybinding(candidate, event));
		deepEqual(matched.map((candidate) => candidate.id), [binding.id]);
	}
});

Deno.test("the matcher is exact: the chord the handlers used before, and nothing looser", () => {
	// Send: Ctrl+Enter or Cmd+Enter, never bare Enter or Shift+Enter.
	ok(matchesKeybinding(KEYBINDINGS.send, key({ key: "Enter", ctrlKey: true })));
	ok(matchesKeybinding(KEYBINDINGS.send, key({ key: "Enter", metaKey: true })));
	equal(matchesKeybinding(KEYBINDINGS.send, key({ key: "Enter" })), false);
	equal(matchesKeybinding(KEYBINDINGS.send, key({ key: "Enter", shiftKey: true })), false);
	equal(matchesKeybinding(KEYBINDINGS.send, key({ key: "Enter", ctrlKey: true, altKey: true })), false);
	// Approval: Alt+A and Alt+R, either case, and not with Ctrl or Cmd held.
	ok(matchesKeybinding(KEYBINDINGS.allowOnce, key({ key: "a", altKey: true })));
	ok(matchesKeybinding(KEYBINDINGS.allowOnce, key({ key: "A", altKey: true })));
	ok(matchesKeybinding(KEYBINDINGS.reject, key({ key: "r", altKey: true })));
	equal(matchesKeybinding(KEYBINDINGS.allowOnce, key({ key: "a", altKey: true, ctrlKey: true })), false);
	equal(matchesKeybinding(KEYBINDINGS.allowOnce, key({ key: "a", altKey: true, metaKey: true })), false);
	equal(matchesKeybinding(KEYBINDINGS.allowOnce, key({ key: "a" })), false);
	equal(matchesKeybinding(KEYBINDINGS.reject, key({ key: "a", altKey: true })), false);
	// Escape and the catalog arrows take no modifier.
	ok(matchesKeybinding(KEYBINDINGS.escape, key({ key: "Escape" })));
	equal(matchesKeybinding(KEYBINDINGS.escape, key({ key: "Escape", ctrlKey: true })), false);
	ok(matchesKeybinding(KEYBINDINGS.catalogPreviousTab, key({ key: "ArrowLeft" })));
	ok(matchesKeybinding(KEYBINDINGS.catalogNextTab, key({ key: "ArrowRight" })));
	ok(matchesKeybinding(KEYBINDINGS.catalogFirstTab, key({ key: "Home" })));
	ok(matchesKeybinding(KEYBINDINGS.catalogLastTab, key({ key: "End" })));
	equal(matchesKeybinding(KEYBINDINGS.catalogNextTab, key({ key: "ArrowRight", shiftKey: true })), false);
});

Deno.test("the reference prints chords the way an operator reads them", () => {
	equal(formatKeybinding(KEYBINDINGS.send), "Ctrl or Cmd + Enter");
	equal(formatKeybinding(KEYBINDINGS.allowOnce), "Alt + A");
	equal(formatKeybinding(KEYBINDINGS.escape), "Esc");
	equal(formatKeybinding(KEYBINDINGS.catalogNextTab), "Right arrow");
});

Deno.test("every view has a guide entry and the reference lists every keybinding", () => {
	const views = HELP_SECTIONS.find((section) => section.id === "views");
	ok(views);
	deepEqual(views.entries.map((entry) => entry.term), Object.values(VIEW_GUIDE).map((guide) => guide.title));
	const keyboard = HELP_SECTIONS.find((section) => section.id === "keyboard");
	ok(keyboard);
	deepEqual(keyboard.entries.map((entry) => entry.term), KEYBINDING_ORDER.map(formatKeybinding));
	// The reserved slots exist, say they are not built, and carry no entries yet.
	for (const id of ["tasks-and-decisions", "interview"]) {
		const section = HELP_SECTIONS.find((candidate) => candidate.id === id);
		ok(section, `${id} slot`);
		equal(section.entries.length, 0);
		ok(section.reserved !== undefined && section.reserved.startsWith("This build of the desktop app"));
	}
	// The interview slot names the keys it must never reuse.
	const interview = HELP_SECTIONS.find((section) => section.id === "interview");
	ok(interview?.reserved?.includes("Alt+A"));
	// The terminal note is one line that scopes the reference.
	const terminal = HELP_SECTIONS.find((section) => section.id === "terminal");
	ok(terminal?.entries[0]?.meaning.includes("/help lists Clio Coder's own commands"));
});

Deno.test("searching the reference finds the key for allowing an approval and reports an empty match honestly", () => {
	const whole = searchHelp("");
	equal(whole.length, HELP_SECTIONS.length);
	const allow = searchHelp("allow");
	ok(
		allow.some(({ section, entries }) =>
			section.id === "keyboard" && entries.some((entry) => entry.term === "Alt + A")
		),
	);
	ok(!allow.some(({ section, entries }) => section.id === "keyboard" && entries.some((entry) => entry.term === "Esc")));
	// Every word must match; a section heading hit returns the whole section.
	const views = searchHelp("views").find(({ section }) => section.id === "views");
	equal(views?.entries.length, Object.keys(VIEW_GUIDE).length);
	const receipt = searchHelp("receipt verified");
	ok(receipt.some(({ section }) => section.id === "vocabulary"));
	deepEqual(searchHelp("zzz-not-in-the-reference"), []);
});
