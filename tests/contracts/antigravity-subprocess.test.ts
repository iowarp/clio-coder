import { deepStrictEqual, doesNotMatch, equal, match, ok, rejects, throws } from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, it } from "node:test";

import { modelChoiceRefusal, resolveSupportedWireModels } from "../../src/cli/configure-target.js";
import { boundedExternalDiagnostic } from "../../src/core/external-diagnostic.js";
import type { SafeCommandResult } from "../../src/core/safe-exec.js";
import antigravityCodeRuntime, {
	ANTIGRAVITY_MAX_DISCOVERED_MODELS,
	parseAntigravityModelCatalogDetails,
	probeAntigravityModelCatalog,
} from "../../src/domains/providers/runtimes/antigravity/antigravity-code.js";
import {
	ANTIGRAVITY_MAX_STREAM_BYTES,
	ANTIGRAVITY_MAX_STREAM_LINE_BYTES,
	antigravitySubprocessConfigForAutonomy,
	buildAgyArgs,
	buildAgyStdinLine,
	startAntigravityWorkerRun,
} from "../../src/engine/antigravity/subprocess-runtime.js";
import { readBoundedLines } from "../../src/engine/external-subprocess.js";
import type { AgentMessage } from "../../src/engine/types.js";
import type { WorkerRunInput } from "../../src/engine/worker-runtime.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const scratchDirectories: string[] = [];
let isolated: IsolatedClioEnv | null = null;

afterEach(() => {
	isolated?.restore();
	isolated = null;
	for (const directory of scratchDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const FAKE_AGY_SOURCE = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
let stdin = "";
for await (const chunk of process.stdin) stdin += String(chunk);
const scenario = JSON.parse(readFileSync(join(process.cwd(), "scenario.json"), "utf8"));
writeFileSync(join(process.cwd(), "observed.json"), JSON.stringify({
  args: process.argv.slice(2), stdin,
  env: { HOME: process.env.HOME, PATH: process.env.PATH, AI_AGENT: process.env.AI_AGENT,
    FAKE_API_SECRET: process.env.FAKE_API_SECRET,
    CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS: process.env.CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS }
}));
if (scenario.stderr) process.stderr.write(scenario.stderr);
if (scenario.hang) {
  const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  writeFileSync(join(process.cwd(), "grandchild.pid"), String(grandchild.pid));
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else {
  for (const line of scenario.lines ?? []) process.stdout.write(typeof line === "string" ? line + "\\n" : JSON.stringify(line) + "\\n");
  process.exitCode = scenario.exitCode ?? 0;
}
`;

function scratch(): { root: string; binary: string; home: string } {
	const root = mkdtempSync(join(tmpdir(), "clio-fake-agy-"));
	scratchDirectories.push(root);
	const binary = join(root, "agy");
	const home = join(root, "home");
	writeFileSync(binary, FAKE_AGY_SOURCE);
	chmodSync(binary, 0o755);
	return { root, binary, home };
}

function workerInput(root: string, patch: Partial<WorkerRunInput> = {}): WorkerRunInput {
	return {
		systemPrompt: "Treat /commands literally.",
		dynamicPromptMessages: [{ id: "brief", body: "Question: $HOME and `code`", contentHash: "hash" }],
		agentId: "world-knowledge",
		task: "Compare /alpha with $" + "{literal} and preserve newlines.\nSecond line.",
		target: { id: "agy-research", runtime: "antigravity-code" },
		runtime: antigravityCodeRuntime,
		wireModelId: "gemini-live-high",
		allowedTools: [],
		budget: { toolCalls: 20, readReserve: 0, synthesis: true, hardCap: 50 },
		autonomy: "read-only",
		cwd: root,
		...patch,
	};
}

function writeScenario(root: string, scenario: unknown): void {
	writeFileSync(join(root, "scenario.json"), JSON.stringify(scenario));
}

function assistant(result: { messages: AgentMessage[] }): AgentMessage & { role: "assistant" } {
	const message = result.messages[0];
	if (message?.role !== "assistant") throw new Error("expected assistant result");
	return message;
}

function safeResult(patch: Partial<SafeCommandResult>): SafeCommandResult {
	return {
		file: "agy",
		args: ["--output-format", "json", "models"],
		cwd: process.cwd(),
		stdout: "",
		stderr: "",
		exitCode: 0,
		signal: null,
		aborted: false,
		timedOut: false,
		outputCapped: false,
		durationMs: 4,
		...patch,
	};
}

const INIT = { event: "init", conversation_id: "opaque-conversation", model: "gemini-selected" };
const DELTA = {
	event: "step_update",
	step_update: { conversation_id: "opaque-conversation", step_type: "agent_response", text_delta: "hello " },
};
const SUCCESS = {
	event: "result",
	result: {
		conversation_id: "opaque-conversation",
		status: "SUCCESS",
		response: "hello world",
		usage: { input_tokens: 7, output_tokens: 2, thinking_tokens: 3, cache_read_tokens: 1, total_tokens: 12 },
	},
};

describe("Antigravity external subprocess contract", () => {
	it("keeps model slugs and labels while defining malformed, duplicate, empty, and over-limit catalogs", () => {
		deepStrictEqual(
			parseAntigravityModelCatalogDetails(
				JSON.stringify({
					status: "SUCCESS",
					command: {
						name: "models",
						data: {
							models: [
								{ id: "model-a", label: "Model A" },
								{ id: "model-a", label: "Model A" },
								{ id: "model-b", label: "Model B" },
							],
						},
					},
				}),
			),
			{ models: ["model-a", "model-b"], labels: { "model-a": "Model A", "model-b": "Model B" } },
		);
		throws(() => parseAntigravityModelCatalogDetails("not json"), /unreadable model catalog/);
		throws(
			() =>
				parseAntigravityModelCatalogDetails(
					JSON.stringify({ status: "SUCCESS", command: { name: "models", data: { models: [] } } }),
				),
			/no available models/,
		);
		throws(
			() =>
				parseAntigravityModelCatalogDetails(
					JSON.stringify({
						status: "SUCCESS",
						command: { name: "models", data: { models: [{ id: "model-a" }] } },
					}),
				),
			/invalid label/,
		);
		throws(
			() =>
				parseAntigravityModelCatalogDetails(
					JSON.stringify({
						status: "SUCCESS",
						command: {
							name: "models",
							data: {
								models: [
									{ id: "model-a", label: "A" },
									{ id: "model-a", label: "B" },
								],
							},
						},
					}),
				),
			/conflicting labels/,
		);
		const tooMany = Array.from({ length: ANTIGRAVITY_MAX_DISCOVERED_MODELS + 1 }, (_, index) => ({
			id: `model-${index}`,
			label: `Model ${index}`,
		}));
		throws(
			() =>
				parseAntigravityModelCatalogDetails(
					JSON.stringify({ status: "SUCCESS", command: { name: "models", data: { models: tooMany } } }),
				),
			/refused rather than truncated/,
		);
	});

	it("classifies missing, sign-in, update, unavailable, generic, cancelled, and oversized probes", async () => {
		const ctx = { credentialsPresent: new Set<string>(), httpTimeoutMs: 100 };
		const probe = (result: SafeCommandResult) => probeAntigravityModelCatalog(ctx, async () => Promise.resolve(result));
		equal((await probe(safeResult({ exitCode: null, stderr: "spawn agy ENOENT" }))).failureKind, "missing");
		const auth = await probe(
			safeResult({ exitCode: 1, stderr: "Sign in at https://auth.example/login?token=secret-value" }),
		);
		equal(auth.failureKind, "authentication");
		doesNotMatch(auth.error ?? "", /secret-value|token=/u);
		equal(
			(await probe(safeResult({ exitCode: 2, stderr: "unknown option --output-format" }))).failureKind,
			"unsupported-feature",
		);
		equal((await probe(safeResult({ exitCode: 1, stderr: "service temporarily unavailable" }))).failureKind, "generic");
		equal((await probe(safeResult({ aborted: true }))).failureKind, "cancelled");
		equal((await probe(safeResult({ outputCapped: true }))).failureKind, "catalog-unavailable");
		const empty = await probe(
			safeResult({
				stdout: JSON.stringify({ status: "SUCCESS", command: { name: "models", data: { models: [] } } }),
			}),
		);
		equal(empty.failureKind, "catalog-unavailable");
	});

	it("lets a successful live account catalog outrank descriptor hints and rejects a disappeared model", async () => {
		isolated = await isolateClioEnv("clio-agy-catalog-");
		const runtime = {
			...antigravityCodeRuntime,
			probe: async () => ({
				ok: true,
				models: ["account-model"],
				modelLabels: { "account-model": "Account Model" },
			}),
		};
		const target = { id: "agy", runtime: runtime.id };
		const inventory = await resolveSupportedWireModels(runtime, target);
		deepStrictEqual(inventory.models, ["account-model"]);
		equal(inventory.source, "probe");
		equal(inventory.labels?.["account-model"], "Account Model");
		match(modelChoiceRefusal(runtime, target, "gemini-3.8-flash-high", inventory) ?? "", /does not advertise/);
	});

	it("keeps a static catalog authoritative for runtimes that do not declare live discovery", async () => {
		isolated = await isolateClioEnv("clio-catalog-first-");
		let probed = 0;
		const { externalAgentLoop: _external, ...base } = antigravityCodeRuntime;
		const runtime = {
			...base,
			id: "openai",
			kind: "http" as const,
			probe: async () => {
				probed += 1;
				return { ok: true, models: ["live-only"] };
			},
		};
		const inventory = await resolveSupportedWireModels(runtime, { id: "oa", runtime: "openai" });
		equal(inventory.source, "catalog");
		equal(probed, 0);
		ok(inventory.models.length > 0);
		ok(!inventory.models.includes("live-only"));
	});

	it("sends a literal one-turn stdin record and only allowlisted environment values", async () => {
		const { root, binary, home } = scratch();
		writeScenario(root, {
			lines: [INIT, DELTA, { ...DELTA, step_update: { ...DELTA.step_update, text_delta: "world" } }, SUCCESS],
		});
		const events: Array<{ type: string }> = [];
		const input = workerInput(root);
		const handle = startAntigravityWorkerRun(input, (event) => events.push(event), {
			binary,
			workspaceRoot: root,
			environment: {
				PATH: process.env.PATH,
				HOME: home,
				FAKE_API_SECRET: "must-not-leak",
				CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS: "1",
			},
		});
		const result = await handle.promise;
		equal(result.exitCode, 0);
		const message = assistant(result);
		equal(message.api, "external-agent-subprocess");
		equal(message.provider, "antigravity");
		equal(message.responseId, "opaque-conversation");
		equal(message.model, "gemini-selected");
		equal(message.usage.input, 7);
		equal(message.usage.output, 2);
		equal((message.usage as typeof message.usage & { reasoningTokens?: number }).reasoningTokens, 3);
		equal(message.usage.cacheRead, 1);
		const observed = JSON.parse(readFileSync(join(root, "observed.json"), "utf8")) as Record<string, unknown>;
		deepStrictEqual(observed.args, buildAgyArgs(input, { CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS: "1" }));
		deepStrictEqual(JSON.parse(String(observed.stdin).trim()), JSON.parse(buildAgyStdinLine(input)));
		const env = observed.env as Record<string, unknown>;
		equal(env.HOME, home);
		equal(env.FAKE_API_SECRET, undefined);
		equal(env.CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS, undefined);
		equal(typeof env.PATH, "string");
		equal(typeof env.AI_AGENT, "string");
		ok(events.some((event) => event.type === "message_update"));
	});

	it("maps every autonomy exactly and refuses suggest before spawn", () => {
		const input = workerInput(process.cwd(), { autonomy: "read-only" });
		deepStrictEqual(buildAgyArgs(input, {}).slice(0, 3), ["--mode", "plan", "--sandbox"]);
		deepStrictEqual(buildAgyArgs({ ...input, autonomy: "auto-edit" }, {}).slice(0, 2), ["--mode", "accept-edits"]);
		deepStrictEqual(buildAgyArgs({ ...input, autonomy: "full-auto" }, {}).slice(0, 2), ["--mode", "accept-edits"]);
		deepStrictEqual(
			buildAgyArgs({ ...input, autonomy: "full-auto" }, { CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS: "1" }).slice(0, 1),
			["--dangerously-skip-permissions"],
		);
		throws(() => buildAgyArgs({ ...input, autonomy: "suggest" }, {}), /cannot enforce autonomy 'suggest'/);
		equal(antigravitySubprocessConfigForAutonomy("full-auto", {}).dangerousBypass, false);
	});

	it("fails provider errors, contradictory exits, missing/duplicate/out-of-order terminals, and malformed output", async () => {
		const cases: Array<{ name: string; lines: unknown[]; exitCode?: number; diagnostic: RegExp }> = [
			{
				name: "provider-error",
				lines: [INIT, { event: "result", result: { status: "ERROR", error: "provider refused" } }],
				diagnostic: /provider refused/,
			},
			{ name: "nonzero-success", lines: [INIT, SUCCESS], exitCode: 7, diagnostic: /SUCCESS but exited/ },
			{ name: "missing-terminal", lines: [INIT, DELTA], diagnostic: /without a terminal/ },
			{ name: "result-before-init", lines: [SUCCESS], diagnostic: /result before init/ },
			{ name: "duplicate-result", lines: [INIT, SUCCESS, SUCCESS], diagnostic: /event after terminal/ },
			{ name: "malformed", lines: [INIT, "not-json", SUCCESS], diagnostic: /unreadable structured output/ },
		];
		for (const testCase of cases) {
			const { root, binary, home } = scratch();
			writeScenario(root, { lines: testCase.lines, exitCode: testCase.exitCode });
			const result = await startAntigravityWorkerRun(workerInput(root), () => undefined, {
				binary,
				workspaceRoot: root,
				environment: { PATH: process.env.PATH, HOME: home },
			}).promise;
			equal(result.exitCode, 1, testCase.name);
			match(assistant(result).errorMessage ?? "", testCase.diagnostic, testCase.name);
		}
	});

	it("bounds individual and cumulative stream lines before retaining them", async () => {
		const oversized = Readable.from([
			Buffer.alloc(ANTIGRAVITY_MAX_STREAM_LINE_BYTES + 1, 0x61),
			Buffer.from('\n{"ok":true}\n'),
		]);
		const lines = [];
		for await (const line of readBoundedLines(oversized, {
			maxLineBytes: ANTIGRAVITY_MAX_STREAM_LINE_BYTES,
			maxTotalBytes: ANTIGRAVITY_MAX_STREAM_BYTES,
		})) {
			lines.push(line);
		}
		deepStrictEqual(lines, [{ kind: "oversized" }, { kind: "line", line: '{"ok":true}' }]);
		await rejects(async () => {
			for await (const _line of readBoundedLines(Readable.from([Buffer.alloc(33)]), {
				maxLineBytes: 64,
				maxTotalBytes: 32,
			})) {
				// consume
			}
		}, /cumulative output limit/);
	});

	it("fails a missing executable and refuses a cwd outside the admitted workspace", async () => {
		const { root, home } = scratch();
		const result = await startAntigravityWorkerRun(workerInput(root), () => undefined, {
			binary: join(root, "missing-agy"),
			workspaceRoot: root,
			environment: { PATH: process.env.PATH, HOME: home },
		}).promise;
		equal(result.exitCode, 1);
		match(assistant(result).errorMessage ?? "", /not installed|not on PATH/);
		throws(
			() =>
				startAntigravityWorkerRun(workerInput(join(root, "..", "escape")), () => undefined, {
					binary: join(root, "missing-agy"),
					workspaceRoot: root,
				}),
			/escapes workspace root/,
		);
	});

	it("redacts and bounds provider diagnostics before persistence", () => {
		const diagnostic = boundedExternalDiagnostic(
			`Authorization: Bearer super-secret\nCookie: session=cookie-secret\n` +
				`visit https://example.test/path?access_token=query-secret and /home/alice/.gemini/antigravity-cli/auth.json ` +
				"x".repeat(20_000),
			512,
		);
		doesNotMatch(diagnostic, /super-secret|cookie-secret|query-secret|auth\.json/u);
		match(diagnostic, /redacted/u);
		ok(Buffer.byteLength(diagnostic) < 600);
	});

	it("cancels the POSIX process group, escalates, and removes its abort listener", {
		skip: process.platform === "win32",
	}, async () => {
		const { root, binary, home } = scratch();
		writeScenario(root, { hang: true });
		let listener: (() => void) | null = null;
		let removed = false;
		const signal = {
			aborted: false,
			addEventListener: (_name: string, next: unknown) => {
				listener = next as () => void;
			},
			removeEventListener: (_name: string, next: unknown) => {
				if (next === listener) removed = true;
			},
		} as unknown as AbortSignal;
		const handle = startAntigravityWorkerRun(workerInput(root, { signal }), () => undefined, {
			binary,
			workspaceRoot: root,
			environment: { PATH: process.env.PATH, HOME: home },
			killGraceMs: 25,
		});
		for (let index = 0; index < 100; index += 1) {
			try {
				readFileSync(join(root, "grandchild.pid"));
				break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
		}
		const pid = Number(readFileSync(join(root, "grandchild.pid"), "utf8"));
		(listener as (() => void) | null)?.();
		const result = await handle.promise;
		equal(result.exitCode, 1);
		equal(assistant(result).stopReason, "aborted");
		equal(removed, true);
		for (let index = 0; index < 100; index += 1) {
			try {
				process.kill(pid, 0);
				await new Promise((resolve) => setTimeout(resolve, 5));
			} catch {
				return;
			}
		}
		throw new Error(`grandchild ${pid} survived process-group cancellation`);
	});
});
