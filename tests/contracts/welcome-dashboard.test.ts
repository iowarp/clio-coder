import { match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import {
	buildCodewiki,
	listWikiPages,
	wikiDir,
	writeCodewiki,
	writeWikiMeta,
} from "../../src/domains/context/index.js";
import { costAggregateForAmount, type ObservabilityContract } from "../../src/domains/observability/index.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { emptyWorkspaceSnapshot } from "../../src/domains/session/workspace/index.js";
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

const scratchRoots: string[] = [];

afterEach(() => {
	for (const root of scratchRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function scratchDashboardProject(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-welcome-dashboard-"));
	scratchRoots.push(root);
	writeFileSync(
		join(root, "package.json"),
		JSON.stringify({ name: "welcome-dashboard-fixture", type: "module" }),
		"utf8",
	);
	mkdirSync(join(root, "src"), { recursive: true });
	writeFileSync(join(root, "src", "index.ts"), "export const dashboardEntry = true;\n", "utf8");
	return root;
}

async function writeDashboardCodewiki(cwd: string): Promise<void> {
	writeCodewiki(cwd, await buildCodewiki({ cwd, language: "typescript", generatedAt: "2026-07-04T00:00:00.000Z" }));
}

function writeDashboardWiki(cwd: string): void {
	mkdirSync(wikiDir(cwd), { recursive: true });
	writeFileSync(join(wikiDir(cwd), "quickstart.md"), "# Quickstart\n\nStart with `src/index.ts`.\n", "utf8");
	writeWikiMeta(cwd, {
		version: 1,
		updatedAt: "2026-07-04T00:00:00.000Z",
		gitHead: null,
		model: "test-model",
		contentHash: "0".repeat(64),
		pages: listWikiPages(cwd),
	});
}

function dashboardStatsFor(cwd: string) {
	return deriveWelcomeDashboardStats({
		providers: mockProviders,
		observability: mockObservability,
		getSettings: () => mockSettings,
		getWorkspaceSnapshot: () => emptyWorkspaceSnapshot(cwd),
	});
}

function strippedDashboardRow(
	stats: ReturnType<typeof deriveWelcomeDashboardStats>,
	width: number,
	label: string,
): string {
	const row = buildWelcomeDashboardLines(stats, width)
		.map(stripAnsi)
		.find((line) => line.includes(label));
	if (!row) throw new Error(`missing dashboard row ${label}`);
	return row;
}

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

	it("shows truthful proactive-memory status and drops narrow facts whole", () => {
		const bank = { version: 1 as const, status: null, knowledge: [], procedural: [] };
		const stats = deriveWelcomeDashboardStats({
			providers: mockProviders,
			observability: mockObservability,
			getSettings: () => mockSettings,
			getTaskMemoryStatus: () => ({
				enabled: true,
				tier: "llm",
				size: 3,
				lastDecision: "injected",
				bank,
			}),
		});

		const wide = strippedDashboardRow(stats, 100, "Memory:");
		ok(wide.includes("Memory:   on · tier LLM · bank 3"), wide);
		const narrow = buildWelcomeDashboardLines(stats, 30)
			.map(stripAnsi)
			.find((line) => line.includes("Memory: on"));
		ok(narrow, "expected a narrow memory status row");
		ok(narrow.includes("Memory: on · tier LLM …"), narrow);
		ok(!narrow.includes("ban"), `a bank fact must be retained whole or dropped: ${narrow}`);
	});

	it("renders a no-wiki dashboard row when codewiki exists without Markdown wiki", async () => {
		const cwd = scratchDashboardProject();
		await writeDashboardCodewiki(cwd);

		const stats = dashboardStatsFor(cwd);
		const row = strippedDashboardRow(stats, 120, "Wiki:");

		ok(row.includes("no wiki; run clio context wiki"), row);
		ok(row.includes("entry points:"), row);
		ok(row.includes("src/index.ts"), row);
	});

	it("renders wiki page count, staleness, and digest excerpt in the dashboard row", async () => {
		const cwd = scratchDashboardProject();
		await writeDashboardCodewiki(cwd);
		writeDashboardWiki(cwd);

		const stats = dashboardStatsFor(cwd);
		const row = strippedDashboardRow(stats, 120, "Wiki:");

		ok(row.includes("1 page"), row);
		ok(row.includes("fresh"), row);
		ok(row.includes("entry points:"), row);
		ok(row.includes("src/index.ts"), row);
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
			getSessionCost: () => costAggregateForAmount(0.05, "known"),
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
			getTaskMemoryStatus: () => ({
				enabled: true,
				tier: "rules",
				size: 2,
				lastDecision: "silent",
				bank: { version: 1, status: null, knowledge: [], procedural: [] },
			}),
		});

		const lines = footer.statusLines(120);
		const joined = lines.join("\n");
		const narrowJoined = stripAnsi(footer.statusLines(79).join("\n"));

		ok(joined.includes("SESSION"));
		ok(joined.includes("CONTEXT"));
		ok(joined.includes("WORKSPACE"));
		ok(joined.includes("ACTIVITY"));

		// Target should be formatted inside the Session facts
		ok(joined.includes("mock-target"));
		match(narrowJoined, /memory\s+on · tier rules · bank 2/u);
	});
});
