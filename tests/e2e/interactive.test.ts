import { ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { makeScratchHome, spawnClioPty } from "../harness/pty.js";
import { runCli } from "../harness/spawn.js";

describe("clio interactive tui e2e", { concurrency: false }, () => {
	let scratch: ReturnType<typeof makeScratchHome>;

	beforeEach(async () => {
		scratch = makeScratchHome();
		// Bootstrap the scratch home so interactive mode doesn't hit first-run paths.
		await runCli(["install"], { env: scratch.env });
	});

	afterEach(() => {
		scratch.cleanup();
	});

	it("boots, renders banner, and exits cleanly on /quit", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/clio\s+IOWarp orchestrator coding-agent/, 15_000);
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0, `expected clean exit, got code=${exit.code} signal=${exit.signal}`);
		} finally {
			p.kill();
		}
	});

	it("Ctrl-D shuts down the tui", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/clio\s+IOWarp/, 15_000);
			// Ctrl-D (EOT, 0x04)
			p.send("\x04");
			const exit = await p.wait(10_000);
			ok(exit.code === 0 || exit.code === 130, `expected 0 or 130, got code=${exit.code}`);
		} finally {
			p.kill();
		}
	});
});
