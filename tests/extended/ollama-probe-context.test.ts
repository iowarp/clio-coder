import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, it } from "node:test";
import { promisify } from "node:util";
import ollamaRuntime from "../../src/domains/providers/runtimes/local-native/ollama.js";
import type { ProbeContext } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import { closeServer } from "../harness/openai-compat-fixture.js";

const ROOT = new URL("../..", import.meta.url).pathname;
const CLI = join(ROOT, "src", "cli", "index.ts");
const execFileAsync = promisify(execFile);

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map(closeServer));
});

/** Serves the two bodies the ollama probe reads. `ps` is sent verbatim. */
async function fixture(ps: unknown): Promise<string> {
	const server = createServer((req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.url === "/api/tags") {
			res.end(JSON.stringify({ models: [{ name: "qwen3:30b-a3b-instruct" }] }));
			return;
		}
		strictEqual(req.url, "/api/ps");
		res.end(JSON.stringify(ps));
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function context(): ProbeContext {
	return { credentialsPresent: new Set<string>(), httpTimeoutMs: 2_000 };
}

it("reports the window a resident Ollama model is actually served at", async () => {
	const url = await fixture({
		models: [
			{
				model: "qwen3:30b-a3b-instruct",
				name: "qwen3:30b-a3b-instruct",
				size: 20_330_336_746,
				size_vram: 20_330_336_746,
				context_length: 32_768,
			},
		],
	});

	const result = await ollamaRuntime.probe?.({ url } as TargetDescriptor, context());

	strictEqual(result?.ok, true);
	const status = result?.modelStates?.["qwen3:30b-a3b-instruct"];
	strictEqual(status?.state, "loaded");
	// The serving window, not the model's 262144 maximum, is what a run is planned against.
	strictEqual(status?.contextLength, 32_768);
	strictEqual(status?.sizeVramBytes, 20_330_336_746);
});

it("omits the context window when Ollama does not report a usable one", async () => {
	const url = await fixture({
		models: [
			{ model: "a", name: "a", context_length: 0 },
			{ model: "b", name: "b" },
			{ model: "c", name: "c", context_length: "32768" },
		],
	});

	const result = await ollamaRuntime.probe?.({ url } as TargetDescriptor, context());

	strictEqual(result?.ok, true);
	for (const id of ["a", "b", "c"]) {
		strictEqual(result?.modelStates?.[id]?.state, "loaded");
		strictEqual(result?.modelStates?.[id]?.contextLength, undefined);
	}
});

/** An Ollama that answers `/api/tags`, `/api/ps`, and `/api/show` with the given bodies. */
async function ollama(bodies: {
	tags: unknown;
	ps?: unknown;
	show?: unknown;
}): Promise<{ url: string; shown: string[] }> {
	const shown: string[] = [];
	const server = createServer((req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.url === "/api/tags") return res.end(JSON.stringify(bodies.tags));
		if (req.url === "/api/ps") return res.end(JSON.stringify(bodies.ps ?? { models: [] }));
		if (req.url === "/api/show" && req.method === "POST") {
			let raw = "";
			req.on("data", (chunk) => {
				raw += chunk;
			});
			req.on("end", () => {
				shown.push((JSON.parse(raw) as { model: string }).model);
				res.statusCode = bodies.show === undefined ? 404 : 200;
				res.end(JSON.stringify(bodies.show ?? { error: "model not found" }));
			});
			return;
		}
		res.statusCode = 404;
		res.end("{}");
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, shown };
}

// `/api/tags` on Ollama 0.18.2 (ollama-mini, read 2026-09-18) carries no
// `details.context_length`; `/api/show` names the maximum under the
// architecture prefix.
const TAGS_0_18 = {
	models: [{ name: "qwen3:30b-a3b-instruct", details: { format: "gguf", family: "qwen3moe" } }],
};
const SHOW_QWEN = {
	model_info: { "general.architecture": "qwen3moe", "qwen3moe.context_length": 262_144 },
	parameters: 'stop "<|im_end|>"\ntemperature 0.7',
};

it("reads the default model's maximum window from /api/show", async () => {
	const { url, shown } = await ollama({ tags: TAGS_0_18, show: SHOW_QWEN });

	const result = await ollamaRuntime.probe?.(
		{ id: "o", runtime: "ollama", url, defaultModel: "qwen3:30b-a3b-instruct" },
		context(),
	);

	strictEqual(result?.ok, true);
	deepStrictEqual(shown, ["qwen3:30b-a3b-instruct"]);
	strictEqual(result?.modelCapabilities?.["qwen3:30b-a3b-instruct"]?.contextWindow, 262_144);
});

it("caps the maximum at a num_ctx baked into the Modelfile", async () => {
	const { url } = await ollama({
		tags: TAGS_0_18,
		show: { ...SHOW_QWEN, parameters: 'num_ctx                        40960\nstop "<|im_end|>"' },
	});

	const result = await ollamaRuntime.probe?.(
		{ id: "o", runtime: "ollama", url, defaultModel: "qwen3:30b-a3b-instruct" },
		context(),
	);

	strictEqual(result?.modelCapabilities?.["qwen3:30b-a3b-instruct"]?.contextWindow, 40_960);
});

it("takes per-model maxima from /api/tags when the server reports them there", async () => {
	const { url } = await ollama({
		tags: {
			models: [
				{ name: "a", details: { context_length: 262_144 } },
				{ name: "b", details: { context_length: 0 } },
			],
		},
	});

	const result = await ollamaRuntime.probe?.({ id: "o", runtime: "ollama", url }, context());

	strictEqual(result?.ok, true);
	deepStrictEqual(result?.modelCapabilities, { a: { contextWindow: 262_144 } });
});

it("keeps the probe healthy when /api/show fails", async () => {
	const { url } = await ollama({ tags: TAGS_0_18 });

	const result = await ollamaRuntime.probe?.({ id: "o", runtime: "ollama", url, defaultModel: "missing" }, context());

	strictEqual(result?.ok, true);
	strictEqual(result?.modelCapabilities, undefined);
});

async function probeTable(
	url: string,
	extra: Record<string, unknown> = {},
): Promise<{ table: string; json: Array<Record<string, unknown>> }> {
	const root = mkdtempSync(join(tmpdir(), "clio-ollama-ctx-"));
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
	writeFileSync(
		join(root, "config", "settings.yaml"),
		JSON.stringify({
			targets: [{ id: "local-ollama", runtime: "ollama", url, defaultModel: "qwen3:30b-a3b-instruct", ...extra }],
		}),
	);
	const run = async (args: string[]): Promise<string> => {
		const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", CLI, "targets", ...args], {
			cwd: ROOT,
			env,
		});
		return stdout;
	};
	try {
		const table = await run(["--probe"]);
		const json = (JSON.parse(await run(["--probe", "--json"])) as { targets: Array<Record<string, unknown>> }).targets;
		return { table, json };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

it("shows the serving window beside the model maximum in targets --probe", async () => {
	const { url } = await ollama({
		tags: TAGS_0_18,
		show: SHOW_QWEN,
		ps: { models: [{ name: "qwen3:30b-a3b-instruct", model: "qwen3:30b-a3b-instruct", context_length: 32_768 }] },
	});

	const { table, json } = await probeTable(url);

	match(table, /ctx 32768 \(serving; model max 262144\)/);
	const row = json.find((entry) => (entry.target as { id: string }).id === "local-ollama");
	strictEqual((row?.capabilities as { contextWindow: number }).contextWindow, 262_144);
	strictEqual(row?.contextWindowProvenance, "discovered");
	const states = row?.discoveredModelStates as Record<string, { contextLength?: number }>;
	strictEqual(states["qwen3:30b-a3b-instruct"]?.contextLength, 32_768);
});

it("shows the cold cap beside the model maximum when nothing is resident", async () => {
	const { url } = await ollama({ tags: TAGS_0_18, show: SHOW_QWEN });

	const { table, json } = await probeTable(url);

	match(table, /ctx 131072 \(cold; model max 262144\)/);
	strictEqual(table.includes("unverified runtime default"), false);
	const row = json.find((entry) => (entry.target as { id: string }).id === "local-ollama");
	strictEqual((row?.capabilities as { contextWindow: number }).contextWindow, 262_144);
});

it("shows a cold model maximum below the cap as is", async () => {
	const { url } = await ollama({
		tags: TAGS_0_18,
		show: { ...SHOW_QWEN, model_info: { ...SHOW_QWEN.model_info, "qwen3moe.context_length": 32_768 } },
	});

	const { table } = await probeTable(url);

	match(table, /ctx 32768(?! \()/);
});

it("shows a configured num_ctx on a cold model beside the model maximum", async () => {
	const { url } = await ollama({ tags: TAGS_0_18, show: SHOW_QWEN });

	const { table } = await probeTable(url, { ollama: { numCtx: 65_536 } });

	match(table, /ctx 65536 \(num_ctx; model max 262144\)/);
});

it("ignores a Modelfile num_ctx when the target sends its own", async () => {
	const { url } = await ollama({
		tags: TAGS_0_18,
		show: { ...SHOW_QWEN, parameters: "num_ctx 40960" },
	});

	const result = await ollamaRuntime.probe?.(
		{ id: "o", runtime: "ollama", url, defaultModel: "qwen3:30b-a3b-instruct", ollama: { numCtx: 65_536 } },
		context(),
	);

	strictEqual(result?.modelCapabilities?.["qwen3:30b-a3b-instruct"]?.contextWindow, 262_144);
});

it("shows a configured num_ctx as the planning window in targets --probe", async () => {
	const { url } = await ollama({
		tags: TAGS_0_18,
		show: SHOW_QWEN,
		ps: { models: [{ name: "qwen3:30b-a3b-instruct", model: "qwen3:30b-a3b-instruct", context_length: 32_768 }] },
	});

	const { table } = await probeTable(url, { ollama: { numCtx: 65_536 } });

	match(table, /ctx 65536 \(num_ctx; serving 32768; model max 262144\)/);
});
