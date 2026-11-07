import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import {
	ACTION_BY_COMMAND,
	CLIO_APP_KEYBINDING_IDS,
	CLIO_APP_KEYBINDINGS,
} from "../../src/domains/config/keybindings.js";
import { getKeybindings, setKeybindings } from "../../src/engine/tui.js";
import { actionKeyLabel, createKeybindingManager } from "../../src/interactive/keybinding-manager.js";
import {
	MUTATION_PREVIEW_KEY,
	PERMISSION_STOP_KEY,
	PERMISSION_TERMS_KEY,
	permissionKeyLabel,
} from "../../src/interactive/permission-hint.js";
import { WORKSPACE_FOCUS_KEY, WORKSPACE_LEAVE_KEY } from "../../src/interactive/surfaces/registry.js";
import { BUILTIN_SLASH_COMMANDS } from "../../src/session-control/slash-commands.js";

const descriptors = CLIO_APP_KEYBINDING_IDS.map((id) => {
	const descriptor: { defaultKeys: string | string[]; leader?: string; command?: string; label: string } =
		CLIO_APP_KEYBINDINGS[id];
	const keys = Array.isArray(descriptor.defaultKeys) ? descriptor.defaultKeys : [descriptor.defaultKeys];
	return { id, ...descriptor, keys };
});

test("every Alt+letter default runs the action whose menu letter is that letter", () => {
	for (const { id, keys, leader } of descriptors) {
		for (const key of keys) {
			const letter = /^alt\+([a-z])$/u.exec(key)?.[1];
			if (letter) strictEqual(leader, letter, `${id}: Alt+${letter} must be Ctrl+G ${letter}`);
		}
	}
});

test("menu letters are unique and leave the extension workspace letters free", () => {
	const letters = descriptors.flatMap(({ leader }) => (leader ? [leader] : []));
	strictEqual(new Set(letters).size, letters.length);
	ok(!letters.includes(WORKSPACE_LEAVE_KEY));
	ok(!letters.includes(WORKSPACE_FOCUS_KEY));
	// The viewport entries share the menu.
	for (const viewport of ["z", "r", "p", "n"]) ok(!letters.includes(viewport), `${viewport} is a viewport entry`);
});

test("an action's command exists, and a typed command can teach its key", () => {
	const names = new Set(BUILTIN_SLASH_COMMANDS.map((command) => `/${command.name}`));
	for (const { id, command } of descriptors) if (command) ok(names.has(command), `${id}: ${command} is not a command`);
	strictEqual(ACTION_BY_COMMAND.get("/model"), "clio-coder.model.select");
	strictEqual(ACTION_BY_COMMAND.has("/quit"), false);
});

test("hints spell one route: the direct key, the menu letter, or the menu in a terminal that eats Alt", () => {
	const previous = getKeybindings();
	createKeybindingManager({
		...DEFAULT_SETTINGS,
		interface: { ...DEFAULT_SETTINGS.interface, keybindings: { "clio-coder.files.toggle": [] } },
	});
	try {
		strictEqual(actionKeyLabel("clio-coder.model.select", {}), "Alt+M");
		strictEqual(actionKeyLabel("clio-coder.thinking.cycle", {}), "Shift+Tab");
		strictEqual(actionKeyLabel("clio-coder.autonomy.toggle", {}), "Ctrl+G Y");
		strictEqual(actionKeyLabel("clio-coder.files.toggle", {}), null);
		strictEqual(actionKeyLabel("clio-coder.session.tree", {}), null);
		const appleTerminal = { TERM_PROGRAM: "Apple_Terminal" };
		strictEqual(actionKeyLabel("clio-coder.model.select", appleTerminal), "Ctrl+G M");
		strictEqual(actionKeyLabel("clio-coder.thinking.cycle", appleTerminal), "Shift+Tab");
	} finally {
		setKeybindings(previous);
	}
});

test("the documented key table is the registry", () => {
	const doc = readFileSync(new URL("../../docs/guide/commands-and-modes.md", import.meta.url), "utf8");
	const table = /<!-- keyboard-model:start -->\n([\s\S]*?)<!-- keyboard-model:end -->/u.exec(doc)?.[1] ?? "";
	const rows = table
		.split("\n")
		.slice(2)
		.filter((line) => line.startsWith("|"))
		.map((line) => line.split("|").map((cell) => cell.trim().replaceAll("`", "")))
		.map(([, key, letter, , command]) => ({ key, letter, command: command || undefined }));
	const previous = getKeybindings();
	createKeybindingManager(DEFAULT_SETTINGS);
	try {
		const expected = descriptors
			.filter(({ leader }) => leader !== undefined)
			.map(({ id, leader, command }) => {
				const key = actionKeyLabel(id, {});
				return { key: key?.startsWith("Ctrl+G") ? "—" : key, letter: leader, command };
			});

		test("permission hints follow the portable leader, including rebinding and disabling it", () => {
			const previous = getKeybindings();
			const manager = createKeybindingManager(DEFAULT_SETTINGS, {});
			const apple = { TERM_PROGRAM: "Apple_Terminal" };
			try {
				for (const [key, letter] of [
					[PERMISSION_STOP_KEY, "X"],
					[MUTATION_PREVIEW_KEY, "V"],
					[PERMISSION_TERMS_KEY, "T"],
				] as const) {
					strictEqual(permissionKeyLabel(key, {}), `Alt+${letter}`);
					strictEqual(permissionKeyLabel(key, apple), `Ctrl+G ${letter}`);
				}
				manager.reload({ "clio-coder.leader": "ctrl+x" });
				strictEqual(permissionKeyLabel(PERMISSION_STOP_KEY, apple), "Ctrl+X X");
				manager.reload({ "clio-coder.leader": [] });
				strictEqual(permissionKeyLabel(PERMISSION_STOP_KEY, apple), "Alt+X");
			} finally {
				setKeybindings(previous);
			}
		});
		deepStrictEqual(rows, expected);
	} finally {
		setKeybindings(previous);
	}
});
