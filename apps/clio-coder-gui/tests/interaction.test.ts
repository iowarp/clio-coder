import assert from "node:assert/strict";
import { test } from "node:test";
import { HELP_SECTIONS, searchHelp, VIEW_GUIDE } from "../client/interaction/help-reference.js";
import {
	formatKeybinding,
	KEYBINDING_ORDER,
	KEYBINDINGS,
	type KeyEventLike,
	matchesKeybinding,
} from "../client/interaction/keybindings.js";
import { prefixScore } from "../client/interaction/prefix-score.js";

function press(key: string, held: Partial<Omit<KeyEventLike, "key">> = {}): KeyEventLike {
	return { key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...held };
}

test("the keybinding table declares one chord per scope and never a bare printable key", () => {
	assert.deepEqual(
		KEYBINDING_ORDER.map((binding) => binding.id),
		Object.keys(KEYBINDINGS),
	);
	for (const binding of KEYBINDING_ORDER)
		assert.ok(binding.key.length > 1 || binding.modifiers.length > 0, `${binding.id} fires on plain typing`);
	const byScope = new Map<string, Set<string>>();
	for (const binding of KEYBINDING_ORDER) {
		const chords = byScope.get(binding.scope) ?? new Set<string>();
		const chord = formatKeybinding(binding);
		assert.ok(!chords.has(chord), `${chord} is bound twice in scope ${binding.scope}`);
		chords.add(chord);
		byScope.set(binding.scope, chords);
	}
	// A global chord may never be shadowed by a scoped one: the operator would have no way to tell
	// which fired.
	const globals = byScope.get("global") ?? new Set<string>();
	for (const [scope, chords] of byScope)
		if (scope !== "global") for (const chord of chords) assert.ok(!globals.has(chord), `${chord} collides with global`);
});

test("the sidebar chord is Ctrl or Cmd plus backslash and reaches no dialog or input binding", () => {
	assert.ok(matchesKeybinding(KEYBINDINGS.sidebar, press("\\", { ctrlKey: true })));
	assert.ok(matchesKeybinding(KEYBINDINGS.sidebar, press("\\", { metaKey: true })));
	assert.ok(!matchesKeybinding(KEYBINDINGS.sidebar, press("\\")));
	assert.ok(
		!matchesKeybinding(KEYBINDINGS.sidebar, press("\\", { ctrlKey: true, altKey: true })),
		"AltGr layouts type it",
	);
	assert.equal(formatKeybinding(KEYBINDINGS.sidebar), "Ctrl or Cmd + \\");
	assert.equal(KEYBINDINGS.sidebar.scope, "global");
});

test("the matcher is exact: every listed modifier held and no unlisted one", () => {
	assert.ok(matchesKeybinding(KEYBINDINGS.send, press("Enter", { ctrlKey: true })));
	assert.ok(matchesKeybinding(KEYBINDINGS.send, press("Enter", { metaKey: true })));
	assert.ok(!matchesKeybinding(KEYBINDINGS.send, press("Enter")));
	assert.ok(!matchesKeybinding(KEYBINDINGS.send, press("Enter", { shiftKey: true })));
	assert.ok(!matchesKeybinding(KEYBINDINGS.send, press("Enter", { ctrlKey: true, altKey: true })));

	assert.ok(matchesKeybinding(KEYBINDINGS.allowOnce, press("a", { altKey: true })));
	assert.ok(matchesKeybinding(KEYBINDINGS.allowOnce, press("A", { altKey: true })));
	assert.ok(!matchesKeybinding(KEYBINDINGS.allowOnce, press("a")));
	assert.ok(!matchesKeybinding(KEYBINDINGS.allowOnce, press("a", { altKey: true, ctrlKey: true })));
	assert.ok(!matchesKeybinding(KEYBINDINGS.allowOnce, press("a", { altKey: true, metaKey: true })));
	assert.ok(!matchesKeybinding(KEYBINDINGS.allowOnce, press("r", { altKey: true })));

	assert.ok(matchesKeybinding(KEYBINDINGS.escape, press("Escape")));
	assert.ok(!matchesKeybinding(KEYBINDINGS.escape, press("Escape", { ctrlKey: true })));
	assert.ok(matchesKeybinding(KEYBINDINGS.tabNext, press("ArrowRight")));
	assert.ok(!matchesKeybinding(KEYBINDINGS.tabNext, press("ArrowRight", { shiftKey: true })));
	// The exactness rule as a table sweep: an event for one binding matches only that binding.
	for (const binding of KEYBINDING_ORDER) {
		const event = press(binding.key, {
			ctrlKey: binding.modifiers.includes("primary"),
			altKey: binding.modifiers.includes("alt"),
			shiftKey: binding.modifiers.includes("shift"),
		});
		const hits = KEYBINDING_ORDER.filter((other) => other.scope === binding.scope && matchesKeybinding(other, event)).map(
			(other) => other.id,
		);
		assert.deepEqual(hits, [binding.id]);
	}
});

test("chords print the way the reference reads them", () => {
	assert.equal(formatKeybinding(KEYBINDINGS.send), "Ctrl or Cmd + Enter");
	assert.equal(formatKeybinding(KEYBINDINGS.allowOnce), "Alt + A");
	assert.equal(formatKeybinding(KEYBINDINGS.escape), "Esc");
	assert.equal(formatKeybinding(KEYBINDINGS.tabNext), "Right arrow");
	assert.equal(formatKeybinding(KEYBINDINGS.palette), "Ctrl or Cmd + K");
});

test("the launcher score ranks a whole-value prefix over a word prefix over a substring", () => {
	assert.ok(prefixScore(["Traces"], "tra") > prefixScore(["Go to traces"], "tra"));
	assert.ok(prefixScore(["Go to traces"], "tra") > prefixScore(["Retraced"], "tra"));
	assert.equal(prefixScore(["Traces", "Go to"], "zz"), 0);
	assert.equal(prefixScore(["Traces"], "  "), 1, "an empty needle keeps every command in the list");
	// The first haystack weighs triple, so a title match outranks a keyword match.
	assert.ok(prefixScore(["Evidence", "receipt"], "receipt") < prefixScore(["Receipts", "evidence"], "receipt"));
});

test("the reference covers every route and prints the keyboard table verbatim", () => {
	for (const path of ["/", "/sessions", "/traces", "/toolchain", "/docs", "/settings", "/fleet"] as const)
		assert.ok(VIEW_GUIDE[path].meaning.length > 0, `${path} has no guide sentence`);
	const keyboard = HELP_SECTIONS.find((section) => section.id === "keyboard");
	assert.ok(keyboard);
	assert.deepEqual(
		keyboard.entries.map((entry) => entry.term),
		KEYBINDING_ORDER.map(formatKeybinding),
	);
	for (const section of HELP_SECTIONS)
		if (section.reserved !== undefined) {
			assert.equal(section.entries.length, 0, `${section.id} is reserved but carries entries`);
			assert.ok(section.reserved.startsWith("This build of the app"));
		}
	const interview = HELP_SECTIONS.find((section) => section.reserved?.includes("Alt+A"));
	assert.ok(interview, "the reserved interview slot must state that it never reuses the approval keys");
});

test("help search matches every word across any field and reports nothing as nothing", () => {
	assert.deepEqual(searchHelp("zzz-not-in-the-reference"), []);
	assert.equal(searchHelp("").length, HELP_SECTIONS.length);
	assert.equal(searchHelp("   ").length, HELP_SECTIONS.length);

	const allow = searchHelp("allow");
	const keyboard = allow.find((match) => match.section.id === "keyboard");
	assert.ok(keyboard);
	assert.deepEqual(
		keyboard.entries.map((entry) => entry.term),
		["Alt + A"],
	);
	assert.ok(!keyboard.entries.some((entry) => entry.term === "Esc"));

	// A heading hit widens to the whole section; an entry hit narrows to the matching entries.
	const views = searchHelp("views").find((match) => match.section.id === "views");
	assert.ok(views);
	assert.equal(views.entries.length, views.section.entries.length);

	// AND across words, OR across fields.
	assert.equal(searchHelp("pending approval").length > 0, true);
	assert.deepEqual(searchHelp("approval zzzz"), []);
});
