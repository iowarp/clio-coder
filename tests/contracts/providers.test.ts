import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createMemoryAuthStorage,
	resolveAuthTarget,
	targetRequiresAuth,
} from "../../src/domains/providers/auth/index.js";
import type { EndpointStatus, ProvidersContract } from "../../src/domains/providers/contract.js";
import { isWorkerOnlyRuntime } from "../../src/domains/providers/eligibility.js";
import { createRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { resolveRuntimeTarget } from "../../src/domains/providers/runtime-resolution.js";
import { BUILTIN_RUNTIMES } from "../../src/domains/providers/runtimes/builtins.js";
import { synthesizeOpenAICompatModel } from "../../src/domains/providers/runtimes/protocol/openai-compat.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { EndpointDescriptor } from "../../src/domains/providers/types/endpoint-descriptor.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";

function fakeDescriptor(id: string, overrides: Partial<RuntimeDescriptor> = {}): RuntimeDescriptor {
	return {
		id,
		displayName: id,
		kind: "http",
		apiFamily: "openai-completions",
		auth: "api-key",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
		synthesizeModel: () => ({ id, provider: id }) as never,
		...overrides,
	};
}

describe("contracts/providers", () => {
	it("registers, retrieves, and lists runtime descriptors", () => {
		const registry = createRuntimeRegistry();
		const desc = fakeDescriptor("test-runtime");
		registry.register(desc);

		strictEqual(registry.get("test-runtime"), desc);
		strictEqual(registry.get("unknown"), null);
		strictEqual(registry.list().length, 1);
		strictEqual(registry.list()[0], desc);

		throws(() => registry.register(fakeDescriptor("test-runtime")), /already registered/);
	});

	it("resolves runtime targets with default capabilities", () => {
		const endpoint: EndpointDescriptor = {
			id: "my-endpoint",
			runtime: "test-runtime",
			defaultModel: "my-model",
		};
		const runtime = fakeDescriptor("test-runtime");

		const status: EndpointStatus = {
			endpoint,
			runtime,
			available: true,
			reason: "test",
			health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
			capabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
			discoveredModels: [],
		};

		const mockProviders: ProvidersContract = {
			list: () => [status],
			getEndpoint: (id: string) => (id === "my-endpoint" ? endpoint : null),
			getRuntime: (id: string) => (id === "test-runtime" ? runtime : null),
			getDetectedReasoning: () => null,
			knowledgeBase: null,
		} as never;

		const resolution = resolveRuntimeTarget(mockProviders, {
			endpointId: "my-endpoint",
			wireModelId: "my-model",
			requestedThinkingLevel: "off",
		});

		ok(resolution.ok);
		if (resolution.ok) {
			strictEqual(resolution.target.targetId, "my-endpoint");
			strictEqual(resolution.target.runtimeId, "test-runtime");
			strictEqual(resolution.target.wireModelId, "my-model");
			strictEqual(resolution.target.capabilities.chat, true);
		}
	});

	it("produces diagnostics when target is missing or runtime is not registered", () => {
		const endpoint: EndpointDescriptor = {
			id: "err-endpoint",
			runtime: "missing-runtime",
			defaultModel: "model",
		};
		const mockProviders: ProvidersContract = {
			list: () => [],
			getEndpoint: (id: string) => (id === "err-endpoint" ? endpoint : null),
			getRuntime: () => null,
		} as never;

		const res1 = resolveRuntimeTarget(mockProviders, {
			endpointId: "missing-endpoint",
		});
		strictEqual(res1.ok, false);
		if (!res1.ok) {
			ok(res1.diagnostics.some((d) => d.code === "target-not-found"));
		}

		const res2 = resolveRuntimeTarget(mockProviders, {
			endpointId: "err-endpoint",
		});
		strictEqual(res2.ok, false);
		if (!res2.ok) {
			ok(res2.diagnostics.some((d) => d.code === "runtime-not-registered"));
		}
	});

	it("evaluates auth status and fallback criteria", () => {
		const endpoint: EndpointDescriptor = {
			id: "custom-auth",
			runtime: "openai",
			auth: { apiKeyEnvVar: "CUSTOM_KEY" },
		};
		const runtime = fakeDescriptor("openai", { credentialsEnvVar: "OPENAI_API_KEY" });

		// targetRequiresAuth checks
		strictEqual(targetRequiresAuth(endpoint, runtime), true);

		// resolveAuthTarget mappings
		const authTarget = resolveAuthTarget(endpoint, runtime);
		strictEqual(authTarget.providerId, "openai");
		strictEqual(authTarget.explicitEnvVar, "CUSTOM_KEY");

		// AuthStorage memory backend and stored credential lookup
		const storage = createMemoryAuthStorage({
			openai: { type: "api_key", key: "secret-key", updatedAt: new Date().toISOString() },
		});
		const stored = storage.get("openai");
		ok(stored);
		strictEqual(stored.type, "api_key");
		strictEqual(stored.key, "secret-key");
	});

	it("synthesizes local/openai-compatible provider request shapes correctly", () => {
		const endpoint: EndpointDescriptor = {
			id: "local-endpoint",
			runtime: "openai-compat",
			url: "http://localhost:1234/v1/",
			pricing: { input: 0.15, output: 0.6, cacheRead: 0.05, cacheWrite: 0.1 },
			auth: { headers: { "X-Test": "Clio" } },
		};

		const model = synthesizeOpenAICompatModel({
			endpoint,
			wireModelId: "qwen-2.5",
			kb: null,
			defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, reasoning: true },
			provider: "openai-compat",
		});

		strictEqual(model.id, "qwen-2.5");
		strictEqual(model.api, "openai-completions");
		strictEqual(model.baseUrl, "http://localhost:1234/v1/v1");
		strictEqual(model.reasoning, true);
		deepStrictEqual(model.headers, { "X-Test": "Clio" });
		strictEqual(model.cost.input, 0.15);
		strictEqual(model.cost.output, 0.6);
		ok(model.compat);
	});
});

describe("contracts/providers/runtime-cleanup", () => {
	const builtinIds = new Set(BUILTIN_RUNTIMES.map((r) => r.id));

	it("does not register any Claude Code or removed CLI runtimes", () => {
		for (const removed of ["claude-code-sdk", "claude-code-cli", "gemini-cli", "copilot-cli"]) {
			ok(!builtinIds.has(removed), `runtime '${removed}' must be absent from the builtin registry`);
		}
		// No descriptor may advertise a Claude Code / agent-sdk API family.
		for (const runtime of BUILTIN_RUNTIMES) {
			ok(
				!/claude|agent-sdk/.test(runtime.apiFamily),
				`runtime '${runtime.id}' must not use a Claude Code apiFamily (${runtime.apiFamily})`,
			);
			ok(runtime.kind !== "sdk", `no builtin runtime should use the sdk kind (${runtime.id})`);
		}
	});

	it("keeps the Anthropic API runtime on the anthropic-messages family", () => {
		const anthropic = BUILTIN_RUNTIMES.find((r) => r.id === "anthropic");
		ok(anthropic, "anthropic runtime must remain registered");
		strictEqual(anthropic?.apiFamily, "anthropic-messages");
		strictEqual(anthropic?.kind, "http");
		// Protocol-compatible escape hatch stays available.
		ok(builtinIds.has("anthropic-compat"), "anthropic-compat must remain registered");
	});

	it("limits worker-only (subprocess) runtimes to codex-cli and opencode-cli", () => {
		const workerOnly = BUILTIN_RUNTIMES.filter((r) => isWorkerOnlyRuntime(r))
			.map((r) => r.id)
			.sort();
		deepStrictEqual(workerOnly, ["codex-cli", "opencode-cli"]);
	});

	it("rejects worker-only runtimes as orchestrator and print targets", () => {
		const runtime = fakeDescriptor("codex-cli", { kind: "subprocess", apiFamily: "subprocess-codex" });
		const endpoint: EndpointDescriptor = { id: "codex-worker", runtime: "codex-cli", defaultModel: "gpt-5.4" };
		const mockProviders: ProvidersContract = {
			list: () => [],
			getEndpoint: (id: string) => (id === "codex-worker" ? endpoint : null),
			getRuntime: (id: string) => (id === "codex-cli" ? runtime : null),
			getDetectedReasoning: () => null,
			knowledgeBase: null,
		} as never;

		for (const use of ["orchestrator", "print"] as const) {
			const res = resolveRuntimeTarget(mockProviders, { endpointId: "codex-worker", use });
			strictEqual(res.ok, false, `${use} target must reject a worker-only runtime`);
			if (!res.ok) {
				ok(res.diagnostics.some((d) => d.code === "worker-only-target-unsupported"));
			}
		}
	});
});
