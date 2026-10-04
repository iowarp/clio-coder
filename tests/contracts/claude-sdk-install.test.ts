import { match, rejects, strictEqual } from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runCommandVector } from "../../src/core/safe-exec.js";
import {
	ClaudeAgentSdkUnavailableError,
	claudeSdkComponentDir,
	claudeSdkNpmCommand,
	ensureClaudeAgentSdk,
	installClaudeAgentSdk,
} from "../../src/domains/lifecycle/claude-sdk-install.js";
import { loadClaudeAgentSdk } from "../../src/engine/claude/sdk-module.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function sdk(prefix: string, code: string): string {
	const dir = join(prefix, "node_modules/@anthropic-ai/claude-agent-sdk");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.186", type: "module", exports: "./sdk.mjs" }),
	);
	writeFileSync(join(dir, "sdk.mjs"), code);
	return dir;
}

test("prepared SDK selection is explicit and missing headless components never prompt or write", async (t) => {
	const env = await isolateClioEnv();
	t.after(env.restore);
	process.env.CLIO_CODER_CLAUDE_SDK_DIR = join(env.dir, "prepared");
	await rejects(ensureClaudeAgentSdk(), ClaudeAgentSdkUnavailableError);
	await rejects(loadClaudeAgentSdk(), (error: unknown) => {
		strictEqual(error instanceof ClaudeAgentSdkUnavailableError, true);
		match((error as Error).message, /administrator.*CLIO_CODER_CLAUDE_SDK_DIR/u);
		return true;
	});
	let prompted = false;
	await rejects(
		ensureClaudeAgentSdk({
			confirm: async () => {
				prompted = true;
				return true;
			},
		}),
		ClaudeAgentSdkUnavailableError,
	);
	strictEqual(prompted, false);
	strictEqual(existsSync(claudeSdkComponentDir()), false);
});

test("a prepared SDK loads without writing its prefix and takes precedence over a user component", async (t) => {
	const env = await isolateClioEnv();
	t.after(env.restore);
	sdk(claudeSdkComponentDir(), "export const query = () => 'user';");
	const prefix = join(env.dir, "prepared");
	const dir = sdk(prefix, "export const query = () => 'prepared';");
	process.env.CLIO_CODER_CLAUDE_SDK_DIR = prefix;
	const before = readFileSync(join(dir, "sdk.mjs"), "utf8");
	await ensureClaudeAgentSdk();
	const module = await loadClaudeAgentSdk();
	strictEqual((module.query as unknown as () => string)(), "prepared");
	strictEqual(await installClaudeAgentSdk(), prefix);
	strictEqual(readFileSync(join(dir, "sdk.mjs"), "utf8"), before);
	delete process.env.CLIO_CODER_CLAUDE_SDK_DIR;
	strictEqual(((await loadClaudeAgentSdk()).query as unknown as () => string)(), "user");
});

test("broken SDK imports, exports and missing dependencies are not reported as absent", async (t) => {
	const env = await isolateClioEnv();
	t.after(env.restore);
	for (const [name, code] of [
		["throwing", "throw new Error('SDK evaluation failed');"],
		["dependency", "import 'missing-sdk-dependency'; export const query = () => {};"],
		["export", "export const unrelated = true;"],
	] as const) {
		const prefix = join(env.dir, name);
		sdk(prefix, code);
		process.env.CLIO_CODER_CLAUDE_SDK_DIR = prefix;
		await rejects(loadClaudeAgentSdk(), (error: unknown) => {
			strictEqual(error instanceof ClaudeAgentSdkUnavailableError, false);
			return error instanceof Error;
		});
	}
});

test("Claude provisioning uses paired managed npm and discovers unmanaged PATH symlinks", {
	skip: process.platform === "win32",
}, async (t) => {
	const env = await isolateClioEnv();
	t.after(env.restore);
	const node = join(env.dir, "runtime/bin/node");
	mkdirSync(dirname(node), { recursive: true });
	symlinkSync(process.execPath, node);
	const paired = join(env.dir, "runtime/lib/node_modules/npm/bin/npm-cli.js");
	const outside = join(env.dir, "distribution/npm-cli.js");
	const code = `import fs from 'node:fs'; import path from 'node:path';
const prefix = process.argv[process.argv.indexOf('--prefix') + 1];
const dir = path.join(prefix, 'node_modules/@anthropic-ai/claude-agent-sdk');
fs.mkdirSync(dir, {recursive:true});
fs.writeFileSync(path.join(dir,'package.json'), JSON.stringify({type:'module',exports:'./sdk.mjs'}));
fs.writeFileSync(path.join(dir,'sdk.mjs'), 'export const query = () => "provisioned";');`;
	for (const entry of [paired, outside]) {
		mkdirSync(dirname(entry), { recursive: true });
		writeFileSync(entry, code);
	}
	const pathDir = join(env.dir, "path-bin");
	mkdirSync(pathDir);
	chmodSync(outside, 0o755);
	symlinkSync(outside, join(pathDir, "npm"));
	process.env.PATH = pathDir;
	for (const managed of [true, false]) {
		const command = claudeSdkNpmCommand(node, managed);
		strictEqual(command.file, node);
		strictEqual(command.args[0], managed ? paired : outside);
		const prefix = join(env.dir, managed ? "managed-component" : "unmanaged-component");
		mkdirSync(prefix);
		const result = await runCommandVector(
			command.file,
			[...command.args, "install", "--prefix", prefix, "@anthropic-ai/claude-agent-sdk@0.3.186"],
			{ cwd: prefix, workspaceRoot: prefix },
		);
		strictEqual(result.exitCode, 0, result.stderr);
		strictEqual(existsSync(join(prefix, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs")), true);
		if (managed) rmSync(paired);
	}
	// A managed runtime must not borrow the unrelated npm still present on PATH.
	strictEqual(claudeSdkNpmCommand(node, false).args[0], outside);
	await rejects(async () => claudeSdkNpmCommand(node, true), /repair the managed runtime/u);
	process.env.PATH = "";
	await rejects(
		async () => claudeSdkNpmCommand(node, false),
		/No npm available.*put it on PATH.*CLIO_CODER_CLAUDE_SDK_DIR/u,
	);
});
