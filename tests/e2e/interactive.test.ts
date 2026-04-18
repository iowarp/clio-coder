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

	it("/model opens the picker, Esc closes, /quit exits clean", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/clio\s+IOWarp/, 15_000);
			p.send("/model\r");
			// Any provider from the static catalog proves the picker rendered.
			// A static catalog model id only appears inside the /model picker, not in the footer.
			await p.expect(/claude-sonnet-4-6|gpt-5/, 10_000);
			// Esc closes the overlay per routeModelOverlayKey.
			p.send("\x1b");
			// Give the TUI a tick to process the close and restore editor focus before
			// the next submit; without it, /quit can race with the overlay teardown and
			// land as a SelectList filter.
			await new Promise((r) => setTimeout(r, 300));
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0, `expected clean exit, got code=${exit.code} signal=${exit.signal}`);
		} finally {
			p.kill();
		}
	});

	it("Ctrl+L opens the /model picker and Esc closes it", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/clio\s+IOWarp/, 15_000);
			// Ctrl+L is \x0c (form feed).
			p.send("\x0c");
			// A static catalog model id only appears inside the /model picker, not in the footer.
			await p.expect(/claude-sonnet-4-6|gpt-5/, 10_000);
			p.send("\x1b");
			// Give the TUI a tick to process the close and restore editor focus before
			// the next submit; without it, /quit can race with the overlay teardown and
			// land as a SelectList filter.
			await new Promise((r) => setTimeout(r, 300));
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p.kill();
		}
	});

	it("/scoped-models opens the scope picker with [ ] rows, Esc closes", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/clio\s+IOWarp/, 15_000);
			p.send("/scoped-models\r");
			// Checkbox-style row is unique to the scoped-models overlay.
			await p.expect(/\[ ]\s+anthropic\/|\[ ]\s+openai\//, 10_000);
			p.send("\x1b");
			await new Promise((r) => setTimeout(r, 300));
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p.kill();
		}
	});

	it("/settings opens the settings overlay, Esc closes", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/clio\s+IOWarp/, 15_000);
			p.send("/settings\r");
			// defaultMode / safetyLevel labels are unique to the settings overlay.
			await p.expect(/defaultMode|safetyLevel/, 10_000);
			p.send("\x1b");
			await new Promise((r) => setTimeout(r, 300));
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p.kill();
		}
	});

	it("/resume opens the session picker (possibly empty), Esc closes", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/clio\s+IOWarp/, 15_000);
			p.send("/resume\r");
			// The overlay may render an empty list (fresh scratch home) or a single
			// row that we just created. Give the TUI time to paint either way, then
			// send Esc to close whichever state we ended up in.
			await new Promise((r) => setTimeout(r, 400));
			p.send("\x1b");
			await new Promise((r) => setTimeout(r, 300));
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p.kill();
		}
	});

	it("/new rotates the session and exits clean on /quit", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/clio\s+IOWarp/, 15_000);
			p.send("/new\r");
			await new Promise((r) => setTimeout(r, 300));
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p.kill();
		}
	});

	it("/hotkeys opens the reference, Esc closes", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/clio\s+IOWarp/, 15_000);
			p.send("/hotkeys\r");
			// The scope headers (GLOBAL / EDITOR) are unique to the hotkeys overlay.
			await p.expect(/GLOBAL|EDITOR/, 10_000);
			p.send("\x1b");
			await new Promise((r) => setTimeout(r, 300));
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p.kill();
		}
	});
});
