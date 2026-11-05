import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { detectPlatformKeybindingWarnings } from "../../src/interactive/keybinding-manager.js";
import { suspendProcessUntilContinued } from "../../src/interactive/process-suspend.js";

test("Ctrl-Z warns for other actions but not the suspend action (#413)", () => {
	const support = { name: "test-terminal", supportsCsiU: false, reason: "CSI-u not detected" };
	strictEqual(
		detectPlatformKeybindingWarnings({}, support).some((warning) => warning.id === "clio-coder.suspend"),
		false,
	);
	const warnings = detectPlatformKeybindingWarnings(
		{ "clio-coder.suspend": ["ctrl+z", "ctrl+s"], "clio-coder.exit": "ctrl+z" },
		{ ...support, ideReservedKeys: ["ctrl+z"] },
	);
	deepStrictEqual(warnings.find((warning) => warning.id === "clio-coder.suspend")?.keys, ["ctrl+s"]);
	deepStrictEqual(warnings.find((warning) => warning.id === "clio-coder.exit")?.keys, ["ctrl+z"]);
});

test("a discarded SIGTSTP releases the terminal handoff and SIGCONT listener", async (t) => {
	const listeners = process.listenerCount("SIGCONT");
	const events: string[] = [];
	t.mock.method(process, "kill", (pid: number, signal: NodeJS.Signals) => {
		strictEqual(pid, 0);
		strictEqual(signal, "SIGTSTP");
		strictEqual(process.listenerCount("SIGCONT"), listeners + 1);
		events.push("signal discarded");
		return true;
	});
	events.push("terminal stopped");
	try {
		strictEqual(await suspendProcessUntilContinued(), false);
	} finally {
		events.push("terminal restored");
	}
	deepStrictEqual(events, ["terminal stopped", "signal discarded", "terminal restored"]);
	strictEqual(process.listenerCount("SIGCONT"), listeners);
});
