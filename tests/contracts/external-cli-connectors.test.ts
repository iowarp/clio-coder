import { deepStrictEqual, equal, match, ok, throws } from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { peerModeCapabilities } from "../../src/domains/interop/peer-modes.js";
import { interopAgentKind } from "../../src/domains/interop/registry.js";
import type { InteropAgentRecord } from "../../src/domains/interop/types.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import { resolveRuntimeTarget } from "../../src/domains/providers/runtime-resolution.js";
import codexCliRuntime from "../../src/domains/providers/runtimes/codex/codex-cli.js";
import { opencodeCliRuntime, piCliRuntime } from "../../src/domains/providers/runtimes/external-cli-peers.js";
import {
	buildCodexExecArgs,
	buildCodexExecPrompt,
	startCodexCliWorkerRun,
} from "../../src/engine/codex/subprocess-runtime.js";
import { externalCliConnector } from "../../src/engine/external-cli/connectors.js";
import { startJsonlCliRun } from "../../src/engine/external-cli/jsonl-runner.js";
import { buildOpenCodeCliArgs, OPENCODE_CLI_CONNECTOR } from "../../src/engine/external-cli/opencode.js";
import { buildPiCliArgs, PI_CLI_CONNECTOR } from "../../src/engine/external-cli/pi.js";
import type { AgentMessage } from "../../src/engine/types.js";
import type { WorkerRunInput } from "../../src/engine/worker-runtime.js";
import { handleRun, parseSlashCommand } from "../../src/interactive/slash-commands.js";
import { formatWorkerShareNote } from "../../src/interactive/worker-share.js";

const directories: string[] = [];
afterEach(() => {
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const FAKE_CLI = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
let stdin = "";
for await (const chunk of process.stdin) stdin += String(chunk);
const cwd = process.cwd();
const scenario = JSON.parse(readFileSync(join(cwd, "scenario.json"), "utf8"));
writeFileSync(join(cwd, "observed.json"), JSON.stringify({
  args: process.argv.slice(2), stdin,
  env: {
    CODEX_HOME: process.env.CODEX_HOME,
    OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    FAKE_SECRET: process.env.FAKE_SECRET,
    UNREFERENCED_SECRET: process.env.UNREFERENCED_SECRET
  }
}));
if (scenario.hang) setInterval(() => {}, 1000);
else {
  for (const line of scenario.lines ?? []) process.stdout.write(typeof line === "string" ? line + "\\n" : JSON.stringify(line) + "\\n");
  if (scenario.stderr) process.stderr.write(scenario.stderr);
  process.exitCode = scenario.exitCode ?? 0;
}
`;

function scratch(lines: unknown[], extras: Record<string, unknown> = {}): { root: string; binary: string } {
	const root = mkdtempSync(join(tmpdir(), "clio-external-cli-"));
	directories.push(root);
	const binary = join(root, "fake-cli");
	writeFileSync(binary, FAKE_CLI);
	chmodSync(binary, 0o755);
	writeFileSync(join(root, "scenario.json"), JSON.stringify({ lines, ...extras }));
	return { root, binary };
}

function input(root: string, runtime: WorkerRunInput["runtime"], patch: Partial<WorkerRunInput> = {}): WorkerRunInput {
	return {
		systemPrompt: "Stay within the task.",
		dynamicPromptMessages: [{ id: "brief", body: "Context: $HOME and `literal`", contentHash: "hash" }],
		agentId: "builder",
		task: "Reply PONG.\nSecond line.",
		target: { id: "external", runtime: runtime.id },
		runtime,
		wireModelId: runtime.knownModels?.[0] ?? "default",
		allowedTools: [],
		budget: { toolCalls: 20, readReserve: 0, synthesis: true, hardCap: 50 },
		autonomy: "default",
		cwd: root,
		...patch,
	};
}

function assistant(messages: AgentMessage[]): AgentMessage & { role: "assistant" } {
	const message = messages[0];
	if (message?.role !== "assistant") throw new Error("expected assistant message");
	return message;
}

describe("Clio external CLI connectors", { skip: process.platform === "win32" }, () => {
	it("projects named modes with explicit setup and parses isolated placement", () => {
		const kind = interopAgentKind("codex");
		ok(kind);
		const record = {
			kind: "codex",
			presence: "present",
			binary: "/usr/bin/codex",
			adapter: "absent",
			skillCount: 0,
			projectArtifacts: 0,
			fingerprint: "fixture",
		} as InteropAgentRecord;
		const modes = peerModeCapabilities(kind, record, {
			configuredAcp: true,
			configuredTargets: [{ id: "codex-peer", runtime: "codex-cli" }],
			paneAvailable: false,
		});
		equal(modes.find((mode) => mode.mode === "acp")?.status, "unavailable");
		match(modes.find((mode) => mode.mode === "acp")?.setupAction ?? "", /codex-acp/);
		const unverified = peerModeCapabilities(
			kind,
			{ ...record, adapter: "unknown" },
			{
				configuredAcp: true,
				configuredTargets: [],
				paneAvailable: null,
			},
		);
		equal(unverified.find((mode) => mode.mode === "acp")?.status, "experimental");
		equal(modes.find((mode) => mode.mode === "headless")?.command, "/run --target codex-peer <agent> <task>");
		equal(modes.find((mode) => mode.mode === "pane")?.status, "unavailable");
		equal(modes.find((mode) => mode.mode === "pane")?.command, "/peer codex <brief>");
		const parsed = parseSlashCommand("/run --target codex-peer --worktree coder Fix parser");
		equal(parsed.kind, "run");
		if (parsed.kind === "run") {
			equal(parsed.options.target, "codex-peer");
			equal(parsed.options.worktree, true);
		}
	});

	it("passes isolated placement through /run and warns before external execution", async () => {
		let requested: Record<string, unknown> | null = null;
		const notices: string[] = [];
		await handleRun(
			"coder",
			"Fix parser",
			{
				dispatch: {
					async dispatch(request: Record<string, unknown>) {
						requested = request;
						return {
							runId: "peer-run",
							events: (async function* () {})(),
							finalPromise: Promise.resolve({ outcome: "succeeded", exitCode: 0 }),
						};
					},
				},
				runtimeForTarget: () => "codex-cli",
				notice: (_level: string, message: string) => notices.push(message),
				io: {},
			} as unknown as Parameters<typeof handleRun>[2],
			{ target: "codex-peer", worktree: true },
		);
		const captured = requested as Record<string, unknown> | null;
		ok(captured);
		equal(captured.target, "codex-peer");
		equal(captured.worktree, true);
		equal(captured.apply, "preserve");
		match(notices[0] ?? "", /worktree.*does not confine/);
		const note = formatWorkerShareNote({
			agentId: "coder",
			runId: "peer-run",
			outcome: "succeeded",
			text: "Done",
			placement: { mode: "worktree", cwd: "/tmp/task-tree", branch: "clio/task" },
		});
		match(note ?? "", /Workspace: isolated worktree \/tmp\/task-tree; branch clio\/task/);
	});
	it("registers direct headless runners beside ACP peer identities", () => {
		for (const id of ["claude-code", "codex-cli", "opencode-cli", "pi-cli", "antigravity-code"]) {
			ok(externalCliConnector(id), `missing ${id} connector`);
		}
		equal(externalCliConnector("unknown"), null);
	});

	it("resolves each new CLI as a worker target while keeping it out of main-agent selection", () => {
		for (const runtime of [codexCliRuntime, opencodeCliRuntime, piCliRuntime]) {
			const target = { id: runtime.id, runtime: runtime.id, defaultModel: runtime.knownModels?.[0] };
			const providers = {
				getTarget: (id: string) => (id === target.id ? target : null),
				getRuntime: (id: string) => (id === runtime.id ? runtime : null),
				getDetectedReasoning: () => null,
				list: () => [],
				knowledgeBase: { lookup: () => null, entries: () => [] },
			} as unknown as ProvidersContract;
			const dispatch = resolveRuntimeTarget(providers, { targetId: target.id, use: "dispatch" });
			ok(dispatch.ok, `${runtime.id}: ${dispatch.diagnostics.map((item) => item.message).join("; ")}`);
			const main = resolveRuntimeTarget(providers, { targetId: target.id, use: "orchestrator" });
			equal(main.ok, false);
		}
	});

	it("runs Codex exec with stdin, JSONL events, usage, and a distinct CLI auth home", async () => {
		const { root, binary } = scratch([
			{ type: "thread.started", thread_id: "thread-1" },
			{ type: "turn.started" },
			{ type: "item.completed", item: { id: "item-1", type: "agent_message", text: "PONG" } },
			{
				type: "turn.completed",
				usage: { input_tokens: 10, cached_input_tokens: 4, cache_write_input_tokens: 1, output_tokens: 3 },
			},
		]);
		const run = input(root, codexCliRuntime);
		const events: string[] = [];
		const result = await startCodexCliWorkerRun(run, (event) => events.push(event.type), {
			binary,
			workspaceRoot: root,
			environment: { PATH: process.env.PATH, HOME: root, CODEX_HOME: join(root, "codex-home"), FAKE_SECRET: "hidden" },
		}).promise;
		equal(result.exitCode, 0);
		const message = assistant(result.messages);
		equal(message.stopReason, "stop");
		equal(message.responseId, "thread-1");
		equal(message.usage.input, 5);
		equal(message.usage.cacheRead, 4);
		equal(message.usage.cacheWrite, 1);
		equal(message.usage.totalTokens, 13);
		deepStrictEqual((message.usage as unknown as { clioExternal?: unknown }).clioExternal, {
			tokenUsage: "provider-reported",
			cost: "missing",
			sessionId: "thread-1",
		});
		deepStrictEqual(
			events.filter((event) => event === "message_update"),
			["message_update"],
		);
		const observed = JSON.parse(readFileSync(join(root, "observed.json"), "utf8"));
		deepStrictEqual(observed.args, buildCodexExecArgs(run));
		equal(observed.stdin, buildCodexExecPrompt(run));
		ok(!observed.args.join(" ").includes("PONG"));
		equal(observed.env.CODEX_HOME, join(root, "codex-home"));
		equal(observed.env.FAKE_SECRET, undefined);
	});

	it("fails Codex turns without a valid terminal JSONL event", async () => {
		const { root, binary } = scratch([{ type: "thread.started", thread_id: "t" }, { type: "turn.started" }]);
		const result = await startCodexCliWorkerRun(input(root, codexCliRuntime), () => undefined, {
			binary,
			workspaceRoot: root,
		}).promise;
		equal(result.exitCode, 1);
		match(assistant(result.messages).errorMessage ?? "", /without a terminal JSONL turn/);
	});

	it("does not treat a Codex error event followed by a completed turn as success", async () => {
		const { root, binary } = scratch([
			{ type: "thread.started", thread_id: "t" },
			{ type: "turn.started" },
			{ type: "item.completed", item: { type: "agent_message", text: "partial answer" } },
			{ type: "error", message: "provider denied the request" },
			{ type: "turn.completed", usage: { input_tokens: 2, output_tokens: 2 } },
		]);
		const result = await startCodexCliWorkerRun(input(root, codexCliRuntime), () => undefined, {
			binary,
			workspaceRoot: root,
		}).promise;
		equal(result.exitCode, 1);
		match(assistant(result.messages).errorMessage ?? "", /provider denied/);
	});

	it("does not accept a failed Codex turn even when the CLI exits zero with partial text", async () => {
		const { root, binary } = scratch([
			{ type: "thread.started", thread_id: "t" },
			{ type: "turn.started" },
			{ type: "item.completed", item: { type: "agent_message", text: "partial answer" } },
			{ type: "turn.failed", usage: { input_tokens: 2, output_tokens: 2 } },
		]);
		const result = await startCodexCliWorkerRun(input(root, codexCliRuntime), () => undefined, {
			binary,
			workspaceRoot: root,
		}).promise;
		equal(result.exitCode, 1);
		match(assistant(result.messages).errorMessage ?? "", /turn failed/);
	});

	it("parses Pi print-mode assistant result and refuses unsupported authority", async () => {
		const { root, binary } = scratch([
			{ type: "session", id: "session-1" },
			{
				type: "message_end",
				message: {
					role: "assistant",
					model: "selected",
					responseId: "response-1",
					content: [{ type: "text", text: "PONG" }],
					stopReason: "stop",
					usage: { input: 2, output: 1, totalTokens: 3, cost: { total: 0.02 } },
				},
			},
			{ type: "agent_settled" },
		]);
		const run = input(root, piCliRuntime, { readOnly: true });
		const result = await startJsonlCliRun(PI_CLI_CONNECTOR, run, () => undefined, {
			binary,
			workspaceRoot: root,
			environment: {
				PATH: process.env.PATH,
				HOME: root,
				PI_CODING_AGENT_DIR: join(root, "pi-home"),
				FAKE_SECRET: "hidden",
			},
		}).promise;
		equal(result.exitCode, 0);
		const message = assistant(result.messages);
		equal(message.model, "selected");
		equal(message.responseId, "response-1");
		equal(message.usage.cost.total, 0.02);
		deepStrictEqual((message.usage as unknown as { clioExternal?: unknown }).clioExternal, {
			tokenUsage: "provider-reported",
			cost: "provider-reported",
			sessionId: "session-1",
		});
		const observed = JSON.parse(readFileSync(join(root, "observed.json"), "utf8"));
		deepStrictEqual(observed.args, buildPiCliArgs(run));
		ok(observed.args.includes("read,grep,find,ls"));
		match(observed.stdin, /Reply PONG/);
		equal(observed.env.PI_CODING_AGENT_DIR, join(root, "pi-home"));
		equal(observed.env.FAKE_SECRET, undefined);
		ok(!buildPiCliArgs({ ...run, readOnly: false }).includes("read,grep,find,ls"));
	});

	it("parses OpenCode source-defined text, step usage, and error events", async () => {
		const { root, binary } = scratch([
			{ type: "text", sessionID: "session-1", part: { type: "text", text: "PONG" } },
			{
				type: "step_finish",
				sessionID: "session-1",
				part: { type: "step-finish", cost: 0.1, tokens: { input: 5, output: 2, cache: { read: 1, write: 0 } } },
			},
		]);
		const run = input(root, opencodeCliRuntime);
		const result = await startJsonlCliRun(OPENCODE_CLI_CONNECTOR, run, () => undefined, {
			binary,
			workspaceRoot: root,
			environment: { PATH: process.env.PATH, HOME: root, OPENCODE_CONFIG_DIR: join(root, "opencode-home") },
		}).promise;
		equal(result.exitCode, 0);
		const message = assistant(result.messages);
		equal(message.responseId, "session-1");
		equal(message.usage.input, 5);
		equal(message.usage.cost.total, 0.1);
		deepStrictEqual((message.usage as unknown as { clioExternal?: unknown }).clioExternal, {
			tokenUsage: "provider-reported",
			cost: "provider-reported",
			sessionId: "session-1",
		});
		const observed = JSON.parse(readFileSync(join(root, "observed.json"), "utf8"));
		deepStrictEqual(observed.args, buildOpenCodeCliArgs(run));
		match(observed.stdin, /Reply PONG/);
		equal(observed.env.OPENCODE_CONFIG_DIR, join(root, "opencode-home"));
		throws(() => buildOpenCodeCliArgs({ ...run, readOnly: true }), /cannot enforce a read-only run/);
	});

	it("passes only credentials explicitly referenced by OpenCode's local config", async () => {
		const { root, binary } = scratch([{ type: "text", part: { type: "text", text: "PONG" } }]);
		const configDir = join(root, "opencode-home");
		mkdirSync(configDir);
		writeFileSync(
			join(configDir, "opencode.jsonc"),
			JSON.stringify({ provider: { blade: { options: { apiKey: "{env:FAKE_SECRET}" } } } }),
		);
		const result = await startJsonlCliRun(OPENCODE_CLI_CONNECTOR, input(root, opencodeCliRuntime), () => undefined, {
			binary,
			workspaceRoot: root,
			environment: {
				PATH: process.env.PATH,
				HOME: root,
				OPENCODE_CONFIG_DIR: configDir,
				FAKE_SECRET: "fixture-only",
				UNREFERENCED_SECRET: "must-stay-out",
			},
		}).promise;
		equal(result.exitCode, 0);
		const observed = JSON.parse(readFileSync(join(root, "observed.json"), "utf8"));
		equal(observed.env.FAKE_SECRET, "fixture-only");
		equal(observed.env.UNREFERENCED_SECRET, undefined);
	});

	it("keeps malformed JSONL and peer errors from becoming successful receipts", async () => {
		const malformed = scratch(["not-json"]);
		const failed = await startJsonlCliRun(PI_CLI_CONNECTOR, input(malformed.root, piCliRuntime), () => undefined, {
			binary: malformed.binary,
			workspaceRoot: malformed.root,
		}).promise;
		equal(failed.exitCode, 1);
		match(assistant(failed.messages).errorMessage ?? "", /invalid JSONL/);

		const errored = scratch([{ type: "error", error: { name: "ProviderError", data: { message: "login required" } } }]);
		const outcome = await startJsonlCliRun(
			OPENCODE_CLI_CONNECTOR,
			input(errored.root, opencodeCliRuntime),
			() => undefined,
			{
				binary: errored.binary,
				workspaceRoot: errored.root,
			},
		).promise;
		equal(outcome.exitCode, 1);
		match(assistant(outcome.messages).errorMessage ?? "", /login required/);

		const empty = scratch([{ type: "step_finish", part: { type: "step-finish", tokens: { input: 2 } } }]);
		const noAnswer = await startJsonlCliRun(
			OPENCODE_CLI_CONNECTOR,
			input(empty.root, opencodeCliRuntime),
			() => undefined,
			{ binary: empty.binary, workspaceRoot: empty.root },
		).promise;
		equal(noAnswer.exitCode, 1);
		match(assistant(noAnswer.messages).errorMessage ?? "", /without an assistant response/);
	});
});
