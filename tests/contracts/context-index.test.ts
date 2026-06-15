import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runContextIndexCommand } from "../../src/cli/context-index.js";
import { readCodewiki } from "../../src/domains/context/index.js";
import { readClioState } from "../../src/domains/context/state.js";

async function captureStdout<T>(fn: () => Promise<T>): Promise<{ output: string; value: T }> {
	const originalWrite = process.stdout.write;
	let output = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
		if (buffer.every((byte) => byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126))) {
			output += buffer.toString("utf8");
		}
		return true;
	}) as typeof process.stdout.write;
	try {
		const value = await fn();
		return { output, value };
	} finally {
		process.stdout.write = originalWrite;
	}
}

describe("contracts/context-index", () => {
	let scratch: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "clio-context-index-"));
		process.chdir(scratch);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(scratch, { recursive: true, force: true });
	});

	it("builds Stage 1 codewiki and state without model or handoff artifacts", async () => {
		mkdirSync(join(scratch, "app"), { recursive: true });
		writeFileSync(join(scratch, "app", "main.py"), "def main():\n    return 0\n", "utf8");

		const { output, value } = await captureStdout(() => runContextIndexCommand(["--json"]));
		strictEqual(value, 0);
		const payload = JSON.parse(output) as Record<string, unknown>;

		strictEqual(payload.projectType, "python");
		strictEqual(payload.sourceFiles, 1);
		strictEqual(payload.indexedSourceFiles, 1);
		strictEqual(payload.coverage, 1);
		strictEqual(typeof payload.structuralHash, "string");
		ok(existsSync(join(scratch, ".clio", "codewiki.json")));
		ok(existsSync(join(scratch, ".clio", "state.json")));
		strictEqual(existsSync(join(scratch, ".clio", "handoffs")), false);

		const codewiki = readCodewiki(scratch);
		ok(codewiki);
		strictEqual(
			codewiki.files.some((file) => file.path === "app/main.py"),
			true,
		);
		const state = readClioState(scratch);
		strictEqual(state?.projectType, "python");
		strictEqual(typeof state?.lastIndexedAt, "string");
		ok(readFileSync(join(scratch, ".clio", "codewiki.json"), "utf8").includes('"version": 3'));
	});
});
