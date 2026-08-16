/**
 * `docs/acp.md` documented `--cwd` and `--permission-timeout` while the command
 * rejected both as unknown options. The two now agree, and this pins the
 * agreement: the usage line in the doc is the usage line the command prints.
 */

import { ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runAcpCommand } from "../../src/cli/acp.js";

async function captureAcp(args: ReadonlyArray<string>): Promise<{ code: number; stdout: string; stderr: string }> {
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
		const code = await runAcpCommand(args);
		return { code, stdout, stderr };
	} finally {
		process.stdout.write = originalOut;
		process.stderr.write = originalErr;
	}
}

function documentedUsage(): string {
	const doc = readFileSync(join(process.cwd(), "docs", "acp.md"), "utf8");
	const line = doc.split("\n").find((entry) => entry.startsWith("clio-coder acp"));
	ok(line, "docs/acp.md no longer shows a clio-coder acp usage line");
	return line.trim();
}

describe("contracts/acp cli flags", () => {
	it("prints the usage line docs/acp.md documents", async () => {
		const { code, stdout } = await captureAcp(["--help"]);
		strictEqual(code, 0);
		strictEqual(stdout.split("\n")[0], documentedUsage());
		ok(stdout.includes("--cwd PATH"));
		ok(stdout.includes("--permission-timeout MS"));
	});

	it("refuses a permission timeout that is not a positive whole number", async () => {
		const { code, stdout } = await captureAcp(["--permission-timeout", "soon"]);
		strictEqual(code, 2);
		strictEqual(stdout, "", "a rejected invocation must not write to the protocol channel");
	});

	it("refuses --cwd with no directory after it", async () => {
		const { code } = await captureAcp(["--cwd"]);
		strictEqual(code, 2);
	});

	it("refuses a --cwd the process cannot enter", async () => {
		const { code } = await captureAcp(["--cwd", join(process.cwd(), "no-such-workspace-dir")]);
		strictEqual(code, 2);
	});
});
