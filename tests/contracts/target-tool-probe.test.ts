import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProvidersContract, TargetStatus, ToolCallVerification } from "../../src/domains/providers/contract.js";
import { probeToolCall, TOOL_PROBE_TOOL_NAME } from "../../src/domains/providers/probe/tool-call.js";
import { resolveRuntimeTarget, runtimeTargetSnapshot } from "../../src/domains/providers/runtime-resolution.js";
import ollamaRuntime from "../../src/domains/providers/runtimes/local-native/ollama.js";
import openAICompatRuntime from "../../src/domains/providers/runtimes/protocol/openai-compat.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import { ensurePiAiRegistered } from "../../src/engine/ai.js";
import { registerClioApiProviders } from "../../src/engine/apis/index.js";
import type { EngineModel } from "../../src/engine/types.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { closeServer, readRequestBody, startOpenAICompatFixture } from "../harness/openai-compat-fixture.js";

const ROOT = new URL("../..", import.meta.url).pathname;
const CLI = join(ROOT, "src", "cli", "index.ts");
const execFileAsync = promisify(execFile);
const MODEL = "mock-model";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

ensurePiAiRegistered();
registerClioApiProviders();

function openAICompatModel(url: string): EngineModel {
	const target: TargetDescriptor = { id: "compat", runtime: "openai-compat", url, defaultModel: MODEL };
	return openAICompatRuntime.synthesizeModel(target, MODEL, null) as EngineModel;
}

function ollamaModel(url: string): EngineModel {
	const target: TargetDescriptor = { id: "ollama", runtime: "ollama", url, defaultModel: MODEL };
	return ollamaRuntime.synthesizeModel(target, MODEL, null) as EngineModel;
}

async function compatFixture(rawArguments?: string): Promise<string> {
	const fixture = await startOpenAICompatFixture("unused", {
		toolCall: { name: TOOL_PROBE_TOOL_NAME, arguments: { a: 2, b: 3 }, ...(rawArguments ? { rawArguments } : {}) },
	});
	cleanups.push(() => closeServer(fixture.server));
	return fixture.url;
}

/** An Ollama `/api/chat` that answers one tool call, as NDJSON frames or as one JSON body. */
async function ollamaChat(mode: "stream" | "single"): Promise<string> {
	const call = { function: { name: TOOL_PROBE_TOOL_NAME, arguments: { a: 2, b: 3 } } };
	const server = createServer(async (req, res) => {
		if (req.url === "/api/ps") {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ models: [{ name: MODEL, model: MODEL }] }));
			return;
		}
		if (req.url !== "/api/chat") {
			res.statusCode = 404;
			res.end("{}");
			return;
		}
		await readRequestBody(req);
		const base = { model: MODEL, created_at: "2026-09-18T00:00:00Z" };
		if (mode === "single") {
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({
					...base,
					message: { role: "assistant", content: "", tool_calls: [call] },
					done: true,
					done_reason: "stop",
				}),
			);
			return;
		}
		res.setHeader("content-type", "application/x-ndjson");
		res.write(
			`${JSON.stringify({ ...base, message: { role: "assistant", content: "", tool_calls: [call] }, done: false })}\n`,
		);
		res.end(
			`${JSON.stringify({ ...base, message: { role: "assistant", content: "" }, done: true, done_reason: "stop" })}\n`,
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	cleanups.push(() => closeServer(server));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("live tool-call probe", () => {
	it("passes a valid streamed tool call through the engine path", async () => {
		const url = await compatFixture();

		const result = await probeToolCall({ model: openAICompatModel(url), timeoutMs: 5_000, apiKey: "k" });

		strictEqual(result.error, undefined);
		strictEqual(result.ok, true);
		strictEqual(result.streamed, true);
		ok((result.frames ?? 0) > 1, `frames ${result.frames}`);
		strictEqual(result.toolCall, true);
		strictEqual(result.argumentsValid, true);
	});

	it("fails malformed argument JSON with the reason", async () => {
		const url = await compatFixture('{"a": 2, "b":');

		const result = await probeToolCall({ model: openAICompatModel(url), timeoutMs: 5_000, apiKey: "k" });

		strictEqual(result.ok, false);
		strictEqual(result.toolCall, true);
		strictEqual(result.argumentsValid, false);
		match(result.error ?? "", /arguments are not valid JSON/);
	});

	it("passes a streamed Ollama /api/chat tool call", async () => {
		const url = await ollamaChat("stream");

		const result = await probeToolCall({ model: ollamaModel(url), timeoutMs: 5_000 });

		strictEqual(result.error, undefined);
		strictEqual(result.ok, true);
		strictEqual(result.frames, 2);
	});

	it("fails the streamed check when the server answers with one JSON body", async () => {
		const url = await ollamaChat("single");

		const result = await probeToolCall({ model: ollamaModel(url), timeoutMs: 5_000 });

		// The call itself is fine; only the transport is wrong, and that is what a turn trips on.
		strictEqual(result.toolCall, true);
		strictEqual(result.argumentsValid, true);
		strictEqual(result.streamed, false);
		strictEqual(result.ok, false);
		match(result.error ?? "", /not streamed \(1 frame before done\)/);
	});

	it("fails bounded when the server never answers", async () => {
		const server: Server = createServer(() => {});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		cleanups.push(() => closeServer(server));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

		const result = await probeToolCall({ model: openAICompatModel(url), timeoutMs: 200, apiKey: "k" });

		strictEqual(result.ok, false);
		strictEqual(result.error, "timeout after 200ms");
		ok(result.latencyMs < 5_000, `latency ${result.latencyMs}`);
	});
});

describe("targets --probe --tools", () => {
	async function runTargets(
		url: string,
		args: string[],
		target: Record<string, unknown> = { id: "compat", runtime: "openai-compat", url, defaultModel: MODEL },
	): Promise<string> {
		const root = mkdtempSync(join(tmpdir(), "clio-tool-probe-"));
		cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
		const env: NodeJS.ProcessEnv = {
			...process.env,
			NODE_ENV: "test",
			NO_COLOR: "1",
			COLUMNS: "400",
			CLIO_CODER_HOME: root,
			CLIO_CODER_CONFIG_DIR: join(root, "config"),
			CLIO_CODER_DATA_DIR: join(root, "data"),
			CLIO_CODER_STATE_DIR: join(root, "state"),
			CLIO_CODER_CACHE_DIR: join(root, "cache"),
			CLIO_CODER_REQUIRE_HOME_PREFIX: "1",
		};
		mkdirSync(join(root, "config"), { recursive: true });
		writeFileSync(join(root, "config", "settings.yaml"), JSON.stringify({ targets: [target] }));
		const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", CLI, "targets", ...args], {
			cwd: ROOT,
			env,
		});
		return stdout;
	}

	async function fixture() {
		const server = await startOpenAICompatFixture("4", {
			toolCall: (request) =>
				Array.isArray(request.tools) ? { name: TOOL_PROBE_TOOL_NAME, arguments: { a: 2, b: 3 } } : null,
		});
		cleanups.push(() => closeServer(server.server));
		return server;
	}

	it("plain --probe sends no generation beyond the reasoning probe", async () => {
		const server = await fixture();

		const out = JSON.parse(await runTargets(server.url, ["--probe", "--json"])) as {
			targets: Array<Record<string, unknown>>;
		};

		strictEqual(out.targets[0]?.toolProbe, undefined);
		strictEqual(
			server.requests.some((request) => Array.isArray(request.tools)),
			false,
		);
		ok(server.requests.every((request) => request.stream === false));
	});

	it("records a verified tool probe in --json and the table", async () => {
		const server = await fixture();

		const out = JSON.parse(await runTargets(server.url, ["--probe", "--tools", "--json"])) as {
			targets: Array<{ toolProbe?: Record<string, unknown>; capabilities: { tools: boolean } }>;
		};

		const probe = out.targets[0]?.toolProbe;
		strictEqual(probe?.status, "verified");
		strictEqual(probe?.modelId, MODEL);
		strictEqual(probe?.streamed, true);
		strictEqual(out.targets[0]?.capabilities.tools, true);
		strictEqual(server.requests.filter((request) => Array.isArray(request.tools)).length, 1);

		const table = await runTargets(server.url, ["--probe", "--tools"]);
		match(table, /tools verified \(mock-model, \d+ms\)/);
	});

	const OLLAMA_MODEL = "fixture:latest";

	/**
	 * An Ollama server that loads a model on chat, streams one tool call after
	 * `chatDelayMs`, and records every `/api/generate`, which is how Clio
	 * releases a pinned model.
	 */
	async function ollamaServer(options: { resident?: boolean; chatDelayMs?: number } = {}) {
		const resident = new Set<string>(options.resident ? [OLLAMA_MODEL] : []);
		const releases: Array<{ model: string; keep_alive: unknown }> = [];
		const server = createServer(async (req, res) => {
			const raw = req.method === "POST" ? await readRequestBody(req) : "";
			res.setHeader("content-type", "application/json");
			if (req.url === "/api/ps") {
				res.end(JSON.stringify({ models: [...resident].map((model) => ({ model, name: model })) }));
				return;
			}
			if (req.url === "/api/tags") {
				res.end(JSON.stringify({ models: [{ model: OLLAMA_MODEL, name: OLLAMA_MODEL }] }));
				return;
			}
			if (req.url === "/api/version") {
				res.end(JSON.stringify({ version: "0.34.0" }));
				return;
			}
			if (req.url === "/api/show") {
				res.end(
					JSON.stringify({
						capabilities: ["completion", "tools"],
						model_info: { "general.architecture": "fixture", "fixture.context_length": 32768 },
					}),
				);
				return;
			}
			if (req.url === "/api/generate") {
				const body = JSON.parse(raw) as { model: string; keep_alive: unknown };
				releases.push({ model: body.model, keep_alive: body.keep_alive });
				if (body.keep_alive === 0) resident.delete(body.model);
				res.end(JSON.stringify({ done: true }));
				return;
			}
			if (req.url === "/api/chat") {
				const body = JSON.parse(raw) as { model: string; tools?: unknown[]; stream?: boolean };
				if (options.chatDelayMs) await new Promise((resolve) => setTimeout(resolve, options.chatDelayMs));
				if (res.destroyed) return;
				resident.add(body.model);
				const base = { model: body.model, created_at: "2026-09-18T00:00:00Z" };
				const call = { function: { name: TOOL_PROBE_TOOL_NAME, arguments: { a: 2, b: 3 } } };
				const message = Array.isArray(body.tools)
					? { role: "assistant", content: "", tool_calls: [call] }
					: { role: "assistant", content: "4" };
				if (body.stream === false) {
					res.end(JSON.stringify({ ...base, message, done: true, done_reason: "stop" }));
					return;
				}
				res.setHeader("content-type", "application/x-ndjson");
				res.write(`${JSON.stringify({ ...base, message, done: false })}\n`);
				res.end(
					`${JSON.stringify({ ...base, message: { role: "assistant", content: "" }, done: true, done_reason: "stop" })}\n`,
				);
				return;
			}
			res.statusCode = 404;
			res.end(JSON.stringify({ error: "not found" }));
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		cleanups.push(() => closeServer(server));
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const target = { id: "local-ollama", runtime: "ollama", url, defaultModel: OLLAMA_MODEL };
		return { url, target, resident, releases };
	}

	type ToolProbeJson = { targets: Array<{ toolProbe?: ToolCallVerification }> };

	it("releases a cold Ollama model the probe loaded before the command returns (#379)", async () => {
		const ollama = await ollamaServer();

		const out = JSON.parse(
			await runTargets(ollama.url, ["--probe", "--tools", "--json"], ollama.target),
		) as ToolProbeJson;

		strictEqual(out.targets[0]?.toolProbe?.status, "verified");
		deepStrictEqual(ollama.releases, [{ model: OLLAMA_MODEL, keep_alive: 0 }]);
		strictEqual(ollama.resident.size, 0);
	});

	it("leaves an Ollama model that was resident before the probe loaded (#313)", async () => {
		const ollama = await ollamaServer({ resident: true });

		const out = JSON.parse(
			await runTargets(ollama.url, ["--probe", "--tools", "--json"], ollama.target),
		) as ToolProbeJson;

		strictEqual(out.targets[0]?.toolProbe?.status, "verified");
		deepStrictEqual(ollama.releases, []);
		ok(ollama.resident.has(OLLAMA_MODEL));
	});

	it("gives a cold load its own generation timeout, bounded by --tools-timeout", async () => {
		// Slower than the 5 s HTTP probe timeout, well inside the tool probe default.
		const slow = await ollamaServer({ chatDelayMs: 5_500 });
		const bounded = await ollamaServer({ chatDelayMs: 5_500 });

		const [passed, timedOut] = await Promise.all([
			runTargets(slow.url, ["--probe", "--tools", "--json"], slow.target),
			runTargets(bounded.url, ["--probe", "--tools", "--tools-timeout", "1", "--json"], bounded.target),
		]).then((outputs) => outputs.map((output) => (JSON.parse(output) as ToolProbeJson).targets[0]?.toolProbe));

		strictEqual(passed?.error, undefined);
		strictEqual(passed?.status, "verified");
		strictEqual(timedOut?.status, "failed");
		strictEqual(timedOut?.error, "timeout after 1000ms");
		ok((timedOut?.latencyMs ?? Number.POSITIVE_INFINITY) < 5_000, `latency ${timedOut?.latencyMs}`);
	});
});

describe("runtime resolution with a tool probe result", () => {
	function providersWithProbe(toolProbe: ToolCallVerification): ProvidersContract {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.targets = [{ id: "local", runtime: "openai-compat", url: "http://127.0.0.1:1", defaultModel: MODEL }];
		const stub = dispatchStubContext({ settings, runtime: openAICompatRuntime });
		const providers = stub.getContract<ProvidersContract>("providers");
		if (!providers) throw new Error("stub has no providers contract");
		const status = providers.list()[0] as TargetStatus;
		status.toolProbe = toolProbe;
		return providers;
	}
	const base = { streamed: true, frames: 3, toolCall: true, argumentsValid: true, latencyMs: 40, checkedAt: 1 };

	it("carries a failed probe as tools provenance and a warning for that model", () => {
		const providers = providersWithProbe({
			...base,
			status: "failed",
			modelId: MODEL,
			streamed: false,
			error: "response was not streamed (1 frame before done)",
		});

		const resolved = resolveRuntimeTarget(providers, { targetId: "local", wireModelId: MODEL });

		ok(resolved.ok);
		strictEqual(resolved.target.toolsVerification?.status, "failed");
		strictEqual(resolved.target.toolsVerification?.source, "probe");
		const warning = resolved.diagnostics.find((entry) => entry.code === "tools-probe-failed");
		match(warning?.message ?? "", /not streamed/);
		strictEqual(runtimeTargetSnapshot(resolved.target).toolsVerification?.status, "failed");
	});

	it("ignores a probe of another model", () => {
		const providers = providersWithProbe({ ...base, status: "verified", modelId: "other-model" });

		const resolved = resolveRuntimeTarget(providers, { targetId: "local", wireModelId: MODEL });

		ok(resolved.ok);
		strictEqual(resolved.target.toolsVerification, undefined);
	});
});
