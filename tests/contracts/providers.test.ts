import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	createMemoryAuthStorage,
	resolveAuthTarget,
	targetRequiresAuth,
} from "../../src/domains/providers/auth/index.js";
import type { EndpointStatus, ProvidersContract } from "../../src/domains/providers/contract.js";
import { isTargetEligibleRuntime } from "../../src/domains/providers/eligibility.js";
import { modelCandidatesForStatus, resolveModelReference } from "../../src/domains/providers/index.js";
import { createRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { resolveRuntimeTarget } from "../../src/domains/providers/runtime-resolution.js";
import { BUILTIN_RUNTIMES } from "../../src/domains/providers/runtimes/builtins.js";
import { synthesizeOpenAICompatModel } from "../../src/domains/providers/runtimes/protocol/openai-compat.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { EndpointDescriptor } from "../../src/domains/providers/types/endpoint-descriptor.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import {
	parseWorkerSpec,
	WORKER_RUNTIME_DESCRIPTOR_VERSION,
	WORKER_SPEC_VERSION,
} from "../../src/worker/spec-contract.js";

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

	it("uses live probe capabilities for the selected LM Studio model, not only the endpoint default", () => {
		const endpoint: EndpointDescriptor = {
			id: "zbook",
			runtime: "lmstudio-native",
			defaultModel: "qwopus3.5-9b-coder",
		};
		const runtime = fakeDescriptor("lmstudio-native", {
			tier: "local-native",
			apiFamily: "lmstudio-native",
			defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow: 8192, maxTokens: 4096 },
		});
		const status: EndpointStatus = {
			endpoint,
			runtime,
			available: true,
			reason: "test",
			health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
			capabilities: { ...runtime.defaultCapabilities, contextWindow: 262144 },
			probeCapabilities: { contextWindow: 262144 },
			probeModelCapabilities: {
				"qwopus3.5-9b-coder": { contextWindow: 262144, tools: true, vision: true },
				"lfm2-24b-a2b": { contextWindow: 128000, tools: true, vision: false },
			},
			probeModelId: "qwopus3.5-9b-coder",
			discoveredModels: ["qwopus3.5-9b-coder", "lfm2-24b-a2b"],
		};
		const mockProviders: ProvidersContract = {
			list: () => [status],
			getEndpoint: (id: string) => (id === endpoint.id ? endpoint : null),
			getRuntime: (id: string) => (id === runtime.id ? runtime : null),
			getDetectedReasoning: () => null,
			knowledgeBase: null,
		} as never;

		const resolution = resolveRuntimeTarget(mockProviders, {
			endpointId: "zbook",
			wireModelId: "lfm2-24b-a2b",
			requestedThinkingLevel: "off",
		});

		ok(resolution.ok);
		if (resolution.ok) {
			strictEqual(resolution.target.capabilityDecisions.contextWindow, 128000);
			strictEqual(resolution.target.contextWindowDetails.contextWindowSource, "loaded");
			strictEqual(resolution.target.contextWindowDetails.loadedContextWindow, 128000);
			strictEqual(resolution.target.contextWindowDetails.warning, null);
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

	it("treats a live model catalog as authoritative over stale configured names", () => {
		const runtime = fakeDescriptor("llamacpp");
		const endpoint: EndpointDescriptor = {
			id: "mini",
			runtime: runtime.id,
			defaultModel: "old-default",
			wireModels: ["old-curated"],
		};
		const status: EndpointStatus = {
			endpoint,
			runtime,
			available: true,
			reason: "ready",
			health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
			capabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
			discoveredModels: ["new-live-model"],
			discoveredModelsSource: "probe",
			discoveredModelStates: { "new-live-model": { state: "loaded" } },
		};
		const providers: ProvidersContract = {
			list: () => [status],
			getEndpoint: (id: string) => (id === endpoint.id ? endpoint : null),
			getRuntime: (id: string) => (id === runtime.id ? runtime : null),
			getDetectedReasoning: () => null,
			knowledgeBase: null,
		} as never;

		deepStrictEqual(modelCandidatesForStatus(status), [{ id: "new-live-model", source: "live", loadState: "loaded" }]);
		strictEqual(resolveModelReference("old-default", providers).ref, null);
		deepStrictEqual(resolveModelReference("new-live", providers).ref, {
			endpoint: "mini",
			model: "new-live-model",
		});
	});
});

describe("contracts/providers/runtime-cleanup", () => {
	const builtinIds = new Set(BUILTIN_RUNTIMES.map((r) => r.id));

	it("does not register any Claude Code or removed CLI runtimes", () => {
		for (const removed of [
			"claude-code-sdk",
			"claude-code-cli",
			"gemini-cli",
			"copilot-cli",
			"codex-cli",
			"opencode-cli",
		]) {
			ok(!builtinIds.has(removed), `runtime '${removed}' must be absent from the builtin registry`);
		}
		// Every builtin runtime is an HTTP/native adapter; no Claude Code, agent-sdk,
		// or subprocess/CLI families or kinds survive.
		for (const runtime of BUILTIN_RUNTIMES) {
			ok(
				!/claude|agent-sdk|subprocess/.test(runtime.apiFamily),
				`runtime '${runtime.id}' must not use a removed apiFamily (${runtime.apiFamily})`,
			);
			strictEqual(runtime.kind, "http", `runtime '${runtime.id}' must be an http runtime`);
		}
	});

	it("keeps the Anthropic API runtime on the anthropic-messages family", () => {
		const anthropic = BUILTIN_RUNTIMES.find((r) => r.id === "anthropic");
		ok(anthropic, "anthropic runtime must remain registered");
		strictEqual(anthropic?.apiFamily, "anthropic-messages");
		strictEqual(anthropic?.kind, "http");
		// Protocol-compatible escape hatches stay available.
		ok(builtinIds.has("anthropic-compat"), "anthropic-compat must remain registered");
		ok(builtinIds.has("openai-compat"), "openai-compat must remain registered");
	});

	it("treats every builtin runtime as one http target-eligibility class", () => {
		for (const runtime of BUILTIN_RUNTIMES) {
			ok(isTargetEligibleRuntime(runtime), `${runtime.id} should be target-eligible`);
		}
	});

	it("rejects non-http runtime targets cleanly for orchestrator, print, and dispatch", () => {
		const runtime = { ...fakeDescriptor("legacy-subprocess"), kind: "subprocess" } as unknown as RuntimeDescriptor;
		const endpoint: EndpointDescriptor = { id: "legacy-target", runtime: "legacy-subprocess", defaultModel: "m" };
		const mockProviders: ProvidersContract = {
			list: () => [],
			getEndpoint: (id: string) => (id === "legacy-target" ? endpoint : null),
			getRuntime: (id: string) => (id === "legacy-subprocess" ? runtime : null),
			getDetectedReasoning: () => null,
			knowledgeBase: null,
		} as never;

		for (const use of ["orchestrator", "print", "dispatch"] as const) {
			const res = resolveRuntimeTarget(mockProviders, { endpointId: "legacy-target", use });
			strictEqual(res.ok, false, `${use} target must reject a non-http runtime`);
			if (!res.ok) {
				ok(res.diagnostics.some((d) => d.code === "runtime-target-unsupported"));
			}
		}
	});

	it("accepts an http runtime as a dispatch worker target", () => {
		const runtime = fakeDescriptor("http-worker", { auth: "api-key" });
		const endpoint: EndpointDescriptor = {
			id: "http-worker-target",
			runtime: "http-worker",
			defaultModel: "worker-model",
		};
		const mockProviders: ProvidersContract = {
			list: () => [],
			getEndpoint: (targetId: string) => (targetId === endpoint.id ? endpoint : null),
			getRuntime: (runtimeId: string) => (runtimeId === "http-worker" ? runtime : null),
			getDetectedReasoning: () => null,
			knowledgeBase: null,
		} as never;

		const res = resolveRuntimeTarget(mockProviders, { endpointId: endpoint.id, use: "dispatch" });
		strictEqual(res.ok, true, "http target must be dispatch-eligible");
	});

	it("rejects unsupported runtime kinds in the worker spec contract", () => {
		throws(
			() =>
				parseWorkerSpec({
					specVersion: WORKER_SPEC_VERSION,
					systemPrompt: "",
					agentId: "coder",
					task: "t",
					endpoint: { id: "target", runtime: "legacy-sdk" },
					runtime: {
						version: WORKER_RUNTIME_DESCRIPTOR_VERSION,
						id: "legacy-sdk",
						kind: "sdk",
						apiFamily: "openai-responses",
						auth: "none",
					},
					runtimeId: "legacy-sdk",
					wireModelId: "model",
					allowedTools: [],
				}),
			/one of: http/,
		);
	});

	it("has no builtin Claude Code SDK/CLI, native CLI auth, or subprocess runtime paths", () => {
		const removedPaths = [
			"src/engine/claude-code-sdk-runtime.ts",
			"src/engine/sdk-policy-bridge.ts",
			"src/engine/subprocess-runtime.ts",
			"src/cli/native-cli-auth.ts",
			"src/domains/providers/runtimes/cli-stub/claude-code-cli.ts",
			"src/domains/providers/runtimes/cli-stub/claude-code-sdk.ts",
			"src/domains/providers/runtimes/cli-stub/gemini-cli.ts",
			"src/domains/providers/runtimes/cli-stub/copilot-cli.ts",
			"src/domains/providers/runtimes/cli-stub/codex-cli.ts",
			"src/domains/providers/runtimes/cli-stub/opencode-cli.ts",
			"src/interactive/tool-approval-overlay.ts",
			"src/interactive/overlays/tool-approval-overlay.ts",
		];
		for (const rel of removedPaths) {
			ok(!existsSync(join(process.cwd(), rel)), `${rel} must stay removed`);
		}
	});

	it("keeps docs-sensitive runtime lists free of removed CLI and Claude Code support", () => {
		const docs = [
			"README.md",
			"docs/configuration-and-targets.md",
			"docs/commands-and-modes.md",
			"docs/safety-model.md",
			"docs/built-in-agents.md",
		];
		const forbidden =
			/claude-code-(?:sdk|cli)|gemini-cli|copilot-cli|codex-cli|opencode-cli|worker-only|Claude Code runtime|External CLI\/SDK|SDK-backed runtimes|native \| sdk \| cli/i;
		for (const rel of docs) {
			const text = readFileSync(join(process.cwd(), rel), "utf8");
			ok(!forbidden.test(text), `${rel} must not advertise removed runtime support`);
		}
	});
});
