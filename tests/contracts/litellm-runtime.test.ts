import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
	GATEWAY_SCHEMA_RUNTIME_ID,
	responseSchemaConflictsWithTools,
	responseSchemaDialectFor,
	runtimeSpeaksResponseSchemaDialect,
} from "../../src/core/response-schema.js";
import { createRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../src/domains/providers/runtimes/builtins.js";
import litellmRuntime, {
	capabilitiesFromLiteLLMModelInfo,
	formatRoutedDeployment,
	routedDeploymentFromHeaders,
} from "../../src/domains/providers/runtimes/protocol/litellm.js";
import type { ProbeContext } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";

const GATEWAY_URL = "http://blade.example.ts.net:4000";

const target: TargetDescriptor = {
	id: "blade-gateway",
	runtime: "litellm",
	url: GATEWAY_URL,
	defaultModel: "code",
};

const ctx: ProbeContext = {
	credentialsPresent: new Set<string>(),
	httpTimeoutMs: 2000,
	authToken: "sk-test",
};

/** One `/v1/model/info` row shaped the way LiteLLM v1.98 returns it. */
function infoRow(name: string, upstream: string, apiBase: string, info: Record<string, unknown>) {
	return { model_name: name, litellm_params: { model: upstream, api_base: apiBase }, model_info: info };
}

const MODEL_INFO = {
	data: [
		infoRow("code", "openai/katcoder2.5-35b-moe", "http://mini.example:8080/v1", {
			mode: "chat",
			max_input_tokens: 262144,
			max_output_tokens: 65536,
			supports_function_calling: true,
			supports_vision: false,
			supports_reasoning: false,
			supports_response_schema: true,
		}),
		infoRow("memory", "openai/blade-local", "http://127.0.0.1:8081/v1", {
			mode: "chat",
			max_input_tokens: 32768,
			max_output_tokens: 8192,
			supports_function_calling: true,
			supports_vision: true,
			supports_reasoning: false,
		}),
		infoRow("embed", "openai/blade-embed", "http://127.0.0.1:8082/v1", {
			mode: "embedding",
			max_input_tokens: 2048,
		}),
	],
};

const realFetch = globalThis.fetch;

interface Route {
	status?: number;
	body?: unknown;
}

/** Serve a fixed routing table and record every URL the probe asked for. */
function stubFetch(routes: Record<string, Route>): { urls: string[]; auth: Array<string | undefined> } {
	const urls: string[] = [];
	const auth: Array<string | undefined> = [];
	globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
		const url = String(input);
		urls.push(url);
		const headers = new Headers((init?.headers ?? {}) as Record<string, string>);
		auth.push(headers.get("authorization") ?? undefined);
		const path = new URL(url).pathname;
		const route = routes[path];
		if (!route) return new Response("not found", { status: 404 });
		return new Response(JSON.stringify(route.body ?? {}), {
			status: route.status ?? 200,
			headers: { "content-type": "application/json" },
		});
	}) as unknown as typeof globalThis.fetch;
	return { urls, auth };
}

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("litellm runtime registration", () => {
	it("registers as a builtin protocol runtime", () => {
		const registry = createRuntimeRegistry();
		registerBuiltinRuntimes(registry);
		const found = registry.get("litellm");
		ok(found !== null, "litellm runtime is registered");
		strictEqual(found?.tier, "protocol");
		strictEqual(found?.apiFamily, "openai-completions");
		strictEqual(found?.auth, "api-key");
	});

	it("does not claim tools before the probe answers", () => {
		// A gateway that published nothing has told Clio nothing. Claiming tools
		// here produces a worker that fails on its first tool call instead of one
		// that is never admitted.
		strictEqual(litellmRuntime.defaultCapabilities.tools, false);
		strictEqual(litellmRuntime.defaultCapabilities.vision, false);
	});
});

describe("litellm capability discovery", () => {
	it("reads context, tools, and vision from /v1/model/info", async () => {
		const { urls, auth } = stubFetch({
			"/health/liveliness": { body: { status: "healthy" } },
			"/v1/model/info": { body: MODEL_INFO },
		});
		const result = await litellmRuntime.probe?.(target, ctx);
		ok(result?.ok, `probe failed: ${result?.error}`);
		deepStrictEqual(result?.models?.sort(), ["code", "embed", "memory"]);
		strictEqual(result?.modelCapabilities?.code?.contextWindow, 262144);
		strictEqual(result?.modelCapabilities?.code?.maxTokens, 65536);
		strictEqual(result?.modelCapabilities?.code?.tools, true);
		strictEqual(result?.modelCapabilities?.code?.vision, false);
		// The configured default's capabilities are promoted for the target.
		strictEqual(result?.capabilityModelId, "code");
		strictEqual(result?.discoveredCapabilities?.contextWindow, 262144);
		ok(
			urls.some((url) => url.endsWith("/v1/model/info")),
			"probe asked the detail endpoint",
		);
		ok(auth.includes("Bearer sk-test"), "probe sent the resolved bearer token");
	});

	it("reports the physical model behind each alias", async () => {
		stubFetch({
			"/health/liveliness": { body: { status: "healthy" } },
			"/v1/model/info": { body: MODEL_INFO },
		});
		const result = await litellmRuntime.probe?.(target, ctx);
		const routes = result?.notes?.find((note) => note.startsWith("routes:"));
		ok(routes !== undefined, "probe reported its routing table");
		match(routes as string, /code=openai\/katcoder2\.5-35b-moe/);
		match(routes as string, /memory=openai\/blade-local/);
	});

	it("marks an embedding deployment as not a chat deployment", () => {
		const caps = capabilitiesFromLiteLLMModelInfo({ mode: "embedding", max_input_tokens: 2048 });
		strictEqual(caps.chat, false);
		strictEqual(caps.embeddings, true);
		strictEqual(caps.contextWindow, 2048);
	});

	it("returns nothing for fields the gateway left null", () => {
		// Distinguishes "the gateway says no vision" from "the gateway did not
		// say", so a merge cannot mistake silence for a negative answer.
		const caps = capabilitiesFromLiteLLMModelInfo({
			max_input_tokens: null,
			supports_vision: null,
			supports_function_calling: null,
		});
		deepStrictEqual(caps, {});
	});

	it("separates an unreachable gateway from a rejected key", async () => {
		// /v1/models answers 401 for a bad key, which is indistinguishable from a
		// dead host if that is the only thing probed. The liveness endpoint is
		// unauthenticated, so the two failures get different messages.
		stubFetch({
			"/health/liveliness": { body: { status: "healthy" } },
			"/v1/model/info": { status: 401, body: { error: "invalid key" } },
			"/v1/models": { status: 401, body: { error: "invalid key" } },
		});
		const rejected = await litellmRuntime.probe?.(target, ctx);
		strictEqual(rejected?.ok, false);
		match(rejected?.error ?? "", /API key/);

		stubFetch({});
		const unreachable = await litellmRuntime.probe?.(target, ctx);
		strictEqual(unreachable?.ok, false);
		ok(!/API key/.test(unreachable?.error ?? ""), "a dead gateway is not reported as a key problem");
	});

	it("falls back to /v1/models when the detail endpoint is refused", async () => {
		stubFetch({
			"/health/liveliness": { body: { status: "healthy" } },
			"/v1/model/info": { status: 403, body: { error: "forbidden" } },
			"/v1/models": { body: { data: [{ id: "code" }, { id: "memory" }] } },
		});
		const result = await litellmRuntime.probe?.(target, ctx);
		ok(result?.ok, "a gateway serving only the plain listing is still usable");
		deepStrictEqual(result?.models?.sort(), ["code", "memory"]);
		strictEqual(result?.modelCapabilities, undefined, "no capabilities are invented");
	});

	it("flags a configured model the gateway does not serve", async () => {
		stubFetch({
			"/health/liveliness": { body: { status: "healthy" } },
			"/v1/model/info": { body: MODEL_INFO },
		});
		const result = await litellmRuntime.probe?.({ ...target, defaultModel: "ai-code" }, ctx);
		ok(result?.ok);
		ok(
			result?.notes?.some((note) => note.includes("'ai-code' is not in the gateway catalog")),
			"a stale alias is named",
		);
	});
});

describe("litellm model synthesis", () => {
	it("marks the target as a gateway so residency stays observe-only", () => {
		const model = litellmRuntime.synthesizeModel?.(target, "code", null);
		const clio = (model as { clio?: { gateway?: boolean; targetId?: string } }).clio;
		strictEqual(clio?.gateway, true, "the models behind an alias are the proxy's to load and evict");
		strictEqual(clio?.targetId, "blade-gateway");
	});

	it("mounts the base url at /v1 exactly once", () => {
		const plain = litellmRuntime.synthesizeModel?.(target, "code", null);
		strictEqual(plain?.baseUrl, `${GATEWAY_URL}/v1`);
		const alreadyMounted = litellmRuntime.synthesizeModel?.({ ...target, url: `${GATEWAY_URL}/v1` }, "code", null);
		strictEqual(alreadyMounted?.baseUrl, `${GATEWAY_URL}/v1`);
	});
});

describe("litellm structured output", () => {
	it("speaks the standard json_schema dialect", () => {
		// Measured against a live gateway: json_schema is enforced through both a
		// llama.cpp and an LM Studio upstream, json_object+schema is not.
		strictEqual(responseSchemaDialectFor(GATEWAY_SCHEMA_RUNTIME_ID), "openai-json-schema");
	});

	it("admits contract-bearing workers to a gateway target", () => {
		ok(
			runtimeSpeaksResponseSchemaDialect({
				id: "litellm",
				kind: "http",
				apiFamily: "openai-completions",
			}),
		);
	});

	it("still refuses a generic openai-compatible proxy", () => {
		// The hazard the module documents: a generic gateway answers HTTP 200 to a
		// spelling it does not implement and returns unconstrained JSON.
		strictEqual(responseSchemaDialectFor("openai-compat"), null);
		strictEqual(
			runtimeSpeaksResponseSchemaDialect({
				id: "openai-compat",
				kind: "http",
				apiFamily: "openai-completions",
			}),
			false,
		);
	});

	it("treats schema plus tools as a conflict, conservatively", () => {
		const runtime = { id: "litellm", kind: "http", apiFamily: "openai-completions" };
		strictEqual(responseSchemaConflictsWithTools(runtime, 1), true);
		strictEqual(responseSchemaConflictsWithTools(runtime, 0), false);
	});
});

describe("routed deployment attribution", () => {
	const headers = new Headers({
		"x-litellm-model-group": "code",
		"x-litellm-model-name": "openai/katcoder2.5-35b-moe",
		"x-litellm-model-api-base": "http://mini.example:8080/v1",
		"x-litellm-model-id": "b258128569d177a9",
		"x-litellm-attempted-fallbacks": "0",
		"x-litellm-attempted-retries": "0",
	});

	it("reads the physical model out of the response headers", () => {
		const routed = routedDeploymentFromHeaders(headers);
		strictEqual(routed?.group, "code");
		strictEqual(routed?.model, "openai/katcoder2.5-35b-moe");
		strictEqual(routed?.apiBase, "http://mini.example:8080/v1");
		strictEqual(routed?.attemptedFallbacks, 0);
	});

	it("returns null for a target that is not behind a gateway", () => {
		strictEqual(routedDeploymentFromHeaders(new Headers()), null);
	});

	it("formats the alias, the model, and the host", () => {
		strictEqual(
			formatRoutedDeployment(routedDeploymentFromHeaders(headers) ?? {}),
			"code -> openai/katcoder2.5-35b-moe @ mini.example:8080",
		);
	});

	it("says so when the request did not reach its first choice", () => {
		const fellBack = new Headers({
			"x-litellm-model-group": "code",
			"x-litellm-model-name": "openai/qwen3.8-27b-dense",
			"x-litellm-model-api-base": "http://mini.example:8080/v1",
			"x-litellm-attempted-fallbacks": "1",
		});
		match(formatRoutedDeployment(routedDeploymentFromHeaders(fellBack) ?? {}), /\(fallback\)$/);
	});
});
