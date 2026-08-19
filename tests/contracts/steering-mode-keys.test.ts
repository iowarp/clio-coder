import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { CLIO_APP_KEYBINDINGS } from "../../src/domains/config/keybindings.js";
import { dispatchInteractiveAction, type KeyBindingDeps } from "../../src/interactive/interactive-application.js";
import { createKeybindingManagerForTesting } from "../../src/interactive/keybinding-manager.js";

/**
 * Issue #89: three steering modes, each chosen per message by the key that
 * submits it. Enter is the editor's own submit and reaches the chat loop as
 * the default (next slot); the other two are app actions with distinct chords.
 */
describe("contracts/steering mode key selection", () => {
	it("binds end-of-turn to Alt+Enter and interrupt to Alt+I, and names the modes in the help text", () => {
		strictEqual(CLIO_APP_KEYBINDINGS["clio.message.followUp"].defaultKeys, "alt+enter");
		strictEqual(CLIO_APP_KEYBINDINGS["clio.message.interrupt"].defaultKeys, "alt+i");
		ok(CLIO_APP_KEYBINDINGS["clio.message.followUp"].description.startsWith("End of turn:"));
		ok(CLIO_APP_KEYBINDINGS["clio.message.followUp"].description.includes("next slot"));
		ok(CLIO_APP_KEYBINDINGS["clio.message.interrupt"].description.startsWith("Interrupt:"));
		ok(CLIO_APP_KEYBINDINGS["clio.message.interrupt"].description.includes("attached dispatch"));
		ok(CLIO_APP_KEYBINDINGS["clio.message.interrupt"].description.includes("permission ask"));

		const manager = createKeybindingManagerForTesting();
		strictEqual(manager.matches("\x1bi", "clio.message.interrupt"), true, "Alt+I arrives as ESC i");
		strictEqual(manager.matches("\x1bi", "clio.message.followUp"), false);
		strictEqual(manager.matches("\x1b\r", "clio.message.followUp"), true, "Alt+Enter arrives as ESC CR");
		strictEqual(manager.matches("\x1b\r", "clio.message.interrupt"), false);
		strictEqual(manager.matches("\r", "clio.message.interrupt"), false, "plain Enter never interrupts");
		strictEqual(manager.matches("\r", "clio.message.followUp"), false, "plain Enter never queues for end of turn");
		ok(
			manager.leaderTargets().some((target) => target.key === "i" && target.id === "clio.message.interrupt"),
			"Ctrl+G then i reaches interrupt on Alt-less terminals",
		);
	});

	it("binds pi-tui's dedicated prompt history actions to Ctrl+P and Ctrl+N", () => {
		const manager = createKeybindingManagerForTesting();
		deepStrictEqual(manager.getKeys("tui.editor.historyPrevious"), ["ctrl+p"]);
		deepStrictEqual(manager.getKeys("tui.editor.historyNext"), ["ctrl+n"]);
	});

	it("dispatches each chord to its own editor action", () => {
		const calls: string[] = [];
		const deps = {
			queueFollowUp: () => calls.push("end-of-turn"),
			interruptWithMessage: () => calls.push("interrupt"),
			restoreQueuedFollowUps: () => calls.push("dequeue"),
		} as unknown as KeyBindingDeps;
		strictEqual(dispatchInteractiveAction("clio.message.followUp", deps), true);
		strictEqual(dispatchInteractiveAction("clio.message.interrupt", deps), true);
		strictEqual(dispatchInteractiveAction("clio.message.dequeue", deps), true);
		deepStrictEqual(calls, ["end-of-turn", "interrupt", "dequeue"]);
	});
});
