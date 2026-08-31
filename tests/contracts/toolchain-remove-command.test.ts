/**
 * `clio-coder tools remove <id>`, the cleanup verb the toolchain domain shipped
 * without.
 *
 * The three answers it can give are the contract. An id the registry does not
 * know is a usage error that names the ids that exist, because the only mistake
 * an operator makes here is a name. A tool with nothing vendored is exit 0 with
 * a message saying so, because the state they asked for already holds and
 * failing them for it would make the verb unusable in a script. And a tool with
 * versions on disk loses all of them plus its own directory, so the vendor root
 * carries no trace of a tool that was removed.
 */

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { runToolsCommand } from "../../src/cli/tools.js";

interface Captured {
	code: number;
	stdout: string;
	stderr: string;
}

async function runTools(args: ReadonlyArray<string>): Promise<Captured> {
	const originalOut = process.stdout.write.bind(process.stdout);
	const originalErr = process.stderr.write.bind(process.stderr);
	let stdout = "";
	let stderr = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stderr.write;
	try {
		const code = await runToolsCommand(args);
		return { code, stdout, stderr };
	} finally {
		process.stdout.write = originalOut;
		process.stderr.write = originalErr;
	}
}

describe("contracts/tools remove command", () => {
	let scratch: string;
	let dataDir: string;
	const originalDataDir = process.env.CLIO_CODER_DATA_DIR;

	before(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-tools-remove-"));
		// Under CLIO_CODER_HOME when the harness set one, so the home-prefix
		// guardrail in src/core/init.ts stays satisfied.
		dataDir = join(process.env.CLIO_CODER_HOME ?? scratch, "tools-remove-data");
		mkdirSync(dataDir, { recursive: true });
	});
	after(() => {
		rmSync(scratch, { recursive: true, force: true });
		rmSync(dataDir, { recursive: true, force: true });
	});
	beforeEach(() => {
		process.env.CLIO_CODER_DATA_DIR = dataDir;
	});
	afterEach(() => {
		rmSync(join(dataDir, "tools"), { recursive: true, force: true });
		if (originalDataDir === undefined) delete process.env.CLIO_CODER_DATA_DIR;
		else process.env.CLIO_CODER_DATA_DIR = originalDataDir;
	});

	function vendor(id: string, version: string): string {
		const dir = join(dataDir, "tools", id, version);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, id), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		return dir;
	}

	it("refuses an unknown tool and names the ones that exist", async () => {
		const result = await runTools(["remove", "tmux"]);
		strictEqual(result.code, 2);
		match(result.stderr, /unknown tool: tmux/);
		match(result.stderr, /known: herdr, yazi, croc/);
	});

	it("asks for an id when none is given", async () => {
		const result = await runTools(["remove"]);
		strictEqual(result.code, 2);
		match(result.stderr, /usage: clio-coder tools remove <id>/);
	});

	it("says so and succeeds when the tool has nothing vendored", async () => {
		const result = await runTools(["remove", "croc"]);
		strictEqual(result.code, 0);
		match(result.stdout, /croc is not installed under .*[/\\]tools[/\\]croc; nothing to remove/);
		strictEqual(result.stdout.includes("reinstall with"), false, "nothing was removed, so nothing to reinstall");
	});

	it("deletes every vendored version and points at the command that brings it back", async () => {
		vendor("croc", "11.3.6");
		vendor("croc", "10.0.1");
		const kept = vendor("yazi", "26.8.15");

		const result = await runTools(["remove", "croc"]);
		strictEqual(result.code, 0);
		match(result.stdout, /removed croc 10\.0\.1, 11\.3\.6/);
		match(result.stdout, /reinstall with `clio-coder tools install croc`/);
		strictEqual(existsSync(join(dataDir, "tools", "croc")), false);
		ok(existsSync(kept), "another tool's vendored copy is untouched");
	});

	it("reports the removal as JSON for a script", async () => {
		vendor("herdr", "0.8.2");
		const result = await runTools(["remove", "herdr", "--json"]);
		strictEqual(result.code, 0);
		const payload = JSON.parse(result.stdout) as { ok: boolean; id: string; removed: string[]; dir: string };
		strictEqual(payload.ok, true);
		strictEqual(payload.id, "herdr");
		deepStrictEqual(payload.removed, ["0.8.2"]);
		match(payload.dir, /[/\\]tools[/\\]herdr$/);
	});

	it("sweeps every pinned tool under --all and counts the ones that had nothing", async () => {
		vendor("croc", "11.3.6");
		vendor("herdr", "0.8.2");

		const result = await runTools(["remove", "--all"]);
		strictEqual(result.code, 0);
		match(result.stdout, /removed herdr 0\.8\.2/);
		match(result.stdout, /removed croc 11\.3\.6/);
		match(result.stdout, /1 of 3 had nothing vendored/);
		strictEqual(existsSync(join(dataDir, "tools", "croc")), false);
		strictEqual(existsSync(join(dataDir, "tools", "herdr")), false);
	});

	it("refuses --all together with an id rather than guessing which one was meant", async () => {
		const result = await runTools(["remove", "--all", "croc"]);
		strictEqual(result.code, 2);
		match(result.stderr, /takes no tool id/);
	});

	it("refuses --all on a verb that does not have it", async () => {
		const result = await runTools(["install", "--all"]);
		strictEqual(result.code, 2);
		match(result.stderr, /--all is only valid with `tools remove`/);
	});

	it("reports every tool under --all --json", async () => {
		vendor("yazi", "26.8.15");
		const result = await runTools(["remove", "--all", "--json"]);
		strictEqual(result.code, 0);
		const payload = JSON.parse(result.stdout) as Array<{ id: string; removed: string[] }>;
		strictEqual(payload.length, 3, "one entry per registry row, installed or not");
		deepStrictEqual(payload.find((row) => row.id === "yazi")?.removed, ["26.8.15"]);
	});

	it("advertises the verb in the command's own help", async () => {
		const result = await runTools(["--help"]);
		strictEqual(result.code, 0);
		match(result.stdout, /clio-coder tools remove <id>\|--all/);
		match(result.stdout, /versions it superseded are pruned/);
	});
});
