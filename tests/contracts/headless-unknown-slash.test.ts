/**
 * A headless `clio-coder run "/typo"` used to forward the token to the model as
 * ordinary prose: it booted, opened a session, spent a full turn, and exited 0
 * with a conversational answer to a command that was never run. The TUI has
 * always refused the same spelling by name, and
 * `docs/extensions-and-sharing.md:74` documents the refusal as the shipped
 * behavior for both surfaces. These pin the headless half of that promise
 * (issue #259).
 *
 * The refusal is a pre-boot verdict, so every case here runs without a target,
 * without a session, and without a model.
 */

import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runClioRun, unknownSlashCommandRefusal } from "../../src/cli/run.js";

const scratchHomes: string[] = [];

function isolateHome(): void {
	const home = mkdtempSync(join(tmpdir(), "clio-run-slash-"));
	scratchHomes.push(home);
	process.env.CLIO_CODER_HOME = home;
}

/**
 * Only stderr is captured. The test runner reports on stdout, so intercepting
 * that stream swallows the reporter's own frames instead of the run's output.
 */
async function captureRun(args: string[]): Promise<{ code: number; stderr: string }> {
	const stderrChunks: string[] = [];
	const originalStderr = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof process.stderr.write;
	try {
		const code = await runClioRun(args);
		return { code, stderr: stderrChunks.join("") };
	} finally {
		process.stderr.write = originalStderr;
	}
}

describe("contracts/headless-unknown-slash", () => {
	// Nested inside the describe, not at module top level: under
	// --experimental-test-isolation=none every file shares one root test
	// context, so a top-level afterEach would run around every other file's
	// tests too.
	afterEach(() => {
		delete process.env.CLIO_CODER_HOME;
		for (const home of scratchHomes.splice(0)) {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("refuses an unknown slash token by name, with the TUI's wording", async () => {
		const refusal = await unknownSlashCommandRefusal("/definitely-not-a-command");
		strictEqual(refusal, "/definitely-not-a-command is not a command. Type /help for the list.");
	});

	it("fails the run with exit 2 before any boot, session, or model call", async () => {
		isolateHome();
		const result = await captureRun(["/definitely-not-a-command"]);
		strictEqual(result.code, 2);
		ok(result.stderr.includes("/definitely-not-a-command is not a command."), `stderr names the token: ${result.stderr}`);
		// Before the fix this same call booted: the context-file notice and the
		// orchestrator-not-configured diagnostic are what the boot writes on a
		// scratch home, and neither can appear once the token is refused first.
		ok(!result.stderr.includes("orchestrator not configured"), `no boot happened: ${result.stderr}`);
		ok(!result.stderr.includes("No CLIO-CODER.md detected"), `no boot happened: ${result.stderr}`);
	});

	it("leaves a known command's task alone", async () => {
		// `/help` is a registry command, so it is not an unknown token and keeps
		// whatever the headless path does with it today.
		strictEqual(await unknownSlashCommandRefusal("/help"), null);
		strictEqual(await unknownSlashCommandRefusal("/skill some-skill"), null);
	});

	it("leaves ordinary prose that merely contains a slash alone", async () => {
		strictEqual(await unknownSlashCommandRefusal("read src/cli/run.ts and summarize it"), null);
		// An absolute path carries a separator, so it is not one command-shaped
		// word and reaches the model unchanged.
		strictEqual(await unknownSlashCommandRefusal("/home/user/notes is stale"), null);
		// The TUI's escape for a line that has to open with a slash.
		strictEqual(await unknownSlashCommandRefusal("\\/tmp is full"), null);
	});
});
