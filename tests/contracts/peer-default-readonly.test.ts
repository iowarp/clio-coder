import { deepStrictEqual, equal, match, ok, throws } from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { parseRunCliArgs } from "../../src/cli/args.js";
import { runClioRun } from "../../src/cli/run.js";
import { codexSubprocessPermissionConfigForAutonomy } from "../../src/domains/providers/runtimes/external-cli-policy.js";
import { buildAgyArgs } from "../../src/engine/antigravity/subprocess-runtime.js";
import { buildClaudeCodeArgs } from "../../src/engine/claude/subprocess-runtime.js";
import { buildCodexExecArgs } from "../../src/engine/codex/subprocess-runtime.js";
import { buildOpenCodeCliArgs } from "../../src/engine/external-cli/opencode.js";
import { buildPiCliArgs } from "../../src/engine/external-cli/pi.js";
import type { WorkerRunInput } from "../../src/engine/worker-runtime.js";
import type { SlashCommandContext } from "../../src/interactive/slash-commands.js";
import { dispatchSlashCommand, handleRun, parseSlashCommand } from "../../src/interactive/slash-commands.js";
import { headlessScratch, runCli, sealedReceipt } from "../harness/headless-run.js";

function input(readOnly: boolean): WorkerRunInput {
	return {
		agentId: "builder",
		task: "Inspect the change",
		systemPrompt: "",
		dynamicPromptMessages: [],
		target: { id: "peer", runtime: "codex-cli" },
		runtime: { id: "codex-cli" } as WorkerRunInput["runtime"],
		wireModelId: "",
		allowedTools: [],
		budget: { toolCalls: 10, readReserve: 0, synthesis: true, hardCap: 20 },
		autonomy: "yolo",
		readOnly,
		cwd: process.cwd(),
	};
}

test("peer launch arguments depend only on the read-only restriction", () => {
	const previous = process.env.CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS;
	try {
		process.env.CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS = "1";
		for (const readOnly of [true, false]) {
			const run = input(readOnly);
			const codex = buildCodexExecArgs(run);
			deepStrictEqual(codex.slice(0, 6), [
				"exec",
				"--json",
				"--ephemeral",
				"--skip-git-repo-check",
				"--sandbox",
				readOnly ? "read-only" : "workspace-write",
			]);
			deepStrictEqual(codexSubprocessPermissionConfigForAutonomy(readOnly), {
				sandbox: readOnly ? "read-only" : "workspace-write",
				dangerousBypass: false,
			});
			const claude = buildClaudeCodeArgs(run);
			deepStrictEqual(
				claude.slice(5, readOnly ? 8 : 7),
				readOnly ? ["--permission-mode", "plan", "--tools"] : ["--permission-mode", "acceptEdits"],
			);
			if (readOnly) equal(claude[8], "Read,Grep,Glob,LS,WebFetch,WebSearch");
			const agy = buildAgyArgs(run);
			deepStrictEqual(
				agy.slice(0, readOnly ? 3 : 2),
				readOnly ? ["--mode", "plan", "--sandbox"] : ["--mode", "accept-edits"],
			);
			const pi = buildPiCliArgs(run);
			equal(pi.includes("read,grep,find,ls"), readOnly);
			if (readOnly) throws(() => buildOpenCodeCliArgs(run), /cannot enforce a read-only run/);
			else deepStrictEqual(buildOpenCodeCliArgs(run).slice(0, 3), ["run", "--format", "json"]);
		}
	} finally {
		if (previous === undefined) delete process.env.CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS;
		else process.env.CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS = previous;
	}
});

test("read-only is available on each operator dispatch command", () => {
	const run = parseSlashCommand("/run --read-only builder Inspect");
	equal(run.kind, "run");
	if (run.kind === "run") equal(run.options.readOnly, true);
	const delegate = parseSlashCommand("/delegate --read-only peer Inspect");
	equal(delegate.kind, "delegate");
	if (delegate.kind === "delegate") equal(delegate.readOnly, true);
	const headless = parseRunCliArgs(["--agent", "builder", "--read-only", "Inspect"]);
	equal(headless.readOnly, true);
	const invalid = parseRunCliArgs(["--agent", "builder", "--autonomy", "yolo", "Inspect"]);
	match(invalid.diagnostics.map((entry) => entry.message).join(" "), /--autonomy.*main agent.*--read-only/);
	equal(invalid.diagnostics.at(-1)?.type, "error");
});

test("operator slash flags reach dispatch requests", async () => {
	let runRequest: Record<string, unknown> | undefined;
	const dispatch = {
		async dispatch(request: Record<string, unknown>) {
			runRequest = request;
			return {
				runId: "peer",
				events: (async function* () {})(),
				finalPromise: Promise.resolve({ outcome: "succeeded", exitCode: 0 }),
			};
		},
	};
	const parsed = parseSlashCommand("/run --read-only builder Inspect");
	if (parsed.kind !== "run") throw new Error("expected run command");
	await handleRun(
		parsed.agentId,
		parsed.task,
		{ dispatch, notice: () => {}, io: {} } as unknown as Parameters<typeof handleRun>[2],
		parsed.options,
	);
	equal(runRequest?.readOnly, true);
	const delegated = parseSlashCommand("/delegate --read-only peer Inspect");
	if (delegated.kind !== "delegate") throw new Error("expected delegate command");
	let resolveRequest!: (request: Record<string, unknown>) => void;
	const requested = new Promise<Record<string, unknown>>((resolve) => {
		resolveRequest = resolve;
	});
	const context = {
		dispatch: {
			async dispatch(request: Record<string, unknown>) {
				resolveRequest(request);
				return {
					runId: "peer",
					events: (async function* () {})(),
					finalPromise: Promise.resolve({ outcome: "succeeded", exitCode: 0 }),
				};
			},
		},
		io: {},
		notice: () => {},
		render: () => {},
	} as unknown as SlashCommandContext;
	equal(dispatchSlashCommand(delegated, context), "accepted");
	const delegateRequest = await requested;
	equal(delegateRequest.delegationAgentId, "peer");
	equal(delegateRequest.readOnly, true);
});

test("headless --agent rejects main-agent autonomy before boot", async () => {
	equal(await runClioRun(["--agent", "builder", "--autonomy", "yolo", "Inspect"]), 2);
});

test("headless read-only reaches the peer sandbox through dispatch", { timeout: 30_000 }, async () => {
	const scratch = headlessScratch("clio-peer-readonly-");
	try {
		const bin = join(scratch.root, "bin");
		mkdirSync(bin);
		const executable = join(bin, "codex");
		writeFileSync(
			executable,
			`#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
for await (const chunk of process.stdin) {}
writeFileSync(join(process.cwd(), "peer-argv.json"), JSON.stringify(process.argv.slice(2)));
for (const event of [
  { type: "thread.started", thread_id: "fixture-thread" },
  { type: "turn.started" },
  { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ mutatedPaths: [], validations: [{ name: "read fixture", passed: true, evidence: "PONG" }], summary: "PONG" }) } },
  { type: "turn.completed", usage: { input_tokens: 2, output_tokens: 1 } }
]) process.stdout.write(JSON.stringify(event) + "\\n");
`,
		);
		chmodSync(executable, 0o755);
		const settingsPath = join(scratch.configDir, "settings.yaml");
		const settings = parse(readFileSync(settingsPath, "utf8"));
		settings.targets.push({ id: "peer", runtime: "codex-cli", defaultModel: "codex-cli-default" });
		settings.fleet.default.target = "peer";
		settings.fleet.default.model = "codex-cli-default";
		settings.fleet.retry.maxRetries = 0;
		writeFileSync(settingsPath, stringify(settings));
		const result = await runCli(["run", "--agent", "coder", "--read-only", "--target", "peer", "Inspect the workspace"], {
			cwd: scratch.root,
			env: { ...scratch.env, PATH: `${bin}:${scratch.env.PATH ?? ""}` },
		});
		equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
		const argv = JSON.parse(readFileSync(join(scratch.root, "peer-argv.json"), "utf8")) as string[];
		ok(argv.includes("--sandbox"));
		equal(argv[argv.indexOf("--sandbox") + 1], "read-only");
		equal(sealedReceipt(scratch.stateDir).receipt.autonomyEnforcement?.externalMode, "read-only");
	} finally {
		scratch.cleanup();
	}
});
