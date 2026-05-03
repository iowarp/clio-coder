import { ok, strictEqual } from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";

import { probeHttp, probeJson } from "../../../src/domains/providers/probe/http.js";
import {
	parseLlamaCppServerFlags,
	probeLlamaCppModelStatus,
	probeLlamaCppProps,
} from "../../../src/domains/providers/runtimes/common/probe-helpers.js";

interface Spec {
	status?: number;
	body?: string;
	rejectHead?: boolean;
	delayMs?: number;
}

let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
	res.statusCode = 204;
	res.end();
};
let server: Server | null = null;
let baseUrl = "";

function configure(spec: Spec): void {
	handler = (req, res) => {
		if (spec.rejectHead && req.method === "HEAD") {
			res.statusCode = 405;
			res.end();
			return;
		}
		const send = () => {
			res.statusCode = spec.status ?? 200;
			if (spec.body !== undefined) {
				res.setHeader("content-type", "application/json");
				res.end(spec.body);
			} else {
				res.end();
			}
		};
		if (spec.delayMs && spec.delayMs > 0) {
			setTimeout(send, spec.delayMs);
		} else {
			send();
		}
	};
}

beforeEach(async () => {
	server = createServer((req, res) => handler(req, res));
	await new Promise<void>((resolve) => {
		server?.listen(0, "127.0.0.1", () => resolve());
	});
	const addr = server?.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
	await new Promise<void>((resolve) => {
		if (!server) return resolve();
		server.close(() => resolve());
	});
	server = null;
});

describe("providers/probe probeHttp", () => {
	it("ok on 200", async () => {
		configure({ status: 200 });
		const result = await probeHttp({ url: baseUrl, timeoutMs: 1000 });
		strictEqual(result.ok, true);
	});

	it("HEAD returning 405 is still ok=true (reachable endpoint)", async () => {
		configure({ rejectHead: true, status: 500 });
		const result = await probeHttp({ url: baseUrl, method: "HEAD", timeoutMs: 1000 });
		strictEqual(result.ok, true);
	});

	it("non-ok status surfaces an HTTP error string", async () => {
		configure({ status: 500 });
		const result = await probeHttp({ url: baseUrl, timeoutMs: 1000 });
		strictEqual(result.ok, false);
		ok(result.error?.startsWith("HTTP 500"), `expected HTTP 500 error, got: ${result.error}`);
	});

	it("timeoutMs fires the abort controller with a 'timeout after Xms' error", async () => {
		configure({ delayMs: 200, status: 200 });
		const result = await probeHttp({ url: baseUrl, timeoutMs: 30 });
		strictEqual(result.ok, false);
		strictEqual(result.error, "timeout after 30ms");
	});

	it("caller-supplied signal aborts ahead of timeout", async () => {
		configure({ delayMs: 300, status: 200 });
		const controller = new AbortController();
		const started = probeHttp({ url: baseUrl, timeoutMs: 5000, signal: controller.signal });
		setTimeout(() => controller.abort(), 30);
		const result = await started;
		strictEqual(result.ok, false);
		strictEqual(result.error, "aborted by caller");
	});
});

describe("providers/probe probeJson", () => {
	it("parses a well-formed JSON body", async () => {
		configure({ status: 200, body: '{"hello":"world"}' });
		const result = await probeJson<{ hello: string }>({ url: baseUrl, timeoutMs: 1000 });
		strictEqual(result.ok, true);
		strictEqual(result.data?.hello, "world");
	});

	it("surfaces 'JSON parse: …' on malformed JSON", async () => {
		configure({ status: 200, body: "{not json" });
		const result = await probeJson({ url: baseUrl, timeoutMs: 1000 });
		strictEqual(result.ok, false);
		ok(result.error?.startsWith("JSON parse: "), `expected JSON parse error, got: ${result.error}`);
	});
});

describe("providers/probe llama.cpp props", () => {
	it("maps n_ctx and n_predict into discovered capabilities", async () => {
		configure({
			status: 200,
			body: JSON.stringify({
				default_generation_settings: { n_ctx: 262144, n_predict: 65536 },
				modalities: { vision: true },
			}),
		});

		const result = await probeLlamaCppProps(baseUrl, {
			credentialsPresent: new Set<string>(),
			httpTimeoutMs: 1000,
		});

		strictEqual(result.discoveredCapabilities?.contextWindow, 262144);
		strictEqual(result.discoveredCapabilities?.maxTokens, 65536);
		strictEqual(result.discoveredCapabilities?.vision, true);
	});

	it("parses router status args into typed llama.cpp server flags", () => {
		const flags = parseLlamaCppServerFlags([
			"--jinja",
			"--ctx-size",
			"262144",
			"--cache-type-k",
			"q8_0",
			"--cache-type-v",
			"q8_0",
			"--flash-attn",
			"true",
			"--reasoning",
			"on",
			"--reasoning-budget",
			"4096",
			"--temperature",
			"0.3",
			"--top-k",
			"20",
			"--top-p",
			"0.9",
			"--n-gpu-layers",
			"99",
			"--mmproj",
			"/models/mmproj.gguf",
		]);

		strictEqual(flags.contextSize, 262144);
		strictEqual(flags.cacheTypeK, "q8_0");
		strictEqual(flags.cacheTypeV, "q8_0");
		strictEqual(flags.flashAttention, true);
		strictEqual(flags.jinja, true);
		strictEqual(flags.reasoning, true);
		strictEqual(flags.reasoningBudget, 4096);
		strictEqual(flags.temperature, 0.3);
		strictEqual(flags.topK, 20);
		strictEqual(flags.topP, 0.9);
		strictEqual(flags.nGpuLayers, 99);
		strictEqual(flags.mmproj, "/models/mmproj.gguf");
	});

	it("uses /v1/models router status to enrich llama.cpp capabilities", async () => {
		handler = (req, res) => {
			if (req.url !== "/v1/models") {
				res.statusCode = 404;
				res.end();
				return;
			}
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({
					data: [
						{
							id: "Qwen3.6-35B-A3B-UD-Q4_K_XL",
							status: {
								args: [
									"--jinja",
									"--ctx-size",
									"262144",
									"--flash-attn",
									"true",
									"--reasoning",
									"on",
									"--reasoning-budget",
									"4096",
									"--mmproj",
									"/models/mmproj.gguf",
								],
							},
						},
					],
				}),
			);
		};

		const result = await probeLlamaCppModelStatus(
			baseUrl,
			{ id: "mini", runtime: "llamacpp", defaultModel: "Qwen3.6-35B-A3B-UD-Q4_K_XL" },
			{
				credentialsPresent: new Set<string>(),
				httpTimeoutMs: 1000,
			},
		);

		strictEqual(result.discoveredCapabilities?.contextWindow, 262144);
		strictEqual(result.discoveredCapabilities?.reasoning, true);
		strictEqual(result.discoveredCapabilities?.vision, true);
		strictEqual(result.discoveredCapabilities?.tools, true);
		strictEqual(result.serverFlags?.flashAttention, true);
	});
});
