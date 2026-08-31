/**
 * `docs/acp.md` documented `--cwd` and `--permission-timeout` while the command
 * rejected both as unknown options. The two now agree, and this pins the
 * agreement: the usage line in the doc is the usage line the command prints.
 */

import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { resolveAcpCwd, runAcpCommand } from "../../src/cli/acp.js";
import { MAX_TIMER_DELAY_MS } from "../../src/core/timers.js";
import { makeScratchHome, runCli } from "../harness/spawn.js";

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

function parseInitializeStdout(stdout: string): Record<string, unknown> {
	const lines = stdout.split("\n").filter(Boolean);
	strictEqual(lines.length, 1, `ACP stdout must contain exactly one JSON-RPC frame, got: ${stdout}`);
	const frame: unknown = JSON.parse(lines[0] ?? "");
	ok(typeof frame === "object" && frame !== null && !Array.isArray(frame));
	return frame as Record<string, unknown>;
}

function normalizeWorkspaceInstance(frame: Record<string, unknown>): Record<string, unknown> {
	const normalized = structuredClone(frame);
	const result = normalized.result as Record<string, unknown>;
	const capabilities = result.agentCapabilities as Record<string, unknown>;
	const meta = capabilities._meta as Record<string, unknown>;
	const events = meta["clio-coder/events"] as Record<string, unknown>;
	events.workspaceInstanceId = "<process-instance>";
	return normalized;
}

describe("contracts/acp cli flags", () => {
	const scratch = makeScratchHome("clio-acp-alias-");
	after(() => scratch.cleanup());

	it("prints the usage line docs/acp.md documents", async () => {
		const { code, stdout } = await captureAcp(["--help"]);
		strictEqual(code, 0);
		strictEqual(stdout.split("\n")[0], documentedUsage());
		ok(stdout.includes("--cwd PATH"));
		ok(stdout.includes("--permission-timeout MS"));
	});

	it("accepts a leading --acp at the command boundary", async () => {
		const { code, stdout } = await captureAcp(["--acp", "--help"]);
		strictEqual(code, 0);
		strictEqual(stdout.split("\n")[0], documentedUsage());
	});

	it("routes --acp through the same stdout-pure server path as the acp subcommand", async () => {
		const input = `${JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: 1,
				clientInfo: { name: "contract-client", version: "1" },
				clientCapabilities: { terminal: true },
			},
		})}\n`;
		const positional = await runCli(["acp"], { env: scratch.env, input });
		const globalFlag = await runCli(["--acp"], { env: scratch.env, input });

		strictEqual(positional.code, 0, positional.stderr);
		strictEqual(globalFlag.code, 0, globalFlag.stderr);
		strictEqual(positional.stdout.endsWith("\n"), true);
		strictEqual(globalFlag.stdout.endsWith("\n"), true);
		const positionalFrame = parseInitializeStdout(positional.stdout);
		const globalFlagFrame = parseInitializeStdout(globalFlag.stdout);
		deepStrictEqual(normalizeWorkspaceInstance(globalFlagFrame), normalizeWorkspaceInstance(positionalFrame));
	});

	it("refuses a permission timeout that is not a positive whole number", async () => {
		const { code, stdout } = await captureAcp(["--permission-timeout", "soon"]);
		strictEqual(code, 2);
		strictEqual(stdout, "", "a rejected invocation must not write to the protocol channel");
	});

	it("refuses a permission timeout that Node cannot schedule", async () => {
		const { code, stdout, stderr } = await captureAcp(["--permission-timeout", String(MAX_TIMER_DELAY_MS + 1)]);
		strictEqual(code, 2);
		strictEqual(stdout, "", "a rejected invocation must not write to the protocol channel");
		ok(stderr.includes(String(MAX_TIMER_DELAY_MS)));
	});

	it("refuses --cwd with no directory after it", async () => {
		const { code } = await captureAcp(["--cwd"]);
		strictEqual(code, 2);
	});

	it("refuses a --cwd the process cannot enter", async () => {
		const { code } = await captureAcp(["--cwd", join(process.cwd(), "no-such-workspace-dir")]);
		strictEqual(code, 2);
	});

	/**
	 * The server compares a session's cwd against `process.cwd()`, which reports
	 * the physical path. A client that launches the server through a symlinked
	 * project root and then names that same root at session/new used to be told
	 * it meant a different workspace. Canonicalizing the launch path is what
	 * makes the two agree, so it is pinned here rather than left to the chdir.
	 */
	it("canonicalizes --cwd through the filesystem", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-acp-cwd-")));
		try {
			const physical = join(root, "workspace");
			const link = join(root, "workspace-link");
			mkdirSync(physical);
			symlinkSync(physical, link);

			strictEqual(resolveAcpCwd(link), physical, "a symlinked launch root resolves to its physical path");
			strictEqual(resolveAcpCwd(physical), physical, "an already-physical path is unchanged");
			strictEqual(resolveAcpCwd(join(link, ".")), physical, "dot segments and the symlink resolve together");
			ok(link !== physical, "the test is only meaningful while the two paths differ");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses to canonicalize a path that does not exist", () => {
		throws(() => resolveAcpCwd(join(process.cwd(), "no-such-workspace-dir")));
	});
});
