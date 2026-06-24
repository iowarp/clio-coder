import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { createMemoryAuthStorage, resolveAuthTarget } from "../../src/domains/providers/auth/index.js";
import { buildProviderSupportEntry, isOrchestratorEligibleRuntime } from "../../src/domains/providers/index.js";
import { createRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../src/domains/providers/runtimes/builtins.js";
import alcfRuntime, {
	catalogModels,
	clusterFromUrl,
	frameworkForCluster,
	runningModels,
} from "../../src/domains/providers/runtimes/cloud/alcf.js";
import type { ProbeContext } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
import { registerClioOAuthProviders } from "../../src/engine/oauth.js";

const SOPHIA_URL = "https://inference-api.alcf.anl.gov/resource_server/sophia/vllm/v1";
const METIS_URL = "https://inference-api.alcf.anl.gov/resource_server/metis/api/v1";

const sophiaTarget: TargetDescriptor = {
	id: "alcf-sophia",
	runtime: "alcf",
	url: SOPHIA_URL,
	defaultModel: "openai/gpt-oss-120b",
};

const metisTarget: TargetDescriptor = {
	id: "alcf-metis",
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

interface FetchLog {
	url: string;
	authorization: string | undefined;
}

function stubGateway(log: FetchLog[]): void {
	globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
		const u = String(url);
		const headers = (init?.headers ?? {}) as Record<string, string>;
		log.push({ url: u, authorization: headers.Authorization ?? headers.authorization });
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
	it("is registered as a built-in OAuth cloud runtime", () => {
		const registry = createRuntimeRegistry();
		registerBuiltinRuntimes(registry);
		const desc = registry.get("alcf");
		ok(desc);
		strictEqual(desc.auth, "oauth");
		strictEqual(desc.tier, "cloud");
		strictEqual(desc.apiFamily, "openai-completions");

		const support = buildProviderSupportEntry(desc);
		strictEqual(support.group, "cloud-api");
		strictEqual(support.connectable, true);
		strictEqual(support.supportsCustomUrl, true);
		strictEqual(isOrchestratorEligibleRuntime(desc), true);
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

	it("synthesizes Sophia and Metis models with endpoint URLs used as-is", () => {
		const sophia = alcfRuntime.synthesizeModel(sophiaTarget, "openai/gpt-oss-120b", null) as unknown as {
			id: string;
			provider: string;
			api: string;
			baseUrl: string;
		};
		strictEqual(sophia.id, "openai/gpt-oss-120b");
		strictEqual(sophia.provider, "alcf");
		strictEqual(sophia.api, "openai-completions");
		strictEqual(sophia.baseUrl, SOPHIA_URL);

		const metis = alcfRuntime.synthesizeModel(metisTarget, "gpt-oss-120b", null) as unknown as {
			id: string;
			baseUrl: string;
			clio?: { chatTemplateKwargsUnsupported?: boolean };
		};
		strictEqual(metis.id, "gpt-oss-120b");
		strictEqual(metis.baseUrl, METIS_URL);
		strictEqual(metis.clio?.chatTemplateKwargsUnsupported, true);
	});

	it("refuses to probe without a Globus token and points to the login command", async () => {
		const result = await alcfRuntime.probe?.(sophiaTarget, ctx());
		ok(result);
		strictEqual(result.ok, false);
		match(result.error ?? "", /clio auth login alcf/);
	});

	it("discovers Sophia models over the vLLM framework using the bearer token", async () => {
		const log: FetchLog[] = [];
		stubGateway(log);
		const result = await alcfRuntime.probe?.(sophiaTarget, ctx("SOPHIA_BEARER"));
		ok(result);
		strictEqual(result.ok, true);
		deepStrictEqual(result.models, ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
		ok(log.some((entry) => entry.url.includes("/list-endpoints") && entry.authorization === "Bearer SOPHIA_BEARER"));
	});

	it("discovers Metis models over the api framework from the same catalog", async () => {
		const log: FetchLog[] = [];
		stubGateway(log);
		const result = await alcfRuntime.probeModels?.(metisTarget, ctx("METIS_BEARER"));
		deepStrictEqual(result, ["gpt-oss-120b", "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8"]);
		ok(log.some((entry) => entry.url.includes("/metis/jobs")));
	});

	it("resolves the stored ALCF OAuth bearer for both clusters", async () => {
		registerClioOAuthProviders();
		const auth = createMemoryAuthStorage({
			alcf: {
				type: "oauth",
				access: "GLOBUS_BEARER",
				refresh: "REFRESH",
				expires: Date.now() + 3_600_000,
				updatedAt: new Date().toISOString(),
			},
		});

		for (const target of [sophiaTarget, metisTarget]) {
			const authTarget = resolveAuthTarget(target, alcfRuntime);
			strictEqual(authTarget.providerId, "alcf");
			const resolution = await auth.resolveForTarget(authTarget, { includeFallback: false });
			strictEqual(resolution.credentialType, "oauth");
			strictEqual(resolution.apiKey, "GLOBUS_BEARER");
		}
	});
});
