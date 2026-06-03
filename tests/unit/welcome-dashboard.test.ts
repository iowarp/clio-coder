import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ModesContract } from "../../src/domains/modes/index.js";
import type { ObservabilityContract } from "../../src/domains/observability/index.js";
import type { EndpointStatus, ProvidersContract } from "../../src/domains/providers/index.js";
import type { RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { WorkspaceSnapshot } from "../../src/domains/session/workspace/index.js";
import { visibleWidth } from "../../src/engine/tui.js";
import {
	__welcomeDashboardTest,
	buildWelcomeDashboardLines,
	deriveWelcomeDashboardStats,
	WelcomeDashboard,
	type WelcomeDashboardDeps,
	type WelcomeDashboardStats,
} from "../../src/interactive/welcome-dashboard.js";

function status(args: { id: string; runtimeId: string; model: string; available?: boolean }): EndpointStatus {
	const endpoint: EndpointStatus["endpoint"] = {
		id: args.id,
		runtime: args.runtimeId,
		defaultModel: args.model,
	};
	if (args.runtimeId === "openai-compat") endpoint.url = "http://127.0.0.1:8080";
	const runtime: RuntimeDescriptor = {
		id: args.runtimeId,
		displayName: args.runtimeId,
		kind: args.runtimeId === "codex-cli" ? "subprocess" : "http",
		tier: args.runtimeId === "openai-compat" ? "protocol" : args.runtimeId === "codex-cli" ? "cli" : "cloud",
		apiFamily: "openai-responses",
		auth: "none",
		knownModels: [args.model],
		defaultCapabilities: {
			chat: true,
			tools: true,
			reasoning: true,
			vision: false,
			audio: false,
			embeddings: false,
			rerank: false,
			fim: false,
			contextWindow: 262_144,
			maxTokens: 8192,
		},
		synthesizeModel: () => {
			throw new Error("not used");
		},
	};
	return {
		endpoint,
		runtime,
		available: args.available ?? true,
		reason: args.available === false ? "down" : "ready",
		health: { status: args.available === false ? "down" : "healthy", lastCheckAt: null, lastError: null, latencyMs: 120 },
		capabilities: runtime.defaultCapabilities,
		discoveredModels: [],
	} as EndpointStatus;
}

function harmonyStatus(): EndpointStatus {
	const row = status({ id: "dynamo", runtimeId: "llamacpp", model: "openai/gpt-oss-20b" });
	return {
		...row,
		capabilities: {
			...row.capabilities,
			thinkingFormat: "harmony",
		},
	};
}

function cascadeStatus(): EndpointStatus {
	const row = status({ id: "dynamo", runtimeId: "lmstudio-native", model: "nemotron-cascade-2-30b-a3b-i1" });
	return {
		...row,
		capabilities: {
			...row.capabilities,
			thinkingFormat: "qwen-chat-template",
		},
	};
}

function qwenSelectedStatus(): EndpointStatus {
	const row = status({ id: "dynamo", runtimeId: "lmstudio-native", model: "nemotron-cascade-2-30b-a3b-i1" });
	return {
		...row,
		endpoint: {
			...row.endpoint,
			wireModels: ["nemotron-cascade-2-30b-a3b-i1", "qwen3.6-27b"],
		},
		capabilities: {
			...row.capabilities,
			contextWindow: 1_048_576,
			maxTokens: 65_536,
		},
	};
}

const cascadeKnowledgeBase = {
	lookup: () => ({
		matchKind: "alias",
		entry: {
			family: "nemotron-cascade-2-30b-a3b",
			matchPatterns: ["nemotron-cascade-2"],
			capabilities: { thinkingFormat: "qwen-chat-template" },
			quirks: { thinking: { mechanism: "on-off" } },
		},
	}),
	entries: () => [],
} as ProvidersContract["knowledgeBase"];

const qwenKnowledgeBase = {
	lookup: (modelId: string) =>
		modelId === "qwen3.6-27b"
			? {
					matchKind: "alias",
					entry: {
						family: "qwen3.6-27b",
						matchPatterns: ["qwen3.6-27b"],
						capabilities: { contextWindow: 262_144, maxTokens: 32_768, tools: true, reasoning: true },
					},
				}
			: null,
	entries: () => [],
} as ProvidersContract["knowledgeBase"];

function workspace(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
	return {
		cwd: "/repo",
		isGit: true,
		branch: "main",
		dirty: false,
		ahead: 0,
		behind: 0,
		recentCommits: [{ sha: "abc1234", subject: "x" }],
		remoteUrl: "https://github.com/akougkas/clio-coder",
		projectType: "typescript",
		capturedAt: "2026-04-30T00:00:00Z",
		...overrides,
	};
}

function deps(
	options: { statuses?: EndpointStatus[]; workspace?: WorkspaceSnapshot | null } = {},
): WelcomeDashboardDeps {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.orchestrator.endpoint = "mini";
	settings.orchestrator.model = "qwen";
	settings.workers.default.endpoint = "mini";
	settings.workers.profiles.reviewer = { endpoint: "codex", model: "gpt", thinkingLevel: "off" };
	const statuses = options.statuses ?? [
		status({ id: "mini", runtimeId: "openai-compat", model: "qwen" }),
		status({ id: "cloud", runtimeId: "openai", model: "gpt" }),
		status({ id: "codex", runtimeId: "codex-cli", model: "gpt" }),
	];
	return {
		modes: { current: () => "default" } as ModesContract,
		providers: { list: () => statuses, knowledgeBase: null } as unknown as ProvidersContract,
		observability: {} as ObservabilityContract,
		getSettings: () => settings,
		...(options.workspace !== undefined ? { getWorkspaceSnapshot: () => options.workspace ?? null } : {}),
	};
}

describe("interactive/welcome-dashboard", () => {
	it("derives the static banner stats from provider/settings/workspace state", () => {
		const stats = deriveWelcomeDashboardStats(deps({ workspace: workspace() }));
		strictEqual(stats.activeTargets, 3);
		strictEqual(stats.totalTargets, 3);
		strictEqual(stats.targetLabel, "mini");
		strictEqual(stats.modelLabel, "qwen");
		strictEqual(stats.currentAvailable, true);
		strictEqual(stats.workspace?.branch, "main");
		ok(stats.activeCapabilities.includes("tools"), stats.activeCapabilities.join(", "));
		ok(stats.activeCapabilities.includes("reasoning"), stats.activeCapabilities.join(", "));
		ok(stats.activeCapabilities.includes("262k ctx"), stats.activeCapabilities.join(", "));
	});

	it("shows the effective thinking semantics for reasoning runtimes", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.orchestrator.endpoint = "dynamo";
		settings.orchestrator.model = "openai/gpt-oss-20b";
		settings.orchestrator.thinkingLevel = "off";
		strictEqual(
			deriveWelcomeDashboardStats({
				...deps(),
				providers: { list: () => [harmonyStatus()], knowledgeBase: null } as unknown as ProvidersContract,
				getSettings: () => settings,
			}).thinkingLevel,
			"low",
		);

		settings.orchestrator.model = "nemotron-cascade-2-30b-a3b-i1";
		settings.orchestrator.thinkingLevel = "high";
		strictEqual(
			deriveWelcomeDashboardStats({
				...deps(),
				providers: { list: () => [cascadeStatus()], knowledgeBase: cascadeKnowledgeBase } as unknown as ProvidersContract,
				getSettings: () => settings,
			}).thinkingLevel,
			"on",
		);
	});

	it("shows selected model capabilities instead of endpoint-default capabilities", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.orchestrator.endpoint = "dynamo";
		settings.orchestrator.model = "qwen3.6-27b";
		const stats = deriveWelcomeDashboardStats({
			...deps(),
			providers: {
				list: () => [qwenSelectedStatus()],
				knowledgeBase: qwenKnowledgeBase,
				getDetectedReasoning: () => null,
			} as unknown as ProvidersContract,
			getSettings: () => settings,
		});

		ok(stats.activeCapabilities.includes("262k ctx"), stats.activeCapabilities.join(", "));
		ok(!stats.activeCapabilities.includes("1049k ctx"), stats.activeCapabilities.join(", "));
	});

	it("renders the locked three-line welcome banner safely", () => {
		const stats: WelcomeDashboardStats = {
			activeTargets: 2,
			totalTargets: 3,
			targetLabel: "mini",
			modelLabel: "Qwen3.6-35B-A3B-MTP-UD-Q4_K_XL",
			thinkingLevel: "high",
			workspace: workspace(),
			currentAvailable: true,
			activeCapabilities: ["tools", "reasoning", "262k ctx"],
		};
		const lines = buildWelcomeDashboardLines(stats, 72);
		const text = __welcomeDashboardTest.stripAnsi(lines.join("\n"));

		strictEqual(lines.length, 3);
		ok(text.includes("Clio Coder"), text);
		ok(text.includes("mini · Qwen3.6-35B · think high · 262k ctx"), text);
		ok(text.includes("/repo · git main ✓ · 2/3 targets online"), text);
		ok(!text.includes("Qwen3.6-35B-A3B-MTP-UD-Q4_K_XL"), text);
		for (const forbidden of ["familiarity", "confidence", "Infrastructure", "Context usage"]) {
			ok(!text.includes(forbidden), text);
		}
		for (const line of lines) {
			ok(visibleWidth(line) <= 72, `line too wide: ${visibleWidth(line)} ${line}`);
		}
	});

	it("snapshots stats at construction so later dependency changes do not rewrite scrollback", () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.orchestrator.endpoint = "mini";
		settings.orchestrator.model = "model-one";
		const statuses = [status({ id: "mini", runtimeId: "openai-compat", model: "model-one" })];
		const dashboard = new WelcomeDashboard({
			...deps(),
			providers: { list: () => statuses, knowledgeBase: null } as unknown as ProvidersContract,
			getSettings: () => settings,
			getWorkspaceSnapshot: () => workspace(),
		});

		const first = dashboard.render(96);
		settings.orchestrator.endpoint = "changed";
		settings.orchestrator.model = "model-two";
		statuses.splice(0, statuses.length, status({ id: "changed", runtimeId: "openai-compat", model: "model-two" }));
		deepStrictEqual(dashboard.render(96), first);
	});
});
