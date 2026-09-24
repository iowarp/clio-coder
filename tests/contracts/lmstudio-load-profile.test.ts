import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { validateSettings } from "../../src/core/config.js";
import { residencyTargetKey } from "../../src/core/residency-target-key.js";
import { lmStudioRootUrl } from "../../src/domains/providers/runtimes/common/lmstudio-http.js";
import lmstudio from "../../src/domains/providers/runtimes/local-native/lmstudio.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import {
	effectiveLmStudioLoad,
	lmStudioDeploymentFromModelInfo,
	lmStudioLoadDrift,
} from "../../src/engine/apis/lmstudio.js";
import { clioOwnership, leaseClioModel, recordClioLoad } from "../../src/engine/apis/lmstudio-ownership.js";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import type { Model } from "../../src/engine/types.js";

// The load profile dynamo is meant to serve: LM Studio's GUI defaults gave 262144 and MTP draft 3.
const PROFILE = { contextLength: 131072, parallel: 4, flashAttention: true, speculativeDraftMaxTokens: 2 };
const PROFILE_WIRE = { context_length: 131072, parallel: 4, flash_attention: true, speculative_draft_max_tokens: 2 };
const GUI_DEFAULTS = { context_length: 262144, parallel: 4, flash_attention: true, speculative_draft_max_tokens: 3 };

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
	let raw = "";
	for await (const chunk of req) raw += chunk;
	return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function sse(res: import("node:http").ServerResponse, model: string): void {
	res.setHeader("content-type", "text/event-stream");
	for (const chunk of [
		{ choices: [{ index: 0, delta: { content: "OK" } }] },
		{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } },
	]) {
		res.write(`data: ${JSON.stringify({ id: "fixture", model, ...chunk })}\n\n`);
	}
	res.end("data: [DONE]\n\n");
}

async function listen(server: Server): Promise<string> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A fake LM Studio 0.4 server: REST catalog, load, unload, and OpenAI-compatible chat. */
async function startLmStudio(
	models: Record<string, Array<{ id: string; config: Record<string, unknown> }>>,
	onChat?: () => Promise<void>,
) {
	const loads: Array<Record<string, unknown>> = [];
	const unloads: string[] = [];
	const chats: Array<{ body: Record<string, unknown>; authorization: string | undefined }> = [];
	const controlAuth: Array<string | undefined> = [];
	const server = createServer(async (req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.url?.startsWith("/api/")) controlAuth.push(req.headers.authorization);
		if (req.method === "GET" && req.url === "/api/v1/models") {
			return res.end(
				JSON.stringify({
					models: Object.entries(models).map(([key, loaded_instances]) => ({
						key,
						type: "llm",
						max_context_length: 262144,
						loaded_instances,
					})),
				}),
			);
		}
		if (req.method === "POST" && req.url === "/api/v1/models/load") {
			const body = await readJson(req);
			loads.push(body);
			const key = String(body.model);
			const { model: _model, echo_load_config: _echo, ...config } = body;
			models[key] = [...(models[key] ?? []), { id: key, config }];
			return res.end(JSON.stringify({ type: "llm", instance_id: key, status: "loaded", load_config: config }));
		}
		if (req.method === "POST" && req.url === "/api/v1/models/unload") {
			const id = String((await readJson(req)).instance_id);
			unloads.push(id);
			for (const key of Object.keys(models)) models[key] = (models[key] ?? []).filter((entry) => entry.id !== id);
			return res.end(JSON.stringify({ instance_id: id }));
		}
		if (req.method === "POST" && req.url === "/v1/chat/completions") {
			const body = await readJson(req);
			chats.push({ body, authorization: req.headers.authorization });
			await onChat?.();
			return sse(res, String(body.model));
		}
		res.writeHead(404);
		res.end("{}");
	});
	const url = await listen(server);
	return { url, models, loads, unloads, chats, controlAuth, close: () => server.close() };
}

/** A fake LiteLLM gateway whose detail metadata names the LM Studio deployment behind each alias. */
async function startGateway(rows: Array<Record<string, unknown>>) {
	const chats: Array<Record<string, unknown>> = [];
	const server = createServer(async (req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.url === "/v1/models") {
			return res.end(JSON.stringify({ data: rows.map((row) => ({ id: row.model_name })) }));
		}
		if (req.url === "/v1/model/info") return res.end(JSON.stringify({ data: rows }));
		if (req.method === "POST" && req.url === "/v1/chat/completions") {
			const body = await readJson(req);
			chats.push(body);
			return sse(res, String(body.model));
		}
		res.writeHead(404);
		res.end("{}");
	});
	const url = await listen(server);
	return { url, chats, close: () => server.close() };
}

async function turn(model: Model<"openai-completions">, apiKey = "fixture"): Promise<void> {
	const result = await openAICompletionsApiProvider
		.streamSimple(model, { messages: [{ role: "user", content: "Reply with OK.", timestamp: 0 }] }, { apiKey })
		.result();
	strictEqual(result.stopReason, "stop", result.errorMessage);
}

function pick(body: Record<string, unknown> | undefined, keys: ReadonlyArray<string>): Record<string, unknown> {
	return Object.fromEntries(keys.map((key) => [key, body?.[key]]));
}

const WIRE_KEYS = Object.keys(PROFILE_WIRE);

describe("LM Studio load profile", () => {
	it("settings accept parallel, speculativeDraftMaxTokens and per-model overrides", () => {
		const { issues, settings } = validateSettings({
			version: 2,
			targets: [
				{
					id: "blade",
					runtime: "litellm",
					url: "http://127.0.0.1:1",
					lmstudio: {
						load: PROFILE,
						models: { "dynamo/qwen3.8-27b": { load: { contextLength: 65536 } } },
					},
				},
			],
		});
		deepStrictEqual(issues, []);
		deepStrictEqual(settings.targets[0]?.lmstudio, {
			load: PROFILE,
			models: { "dynamo/qwen3.8-27b": { load: { contextLength: 65536 } } },
		});
		const { issues: bad } = validateSettings({
			version: 2,
			targets: [{ id: "t", runtime: "lmstudio", url: "http://127.0.0.1:1", lmstudio: { load: { parallel: 0, mtp: 2 } } }],
		});
		ok(bad.some((issue) => issue.path.endsWith("lmstudio.load.parallel")));
		ok(bad.some((issue) => issue.path.includes("mtp")));
	});

	it("a per-model override sits on top of the target profile", () => {
		const settings = { load: PROFILE, models: { big: { load: { contextLength: 262144 } } } };
		deepStrictEqual(effectiveLmStudioLoad(settings, "big"), { ...PROFILE, contextLength: 262144 });
		deepStrictEqual(effectiveLmStudioLoad(settings, "other"), PROFILE);
		strictEqual(effectiveLmStudioLoad(undefined, "other"), undefined);
	});

	it("drift names only the fields the instance reports and the profile sets", () => {
		deepStrictEqual(lmStudioLoadDrift(PROFILE_WIRE, GUI_DEFAULTS), [
			"context_length 262144 to 131072",
			"speculative_draft_max_tokens 3 to 2",
		]);
		deepStrictEqual(lmStudioLoadDrift(PROFILE_WIRE, { context_length: 131072 }), []);
	});

	it("reads the LM Studio deployment behind a gateway route and nothing else", () => {
		const row = (model_name: string, runtime: string, model: string) => ({
			model_name,
			litellm_params: { model, api_base: "http://10.0.0.9:1234/v1" },
			model_info: { runtime },
		});
		deepStrictEqual(
			lmStudioDeploymentFromModelInfo({ data: [row("dynamo/q", "lm-studio", "openai/q@q4_k_m")] }, "dynamo/q"),
			{ controlUrl: "http://10.0.0.9:1234", modelKey: "q@q4_k_m" },
		);
		// A key that holds its own slash keeps it; only LiteLLM's provider prefix is dropped.
		strictEqual(
			lmStudioDeploymentFromModelInfo(
				{ data: [row("dynamo/gpt", "lm-studio", "openai/openai/gpt-oss-20b")] },
				"dynamo/gpt",
			)?.modelKey,
			"openai/gpt-oss-20b",
		);
		strictEqual(lmStudioDeploymentFromModelInfo({ data: [row("mini/q", "llama.cpp", "openai/q")] }, "mini/q"), null);
		strictEqual(
			lmStudioDeploymentFromModelInfo(
				{ data: [row("pool", "lm-studio", "openai/a"), row("pool", "lm-studio", "openai/b")] },
				"pool",
			),
			null,
		);
	});

	it("a direct LM Studio target loads with the profile, then reuses the matching instance", async () => {
		const server = await startLmStudio({ "qwen3.8-27b": [] });
		try {
			const target: TargetDescriptor = {
				id: "dynamo",
				runtime: "lmstudio",
				url: server.url,
				lmstudio: { load: PROFILE },
			};
			const model = lmstudio.synthesizeModel(target, "qwen3.8-27b", null) as Model<"openai-completions">;
			await turn(model);
			strictEqual(server.loads.length, 1);
			deepStrictEqual(pick(server.loads[0], WIRE_KEYS), PROFILE_WIRE);
			await turn(model);
			strictEqual(server.loads.length, 1, "a matching instance is reused, not reloaded");
			deepStrictEqual(server.unloads, []);
		} finally {
			server.close();
		}
	});

	it("a direct LM Studio target reloads an instance another client loaded with GUI defaults", async () => {
		const server = await startLmStudio({ "qwen3.8-27b": [{ id: "qwen3.8-27b", config: GUI_DEFAULTS }] });
		try {
			const target: TargetDescriptor = { id: "dynamo", runtime: "lmstudio", url: server.url, lmstudio: { load: PROFILE } };
			const model = lmstudio.synthesizeModel(target, "qwen3.8-27b", null) as Model<"openai-completions">;
			await turn(model);
			deepStrictEqual(server.unloads, ["qwen3.8-27b"]);
			strictEqual(server.loads.length, 1);
			deepStrictEqual(pick(server.loads[0], WIRE_KEYS), PROFILE_WIRE);
			strictEqual(model.contextWindow, 131072);
		} finally {
			server.close();
		}
	});

	it("a user-managed target is never unloaded or loaded", async () => {
		const server = await startLmStudio({ "qwen3.8-27b": [{ id: "qwen3.8-27b", config: GUI_DEFAULTS }] });
		try {
			const target: TargetDescriptor = {
				id: "dynamo",
				runtime: "lmstudio",
				url: server.url,
				lifecycle: "user-managed",
				lmstudio: { load: PROFILE },
			};
			await turn(lmstudio.synthesizeModel(target, "qwen3.8-27b", null) as Model<"openai-completions">);
			deepStrictEqual(server.unloads, []);
			deepStrictEqual(server.loads, []);
		} finally {
			server.close();
		}
	});

	it("a gateway route loads its LM Studio model with the profile, keeps the alias, and sends LM Studio no credential", async () => {
		const lm = await startLmStudio({
			"qwopus3.8-27b-flash@q4_k_m": [{ id: "qwopus3.8-27b-flash@q4_k_m", config: GUI_DEFAULTS }],
		});
		const alias = "dynamo/qwopus3.8-27b-flash@q4_k_m";
		const gateway = await startGateway([
			{
				model_name: alias,
				litellm_params: { model: "openai/qwopus3.8-27b-flash@q4_k_m", api_base: `${lm.url}/v1` },
				model_info: { runtime: "lm-studio", mode: "chat", max_input_tokens: 262144 },
			},
		]);
		try {
			const target: TargetDescriptor = {
				id: "blade",
				runtime: "litellm",
				url: gateway.url,
				lmstudio: { load: PROFILE, models: { [alias]: { load: { parallel: 2 } } } },
			};
			const model = litellm.synthesizeModel(target, alias, null) as Model<"openai-completions">;
			await turn(model, "gateway-secret");
			deepStrictEqual(lm.unloads, ["qwopus3.8-27b-flash@q4_k_m"]);
			strictEqual(lm.loads.length, 1);
			deepStrictEqual(pick(lm.loads[0], WIRE_KEYS), { ...PROFILE_WIRE, parallel: 2 });
			strictEqual(lm.loads[0]?.model, "qwopus3.8-27b-flash@q4_k_m");
			strictEqual(gateway.chats.length, 1);
			strictEqual(gateway.chats[0]?.model, alias);
			deepStrictEqual(lm.chats, [], "the request itself still goes through the gateway");
			ok(
				lm.controlAuth.every((header) => header === undefined),
				"the gateway key never reaches LM Studio",
			);
			strictEqual(model.contextWindow, 131072);
		} finally {
			lm.close();
			gateway.close();
		}
	});

	it("a gateway target without a load profile stays observe-only", async () => {
		const lm = await startLmStudio({ q: [{ id: "q", config: GUI_DEFAULTS }] });
		const gateway = await startGateway([
			{
				model_name: "dynamo/q",
				litellm_params: { model: "openai/q", api_base: `${lm.url}/v1` },
				model_info: { runtime: "lm-studio", mode: "chat" },
			},
		]);
		try {
			const target: TargetDescriptor = { id: "blade", runtime: "litellm", url: gateway.url };
			await turn(litellm.synthesizeModel(target, "dynamo/q", null) as Model<"openai-completions">);
			deepStrictEqual(lm.controlAuth, [], "no LM Studio control call at all");
			strictEqual(gateway.chats.length, 1);
		} finally {
			lm.close();
			gateway.close();
		}
	});
});

function serverKey(url: string): string {
	const key = residencyTargetKey("lmstudio", lmStudioRootUrl(url));
	ok(key);
	return key;
}

/** Another Clio process holding a lease on `modelKey`, alive until killed. */
async function leaseInChild(key: string, modelKey: string): Promise<ChildProcess> {
	const module = new URL("../../src/engine/apis/lmstudio-ownership.ts", import.meta.url).href;
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"-e",
			`const m = await import(${JSON.stringify(module)}); await m.leaseClioModel(${JSON.stringify(key)}, ${JSON.stringify(modelKey)}); process.stdout.write("leased\\n"); setInterval(() => {}, 1000);`,
		],
		{ env: process.env, stdio: ["ignore", "pipe", "inherit"] },
	);
	await new Promise<void>((resolve, reject) => {
		child.once("exit", (code) => reject(new Error(`lease child exited with ${code}`)));
		child.stdout?.on("data", (chunk: Buffer) => {
			if (chunk.toString().includes("leased")) resolve();
		});
	});
	return child;
}

async function killed(child: ChildProcess): Promise<void> {
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGKILL");
	await exited;
}

describe("LM Studio load ownership across Clio processes", () => {
	const directTarget = (url: string): TargetDescriptor => ({
		id: "dynamo",
		runtime: "lmstudio",
		url,
		lmstudio: { load: PROFILE },
	});
	const synth = (url: string, id: string) =>
		lmstudio.synthesizeModel(directTarget(url), id, null) as Model<"openai-completions">;

	it("a load releases a model an earlier Clio process loaded on the same server", async () => {
		const server = await startLmStudio({ a: [{ id: "a", config: PROFILE_WIRE }], b: [] });
		try {
			// A record is all another process leaves behind; which process wrote it does not matter.
			await recordClioLoad(serverKey(server.url), "a", "a");
			await turn(synth(server.url, "b"));
			deepStrictEqual(server.unloads, ["a"]);
			deepStrictEqual(
				server.loads.map((body) => body.model),
				["b"],
			);
			const { loads } = await clioOwnership(serverKey(server.url));
			deepStrictEqual(
				loads.map((record) => record.instanceId),
				["b"],
			);
		} finally {
			server.close();
		}
	});

	it("back-to-back turns on one model stay warm", async () => {
		const server = await startLmStudio({ a: [] });
		try {
			await turn(synth(server.url, "a"));
			await turn(synth(server.url, "a"));
			strictEqual(server.loads.length, 1);
			deepStrictEqual(server.unloads, []);
		} finally {
			server.close();
		}
	});

	it("a model another client loaded is never released", async () => {
		const server = await startLmStudio({ foreign: [{ id: "foreign", config: PROFILE_WIRE }], b: [] });
		try {
			await turn(synth(server.url, "b"));
			deepStrictEqual(server.unloads, []);
		} finally {
			server.close();
		}
	});

	it("a model a live Clio process is streaming on stays, and is released once that process is gone", async () => {
		const server = await startLmStudio({ a: [{ id: "a", config: PROFILE_WIRE }], b: [], c: [] });
		const key = serverKey(server.url);
		await recordClioLoad(key, "a", "a");
		const child = await leaseInChild(key, "a");
		try {
			await turn(synth(server.url, "b"));
			deepStrictEqual(server.unloads, [], "the other process's model stays while it holds a lease");
			await killed(child);
			await turn(synth(server.url, "c"));
			deepStrictEqual(server.unloads.sort(), ["a", "b"], "a dead process's lease protects nothing");
		} finally {
			if (child.exitCode === null && child.signalCode === null) await killed(child);
			server.close();
		}
	});

	it("an instance that drifted from the profile is not reloaded under a live Clio request", async () => {
		const server = await startLmStudio({ a: [{ id: "a", config: GUI_DEFAULTS }] });
		const release = await leaseClioModel(serverKey(server.url), "a");
		try {
			await turn(synth(server.url, "a"));
			deepStrictEqual(server.unloads, []);
			deepStrictEqual(server.loads, []);
		} finally {
			await release();
			server.close();
		}
	});

	it("a stream holds its lease while the request runs and drops it after", async () => {
		const seen: Array<Set<string>> = [];
		let key = "";
		const server = await startLmStudio({ a: [] }, async () => {
			seen.push((await clioOwnership(key)).leased);
		});
		key = serverKey(server.url);
		try {
			await turn(synth(server.url, "a"));
			deepStrictEqual(
				seen.map((leased) => [...leased]),
				[["a"]],
			);
			deepStrictEqual([...(await clioOwnership(key)).leased], []);
		} finally {
			server.close();
		}
	});
});
