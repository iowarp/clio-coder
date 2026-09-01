/** Ctrl-C is an interrupted configure command, never a successful configuration. */

import { match, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openPty, ptySupported, stripAnsi } from "../harness/pty.js";
import { makeScratchHome } from "../harness/spawn.js";

describe("configure cancellation exit contract", { concurrency: false, skip: !ptySupported }, () => {
	it("returns 130 when Ctrl-C cancels the interactive wizard", async () => {
		const scratch = makeScratchHome("clio-configure-cancel-");
		const child = await openPty(process.execPath, [join(process.cwd(), "dist", "cli", "index.js"), "configure"], {
			cols: 80,
			rows: 24,
			cwd: process.cwd(),
			env: { ...process.env, ...scratch.env, TERM: "xterm-256color" } as Record<string, string>,
		});
		try {
			await child.waitForOutput("Selection [1]:");
			child.write("\u0003");
			const exit = await child.waitForExit();
			strictEqual(exit.exitCode, 130, stripAnsi(child.output));
			match(stripAnsi(child.output), /error: configuration cancelled/u);
		} finally {
			if (!child.exited) await child.killAndWaitForExit();
			scratch.cleanup();
		}
	});
});
