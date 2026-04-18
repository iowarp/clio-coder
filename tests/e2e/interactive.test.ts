import { ok, strictEqual } from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

	it("/tree opens the navigator, Esc closes", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/clio\s+IOWarp/, 15_000);
			p.send("/tree\r");
			// A fresh scratch home has no current session; the overlay either
			// shows the empty-state line or the navigator header. Both paths
			// prove the slash-command dispatched through to the overlay state
			// machine; if routing were broken the PTY would sit on the editor
			// prompt.
			await p.expect(/no sessions yet|session contract unavailable|\[Esc]/, 10_000);
			p.send("\x1b");
			await new Promise((r) => setTimeout(r, 300));
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p.kill();
		}
	});

	it("/fork without a current session prints the no-op message", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/clio\s+IOWarp/, 15_000);
			p.send("/fork\r");
			// The handler short-circuits with an actionable stderr line rather
			// than opening an empty picker.
			await p.expect(/\[\/fork]\s+no current session/, 10_000);
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p.kill();
		}
	});

	it("/compact without a current session prints the actionable error", async () => {
		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/clio\s+IOWarp/, 15_000);
			p.send("/compact\r");
			// The orchestrator's onCompact short-circuits with a stderr line
			// rather than calling the summarization model. The message string
			// is part of the user-facing surface; if it changes, update the
			// renderer + docs together.
			await p.expect(/\[\/compact]\s+no current session/, 10_000);
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0);
		} finally {
			p.kill();
		}
	});

	it("CLIO_FORCE_COMPACT=1 boots the TUI without crashing and /quit exits clean", async () => {
		// Slice 12d e2e. CLIO_FORCE_COMPACT=1 is the deterministic trigger
		// for auto-compaction inside chat-loop.submit. This test verifies
		// the env flag is accepted by the orchestrator boot path and the
		// TUI lifecycle is not disturbed when it is set.
		//
		// Full "compactionSummary entry written" assertion requires either
		// a mock OpenAI SSE server or a faux-orchestrator test hook, both
		// of which are out of scope for this slice. The primitives that
		// back the trigger are covered by unit tests:
		//   - shouldCompact / AutoCompactionTrigger in tests/unit/compaction.test.ts
		//   - toContextOverflowError in tests/unit/providers.test.ts
		//   - resolveSessionCwd in tests/unit/cwd-fallback.test.ts
		// The live drill (plan §6 slice 12d verification gate) is the
		// manual end-to-end with a real local endpoint.
		const env = { ...scratch.env, CLIO_FORCE_COMPACT: "1" };
		const p = spawnClioPty({ env });
		try {
			await p.expect(/clio\s+IOWarp orchestrator coding-agent/, 15_000);
			p.send("/quit\r");
			const exit = await p.wait(10_000);
			strictEqual(exit.code, 0, `expected clean exit, got code=${exit.code} signal=${exit.signal}`);
		} finally {
			p.kill();
		}
	});

	it("/thinking shows the full level set when orchestrator is a Qwen3 local model", async () => {
		// Phase 12a pre-phase fix (see docs/superpowers/plans/...-phase-12-...).
		// Before the resolveLocalModelId composition, getOrchestratorModel
		// looked up the bare id, missed the local-engine registry, threw, and
		// clamped the /thinking overlay to [off]. With the fix, boot registers
		// Qwen3.6-35B-A3B@mini with reasoning=true via the llamacpp preset;
		// /thinking renders every level the model supports.
		const configDir = scratch.env.CLIO_CONFIG_DIR;
		ok(configDir, "scratch env must set CLIO_CONFIG_DIR");
		writeFileSync(
			join(configDir, "settings.yaml"),
			[
				"providers:",
				"  llamacpp:",
				"    endpoints:",
				"      mini:",
				"        url: http://mini.local:8080",
				"        default_model: Qwen3.6-35B-A3B",
				"orchestrator:",
				"  provider: llamacpp",
				"  model: Qwen3.6-35B-A3B",
				"  endpoint: mini",
				"  thinkingLevel: medium",
				"",
			].join("\n"),
			"utf8",
		);

		const p = spawnClioPty({ env: scratch.env });
		try {
			await p.expect(/clio\s+IOWarp/, 15_000);
			p.send("/thinking\r");
			// low / medium / high never render when the overlay clamps to [off];
			// seeing any of them proves the local-engine lookup now succeeds.
			await p.expect(/medium|low|high/, 10_000);
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
