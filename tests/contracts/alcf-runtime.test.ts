import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createMemoryAuthStorage, resolveAuthTarget } from "../../src/domains/providers/auth/index.js";
import { createRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../src/domains/providers/runtimes/builtins.js";
import alcfRuntime, {
	catalogModels,
	clusterFromUrl,
	frameworkForCluster,
	runningModels,
} from "../../src/domains/providers/runtimes/cloud/alcf.js";
import type { EndpointDescriptor } from "../../src/domains/providers/types/endpoint-descriptor.js";
import type { ProbeContext } from "../../src/domains/providers/types/runtime-descriptor.js";
import { alcfOAuthProvider } from "../../src/engine/alcf-oauth.js";
import { getEngineOAuthProvider, registerEngineOAuthProvider } from "../../src/engine/oauth.js";

const SOPHIA_URL = "https://inference-api.alcf.anl.gov/resource_server/sophia/vllm/v1";
const METIS_URL = "https://inference-api.alcf.anl.gov/resource_server/metis/api/v1";

const sophiaEndpoint: EndpointDescriptor = {
	id: "sophia",
	runtime: "alcf",
	url: SOPHIA_URL,
	defaultModel: "openai/gpt-oss-120b",
};
const metisEndpoint: EndpointDescriptor = {
	id: "metis",
	runtime: "alcf",
	url: METIS_URL,
	defaultModel: "gpt-oss-120b",
};

const CATALOG = {
	clusters: {
		sophia: { frameworks: { vllm: { models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"] } } },
		metis: {
			frameworks: { api: { models: ["gpt-oss-120b", "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8"] } },
		},
	},
};

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

function ensureAlcfOAuthRegistered(): void {
	if (getEngineOAuthProvider("alcf") === undefined) registerEngineOAuthProvider(alcfOAuthProvider);
}

interface FetchLog {
	url: string;
	authorization: string | undefined;
}

function stubGateway(log: FetchLog[]): void {
	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		const u = String(url);
		const headers = (init?.headers ?? {}) as Record<string, string>;
		log.push({ url: u, authorization: headers.Authorization });
		if (u.includes("/list-endpoints")) return new Response(JSON.stringify(CATALOG), { status: 200 });
		if (u.endsWith("/jobs")) return new Response(JSON.stringify({ running: [] }), { status: 200 });
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
}

function ctx(authToken?: string): ProbeContext {
	const base: ProbeContext = { credentialsPresent: new Set<string>(), httpTimeoutMs: 5000 };
	return authToken ? { ...base, authToken } : base;
}

describe("contracts/alcf-runtime", () => {
	it("is registered as a built-in oauth cloud runtime", () => {
		const registry = createRuntimeRegistry();
		registerBuiltinRuntimes(registry);
		const desc = registry.get("alcf");
		ok(desc);
		strictEqual(desc.auth, "oauth");
		strictEqual(desc.tier, "cloud");
		strictEqual(desc.apiFamily, "openai-completions");
	});

	it("maps cluster URLs to the correct discovery framework", () => {
		strictEqual(clusterFromUrl(SOPHIA_URL), "sophia");
		strictEqual(clusterFromUrl(METIS_URL), "metis");
		strictEqual(clusterFromUrl("https://example.org/no/cluster"), null);
		strictEqual(frameworkForCluster("sophia"), "vllm");
		strictEqual(frameworkForCluster("metis"), "api");
	});

	it("parses catalog models and running-job models", () => {
		deepStrictEqual(catalogModels(CATALOG, "sophia", "vllm"), ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
		deepStrictEqual(catalogModels(CATALOG, "metis", "vllm"), []);
		deepStrictEqual(runningModels({ running: [{ Models: "a, b ,a" }, { Models: "c" }] }), ["a", "b", "a", "c"]);
	});

	it("synthesizes a Sophia model with the endpoint URL used as-is (no double /v1)", () => {
		const model = alcfRuntime.synthesizeModel(sophiaEndpoint, "openai/gpt-oss-120b", null) as unknown as {
			id: string;
			provider: string;
			api: string;
			baseUrl: string;
		};
		strictEqual(model.id, "openai/gpt-oss-120b");
		strictEqual(model.provider, "alcf");
		strictEqual(model.api, "openai-completions");
		strictEqual(model.baseUrl, SOPHIA_URL);
	});

	it("synthesizes a Metis model on its /api/v1 base", () => {
		const model = alcfRuntime.synthesizeModel(metisEndpoint, "gpt-oss-120b", null) as unknown as {
			id: string;
			baseUrl: string;
		};
		strictEqual(model.id, "gpt-oss-120b");
		strictEqual(model.baseUrl, METIS_URL);
	});

	it("flags models so the engine suppresses chat_template_kwargs (ALCF returns 422 for it)", () => {
		const model = alcfRuntime.synthesizeModel(metisEndpoint, "gpt-oss-120b", null) as unknown as {
			clio?: { chatTemplateKwargsUnsupported?: boolean };
		};
		strictEqual(model.clio?.chatTemplateKwargsUnsupported, true);
	});

	it("refuses to probe without a Globus token and points to the login command", async () => {
		const result = await alcfRuntime.probe?.(sophiaEndpoint, ctx());
		ok(result);
		strictEqual(result.ok, false);
		match(result.error ?? "", /clio auth login alcf/);
	});

	it("discovers Sophia models over the vLLM framework using the bearer token", async () => {
		const log: FetchLog[] = [];
		stubGateway(log);
		const result = await alcfRuntime.probe?.(sophiaEndpoint, ctx("SOPHIA_BEARER"));
		ok(result);
		strictEqual(result.ok, true);
		deepStrictEqual(result.models, ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
		ok(log.some((entry) => entry.url.includes("/list-endpoints") && entry.authorization === "Bearer SOPHIA_BEARER"));
	});

	it("discovers Metis models over the api framework from the same catalog", async () => {
		const log: FetchLog[] = [];
		stubGateway(log);
		const result = await alcfRuntime.probeModels?.(metisEndpoint, ctx("METIS_BEARER"));
		deepStrictEqual(result, ["gpt-oss-120b", "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8"]);
		ok(log.some((entry) => entry.url.includes("/metis/jobs")));
	});

	// End-to-end: clio-coder driven through BOTH ALCF clusters. The resolved
	// bearer (the exact value dispatch hands to pi-ai) plus a correctly-based
	// synthesized model is the full chat-path wiring, network-free.
	it("drives both Sophia and Metis: token resolves and models target the right cluster", async () => {
		ensureAlcfOAuthRegistered();
		const auth = createMemoryAuthStorage({
			alcf: {
				type: "oauth",
				access: "GLOBUS_BEARER",
				refresh: "REFRESH",
				expires: Date.now() + 3_600_000,
				updatedAt: new Date().toISOString(),
			},
		});

		for (const endpoint of [sophiaEndpoint, metisEndpoint]) {
			// auth target defaults providerId to the runtime id "alcf" (matching
			// the OAuth provider) with no explicit oauthProfile needed.
			const target = resolveAuthTarget(endpoint, alcfRuntime);
			strictEqual(target.providerId, "alcf");
			const resolution = await auth.resolveForTarget(target, { includeFallback: false });
			strictEqual(resolution.credentialType, "oauth");
			strictEqual(resolution.apiKey, "GLOBUS_BEARER");

			const model = alcfRuntime.synthesizeModel(endpoint, endpoint.defaultModel ?? "", null) as unknown as {
				baseUrl: string;
			};
			strictEqual(model.baseUrl, endpoint.url);
		}
	});
});
