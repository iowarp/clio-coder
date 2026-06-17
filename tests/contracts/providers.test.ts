import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	createMemoryAuthStorage,
	resolveAuthTarget,
	resolveRuntimeAuthTarget,
	targetRequiresAuth,
} from "../../src/domains/providers/auth/index.js";
import type { ProvidersContract, TargetStatus } from "../../src/domains/providers/contract.js";
import { isOrchestratorEligibleRuntime, isTargetEligibleRuntime } from "../../src/domains/providers/eligibility.js";
import {
	buildProviderSupportEntry,
	canonicalizeWireModelId,
	modelCandidatesForStatus,
	resolveModelReference,
} from "../../src/domains/providers/index.js";
import { createRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { resolveRuntimeTarget } from "../../src/domains/providers/runtime-resolution.js";
import { BUILTIN_RUNTIMES } from "../../src/domains/providers/runtimes/builtins.js";
import { synthesizeOpenAICompatModel } from "../../src/domains/providers/runtimes/protocol/openai-compat.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";
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

function fakeLiveStatus(discoveredModels: ReadonlyArray<string>, overrides: Partial<TargetStatus> = {}): TargetStatus {
	const runtime = fakeDescriptor("llamacpp");
	const target: TargetDescriptor = {
		id: "mini",
		runtime: runtime.id,
		defaultModel: "AgenticQwen-30B-A3B-i1-Q4_K_M",
		wireModels: ["AgenticQwen-30B-A3B-i1-Q4_K_M"],
	};
	return {
		target,
		runtime,
		available: true,
		reason: "test",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
		capabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
		discoveredModels,
		discoveredModelsSource: "probe",
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
		const target: TargetDescriptor = {
			id: "my-target",
			runtime: "test-runtime",
			defaultModel: "my-model",
		};
		const runtime = fakeDescriptor("test-runtime");

		const status: TargetStatus = {
			target,
			runtime,
			available: true,
			reason: "test",
			health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
			capabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
			discoveredModels: [],
		};

		const mockProviders: ProvidersContract = {
			list: () => [status],
			getTarget: (id: string) => (id === "my-target" ? target : null),
			getRuntime: (id: string) => (id === "test-runtime" ? runtime : null),
			getDetectedReasoning: () => null,
			knowledgeBase: null,
		} as never;

		const resolution = resolveRuntimeTarget(mockProviders, {
			targetId: "my-target",
			wireModelId: "my-model",
			requestedThinkingLevel: "off",
		});

		ok(resolution.ok);
		if (resolution.ok) {
			strictEqual(resolution.target.targetId, "my-target");
			strictEqual(resolution.target.runtimeId, "test-runtime");
			strictEqual(resolution.target.wireModelId, "my-model");
			strictEqual(resolution.target.capabilities.chat, true);
		}
	});

	it("uses live probe capabilities for the selected LM Studio model, not only the target default", () => {
		const target: TargetDescriptor = {
			id: "zbook",
			runtime: "lmstudio-native",
			defaultModel: "qwopus3.5-9b-coder",
		};
		const runtime = fakeDescriptor("lmstudio-native", {
			tier: "local-native",
			apiFamily: "lmstudio-native",
			defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow: 8192, maxTokens: 4096 },
		});
		const status: TargetStatus = {
			target,
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
			getTarget: (id: string) => (id === target.id ? target : null),
			getRuntime: (id: string) => (id === runtime.id ? runtime : null),
			getDetectedReasoning: () => null,
			knowledgeBase: null,
		} as never;

		const resolution = resolveRuntimeTarget(mockProviders, {
			targetId: "zbook",
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

	it("canonicalizes wire model ids by preserving exact live catalog matches", () => {
		const status = fakeLiveStatus(["llama-3.1"]);

		strictEqual(canonicalizeWireModelId(status, "llama-3.1"), "llama-3.1");
	});

	it("canonicalizes wire model ids through one unique separator prefix alias", () => {
		const requested = "AgenticQwen-30B-A3B-i1-Q4_K_M";
		const canonical = "AgenticQwen-30B-A3B-i1-Q4_K_M-262K";
		const status = fakeLiveStatus([canonical]);

		strictEqual(canonicalizeWireModelId(status, requested), canonical);
	});

	it("leaves ambiguous wire model prefix aliases unchanged", () => {
		const requested = "AgenticQwen-30B-A3B-i1-Q4_K_M";
		const status = fakeLiveStatus(["AgenticQwen-30B-A3B-i1-Q4_K_M-262K", "AgenticQwen-30B-A3B-i1-Q4_K_M-131K"]);

		strictEqual(canonicalizeWireModelId(status, requested), requested);
	});

	it("leaves wire model ids unchanged when no live catalog exists", () => {
		const requested = "AgenticQwen-30B-A3B-i1-Q4_K_M";
		const status = fakeLiveStatus([], {
			discoveredModelsSource: "none",
			target: {
				id: "mini",
				runtime: "llamacpp",
			},
		});

		strictEqual(canonicalizeWireModelId(status, requested), requested);
	});

	it("canonicalizes wire model ids through a configured wire-model catalog", () => {
		const requested = "AgenticQwen-30B-A3B-i1-Q4_K_M";
		const canonical = "AgenticQwen-30B-A3B-i1-Q4_K_M-262K";
		const status = fakeLiveStatus([], {
			discoveredModelsSource: "none",
			target: {
				id: "mini",
				runtime: "llamacpp",
				defaultModel: requested,
				wireModels: [canonical],
			},
		});

		strictEqual(canonicalizeWireModelId(status, requested), canonical);
	});

	it("canonicalizes wire model ids by unique case-insensitive equality", () => {
		const status = fakeLiveStatus(["LLaMA-3.1"]);

		strictEqual(canonicalizeWireModelId(status, "llama-3.1"), "LLaMA-3.1");
	});

	it("produces diagnostics when target is missing or runtime is not registered", () => {
		const target: TargetDescriptor = {
			id: "err-target",
			runtime: "missing-runtime",
			defaultModel: "model",
		};
		const mockProviders: ProvidersContract = {
			list: () => [],
			getTarget: (id: string) => (id === "err-target" ? target : null),
			getRuntime: () => null,
		} as never;

		const res1 = resolveRuntimeTarget(mockProviders, {
			targetId: "missing-target",
		});
		strictEqual(res1.ok, false);
		if (!res1.ok) {
			ok(res1.diagnostics.some((d) => d.code === "target-not-found"));
		}

		const res2 = resolveRuntimeTarget(mockProviders, {
			targetId: "err-target",
		});
		strictEqual(res2.ok, false);
		if (!res2.ok) {
			ok(res2.diagnostics.some((d) => d.code === "runtime-not-registered"));
		}
	});

	it("evaluates auth status and fallback criteria", () => {
		const target: TargetDescriptor = {
			id: "custom-auth",
			runtime: "openai",
			auth: { apiKeyEnvVar: "CUSTOM_KEY" },
		};
		const runtime = fakeDescriptor("openai", { credentialsEnvVar: "OPENAI_API_KEY" });

		// targetRequiresAuth checks
		strictEqual(targetRequiresAuth(target, runtime), true);

		// resolveAuthTarget mappings
		const authTarget = resolveAuthTarget(target, runtime);
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
		const target: TargetDescriptor = {
			id: "local-target",
			runtime: "openai-compat",
			url: "http://localhost:1234/v1/",
			pricing: { input: 0.15, output: 0.6, cacheRead: 0.05, cacheWrite: 0.1 },
			auth: { headers: { "X-Test": "Clio" } },
		};

		const model = synthesizeOpenAICompatModel({
			target,
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

	it("keeps configured and default model candidates until a live catalog exists", () => {
		const runtime = fakeDescriptor("llamacpp");
		const target: TargetDescriptor = {
			id: "mini",
			runtime: runtime.id,
			defaultModel: "old-default",
			wireModels: ["old-curated"],
		};
		const status: TargetStatus = {
			target,
			runtime,
			available: true,
			reason: "ready",
			health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: null },
			capabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
			discoveredModels: [],
			discoveredModelsSource: "none",
		};
		const providers: ProvidersContract = {
			list: () => [status],
			getTarget: (id: string) => (id === target.id ? target : null),
			getRuntime: (id: string) => (id === runtime.id ? runtime : null),
			getDetectedReasoning: () => null,
			knowledgeBase: null,
		} as never;

		deepStrictEqual(modelCandidatesForStatus(status), [
			{ id: "old-curated", source: "configured" },
			{ id: "old-default", source: "default" },
		]);
		deepStrictEqual(resolveModelReference("old-default", providers).ref, {
			target: "mini",
			model: "old-default",
		});
	});

	it("treats a returned live catalog as authoritative for model selection and resolution", () => {
		const runtime = fakeDescriptor("llamacpp");
		const target: TargetDescriptor = {
			id: "mini",
			runtime: runtime.id,
			defaultModel: "old-default",
			wireModels: ["old-curated"],
		};
		const status: TargetStatus = {
			target,
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
			getTarget: (id: string) => (id === target.id ? target : null),
			getRuntime: (id: string) => (id === runtime.id ? runtime : null),
			getDetectedReasoning: () => null,
			knowledgeBase: null,
		} as never;

		deepStrictEqual(modelCandidatesForStatus(status), [{ id: "new-live-model", source: "live", loadState: "loaded" }]);
		strictEqual(resolveModelReference("old-default", providers).ref, null);
		strictEqual(resolveModelReference("old-curated", providers).ref, null);
		deepStrictEqual(resolveModelReference("new-live", providers).ref, {
			target: "mini",
			model: "new-live-model",
		});
	});
});

describe("contracts/providers/runtime-cleanup", () => {
	const builtinIds = new Set(BUILTIN_RUNTIMES.map((r) => r.id));

	it("registers only the sanctioned Claude Code runtimes and no removed CLI runtimes", () => {
		for (const removed of [
			"claude-code-cli",
			"claude-code-sdk",
			"gemini-cli",
			"copilot-cli",
			"codex-cli",
			"opencode-cli",
		]) {
			ok(!builtinIds.has(removed), `runtime '${removed}' must be absent from the builtin registry`);
		}
		const sdk = BUILTIN_RUNTIMES.find((runtime) => runtime.id === "claude-sdk");
		const code = BUILTIN_RUNTIMES.find((runtime) => runtime.id === "claude-code");
		ok(sdk, "claude-sdk runtime must be registered");
		ok(code, "claude-code runtime must be registered");
		strictEqual(sdk?.kind, "sdk");
		strictEqual(sdk?.apiFamily, "claude-agent-sdk");
		strictEqual(sdk?.auth, "claude-cli");
		strictEqual(sdk?.tier, "subscription");
		strictEqual(code?.kind, "subprocess");
		strictEqual(code?.apiFamily, "claude-code-subprocess");
		strictEqual(code?.auth, "claude-cli");
		strictEqual(code?.tier, "subscription");
		const antigravity = BUILTIN_RUNTIMES.find((runtime) => runtime.id === "antigravity-code");
		ok(antigravity, "antigravity-code runtime must be registered");
		strictEqual(antigravity?.kind, "subprocess");
		strictEqual(antigravity?.apiFamily, "google-generative-ai");
		strictEqual(antigravity?.auth, "none");
		strictEqual(antigravity?.tier, "subscription");
		strictEqual(antigravity?.binaryName, "agy");
		const sanctionedWorkerIds = new Set(["claude-sdk", "claude-code", "antigravity-code"]);
		for (const runtime of BUILTIN_RUNTIMES) {
			if (sanctionedWorkerIds.has(runtime.id)) continue;
			ok(!/agent-sdk|subprocess/.test(runtime.apiFamily), `runtime '${runtime.id}' must not use removed apiFamily`);
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

	it("treats builtins as either http orchestrator targets or sanctioned worker-only targets", () => {
		const workerOnlyIds = new Set(["claude-sdk", "claude-code", "antigravity-code"]);
		for (const runtime of BUILTIN_RUNTIMES) {
			ok(isTargetEligibleRuntime(runtime), `${runtime.id} should be target-eligible`);
			if (workerOnlyIds.has(runtime.id)) {
				strictEqual(isOrchestratorEligibleRuntime(runtime), false, `${runtime.id} must be worker-only`);
			} else {
				strictEqual(isOrchestratorEligibleRuntime(runtime), true, `${runtime.id} must remain orchestrator-eligible`);
			}
		}
	});

	it("rejects unknown non-http runtime targets cleanly for orchestrator, print, and dispatch", () => {
		const runtime = { ...fakeDescriptor("legacy-native-cli"), kind: "native-cli" } as unknown as RuntimeDescriptor;
		const target: TargetDescriptor = { id: "legacy-target", runtime: "legacy-native-cli", defaultModel: "m" };
		const mockProviders: ProvidersContract = {
			list: () => [],
			getTarget: (id: string) => (id === "legacy-target" ? target : null),
			getRuntime: (id: string) => (id === "legacy-native-cli" ? runtime : null),
			getDetectedReasoning: () => null,
			knowledgeBase: null,
		} as never;

		for (const use of ["orchestrator", "print", "dispatch"] as const) {
			const res = resolveRuntimeTarget(mockProviders, { targetId: "legacy-target", use });
			strictEqual(res.ok, false, `${use} target must reject a non-http runtime`);
			if (!res.ok) {
				ok(res.diagnostics.some((d) => d.code === "runtime-target-unsupported"));
			}
		}
	});

	it("accepts sanctioned Claude runtimes for dispatch and rejects them for orchestrator/print", () => {
		const runtime = BUILTIN_RUNTIMES.find((r) => r.id === "claude-sdk");
		ok(runtime);
		if (!runtime) return;
		const target: TargetDescriptor = { id: "claude-worker", runtime: "claude-sdk", defaultModel: "sonnet" };
		const mockProviders: ProvidersContract = {
			list: () => [],
			getTarget: (targetId: string) => (targetId === target.id ? target : null),
			getRuntime: (runtimeId: string) => (runtimeId === "claude-sdk" ? runtime : null),
			getDetectedReasoning: () => null,
			knowledgeBase: null,
		} as never;

		const dispatch = resolveRuntimeTarget(mockProviders, { targetId: target.id, use: "dispatch" });
		strictEqual(dispatch.ok, true, "claude-sdk target must be dispatch-eligible");
		for (const use of ["orchestrator", "print"] as const) {
			const res = resolveRuntimeTarget(mockProviders, { targetId: target.id, use });
			strictEqual(res.ok, false, `${use} must reject worker-only Claude runtime`);
			if (!res.ok) ok(res.diagnostics.some((diag) => diag.code === "runtime-use-unsupported"));
		}
	});

	it("accepts an http runtime as a dispatch worker target", () => {
		const runtime = fakeDescriptor("http-worker", { auth: "api-key" });
		const target: TargetDescriptor = {
			id: "http-worker-target",
			runtime: "http-worker",
			defaultModel: "worker-model",
		};
		const mockProviders: ProvidersContract = {
			list: () => [],
			getTarget: (targetId: string) => (targetId === target.id ? target : null),
			getRuntime: (runtimeId: string) => (runtimeId === "http-worker" ? runtime : null),
			getDetectedReasoning: () => null,
			knowledgeBase: null,
		} as never;

		const res = resolveRuntimeTarget(mockProviders, { targetId: target.id, use: "dispatch" });
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
					target: { id: "target", runtime: "legacy-sdk" },
					runtime: {
						version: WORKER_RUNTIME_DESCRIPTOR_VERSION,
						id: "legacy-cli",
						kind: "native-cli",
						apiFamily: "openai-responses",
						auth: "none",
					},
					runtimeId: "legacy-cli",
					wireModelId: "model",
					allowedTools: [],
				}),
			/one of: http, sdk, subprocess/,
		);
	});

	it("accepts sanctioned Claude runtime descriptors in the worker spec contract", () => {
		for (const runtime of [
			{ id: "claude-sdk", kind: "sdk", apiFamily: "claude-agent-sdk" },
			{ id: "claude-code", kind: "subprocess", apiFamily: "claude-code-subprocess" },
		] as const) {
			const parsed = parseWorkerSpec({
				specVersion: WORKER_SPEC_VERSION,
				systemPrompt: "",
				agentId: "coder",
				task: "t",
				target: { id: `${runtime.id}-target`, runtime: runtime.id },
				runtime: {
					version: WORKER_RUNTIME_DESCRIPTOR_VERSION,
					id: runtime.id,
					kind: runtime.kind,
					apiFamily: runtime.apiFamily,
					auth: "claude-cli",
				},
				runtimeId: runtime.id,
				wireModelId: "sonnet",
				allowedTools: [],
			});
			strictEqual(parsed.runtime.kind, runtime.kind);
			strictEqual(parsed.runtime.apiFamily, runtime.apiFamily);
			strictEqual(parsed.runtime.auth, "claude-cli");
		}
	});

	it("keeps removed legacy Claude Code SDK/CLI, native CLI auth, and generic subprocess paths absent", () => {
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

	it("registers the Claude Pro/Max subscription runtime alongside the api-key Anthropic runtime", () => {
		const apiKey = BUILTIN_RUNTIMES.find((r) => r.id === "anthropic");
		const sub = BUILTIN_RUNTIMES.find((r) => r.id === "anthropic-max");
		ok(apiKey, "api-key anthropic runtime must remain registered");
		ok(sub, "subscription anthropic-max runtime must be registered");

		// The api-key path is untouched.
		strictEqual(apiKey?.auth, "api-key");
		strictEqual(apiKey?.credentialsEnvVar, "ANTHROPIC_API_KEY");

		// The subscription runtime mirrors openai-codex: an oauth anthropic-messages
		// http runtime, bridged to the pi-ai "anthropic" OAuth provider.
		strictEqual(sub?.auth, "oauth");
		strictEqual(sub?.kind, "http");
		strictEqual(sub?.tier, "cloud");
		strictEqual(sub?.apiFamily, "anthropic-messages");
		strictEqual(sub?.oauthProviderId, "anthropic");
		ok(sub?.authNotice && sub.authNotice.length > 0, "subscription runtime must carry a usage-terms notice");
	});

	it("routes subscription auth to the pi-ai anthropic provider without colliding with the api-key runtime", () => {
		const sub = BUILTIN_RUNTIMES.find((r) => r.id === "anthropic-max");
		const apiKey = BUILTIN_RUNTIMES.find((r) => r.id === "anthropic");
		ok(sub && apiKey);
		if (!sub || !apiKey) return;

		// Runtime-only login/status (e.g. `clio auth login anthropic-max`) keys on "anthropic".
		strictEqual(resolveRuntimeAuthTarget(sub).providerId, "anthropic");
		// The api-key runtime still keys on its own id.
		strictEqual(resolveRuntimeAuthTarget(apiKey).providerId, "anthropic");

		// A configured subscription target carries oauthProfile "anthropic".
		const withProfile: TargetDescriptor = {
			id: "claude-sub",
			runtime: "anthropic-max",
			auth: { oauthProfile: "anthropic" },
		};
		strictEqual(resolveAuthTarget(withProfile, sub).providerId, "anthropic");

		// Even a target missing the oauthProfile block falls back through oauthProviderId.
		const bare: TargetDescriptor = { id: "claude-sub-bare", runtime: "anthropic-max" };
		strictEqual(resolveAuthTarget(bare, sub).providerId, "anthropic");
	});

	it("surfaces the subscription runtime as a connectable subscription provider and an eligible target", () => {
		const sub = BUILTIN_RUNTIMES.find((r) => r.id === "anthropic-max");
		ok(sub);
		if (!sub) return;
		const entry = buildProviderSupportEntry(sub);
		strictEqual(entry.group, "subscription");
		strictEqual(entry.connectable, true);
		ok(isTargetEligibleRuntime(sub), "subscription runtime must be orchestrator/worker eligible");
	});

	it("surfaces Claude Code runtimes as non-connectable subscription worker targets", () => {
		for (const id of ["claude-sdk", "claude-code"]) {
			const runtime = BUILTIN_RUNTIMES.find((r) => r.id === id);
			ok(runtime, `${id} runtime must be registered`);
			if (!runtime) continue;
			const entry = buildProviderSupportEntry(runtime);
			strictEqual(entry.group, "subscription");
			strictEqual(entry.connectable, false);
			ok(isTargetEligibleRuntime(runtime), `${id} must be target-eligible`);
			strictEqual(isOrchestratorEligibleRuntime(runtime), false, `${id} must be worker-only`);
			strictEqual(targetRequiresAuth({ id: `${id}-target`, runtime: id }, runtime), false);
			strictEqual(resolveRuntimeAuthTarget(runtime).providerId, id);
		}
	});

	it("keeps docs-sensitive runtime lists free of removed CLI support", () => {
		const docs = [
			"README.md",
			"docs/configuration-and-targets.md",
			"docs/commands-and-modes.md",
			"docs/safety-model.md",
			"docs/built-in-agents.md",
		];
		const forbidden = /claude-code-(?:sdk|cli)|gemini-cli|copilot-cli|codex-cli|opencode-cli|native \| sdk \| cli/i;
		for (const rel of docs) {
			const text = readFileSync(join(process.cwd(), rel), "utf8");
			ok(!forbidden.test(text), `${rel} must not advertise removed runtime support`);
		}
	});
});
