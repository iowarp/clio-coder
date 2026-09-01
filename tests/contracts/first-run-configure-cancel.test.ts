/** Cancelling mandatory first-run configuration must return to the shell before the TUI boots. */

import { match, ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openPty, ptySupported, stripAnsi } from "../harness/pty.js";
import { makeScratchHome } from "../harness/spawn.js";

describe("first-run configure cancellation", { concurrency: false, skip: !ptySupported }, () => {
	it("does not enter an unconfigured interactive session", async () => {
		const scratch = makeScratchHome("clio-first-run-cancel-");
		const child = await openPty(process.execPath, [join(process.cwd(), "dist", "cli", "index.js")], {
			cols: 80,
			rows: 24,
			cwd: process.cwd(),
			env: { ...process.env, ...scratch.env, TERM: "xterm-256color" } as Record<string, string>,
		});
		try {
			await child.waitForOutput("Selection [1]:");
			child.write("\u0003");
			const exit = await child.waitForExit();
			const visible = stripAnsi(child.output);
			strictEqual(exit.exitCode, 130, visible);
			match(visible, /Starting `clio-coder configure`/u);
			match(visible, /error: configuration cancelled/u);
			ok(!visible.includes("Hydrating session services"), visible);
			ok(!visible.includes("not configured · unavailable"), visible);
		} finally {
			if (!child.exited) await child.killAndWaitForExit();
			scratch.cleanup();
		}
	});
});
