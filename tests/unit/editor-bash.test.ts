import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { BashCommandResult } from "../../src/core/bash-exec.js";
import { bashExecutionEntryInput, parseEditorBashCommand } from "../../src/interactive/editor-bash.js";

function result(overrides: Partial<BashCommandResult> = {}): BashCommandResult {
	return {
		error: null,
		stdout: "out\n",
		stderr: "",
		exitCode: 0,
		signal: null,
		aborted: false,
		timedOut: false,
		outputCapped: false,
		...overrides,
	};
}

describe("interactive editor bash syntax", () => {
	it("parses ! and !! command prefixes", () => {
		deepStrictEqual(parseEditorBashCommand("!pwd"), { command: "pwd", excludeFromContext: false });
		deepStrictEqual(parseEditorBashCommand("!! git status "), { command: "git status", excludeFromContext: true });
		strictEqual(parseEditorBashCommand("!   "), null);
		strictEqual(parseEditorBashCommand("hello"), null);
	});

	it("builds bashExecution session entries from command results", () => {
		const entry = bashExecutionEntryInput({
			command: "printf ok",
			result: result({ stdout: "ok", exitCode: 0 }),
			parentTurnId: "parent",
			excludeFromContext: true,
			timeoutMs: 300_000,
		});

		strictEqual(entry.kind, "bashExecution");
		strictEqual(entry.command, "printf ok");
		strictEqual(entry.output, "ok");
		strictEqual(entry.exitCode, 0);
		strictEqual(entry.parentTurnId, "parent");
		strictEqual(entry.excludeFromContext, true);
	});

	it("adds status notes when bash exits without useful output", () => {
		const entry = bashExecutionEntryInput({
			command: "sleep 10",
			result: result({ stdout: "", exitCode: null, signal: "SIGTERM", timedOut: true }),
			parentTurnId: null,
			excludeFromContext: false,
			timeoutMs: 10,
		});

		strictEqual(entry.output, "[command timed out after 10ms]");
		strictEqual(entry.truncated, false);
	});
});
