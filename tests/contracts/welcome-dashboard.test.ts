import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import type { ObservabilityContract } from "../../src/domains/observability/index.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { visibleWidth } from "../../src/engine/tui.js";
import { buildFooterDashboard } from "../../src/interactive/footer/dashboard.js";
import { buildWelcomeDashboardLines, deriveWelcomeDashboardStats } from "../../src/interactive/welcome-dashboard.js";

const mockSettings: ClioSettings = {
	autonomy: "auto-edit",
	orchestrator: {
		target: "mock-target",
		model: "gemini-3.5-flash",
		thinkingLevel: "high",
	},
	scope: ["src/"],
	targets: [],
	workers: {
		default: {
			target: "mock-target",
			model: "gemini-3.5-flash",
		},
		profiles: {},
	},
	budget: {
		sessionCeilingUsd: 10,
	},
	compaction: {
		auto: true,
		excludeLastTurns: 3,
		threshold: 0.8,
	},
	retry: {
		enabled: true,
		maxRetries: 3,
		baseDelayMs: 1000,
		maxDelayMs: 10000,
	},
	terminal: {
		showTerminalProgress: true,
	},
} as unknown as ClioSettings;

const mockProviders = {
	list: () => [
		{
			target: {
				id: "mock-target",
				defaultModel: "gemini-3.5-flash",
				url: "https://mock.example.com",
			},
			available: true,
			health: { status: "ok", latencyMs: 120 },
			reason: null,
			runtime: { tier: "cloud" },
			capabilities: {
				tools: true,
				reasoning: true,
				vision: true,
				fim: false,
				embeddings: false,
				contextWindow: 128000,
			},
		},
	],
	knowledgeBase: {
		lookup: () => ({
			entry: {
				family: "gemini",
				matchPatterns: [".*"],
				capabilities: {
					tools: true,
					reasoning: true,
					vision: true,
					fim: false,
					embeddings: false,
					contextWindow: 128000,
				},
			},
			matchKind: "family" as const,
		}),
	},
	getDetectedReasoning: () => null,
} as unknown as ProvidersContract;

const mockObservability = {
	sessionTokens: () => ({ input: 100, output: 200, reasoningTokens: 50, totalTokens: 350 }),
	latestTokenThroughput: () => null,
	sessionCost: () => 0.05,
} as unknown as ObservabilityContract;

describe("welcome-dashboard and footer integration tests", () => {
	it("derives stats correctly from providers and settings", () => {
		const stats = deriveWelcomeDashboardStats({
			providers: mockProviders,
			observability: mockObservability,
			getSettings: () => mockSettings,
		});

		strictEqual(stats.targetLabel, "mock-target");
		strictEqual(stats.modelLabel, "gemini-3.5-flash");
		strictEqual(stats.thinkingLevel, "on");
		strictEqual(stats.autonomy, "auto-edit");
		strictEqual(stats.toolProfile, "clio-policy");
	});

	it("formats welcome dashboard lines with correct components in wide mode", () => {
		const stats = deriveWelcomeDashboardStats({
			providers: mockProviders,
			observability: mockObservability,
			getSettings: () => mockSettings,
		});

		const lines = buildWelcomeDashboardLines(stats, 100);
		const joined = lines.join("\n");

		ok(joined.includes("Target:"));
		ok(joined.includes("Context:"));
		ok(joined.includes("Config:"));
		ok(joined.includes("Hint:"));
	});

	it("renders every framed line at exactly the requested width (border alignment)", () => {
		const stats = deriveWelcomeDashboardStats({
			providers: mockProviders,
			observability: mockObservability,
			getSettings: () => mockSettings,
		});

		// Wide (>= 90) and mid (>= 64) modes both draw a top border, body rows,
		// and a bottom border. A misaligned border manifests as one line whose
		// visible width differs from the rest, so assert they are all uniform.
		for (const width of [120, 100, 90, 80, 70, 64]) {
			const lines = buildWelcomeDashboardLines(stats, width);
			for (const line of lines) {
				strictEqual(visibleWidth(line), width, `width ${width}: line "${line}" should span ${width} columns`);
			}
		}
	});

	it("never exceeds the requested width in narrow mode", () => {
		const stats = deriveWelcomeDashboardStats({
			providers: mockProviders,
			observability: mockObservability,
			getSettings: () => mockSettings,
		});

		for (const width of [50, 40, 30]) {
			for (const line of buildWelcomeDashboardLines(stats, width)) {
				ok(visibleWidth(line) <= width, `width ${width}: line "${line}" overflows`);
			}
		}
	});

	it("builds footer dashboard and formats quadrants including target/thinking", () => {
		const footer = buildFooterDashboard({
			providers: mockProviders,
			getSettings: () => mockSettings,
			getTerminalColumns: () => 100,
			getSessionTokens: () => ({
				input: 100,
				output: 200,
				reasoningTokens: 50,
				totalTokens: 350,
				cacheRead: 0,
				cacheWrite: 0,
			}),
			getTokenThroughput: () => null,
			getSessionCost: () => 0.05,
			getContextUsage: () => ({
				tokens: 1000,
				contextWindow: 8000,
				percent: 12.5,
				breakdown: { toolSchemaTokens: 100, systemPromptTokens: 0, messageTokens: 0, pendingUserTokens: 0 },
			}),
			getDispatchRows: () => [],
			getToolCounts: () => ({ tools: {}, errors: 0 }),
			getSessionInfo: () => ({ id: "session-1", name: "default", turns: 5 }),
			getExtensionStats: () => ({ active: 1, installed: 2 }),
			getContextState: () => ({ clioMd: "ok", memoryCount: 5 }),
		});

		const lines = footer.statusLines(120);
		const joined = lines.join("\n");

		ok(joined.includes("SESSION"));
		ok(joined.includes("CONTEXT"));
		ok(joined.includes("WORKSPACE"));
		ok(joined.includes("ACTIVITY"));

		// Target should be formatted inside the Session facts
		ok(joined.includes("mock-target"));
	});
});
