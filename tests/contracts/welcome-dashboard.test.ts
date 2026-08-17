import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
import {
	buildWelcomeDashboardLines,
	deriveWelcomeDashboardStats,
	placeholderRepositoryFacts,
	readWelcomeRepositoryFacts,
	WELCOME_REPOSITORY_FACTS_TTL_MS,
	WelcomeDashboard,
} from "../../src/interactive/welcome-dashboard.js";
import { withTimeZone } from "../harness/clock.js";

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

describe("welcome-dashboard and footer integration tests", () => {
	// Nested inside the describe, not at module top level: under
	// --experimental-test-isolation=none every file shares one root test
	// context, so a top-level beforeEach/afterEach runs around every test in
	// every file, not just this one's.
	afterEach(() => {
		for (const root of scratchRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

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

	it("renders the adaptive launchpad with only WORKSPACE, ROUTE, and NEXT decision rows", () => {
		const stats = deriveWelcomeDashboardStats({
			providers: mockProviders,
			observability: mockObservability,
			getSettings: () => mockSettings,
		});

		const lines = buildWelcomeDashboardLines(stats, 100);
		const joined = lines.map(stripAnsi).join("\n");

		for (const tag of ["WORKSPACE", "ROUTE", "NEXT"]) ok(joined.includes(tag), `launchpad lost ${tag}: ${joined}`);
		for (const retired of ["Context", "Wiki", "Config", "Memory", "Hint", "think on"])
			ok(!joined.includes(retired), `launchpad repeats permanent-dashboard fact ${retired}: ${joined}`);
		ok(joined.includes("mock-target · gemini-3.5-flash · ready"), joined);
		ok(joined.includes("ctx missing · /context init"), joined);

		const theme = clioTheme();
		for (const tag of ["WORKSPACE", "ROUTE", "NEXT"])
			ok(lines.join("\n").includes(theme.style("accentDeep", tag.padEnd(9), { bold: true })));
		ok(!joined.includes(stats.autonomy), "autonomy is already owned by the footer and must not be repainted here");
	});

	it("retains EXPERIMENTAL as warning metadata in launchpad and session modes", () => {
		const stats = deriveWelcomeDashboardStats({
			providers: mockProviders,
			observability: mockObservability,
			getSettings: () => mockSettings,
		});

		for (const width of [120, 80, 40]) {
			for (const mode of ["launchpad", "session"] as const) {
				const rendered = buildWelcomeDashboardLines(stats, width, mode).map(stripAnsi).join("\n");
				ok(rendered.includes("EXPERIMENTAL"), `${mode} width ${width}: ${rendered}`);
			}
		}
	});

	it("keeps the EXPERIMENTAL safety warning bold under NO_COLOR", () => {
		const source = `
			import { buildWelcomeDashboardLines } from "./src/interactive/welcome-dashboard.ts";
			const stats = {
				cwd: process.cwd(), workspace: null, targetLabel: "target", modelLabel: "model",
				currentAvailable: true, targetHealthLabel: null, factsPending: false, clioMdStatus: "ok",
			};
			process.stdout.write(buildWelcomeDashboardLines(stats, 80, "launchpad").join("\\n"));
		`;
		const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
			cwd: process.cwd(),
			env: { ...process.env, NO_COLOR: "1" },
			encoding: "utf8",
		});
		strictEqual(child.status, 0, child.stderr);
		ok(!new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*38(?:;|m)`).test(child.stdout));
		ok(
			child.stdout.includes(`${String.fromCharCode(27)}[1mEXPERIMENTAL`),
			`NO_COLOR must retain a bold EXPERIMENTAL run: ${JSON.stringify(child.stdout)}`,
		);
	});

	it("chooses one honest NEXT action from repository readiness", () => {
		const missing = deriveWelcomeDashboardStats({
			providers: mockProviders,
			observability: mockObservability,
			getSettings: () => mockSettings,
			readRepositoryFacts: () => {
				const { pending: _pending, ...facts } = placeholderRepositoryFacts(process.cwd());
				return facts;
			},
		});
		const ready = { ...missing, clioMdStatus: "ok" };
		const pending = { ...missing, factsPending: true };

		ok(stripAnsi(buildWelcomeDashboardLines(missing, 100).join("\n")).includes("ctx missing · /context init"));
		ok(stripAnsi(buildWelcomeDashboardLines(ready, 100).join("\n")).includes("ctx ready · type a task"));
		ok(stripAnsi(buildWelcomeDashboardLines(pending, 100).join("\n")).includes("ctx checking …"));
	});

	// Handoff freshness ages out to a calendar date past 30 days, and that date
	// is the operator's. A handoff written at 02:30Z on the 15th belongs to the
	// 14th for anyone west of UTC that evening.
	it("dates a stale handoff in the operator's zone, not UTC", () => {
		const cwd = scratchDashboardProject();
		const handoffs = join(cwd, ".clio-coder", "handoffs");
		mkdirSync(handoffs, { recursive: true });
		const file = join(handoffs, "handoff-old.md");
		writeFileSync(file, "# handoff\n", "utf8");
		const written = Date.parse("2026-06-15T02:30:00.000Z") / 1000;
		utimesSync(file, written, written);

		const freshness = (zone: string): string =>
			withTimeZone(zone, () => readWelcomeRepositoryFacts(cwd).handoffFreshness);

		strictEqual(freshness("America/Chicago"), "2026-06-14");
		strictEqual(freshness("Asia/Kolkata"), "2026-06-15");
		strictEqual(freshness("UTC"), "2026-06-15");
	});

	it("derives no-wiki repository facts without promoting them to permanent launchpad rows", async () => {
		const cwd = scratchDashboardProject();
		await writeDashboardCodewiki(cwd);

		const stats = dashboardStatsFor(cwd);
		strictEqual(stats.wikiStatus, "no wiki; run clio-coder context wiki");
		ok(stats.wikiDigestExcerpt.includes("src/index.ts"));
		ok(!stripAnsi(buildWelcomeDashboardLines(stats, 120).join("\n")).includes("entry points:"));
	});

	it("keeps wiki facts available to refresh logic without adding launchpad height", async () => {
		const cwd = scratchDashboardProject();
		await writeDashboardCodewiki(cwd);
		writeDashboardWiki(cwd);

		const stats = dashboardStatsFor(cwd);
		strictEqual(stats.wikiPageCount, 1);
		strictEqual(stats.wikiStatus, "fresh");
		ok(stats.wikiDigestExcerpt.includes("src/index.ts"));
		strictEqual(buildWelcomeDashboardLines(stats, 120).length, 6);
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

	it("pins launchpad and session mode heights across the width matrix", () => {
		const stats = deriveWelcomeDashboardStats({
			providers: mockProviders,
			observability: mockObservability,
			getSettings: () => mockSettings,
		});

		for (const width of [40, 80, 120]) {
			strictEqual(buildWelcomeDashboardLines(stats, width).length, width < 64 ? 5 : 6, `launchpad width ${width}`);
			strictEqual(buildWelcomeDashboardLines(stats, width, "session").length, 1, `session width ${width}`);
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
				activity: [],
				stepInFlight: false,
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

	it("reads the repository once for a burst of frames instead of once per frame", async () => {
		// Measured on a live streaming turn: the banner re-derived wiki staleness on
		// every frame, which is three synchronous `git` subprocesses plus a full
		// codewiki parse plus a workspace walk. At a 16ms render timer that was 38%
		// of the process's CPU, on the same event loop the model stream is decoded on.
		const cwd = scratchDashboardProject();
		await writeDashboardCodewiki(cwd);
		let probes = 0;
		let clock = 1_000;
		const dashboard = new WelcomeDashboard(
			{
				providers: mockProviders,
				observability: mockObservability,
				getSettings: () => mockSettings,
				getWorkspaceSnapshot: () => emptyWorkspaceSnapshot(cwd),
				readRepositoryFacts: (probedCwd) => {
					probes += 1;
					return readWelcomeRepositoryFacts(probedCwd);
				},
			},
			() => clock,
		);

		const first = dashboard.render(100);
		for (let frame = 0; frame < 60; frame += 1) dashboard.render(100);
		strictEqual(probes, 1, "61 frames inside the TTL must cost one repository probe");
		deepStrictEqual(dashboard.render(100), first, "a cached probe must not change what the banner says");

		clock += WELCOME_REPOSITORY_FACTS_TTL_MS;
		dashboard.render(100);
		strictEqual(probes, 2, "the probe refreshes once the TTL expires");

		dashboard.invalidate();
		dashboard.render(100);
		strictEqual(probes, 3, "invalidate drops the cache so a context command shows up immediately");
	});
	it("paints dim placeholders at constant height until the first probe lands", async () => {
		// The banner sits at line 0. Once the transcript has scrolled past one
		// viewport, any change to the banner's line count makes firstChanged land
		// above the viewport top, which is pi-tui's full-clear-and-repaint trigger.
		// So the placeholder frame must have exactly the height the filled frame has.
		const cwd = scratchDashboardProject();
		await writeDashboardCodewiki(cwd);

		const placeholderStats = deriveWelcomeDashboardStats({
			providers: mockProviders,
			observability: mockObservability,
			getSettings: () => mockSettings,
			getWorkspaceSnapshot: () => emptyWorkspaceSnapshot(cwd),
			readRepositoryFacts: placeholderRepositoryFacts,
		});
		const settledStats = deriveWelcomeDashboardStats({
			providers: mockProviders,
			observability: mockObservability,
			getSettings: () => mockSettings,
			getWorkspaceSnapshot: () => emptyWorkspaceSnapshot(cwd),
			readRepositoryFacts: readWelcomeRepositoryFacts,
		});

		for (const width of [60, 80, 100, 120, 160]) {
			for (const mode of ["launchpad", "session"] as const) {
				const pending = buildWelcomeDashboardLines(placeholderStats, width, mode);
				const settled = buildWelcomeDashboardLines(settledStats, width, mode);
				strictEqual(pending.length, settled.length, `${mode} width ${width}: async facts must not change mode height`);
				for (const line of pending) {
					strictEqual(visibleWidth(line) <= width, true, `${mode} width ${width}: placeholder line overflows`);
				}
			}
		}

		// A placeholder says it does not know yet; it must not assert a wrong fact.
		const pendingText = stripAnsi(buildWelcomeDashboardLines(placeholderStats, 120).join("\n"));
		ok(pendingText.includes("ctx checking …"), "the pending NEXT row is honest about readiness");
		ok(!pendingText.includes("ctx missing"), "an in-flight probe must not claim project context is missing");
	});

	it("keeps the repository probe off the render call stack", async () => {
		const cwd = scratchDashboardProject();
		await writeDashboardCodewiki(cwd);
		const dashboard = new WelcomeDashboard({
			providers: mockProviders,
			observability: mockObservability,
			getSettings: () => mockSettings,
			getWorkspaceSnapshot: () => emptyWorkspaceSnapshot(cwd),
		});

		// First frame: nothing has been probed, so the banner is placeholders and
		// render() returned without touching git or parsing the codewiki.
		const first = stripAnsi(dashboard.render(120).join("\n"));
		ok(first.includes("ctx checking …"), "the first frame renders before any probe has run");
		const launchpadHeight = dashboard.render(120).length;

		// Let the scheduled probe land, then the banner fills in.
		for (let i = 0; i < 50; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 20));
			const text = stripAnsi(dashboard.render(120).join("\n"));
			if (!text.includes("ctx checking")) {
				strictEqual(dashboard.render(120).length, launchpadHeight, "the settled launchpad keeps its pending height");
				dashboard.collapseToSessionHeader();
				strictEqual(dashboard.render(120).length, 1, "the deliberate mode transition collapses to one line");
				dashboard.collapseToSessionHeader();
				strictEqual(dashboard.render(120).length, 1, "the mode transition is idempotent");
				return;
			}
		}
		throw new Error("the asynchronous repository probe never filled the banner in");
	});

	it("serves the rendered banner from cache while its stats are unchanged", async () => {
		const cwd = scratchDashboardProject();
		await writeDashboardCodewiki(cwd);
		let builds = 0;
		const dashboard = new WelcomeDashboard({
			providers: mockProviders,
			observability: mockObservability,
			getSettings: () => mockSettings,
			getWorkspaceSnapshot: () => emptyWorkspaceSnapshot(cwd),
			readRepositoryFacts: (probedCwd) => {
				builds += 1;
				return readWelcomeRepositoryFacts(probedCwd);
			},
		});

		const first = dashboard.render(120);
		for (let frame = 0; frame < 60; frame += 1) {
			strictEqual(dashboard.render(120), first, "an unchanged banner returns the identical array, not a rebuild");
		}
		strictEqual(builds, 1);

		// A width change must miss.
		const narrow = dashboard.render(80);
		ok(narrow !== first);
		strictEqual(dashboard.render(80), narrow);
	});
});
