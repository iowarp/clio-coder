import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { runBootstrap } from "../../src/domains/context/bootstrap.js";
import {
	applyInitImplications,
	bootstrapInputFromInitOptions,
	validateInitOptions,
} from "../../src/domains/context/init-options.js";
import { runContextRefresh } from "../../src/domains/context/refresh.js";
import { readClioState, writeClioState } from "../../src/domains/context/state.js";
import { assembleWikiTree } from "../../src/domains/context/wiki/assemble.js";
import { readWikiPage } from "../../src/domains/context/wiki/frontmatter.js";
import {
	appendContextSnapshot,
	captureContextSnapshot,
	getLatestContextSnapshot,
	lastLoadedContextWindow,
	reconcileSnapshot,
	snapshotInputTokens,
} from "../../src/domains/session/context-accounting.js";
import type { SessionMeta } from "../../src/domains/session/contract.js";
import type { Usage } from "../../src/engine/types.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const fingerprint = { treeHash: "a".repeat(64), gitHead: null, loc: 1 };
const generation = {
	mode: "model" as const,
	parserOutcome: "parsed" as const,
	runId: "run-7",
	targetId: "local",
	wireModelId: "model-7",
	tokenCount: 42,
};

function snapshot(turnId: string, source: string, window: number, providerId = "local", modelId = "model-7") {
	return captureContextSnapshot({
		sessionId: "session-1",
		turnId,
		providerId,
		runtimeId: "runtime-1",
		modelId,
		systemPrompt: "system context",
		conversationMessages: [{ role: "user", content: "inspect the repository" }],
		activeToolSchemas: [{ name: "read", description: "read a file", parameters: { type: "object" } }],
		desiredContextWindow: 131_072,
		effectiveContextWindow: window,
		contextWindowSource: source,
		compactionThreshold: 0.8,
	});
}

describe("contracts/context lifecycle", () => {
	let isolated: IsolatedClioEnv;

	beforeEach(async () => {
		isolated = await isolateClioEnv("clio-coder-context-lifecycle-");
	});

	afterEach(() => isolated.restore());

	it("normalizes initialization options before validating and dispatching", () => {
		deepStrictEqual(applyInitImplications({ rewriteClioMd: true }), {
			rewriteClioMd: true,
			applyClioMd: true,
		});
		deepStrictEqual(bootstrapInputFromInitOptions({ rewriteClioMd: true, heuristic: true }), {
			rewriteClioMd: true,
			applyClioMd: true,
		});
		strictEqual(validateInitOptions({ proposeClioMd: true, adopt: true })?.includes("cannot be combined"), true);
		strictEqual(validateInitOptions({ adopt: true }), null);
	});

	it("reconciles estimates to provider usage without losing the original comparison", () => {
		const estimated = snapshot("turn-1", "configured", 100_000);
		const estimateTokens = estimated.estimatedTokens ?? 0;
		const usage = {
			input: estimateTokens + 400,
			output: 25,
			cacheRead: 100,
			cacheWrite: 50,
			totalTokens: estimateTokens + 575,
		} as Usage;
		const reconciled = reconcileSnapshot(estimated, usage);

		strictEqual(reconciled.estimatedTokens, estimateTokens);
		strictEqual(reconciled.reconciledTokens, estimateTokens + 550);
		strictEqual(reconciled.categories.streaming, 25);
		strictEqual(reconciled.sources.total, "reconciled");
		strictEqual(reconciled.divergenceRatio, Math.round(((estimateTokens + 550) / estimateTokens) * 1000) / 1000);
	});

	it("keeps fixed prompt estimates stable across growing provider totals and separates tool results", () => {
		const initial = snapshot("turn-tools", "configured", 100000);
		initial.categories.toolResults = 800;
		const usage = (input: number) => ({ input, output: 25, cacheRead: 0, cacheWrite: 0 }) as Usage;
		const first = reconcileSnapshot(initial, usage(2000));
		const next = reconcileSnapshot(first, usage(6000));
		strictEqual(next.categories.tools, initial.categories.tools);
		strictEqual(next.categories.system, initial.categories.system);
		strictEqual(next.categories.toolResults, 800);
		strictEqual(snapshotInputTokens(next), 6000);
		strictEqual(next.categories.streaming, 25);
		strictEqual(next.sources.splits.tools, "estimated");
		strictEqual(next.categories.messages - first.categories.messages, 4000);
		const small = reconcileSnapshot(initial, usage(1));
		strictEqual(snapshotInputTokens(small), 1);
		ok(Object.values(small.categories).every((value) => value >= 0));
		const legacy = structuredClone(initial);
		delete legacy.categories.toolResults;
		strictEqual(snapshotInputTokens(reconcileSnapshot(legacy, usage(2000))), 2000);
	});

	it("classifies tool-result messages independently of schemas and ordinary messages", () => {
		const captured = captureContextSnapshot({
			sessionId: "s",
			turnId: "t",
			providerId: "p",
			runtimeId: "r",
			modelId: "m",
			systemPrompt: "fixed",
			activeToolSchemas: [{ name: "read", description: "fixed schema" }],
			conversationMessages: [
				{ role: "user", content: "hello" },
				{ role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "x".repeat(4000) }] },
			],
			desiredContextWindow: 100000,
			effectiveContextWindow: 100000,
			contextWindowSource: "configured",
			compactionThreshold: 0.9,
		});
		ok((captured.categories.toolResults ?? 0) >= 1000);
		ok(captured.categories.tools < 100);
		ok(captured.categories.messages < 100);
	});

	it("refreshes the index while preserving handbook-generation provenance", async () => {
		const cwd = isolated.dir;
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "context-lifecycle", type: "module" }));
		writeFileSync(join(cwd, "src", "index.ts"), "export const contextLifecycle = true;\n");
		writeClioState(cwd, { version: 1, fingerprint, lastBootstrap: generation });

		const result = await runContextRefresh({ cwd, now: () => new Date("2026-08-31T12:00:00.000Z") });

		strictEqual(result.action, "refreshed");
		strictEqual(result.codewikiEntries, 1);
		deepStrictEqual(readClioState(cwd)?.lastBootstrap, generation);
		strictEqual(readClioState(cwd)?.lastIndexedAt, "2026-08-31T12:00:00.000Z");
	});

	it("retains an existing-guide exploration as a proposal without changing published provenance", async () => {
		const cwd = isolated.dir;
		const path = join(cwd, "CLIO-CODER.md");
		const authored = "Keep this authored instruction and its exact formatting.\n";
		writeFileSync(path, authored);
		writeFileSync(join(cwd, "index.ts"), "export const calibration = true;\n");
		writeClioState(cwd, { version: 1, fingerprint, lastBootstrap: generation });
		const result = await runBootstrap({
			cwd,
			generate(input) {
				strictEqual(input.existingClioMdText, authored);
				input.reportGeneration?.({
					mode: "model",
					parserOutcome: "parsed",
					run: { runId: "proposal-run", structuredOutputMode: "prompt-parser", promptBytes: 100, outputBytes: 100 },
				});
				return {
					projectName: "Calibration",
					identity: "A calibration fixture.",
					conventions: [],
					invariants: [],
					sections: [{ title: "Calibration", body: "Read `index.ts` before changing the calibration entry point." }],
				};
			},
		});
		strictEqual(result.summary.action, "proposed");
		ok(result.summary.proposalPath);
		ok(readFileSync(result.summary.proposalPath, "utf8").includes("calibration entry point"));
		strictEqual(readFileSync(path, "utf8"), authored);
		deepStrictEqual(readClioState(cwd)?.lastBootstrap, generation);
		strictEqual(result.telemetry.generation.run?.runId, "proposal-run");
	});

	it("keeps explicit proposals unpublished when no handbook exists", async () => {
		const cwd = isolated.dir;
		writeFileSync(join(cwd, "index.py"), "value = 1\n");
		const result = await runBootstrap({ cwd, proposeClioMd: true });
		strictEqual(result.summary.action, "proposed");
		ok(result.summary.proposalPath && existsSync(result.summary.proposalPath));
		strictEqual(existsSync(join(cwd, "CLIO-CODER.md")), false);
		strictEqual(readClioState(cwd)?.lastBootstrap, undefined);
	});

	it("resumes from the latest persisted snapshot and bounds loaded-window recall to its target", () => {
		const meta = {
			id: "session-1",
			createdAt: "2026-08-31T12:00:00.000Z",
			cwd: isolated.dir,
			cwdHash: "context-lifecycle",
		} as SessionMeta;
		const first = snapshot("turn-1", "loaded", 65_536);
		const otherModel = snapshot("turn-2", "loaded", 200_000, "local", "other-model");
		const latest = snapshot("turn-3", "probe", 262_144);
		for (const value of [first, otherModel, latest]) appendContextSnapshot(meta, value);

		const resumed = getLatestContextSnapshot(meta);
		strictEqual(resumed?.turnId, "turn-3");
		strictEqual(resumed?.systemPrompt, undefined, "heavy prompt inputs are not duplicated in the ledger");
		strictEqual(lastLoadedContextWindow(meta, "local", "model-7"), 65_536);
		strictEqual(lastLoadedContextWindow(meta, "local", "other-model"), 200_000);
		strictEqual(lastLoadedContextWindow(meta, "remote", "model-7"), null);
	});

	it("repairs wiki links only when their root path or longest matching suffix identifies one page", () => {
		const wiki = join(isolated.dir, ".clio-coder", "wiki");
		for (const path of ["tests", "areas", "other"]) mkdirSync(join(wiki, path), { recursive: true });
		for (const path of ["engine.md", "tests/contracts.md", "areas/shared.md", "other/shared.md"]) {
			writeFileSync(join(wiki, path), "# Target\n\nTarget details.\n");
		}
		const page = join(wiki, "tests/extended.md");
		writeFileSync(
			page,
			[
				"# Extended\n",
				"[Contracts](tests/contracts.md#coverage)",
				"[Engine](engine.md)",
				"[Wrong prefix](old/areas/shared.md#details)",
				"[Suffix](contracts.md)",
				"[Ambiguous](old/shared.md#details)",
				"[Missing](missing.md#details)",
				"[Valid](../engine.md#details)",
				"[External](https://example.com/engine.md)",
				"[Local anchor](#details)",
			].join("\n"),
		);
		const plan = { version: 1 as const, overview: "", pages: [] };
		const report = assembleWikiTree({ dir: wiki, sourceRoot: isolated.dir, plan });
		const repaired = readFileSync(page, "utf8");
		for (const link of [
			"[Contracts](contracts.md#coverage)",
			"[Engine](../engine.md)",
			"[Wrong prefix](../areas/shared.md#details)",
			"[Suffix](contracts.md)",
			"[Ambiguous](old/shared.md#details)",
			"[Missing](missing.md#details)",
			"[Valid](../engine.md#details)",
			"[External](https://example.com/engine.md)",
			"[Local anchor](#details)",
		])
			ok(repaired.includes(link), link);
		deepStrictEqual(
			report.issues.filter((issue) => issue.kind === "link"),
			[
				{ page: "tests/extended.md", kind: "link", reference: "old/shared.md" },
				{ page: "tests/extended.md", kind: "link", reference: "missing.md" },
			],
		);
		ok(repaired.includes("<!-- clio-coder:wiki unresolved links: old/shared.md, missing.md;"));
		assembleWikiTree({ dir: wiki, sourceRoot: isolated.dir, plan });
		strictEqual(readFileSync(page, "utf8"), repaired);
	});

	it("publishes canonical body citations while preserving suffixes, mentions, fences and source metadata", () => {
		const wiki = join(isolated.dir, ".clio-coder", "wiki");
		for (const path of [".clio-coder/wiki", "src", "other", "apps/gui/tests"]) {
			mkdirSync(join(isolated.dir, path), { recursive: true });
		}
		for (const path of ["src/index.ts", "other/index.ts", "apps/gui/tests/view.test.ts"]) {
			writeFileSync(join(isolated.dir, path), "source\n");
		}
		writeFileSync(
			join(isolated.dir, "src/main.ts"),
			'const artifact = "settings.yaml";\nconst path = "verdict-" + tier + ".json";\n',
		);
		const page = join(wiki, "architecture.md");
		writeFileSync(
			page,
			[
				"---\ntitle: Architecture\nsources:\n  - src/main.ts\ntests:\n  - apps/gui/tests/view.test.ts\n---",
				"# Architecture\n",
				"See `tests/view.test.ts::Suite::case`, `src/main.js:1-2:main`, and `main.js#L1-L2`.",
				"Names: `index.ts`, `settings.yaml`, `verdict-<tier>.json`, `src/*.ts`, and `toString`.",
				"```ts\nconst file = `fenced.js`;\n```",
				"~~~text\n`fenced.js`\n~~~",
				"~~~markdown\n~~~text\n`fenced.js`\n~~~~ \nAfter tilde: `main.js#L2`.",
				"```markdown\n````text\n`fenced.js`\n```\nAfter backtick: `main.js:1`.",
				"````text\n```ts\n`fenced.js`\n```\n````",
				"```text\n`fenced.js`",
			].join("\n"),
		);
		const plan = { version: 1 as const, overview: "", pages: [] };
		assembleWikiTree({ dir: wiki, sourceRoot: isolated.dir, plan });
		const canonical = readFileSync(page, "utf8");
		ok(
			canonical.includes(
				"See `apps/gui/tests/view.test.ts::Suite::case`, `src/main.ts:1-2:main`, and `src/main.ts#L1-L2`.",
			),
			canonical,
		);
		const { metadata } = readWikiPage({ pagePath: "architecture.md", content: canonical });
		deepStrictEqual(metadata.sources, ["src/main.ts"]);
		deepStrictEqual(metadata.tests, ["apps/gui/tests/view.test.ts"]);
		ok(canonical.includes("Names: `index.ts`, `settings.yaml`, `verdict-<tier>.json`, `src/*.ts`, and `toString`."));
		ok(canonical.includes("```ts\nconst file = `fenced.js`;\n```"));
		ok(canonical.includes("~~~text\n`fenced.js`\n~~~"));
		ok(canonical.includes("~~~markdown\n~~~text\n`fenced.js`\n~~~~ \nAfter tilde: `src/main.ts#L2`."));
		ok(canonical.includes("```markdown\n````text\n`fenced.js`\n```\nAfter backtick: `src/main.ts:1`."));
		ok(canonical.includes("````text\n```ts\n`fenced.js`\n```\n````"));
		ok(canonical.includes("```text\n`fenced.js`"));
		assembleWikiTree({ dir: wiki, sourceRoot: isolated.dir, plan });
		strictEqual(readFileSync(page, "utf8"), canonical);
	});

	it("preserves authored body bytes and keeps unsafe repairs pending across assembly", () => {
		const wiki = join(isolated.dir, ".clio-coder/wiki");
		mkdirSync(join(wiki, "section"), { recursive: true });
		mkdirSync(join(isolated.dir, "src"), { recursive: true });
		writeFileSync(join(isolated.dir, "src/main.ts"), "source\n");
		writeFileSync(join(wiki, "target.md"), "# Target\n\nTarget details.\n");
		writeFileSync(join(wiki, "section/local.md"), "# Local\n\nLocal details.\n");
		const body = "\r\n# Café 🧪\r\n\r\n\r\nRésumé: `main.ts` and [Target](target.md).\r\n\r\n  ";
		const unsafe = "# Draft\r\n\r\n[Target](\r\n target.md) and `main.ts` twice: `main.ts`.\r\n";
		for (const [name, text] of [
			["safe", body],
			["unsafe", unsafe],
			["rooted", "# Rooted\n\n[Root](/local.md) and `main.ts`.\n"],
		]) {
			writeFileSync(join(wiki, `section/${name}.md`), `---\nsources: [src/main.ts]\n---\n${text}`);
		}
		const plan = {
			version: 1 as const,
			overview: "",
			pages: ["safe", "unsafe", "rooted"].map((name) => ({
				path: `section/${name}.md`,
				title: name,
				intent: "",
				sources: ["src/main.ts"],
				status: "written" as const,
				attempts: 1,
			})),
		};
		const report = assembleWikiTree({ dir: wiki, sourceRoot: isolated.dir, plan });
		const safe = readFileSync(join(wiki, "section/safe.md"), "utf8");
		strictEqual(
			readWikiPage({ pagePath: "section/safe.md", content: safe }).body,
			body.replace("`main.ts`", "`src/main.ts`").replace("target.md", "../target.md"),
		);
		strictEqual(plan.pages[0]?.status, "written");
		strictEqual(plan.pages[1]?.status, "pending");
		// /local.md names the wiki root, so section/local.md must not satisfy it.
		strictEqual(plan.pages[2]?.status, "pending");
		deepStrictEqual(
			report.issues.filter((issue) => issue.page === "section/rooted.md" && issue.kind === "link"),
			[{ page: "section/rooted.md", kind: "link", reference: "/local.md" }],
		);
		ok(report.issues.some((issue) => issue.kind === "repair"));
		const pending = readFileSync(join(wiki, "section/unsafe.md"), "utf8");
		ok(
			readWikiPage({ pagePath: "section/unsafe.md", content: pending }).body.startsWith(
				unsafe.replaceAll("`main.ts`", "`src/main.ts`"),
			),
		);
		ok(readFileSync(join(wiki, "quickstart.md"), "utf8").includes("unsafe.md) (pending draft)"));
		assembleWikiTree({ dir: wiki, sourceRoot: isolated.dir, plan });
		strictEqual(readFileSync(join(wiki, "section/safe.md"), "utf8"), safe);
		strictEqual(readFileSync(join(wiki, "section/unsafe.md"), "utf8"), pending);
	});

	it("writes canonical wiki repair markers and consumes the released marker", () => {
		const wiki = join(isolated.dir, ".clio-coder", "wiki");
		mkdirSync(wiki, { recursive: true });
		const page = join(wiki, "architecture.md");
		writeFileSync(
			page,
			"# Architecture\n\nArchitecture details.\n\n[Missing](missing.md)\n\n<!-- clio:wiki stale marker -->\n",
			"utf8",
		);
		const plan = { version: 1 as const, overview: "", pages: [] };
		assembleWikiTree({ dir: wiki, sourceRoot: isolated.dir, plan });
		const canonical = readFileSync(page, "utf8");
		strictEqual(canonical.includes("<!-- clio-coder:wiki unresolved links: missing.md;"), true);
		strictEqual(canonical.includes("<!-- clio:wiki"), false);
		assembleWikiTree({ dir: wiki, sourceRoot: isolated.dir, plan });
		strictEqual(readFileSync(page, "utf8"), canonical);
	});
});
