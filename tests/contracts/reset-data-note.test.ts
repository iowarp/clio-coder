/**
 * `clio-coder reset --data` deletes the whole data root, and vendored external
 * tools live under it at `<data>/tools`. The preview named memory, evidence and
 * evals and stopped there, so the one product in that root that a reset cannot
 * regenerate locally was the one it did not mention.
 *
 * The dry run prints the identical listing the real run works from, so pinning
 * the note here pins what an operator is told before they pass `--force`.
 */

import { match, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { runResetCommand } from "../../src/cli/reset.js";

function captureReset(args: ReadonlyArray<string>): { code: number; stdout: string } {
	const originalOut = process.stdout.write.bind(process.stdout);
	let stdout = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stdout.write;
	try {
		return { code: runResetCommand(args), stdout };
	} finally {
		process.stdout.write = originalOut;
	}
}

describe("contracts/reset data-root note", () => {
	let scratch: string;
	let home: string;
	const originalHome = process.env.CLIO_CODER_HOME;

	before(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-reset-note-"));
		home = join(process.env.CLIO_CODER_HOME ?? scratch, "reset-note-home");
		mkdirSync(home, { recursive: true });
	});
	after(() => {
		rmSync(scratch, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});
	beforeEach(() => {
		process.env.CLIO_CODER_HOME = home;
	});
	afterEach(() => {
		if (originalHome === undefined) delete process.env.CLIO_CODER_HOME;
		else process.env.CLIO_CODER_HOME = originalHome;
	});

	it("tells an operator that --data takes the vendored tools with it", () => {
		const result = captureReset(["--data", "--dry-run"]);
		strictEqual(result.code, 0);
		match(result.stdout, /vendored external tools/);
		match(result.stdout, /re-downloads/);
	});

	it("says the same thing under --all, since the note belongs to the root", () => {
		const result = captureReset(["--all", "--dry-run"]);
		strictEqual(result.code, 0);
		match(result.stdout, /vendored external tools/);
	});
});
