import { match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import type { ObservabilityContract } from "../../src/domains/observability/index.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { visibleWidth } from "../../src/engine/tui.js";
import { buildFooterDashboard } from "../../src/interactive/footer/dashboard.js";
import { abbreviateModelId, clioTheme } from "../../src/interactive/theme/index.js";
import { buildWelcomeDashboardLines, deriveWelcomeDashboardStats } from "../../src/interactive/welcome-dashboard.js";

const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const stripAnsi = (text: string): string => text.replace(SGR, "");

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

	it("abbreviates model ids by keeping whole dash-separated parts under 18 chars", () => {
		// The version suffix must survive: keep parts while the joined result stays
		// within 18 characters, then stop; a single oversized part is hard-clipped.
		strictEqual(abbreviateModelId("claude-sonnet-5"), "claude-sonnet-5");
		strictEqual(abbreviateModelId("claude-opus-4-8"), "claude-opus-4-8");
		strictEqual(abbreviateModelId("qwen3-coder-30b-a3b-instruct"), "qwen3-coder-30b");
		strictEqual(abbreviateModelId("verylongsinglemodelidentifierwithoutdashes").length, 18);
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
		// abbreviateModelId now keeps whole dash-separated parts under 18 chars,
		// so the version suffix survives instead of being clipped to "gemini-3.5".
		ok(joined.includes("gemini-3.5-flash"), `model label should keep its version suffix, got: ${joined}`);
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

	it("opens the island with the canonical frame recipe: ┌─ styled title ─ fill ┐", () => {
		const stats = deriveWelcomeDashboardStats({
			providers: mockProviders,
			observability: mockObservability,
			getSettings: () => mockSettings,
		});

		// The whole styled title (brand glyph, bold name, dim version) sits with
		// one space on each side; the fill runs frame-colored straight to the
		// right corner. The old `v0.2.8────` glue must be gone: a space, not a
		// dash, follows the version.
		for (const width of [80, 100]) {
			const top = stripAnsi(buildWelcomeDashboardLines(stats, width)[0] ?? "");
			match(top, /^┌─ >C_ Clio Coder v[^ ]+ ─+┐$/, `width ${width}: top border "${top}"`);
		}
	});

	it("paints the title wordmark as a logotype: dim scaffolding around a bold accent C", () => {
		const stats = deriveWelcomeDashboardStats({
			providers: mockProviders,
			observability: mockObservability,
			getSettings: () => mockSettings,
		});

		const theme = clioTheme();
		const logotype = `${theme.fg("dim", ">")}${theme.style("accent", "C", { bold: true })}${theme.fg("dim", "_")}`;
		const top = buildWelcomeDashboardLines(stats, 80)[0] ?? "";
		ok(top.includes(logotype), `the title should open with the composed logotype, got "${top}"`);
		ok(
			top.includes(theme.style("title", "Clio Coder", { bold: true })),
			"the product name next to the logotype stays bold title",
		);
	});

	it("truncates the width-80 hint row with a trailing ellipsis instead of a mid-word cut", () => {
		const stats = deriveWelcomeDashboardStats({
			providers: mockProviders,
			observability: mockObservability,
			getSettings: () => mockSettings,
		});

		const hintRow = buildWelcomeDashboardLines(stats, 80)
			.map(stripAnsi)
			.find((line) => line.includes("Hint:"));
		ok(hintRow, "expected a Hint row");
		ok(hintRow.includes("…"), `hint row should end in an ellipsis, got: ${hintRow}`);
		ok(!hintRow.includes("…dashboard"), "the full hint must not survive the ellipsis at width 80");
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
