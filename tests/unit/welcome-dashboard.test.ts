import { ok, strictEqual } from "node:assert/strict";
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
	type WelcomeDashboardDeps,
} from "../../src/interactive/welcome-dashboard.js";

function status(args: { id: string; runtimeId: string; model: string }): EndpointStatus {
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
			contextWindow: 1000,
			maxTokens: 1000,
		},
		synthesizeModel: () => {
			throw new Error("not used");
		},
	};
	return {
		endpoint,
		runtime,
		available: true,
		reason: "ready",
		health: { status: "healthy", lastCheckAt: null, lastError: null, latencyMs: 120 },
		capabilities: {
			chat: true,
			tools: true,
			reasoning: true,
			vision: false,
			audio: false,
			embeddings: false,
			rerank: false,
			fim: false,
			contextWindow: 1000,
			maxTokens: 1000,
		},
		discoveredModels: [],
	} as EndpointStatus;
}

function deps(
	options: { selfDev?: boolean; contextTokens?: number | null; workspace?: WorkspaceSnapshot | null } = {},
): WelcomeDashboardDeps {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.orchestrator.endpoint = "mini";
	settings.orchestrator.model = "qwen";
	settings.workers.default.endpoint = "mini";
	settings.workers.profiles.reviewer = { endpoint: "codex", model: "gpt", thinkingLevel: "off" };
	const statuses = [
		status({ id: "mini", runtimeId: "openai-compat", model: "qwen" }),
		status({ id: "cloud", runtimeId: "openai", model: "gpt" }),
		status({ id: "codex", runtimeId: "codex-cli", model: "gpt" }),
	];
	return {
		modes: { current: () => "default" } as ModesContract,
		providers: { list: () => statuses, knowledgeBase: null } as unknown as ProvidersContract,
		observability: {
			sessionTokens: () => ({ input: 200, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 250 }),
			metrics: () => ({
				dispatchesCompleted: 0,
				dispatchesFailed: 0,
				safetyClassifications: 0,
				totalTokens: 0,
				histograms: {},
			}),
			telemetry: () => ({ counters: {}, histograms: {} }),
			sessionCost: () => 0,
			costEntries: () => [],
			recordTokens: () => {},
		} as ObservabilityContract,
		getContextUsage: () =>
			options.contextTokens === undefined
				? { tokens: null, contextWindow: 1000, percent: null }
				: options.contextTokens === null
					? { tokens: null, contextWindow: 1000, percent: null }
					: { tokens: options.contextTokens, contextWindow: 1000, percent: (options.contextTokens / 1000) * 100 },
		getSettings: () => settings,
		selfDev: options.selfDev ?? false,
		...(options.workspace !== undefined ? { getWorkspaceSnapshot: () => options.workspace ?? null } : {}),
	};
}

describe("interactive/welcome-dashboard", () => {
	it("derives target, model, and context stats from live contracts", () => {
		const stats = deriveWelcomeDashboardStats(deps({ contextTokens: 250 }));
		strictEqual(stats.activeTargets, 3);
		strictEqual(stats.totalTargets, 3);
		strictEqual(stats.workerProfiles, 2);
		strictEqual(stats.contextPercent, 25);
		strictEqual(stats.localModels, 1);
		strictEqual(stats.cloudModels, 1);
		strictEqual(stats.cliModels, 1);
	});

	it("renders a wide dashboard without exceeding the viewport", () => {
		const lines = buildWelcomeDashboardLines(deriveWelcomeDashboardStats(deps({ contextTokens: 250 })), 112);
		const text = __welcomeDashboardTest.stripAnsi(lines.join("\n"));
		ok(text.includes("Clio Coder"), text);
		ok(!text.includes("Welcome Dashboard"), text);
		ok(!text.includes("v0.1.2 · supervised repository work · ready"), text);
		ok(!text.includes("CLIO_SELF_DEV"), text);
		ok(text.includes("Context usage: 25%"), text);
		for (const line of lines) {
			ok(visibleWidth(line) <= 112, `line too wide: ${visibleWidth(line)} ${line}`);
		}
	});

	it("does not derive context usage from cumulative session token billing", () => {
		const stats = deriveWelcomeDashboardStats(deps());
		strictEqual(stats.contextPercent, null);
		const lines = buildWelcomeDashboardLines(stats, 112);
		const text = __welcomeDashboardTest.stripAnsi(lines.join("\n"));
		ok(text.includes("Context usage: idle"), text);
	});

	it("renders self-development as a magenta mode badge", () => {
		const lines = buildWelcomeDashboardLines(deriveWelcomeDashboardStats(deps({ selfDev: true })), 112);
		const raw = lines.join("\n");
		const text = __welcomeDashboardTest.stripAnsi(raw);
		ok(text.includes("mode default · DEV MODE"), text);
		ok(raw.includes("\u001b[38;5;207mDEV MODE"), raw);
		ok(!text.includes("CLIO_SELF_DEV"), text);
	});

	it("renders a compact banner on narrow terminals", () => {
		const lines = buildWelcomeDashboardLines(deriveWelcomeDashboardStats(deps()), 72);
		strictEqual(lines.length, 1);
		ok(__welcomeDashboardTest.stripAnsi(lines[0] ?? "").includes("Clio Coder"));
	});

	describe("workspace panel", () => {
		const baseSnapshot = (overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot => ({
			cwd: "/repo",
			isGit: true,
			branch: "main",
			dirty: false,
			ahead: 0,
			behind: 0,
			recentCommits: [{ sha: "abc1234", subject: "x" }],
			remoteUrl: "https://github.com/akougkas/clio-coder",
			projectType: "node",
			capturedAt: "2026-04-30T00:00:00Z",
			...overrides,
		});

		it("renders branch, remote, and project type for a git repo", () => {
			const lines = buildWelcomeDashboardLines(deriveWelcomeDashboardStats(deps({ workspace: baseSnapshot() })), 112);
			const text = __welcomeDashboardTest.stripAnsi(lines.join("\n"));
			ok(/Workspace/.test(text), text);
			ok(/main/.test(text), text);
			ok(/akougkas\/clio-coder/.test(text), text);
			ok(/node/.test(text), text);
			ok(/commit: abc1234 x/.test(text), text);
		});

		it("omits the panel when snapshot is null", () => {
			const lines = buildWelcomeDashboardLines(deriveWelcomeDashboardStats(deps({ workspace: null })), 112);
			const text = __welcomeDashboardTest.stripAnsi(lines.join("\n"));
			ok(!/Workspace/.test(text), text);
		});

		it("shows project type only when cwd is not a git repo", () => {
			const snap = baseSnapshot({
				isGit: false,
				branch: null,
				dirty: null,
				ahead: null,
				behind: null,
				recentCommits: [],
				remoteUrl: null,
				cwd: "/some/dir",
				projectType: "python",
			});
			const lines = buildWelcomeDashboardLines(deriveWelcomeDashboardStats(deps({ workspace: snap })), 112);
			const text = __welcomeDashboardTest.stripAnsi(lines.join("\n"));
			ok(/Workspace/.test(text), text);
			ok(/python/.test(text), text);
			ok(!/main/.test(text), text);
		});
	});
});
