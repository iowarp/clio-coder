import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { type KeyBindingDeps, routeInteractiveKey } from "../../src/interactive/interactive-application.js";
import { createKeybindingManagerForTesting } from "../../src/interactive/keybinding-manager.js";
import { type OverlayKeyDeps, routeOverlayKey } from "../../src/interactive/overlay-key-routing.js";

it("routes Library and model defaults independently and closes Library with its own shortcut", () => {
	const manager = createKeybindingManagerForTesting();
	const actions: string[] = [];
	const deps = {
		matches: manager.matches,
		openLibrary: () => actions.push("library"),
		openModelSelector: () => actions.push("model"),
		toggleDispatchBoard: () => actions.push("workers"),
	} as unknown as KeyBindingDeps;
	strictEqual(routeInteractiveKey("\u001bl", deps), true);
	strictEqual(routeInteractiveKey("\u001bm", deps), true);
	strictEqual(routeInteractiveKey("\u001bw", deps), true);
	deepStrictEqual(actions, ["library", "model", "workers"]);
	const overlay = { closeOverlay: () => actions.push("close") } as unknown as OverlayKeyDeps;
	strictEqual(routeOverlayKey("\u001bl", "skills-hub", overlay, manager.matches), true);
	deepStrictEqual(actions, ["library", "model", "workers", "close"]);
	deepStrictEqual(
		manager.leaderTargets().filter((target) => target.key === "l" || target.key === "m"),
		[
			{ key: "m", id: "clio-coder.model.select" },
			{ key: "l", id: "clio-coder.library.toggle" },
		],
	);
});

it("honors explicit user keybindings when the Library and model defaults change", () => {
	const manager = createKeybindingManagerForTesting({
		"clio-coder.library.toggle": "alt+p",
		"clio-coder.model.select": "alt+l",
	});
	const actions: string[] = [];
	const deps = {
		matches: manager.matches,
		openLibrary: () => actions.push("library"),
		openModelSelector: () => actions.push("model"),
	} as unknown as KeyBindingDeps;
	strictEqual(routeInteractiveKey("\u001bl", deps), true);
	strictEqual(routeInteractiveKey("\u001bp", deps), true);
	strictEqual(routeInteractiveKey("\u001bm", deps), false);
	deepStrictEqual(actions, ["model", "library"]);
	strictEqual(manager.hotkeyEntries().find((entry) => entry.id === "clio-coder.library.toggle")?.source, "user");
});
