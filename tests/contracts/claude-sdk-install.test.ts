import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { claudeAuthEnvironment, withClaudeCredential } from "../../src/core/claude-environment.js";
import { runCommandVector } from "../../src/core/safe-exec.js";
import {
	ClaudeAgentSdkUnavailableError,
	claudeSdkComponentDir,
	claudeSdkNpmCommand,
	ensureClaudeAgentSdk,
	installClaudeAgentSdk,
} from "../../src/domains/lifecycle/claude-sdk-install.js";
import {
	isBuiltinClaudeAcp,
	openAuthStorage,
	resolveClaudeLaunchCredential,
} from "../../src/domains/providers/auth/index.js";
import { loadClaudeAgentSdk } from "../../src/engine/claude/sdk-module.js";
import { startClaudeSdkWorkerRun } from "../../src/engine/claude/sdk-runtime.js";
import type { WorkerRunInput } from "../../src/engine/worker-runtime.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function sdk(prefix: string, code: string): string {
	const dir = join(prefix, "node_modules/@anthropic-ai/claude-agent-sdk");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.292", type: "module", exports: "./sdk.mjs" }),
	);
	writeFileSync(join(dir, "sdk.mjs"), code);
	return dir;
}

test("Claude launch shares Clio OAuth while preserving explicit external profiles and custom agents", async (t) => {
	const env = await isolateClioEnv();
	t.after(env.restore);
	const storage = openAuthStorage();
	storage.set("anthropic-max", {
		type: "oauth",
		access: "sk-ant-oat01-shared",
		refresh: "never-send-this",
		expires: Date.now() + 3_600_000,
		updatedAt: "2026-10-07T00:00:00Z",
	});
	const selected = await resolveClaudeLaunchCredential(undefined, { AWS_REGION: "us-east-1" });
	strictEqual(selected?.apiKey, "sk-ant-oat01-shared");
	strictEqual(Object.hasOwn(selected ?? {}, "refresh"), false);
	strictEqual(await resolveClaudeLaunchCredential(undefined, { CLAUDE_CONFIG_DIR: "/selected/account" }), null);
	strictEqual(await resolveClaudeLaunchCredential(undefined, { ANTHROPIC_API_KEY: "external-key" }), null);
	strictEqual(await resolveClaudeLaunchCredential(undefined, { ANTHROPIC_BASE_URL: "https://other.example" }), null);
	const launch = withClaudeCredential(
		claudeAuthEnvironment({
			CLAUDE_CONFIG_DIR: "/selected/account",
			ANTHROPIC_API_KEY: "external-key",
		}),
		selected?.apiKey,
	);
	strictEqual(launch.CLAUDE_CONFIG_DIR, "/selected/account");
	strictEqual(launch.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-shared");
	strictEqual(launch.ANTHROPIC_API_KEY, undefined);
	const agent = { id: "claude-code", command: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp@0.86.0"] };
	strictEqual(isBuiltinClaudeAcp(agent), true);
	strictEqual(isBuiltinClaudeAcp({ ...agent, command: "custom-wrapper" }), false);
	strictEqual(isBuiltinClaudeAcp({ ...agent, args: [...agent.args, "--custom"] }), false);
	storage.logout("anthropic-max");
	strictEqual(await resolveClaudeLaunchCredential(undefined, {}), null);
});

function workerInput(cwd: string): WorkerRunInput {
	return {
		systemPrompt: "",
		task: "Initial task",
		agentId: "scout",
		cwd,
		target: { id: "sdk", runtime: "claude-sdk" },
		runtime: { id: "claude-sdk", kind: "sdk", auth: "claude-cli" } as WorkerRunInput["runtime"],
		wireModelId: "sonnet",
		allowedTools: ["read"],
		autonomy: "default",
		readOnly: true,
		budget: { toolCalls: 10, readReserve: 0, synthesis: true, hardCap: 20 },
	};
}

const STREAMING_SDK = `
export const state = { messages: [], closed: 0, interrupted: 0, options: null };
let started;
state.started = new Promise(resolve => { started = resolve; });
export function query({ prompt, options }) {
  if (typeof prompt === "string") throw new Error("Steerable runs need streaming input");
  state.options = options;
  const output = (async function* () {
    for await (const input of prompt) {
      const text = input.message.content[0].text;
      state.messages.push(text);
      started();
      yield { type: "assistant", message: { content: [{ type: "text", text }], model: "sonnet" } };
      if (!text.startsWith("Wait")) yield { type: "result", subtype: "success", result: text };
    }
  })();
  output.close = () => { state.closed++; };
  output.interrupt = async () => { state.interrupted++; };
  output.streamInput = async () => { throw new Error("A second stream closes the input lane"); };
  return output;
}
`;

test("SDK steering uses one open input lane, keeps Clio mediation, and closes after queued work", async (t) => {
	const env = await isolateClioEnv();
	t.after(env.restore);
	const prefix = join(env.dir, "streaming");
	sdk(prefix, STREAMING_SDK);
	process.env.CLIO_CODER_CLAUDE_SDK_DIR = prefix;
	process.env.CLAUDE_CODE_EXECUTABLE = join(env.dir, "installed-claude");
	openAuthStorage().set("anthropic-max", {
		type: "oauth",
		access: "sk-ant-oat01-latest",
		refresh: "refresh-private",
		expires: Date.now() + 3_600_000,
		updatedAt: "2026-10-07T00:00:00Z",
	});
	const module = (await loadClaudeAgentSdk()) as unknown as {
		state: { messages: string[]; closed: number; options: Record<string, unknown> };
	};
	const handle = startClaudeSdkWorkerRun(
		{
			...workerInput(env.dir),
			authProfile: "anthropic-max",
			apiKey: "sk-ant-oat01-stale",
		},
		() => {},
	);
	ok(handle.steer);
	strictEqual(await handle.steer("Steered follow-up"), true);
	const result = await handle.promise;
	strictEqual(result.exitCode, 0);
	deepStrictEqual(module.state.messages, ["Initial task", "Steered follow-up"]);
	strictEqual(module.state.closed, 1);
	strictEqual(module.state.options.permissionMode, "default");
	strictEqual(typeof module.state.options.canUseTool, "function");
	deepStrictEqual(module.state.options.settingSources, []);
	strictEqual(module.state.options.pathToClaudeCodeExecutable, process.env.CLAUDE_CODE_EXECUTABLE);
	strictEqual((module.state.options.env as Record<string, string>).CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-latest");
	strictEqual(await handle.steer("Too late"), false);
});

test("SDK cancellation closes a waiting input lane and does not accept late steering", async (t) => {
	const env = await isolateClioEnv();
	t.after(env.restore);
	const prefix = join(env.dir, "cancellation");
	sdk(prefix, STREAMING_SDK);
	process.env.CLIO_CODER_CLAUDE_SDK_DIR = prefix;
	const module = (await loadClaudeAgentSdk()) as unknown as {
		state: { started: Promise<void>; closed: number; interrupted: number };
	};
	const handle = startClaudeSdkWorkerRun({ ...workerInput(env.dir), task: "Wait for cancellation" }, () => {});
	ok(handle.steer);
	await module.state.started;
	handle.abort();
	handle.abort();
	strictEqual((await handle.promise).exitCode, 1);
	strictEqual(module.state.closed > 0, true);
	strictEqual(module.state.interrupted, 1);
	strictEqual(await handle.steer("Too late"), false);
});

test("SDK honors an explicitly selected Clio API-key profile", async (t) => {
	const env = await isolateClioEnv();
	t.after(env.restore);
	const prefix = join(env.dir, "api-key");
	sdk(prefix, STREAMING_SDK);
	process.env.CLIO_CODER_CLAUDE_SDK_DIR = prefix;
	openAuthStorage().setApiKey("selected-api", "explicit-api-key");
	const module = (await loadClaudeAgentSdk()) as unknown as { state: { options: { env: Record<string, string> } } };
	const result = await startClaudeSdkWorkerRun(
		{
			...workerInput(env.dir),
			target: { id: "sdk", runtime: "claude-sdk", auth: { apiKeyRef: "selected-api" } },
			authProfile: "selected-api",
		},
		() => {},
	).promise;
	strictEqual(result.exitCode, 0);
	strictEqual(module.state.options.env.ANTHROPIC_API_KEY, "explicit-api-key");
	strictEqual(module.state.options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test("SDK refuses a removed Clio profile instead of reusing the admitted access token", async (t) => {
	const env = await isolateClioEnv();
	t.after(env.restore);
	const prefix = join(env.dir, "logout");
	sdk(prefix, STREAMING_SDK);
	process.env.CLIO_CODER_CLAUDE_SDK_DIR = prefix;
	const module = (await loadClaudeAgentSdk()) as unknown as { state: { messages: string[] } };
	const result = await startClaudeSdkWorkerRun(
		{ ...workerInput(env.dir), authProfile: "anthropic-max", apiKey: "sk-ant-oat01-removed" },
		() => {},
	).promise;
	strictEqual(result.exitCode, 1);
	deepStrictEqual(module.state.messages, []);
	match((result.messages.at(-1) as { errorMessage?: string }).errorMessage ?? "", /credential.*missing/u);
});

test("SDK reports credential expiry before starting an external assignment", async (t) => {
	const env = await isolateClioEnv();
	t.after(env.restore);
	const prefix = join(env.dir, "expiry");
	sdk(prefix, STREAMING_SDK);
	process.env.CLIO_CODER_CLAUDE_SDK_DIR = prefix;
	const result = await startClaudeSdkWorkerRun(
		{
			...workerInput(env.dir),
			apiKey: "sk-ant-oat01-old",
			credentialExpiresAt: Date.now() - 1,
		},
		() => {},
	).promise;
	strictEqual(result.exitCode, 1);
	const message = result.messages.at(-1) as { errorMessage?: string };
	match(message.errorMessage ?? "", /access token expired.*without replaying/u);
});

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
			[...command.args, "install", "--prefix", prefix, "@anthropic-ai/claude-agent-sdk@0.3.292"],
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
