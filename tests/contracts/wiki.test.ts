import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Codewiki, readCodewiki } from "../../src/domains/context/codewiki/indexer.js";
import {
	buildWikiPrompt,
	computeFingerprint,
	computeWikiContentHash,
	listWikiPages,
	planWikiGeneration,
	readWikiMeta,
	runWikiGenerate,
	validateWikiLayout,
	validateWikiMeta,
	wikiDir,
	wikiMetaPath,
	wikiStaleness,
	writeWikiMeta,
} from "../../src/domains/context/index.js";
import { readClioState } from "../../src/domains/context/state.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TSX_LOADER = join(REPO_ROOT, "node_modules/tsx/dist/loader.mjs");

function runContextHandler(
	cwd: string,
	args: ReadonlyArray<string>,
): { status: number; stdout: string; stderr: string } {
	const moduleUrl = pathToFileURL(join(REPO_ROOT, "src/cli/context.ts")).href;
	const script = [
		`const mod = await import(${JSON.stringify(moduleUrl)});`,
		`const code = await mod.runContextCommand(JSON.parse(process.env.CLIO_TEST_ARGS ?? "[]"));`,
		"process.exitCode = code;",
	].join("\n");
	const child = spawnSync(process.execPath, ["--import", TSX_LOADER, "--eval", script], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, CLIO_TEST_ARGS: JSON.stringify(args) },
	});
	if (child.error) throw child.error;
	return { status: child.status ?? 0, stdout: child.stdout, stderr: child.stderr };
}

function writeProjectFile(cwd: string): void {
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "src", "index.ts"), "export const main = true;\n", "utf8");
}

function writeWikiPage(cwd: string, name: string, text: string): void {
	mkdirSync(wikiDir(cwd), { recursive: true });
	writeFileSync(join(wikiDir(cwd), name), text, "utf8");
}

// Writers target the harness-provided staging directory, mirroring how the
// documenter writes into input.outputDir rather than into .clio/wiki directly.
function writeStagingPage(outputDir: string, name: string, text: string): void {
	mkdirSync(outputDir, { recursive: true });
	writeFileSync(join(outputDir, name), text, "utf8");
}

function clioEntryNames(cwd: string): string[] {
	return readdirSync(join(cwd, ".clio"));
}

function writeExistingWikiMeta(cwd: string): void {
	writeWikiMeta(cwd, {
		version: 1,
		updatedAt: "2026-07-04T00:00:00.000Z",
		gitHead: null,
		model: "seed-model",
		contentHash: computeWikiContentHash(cwd),
		pages: listWikiPages(cwd),
	});
}

function git(cwd: string, args: ReadonlyArray<string>): string {
	const child = spawnSync("git", [...args], { cwd, encoding: "utf8" });
	if (child.error) throw child.error;
	if (child.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${child.stderr}`);
	}
	return child.stdout.trim();
}

function initGitRepo(cwd: string): string {
	git(cwd, ["init"]);
	git(cwd, ["config", "user.email", "clio-test@example.com"]);
	git(cwd, ["config", "user.name", "Clio Test"]);
	git(cwd, ["add", "."]);
	git(cwd, ["commit", "-m", "initial"]);
	return git(cwd, ["rev-parse", "--verify", "HEAD"]);
}

function promptCodewiki(): Codewiki {
	return {
		version: 5,
		language: "typescript",
		files: [
			{
				id: "f_index",
				path: "src/index.ts",
				lang: "typescript",
				loc: 1,
				role: "entry",
				hash: "abcd",
				imports: [],
			},
		],
		symbols: [{ name: "main", kind: "const", fileId: "f_index", line: 1 }],
		edges: [],
	};
}

describe("contracts/wiki", () => {
	let scratch: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		scratch = mkdtempSync(join(tmpdir(), "clio-wiki-"));
		process.chdir(scratch);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		rmSync(scratch, { recursive: true, force: true });
	});

	it("roundtrips and validates wiki metadata", () => {
		const meta = {
			version: 1 as const,
			updatedAt: "2026-07-04T00:00:00.000Z",
			gitHead: null,
			sourceTreeHash: "2".repeat(64),
			model: "test-model",
			contentHash: "0".repeat(64),
			pages: [
				{ path: "quickstart.md", title: "Quickstart" },
				{ path: "architecture.md", title: "Architecture" },
			],
		};

		writeWikiMeta(scratch, meta);

		deepStrictEqual(readWikiMeta(scratch), {
			...meta,
			pages: [...meta.pages].sort((a, b) => a.path.localeCompare(b.path)),
		});
		ok(validateWikiMeta(meta).ok);
		const malformed = validateWikiMeta({ ...meta, contentHash: "not-a-hash" });
		strictEqual(malformed.ok, false);
		strictEqual(validateWikiMeta({ ...meta, sourceTreeHash: "not-a-hash" }).ok, false);
		strictEqual(
			validateWikiMeta({
				...meta,
				generation: {
					requestedDepth: "auto",
					depth: "huge",
					sourceFiles: 1,
					sourceLines: 1,
					researchAgents: 0,
				},
			}).ok,
			false,
		);
		writeFileSync(wikiMetaPath(scratch), JSON.stringify({ version: 2 }), "utf8");
		strictEqual(readWikiMeta(scratch), null);
	});

	it("validates missing quickstart, page overflow, and empty pages", () => {
		let validation = validateWikiLayout(scratch);
		strictEqual(validation.ok, false);
		if (!validation.ok) ok(validation.problems.some((problem) => problem.includes("quickstart.md")));

		writeWikiPage(scratch, "quickstart.md", "# Quickstart\n");
		for (let i = 1; i <= 16; i += 1) writeWikiPage(scratch, `page-${i}.md`, `# Page ${i}\n`);
		validation = validateWikiLayout(scratch);
		strictEqual(validation.ok, false);
		if (!validation.ok) ok(validation.problems.some((problem) => problem.includes("maximum for this depth is 16")));

		rmSync(wikiDir(scratch), { recursive: true, force: true });
		writeWikiPage(scratch, "quickstart.md", "# Quickstart\n");
		writeWikiPage(scratch, "empty.md", " \n");
		validation = validateWikiLayout(scratch);
		strictEqual(validation.ok, false);
		if (!validation.ok) ok(validation.problems.some((problem) => problem.includes("empty.md is empty")));
	});

	it("rejects a staged wiki that misses the depth's breadth or substance floor", () => {
		writeWikiPage(scratch, "quickstart.md", "# Quickstart\n");
		writeWikiPage(scratch, "architecture.md", `# Architecture\n${"detail. ".repeat(200)}`);
		const detailed = { minPages: 10, maxPages: 16, minPageBytes: 1_200 };

		const tooNarrow = validateWikiLayout(scratch, detailed);
		strictEqual(tooNarrow.ok, false);
		if (!tooNarrow.ok) {
			ok(tooNarrow.problems.some((problem) => problem.includes("minimum for this depth is 10")));
			// The one substantive page is not reported as thin; only breadth is missing.
			ok(!tooNarrow.problems.some((problem) => problem.includes("architecture.md is")));
		}

		// Breadth alone must not buy a pass: a padded page count of thin files is
		// exactly the filler the byte floor exists to refuse.
		for (let i = 1; i <= 9; i += 1) writeWikiPage(scratch, `thin-${i}.md`, `# Thin ${i}\n`);
		const thin = validateWikiLayout(scratch, detailed);
		strictEqual(thin.ok, false);
		if (!thin.ok) {
			ok(
				thin.problems.some((problem) => problem.includes("thin-1.md is") && problem.includes("minimum substantive size")),
			);
			ok(!thin.problems.some((problem) => problem.includes("minimum for this depth is 10")));
		}
	});

	it("reports absent, fresh, and stale wiki staleness from git metadata", () => {
		strictEqual(wikiStaleness(scratch).state, "absent");

		writeProjectFile(scratch);
		writeWikiPage(scratch, "quickstart.md", "# Quickstart\n");
		const head = initGitRepo(scratch);
		writeWikiMeta(scratch, {
			version: 1,
			updatedAt: "2026-07-04T00:00:00.000Z",
			gitHead: head,
			model: "test-model",
			contentHash: "0".repeat(64),
			pages: listWikiPages(scratch),
		});

		deepStrictEqual(wikiStaleness(scratch), { state: "fresh" });

		writeFileSync(join(scratch, "src", "extra.ts"), "export const extra = true;\n", "utf8");
		git(scratch, ["add", "src/extra.ts"]);
		git(scratch, ["commit", "-m", "add extra"]);
		const stale = wikiStaleness(scratch);
		strictEqual(stale.state, "stale");
		if (stale.state === "stale") ok(stale.changedFiles >= 1);
	});

	it("reports same-HEAD source-tree drift when generated metadata has a fingerprint", () => {
		writeProjectFile(scratch);
		writeWikiPage(scratch, "quickstart.md", "# Quickstart\n");
		const head = initGitRepo(scratch);
		writeWikiMeta(scratch, {
			version: 1,
			updatedAt: "2026-07-04T00:00:00.000Z",
			gitHead: head,
			sourceTreeHash: computeFingerprint(scratch).treeHash,
			model: "test-model",
			contentHash: "0".repeat(64),
			pages: listWikiPages(scratch),
		});

		deepStrictEqual(wikiStaleness(scratch), { state: "fresh" });
		writeFileSync(join(scratch, "src", "index.ts"), "export const main = false;\n", "utf8");
		const stale = wikiStaleness(scratch);
		strictEqual(stale.state, "stale");
		if (stale.state === "stale") ok(stale.changedFiles >= 1);
	});

	it("counts a path changed in history and the working tree only once", () => {
		writeProjectFile(scratch);
		writeFileSync(join(scratch, ".gitignore"), ".clio/\n", "utf8");
		writeWikiPage(scratch, "quickstart.md", "# Quickstart\n");
		const head = initGitRepo(scratch);
		writeWikiMeta(scratch, {
			version: 1,
			updatedAt: "2026-07-04T00:00:00.000Z",
			gitHead: head,
			model: "test-model",
			contentHash: "0".repeat(64),
			pages: listWikiPages(scratch),
		});

		writeFileSync(join(scratch, "src", "index.ts"), "export const main = false;\n", "utf8");
		git(scratch, ["add", "src/index.ts"]);
		git(scratch, ["commit", "-m", "change source"]);
		writeFileSync(join(scratch, "src", "index.ts"), "export const main = null;\n", "utf8");

		deepStrictEqual(wikiStaleness(scratch), { state: "stale", changedFiles: 1 });
	});

	it("degrades git-less wiki staleness checks to fresh with a warning", () => {
		writeWikiPage(scratch, "quickstart.md", "# Quickstart\n");
		writeWikiMeta(scratch, {
			version: 1,
			updatedAt: "2026-07-04T00:00:00.000Z",
			gitHead: "abc123",
			model: "test-model",
			contentHash: "0".repeat(64),
			pages: listWikiPages(scratch),
		});

		const staleness = wikiStaleness(scratch);
		strictEqual(staleness.state, "fresh");
		match(staleness.warning ?? "", /current git HEAD is missing/);
	});

	it("generates pages with a fake callback and preserves metadata on noop", async () => {
		writeProjectFile(scratch);
		const modes: string[] = [];
		const cannedGenerate = async (input: {
			cwd: string;
			mode: "init" | "update";
			prompt: string;
			outputDir: string;
		}): Promise<void> => {
			modes.push(input.mode);
			ok(input.prompt.includes("## Codewiki digest"));
			writeStagingPage(
				input.outputDir,
				"quickstart.md",
				"# Quickstart\n\nThis project exposes `src/index.ts`.\n\n- [Architecture](architecture.md): Runtime map.\n",
			);
			writeStagingPage(input.outputDir, "architecture.md", "# Architecture\n\nThe entry point is `src/index.ts:1`.\n");
		};

		const first = await runWikiGenerate({ cwd: scratch, model: "test-model", generate: cannedGenerate });

		strictEqual(first.status, "generated");
		strictEqual(first.pages, 2);
		const meta = readWikiMeta(scratch);
		ok(meta);
		strictEqual(meta.model, "test-model");
		strictEqual(meta.generation?.depth, "simple");
		strictEqual(meta.generation?.sourceFiles, 1);
		match(meta.sourceTreeHash ?? "", /^[a-f0-9]{64}$/);
		strictEqual(meta.contentHash, computeWikiContentHash(scratch));
		deepStrictEqual(
			meta.pages.map((page) => page.path),
			["architecture.md", "quickstart.md"],
		);
		const rawMeta = readFileSync(wikiMetaPath(scratch), "utf8");
		const updatedAt = meta.updatedAt;

		await new Promise((resolve) => setTimeout(resolve, 5));
		const second = await runWikiGenerate({ cwd: scratch, model: "test-model", generate: cannedGenerate });

		strictEqual(second.status, "noop");
		strictEqual(second.pages, 2);
		strictEqual(readFileSync(wikiMetaPath(scratch), "utf8"), rawMeta);
		strictEqual(readWikiMeta(scratch)?.updatedAt, updatedAt);
		deepStrictEqual(modes, ["init", "update"]);
	});

	it("rebuilds a stale codewiki before grounding the writer prompt and reuses a fresh one", async () => {
		writeProjectFile(scratch);
		const generate = async (input: { outputDir: string }): Promise<void> => {
			writeStagingPage(input.outputDir, "quickstart.md", "# Quickstart\n\nSee `src/index.ts`.\n");
		};

		const first = await runWikiGenerate({ cwd: scratch, model: "test-model", generate });
		strictEqual(first.status, "generated");
		const initialState = readClioState(scratch);
		ok(initialState);

		await new Promise((resolve) => setTimeout(resolve, 10));
		const freshRun = await runWikiGenerate({ cwd: scratch, model: "test-model", generate });
		strictEqual(freshRun.status, "noop");
		strictEqual(readClioState(scratch)?.lastIndexedAt, initialState.lastIndexedAt);

		writeFileSync(join(scratch, "src", "extra.ts"), "export function extraEntry(): void {}\n", "utf8");
		await new Promise((resolve) => setTimeout(resolve, 10));
		const staleRun = await runWikiGenerate({ cwd: scratch, model: "test-model", generate });
		strictEqual(staleRun.status, "noop");
		const rebuilt = readCodewiki(scratch);
		ok(rebuilt?.files.some((file) => file.path === "src/extra.ts"));
		ok(readClioState(scratch)?.lastIndexedAt !== initialState.lastIndexedAt);
	});

	it("writes valid metadata for an existing wiki when a no-op generator leaves content unchanged", async () => {
		writeProjectFile(scratch);
		writeWikiPage(scratch, "quickstart.md", "# Quickstart\n\nExisting wiki page.\n");
		const contentHash = computeWikiContentHash(scratch);

		const result = await runWikiGenerate({
			cwd: scratch,
			model: "test-model",
			generate: () => {
				// The generator intentionally leaves the existing page untouched.
			},
		});

		strictEqual(result.status, "generated");
		strictEqual(result.pages, 1);
		const meta = readWikiMeta(scratch);
		ok(meta);
		strictEqual(meta.model, "test-model");
		strictEqual(meta.contentHash, contentHash);
		deepStrictEqual(meta.pages, [{ path: "quickstart.md", title: "Quickstart" }]);
	});

	it("promotes an init run and leaves no staging or wiki-prev directories", async () => {
		writeProjectFile(scratch);

		const result = await runWikiGenerate({
			cwd: scratch,
			model: "test-model",
			generate: (input) => {
				writeStagingPage(input.outputDir, "quickstart.md", "# Quickstart\n\nSee `src/index.ts`.\n");
			},
		});

		strictEqual(result.status, "generated");
		ok(existsSync(join(wikiDir(scratch), "quickstart.md")));
		const entries = clioEntryNames(scratch);
		ok(!entries.some((name) => name.startsWith("wiki-staging-")), `unexpected staging dir: ${entries.join(", ")}`);
		ok(!entries.includes("wiki-prev"));
		ok(!entries.includes("wiki.lock"));
	});

	it("contains a crashing writer: the prior wiki stays byte-identical with no staging leftover", async () => {
		writeProjectFile(scratch);
		writeWikiPage(scratch, "quickstart.md", "# Quickstart\n\nStable trusted content.\n");
		writeExistingWikiMeta(scratch);
		const pageBefore = readFileSync(join(wikiDir(scratch), "quickstart.md"), "utf8");
		const metaBefore = readFileSync(wikiMetaPath(scratch), "utf8");

		const result = await runWikiGenerate({
			cwd: scratch,
			model: "test-model",
			generate: (input) => {
				writeStagingPage(input.outputDir, "quickstart.md", "# Quickstart\n\nHALF-WRITTEN partial page\n");
				throw new Error("writer crashed mid-run");
			},
		});

		strictEqual(result.status, "failed");
		ok(result.problems?.some((problem) => /writer crashed/.test(problem)));
		strictEqual(readFileSync(join(wikiDir(scratch), "quickstart.md"), "utf8"), pageBefore);
		strictEqual(readFileSync(wikiMetaPath(scratch), "utf8"), metaBefore);
		ok(!clioEntryNames(scratch).some((name) => name.startsWith("wiki-staging-")));
	});

	it("restores the validated seed when a writer bypasses staging and taints the live wiki", async () => {
		writeProjectFile(scratch);
		writeWikiPage(scratch, "quickstart.md", "# Quickstart\n\nTrusted seeded content.\n");
		writeExistingWikiMeta(scratch);
		const pageBefore = readFileSync(join(wikiDir(scratch), "quickstart.md"), "utf8");

		const result = await runWikiGenerate({
			cwd: scratch,
			model: "test-model",
			generate: () => {
				// Bypass outputDir and write directly into .clio/wiki. generate.ts trusts
				// only the staged copy; the tainted live wiki must be overwritten with the
				// validated seed rather than left in place.
				writeWikiPage(scratch, "garbage.md", "# Garbage\n\nuntrusted direct write\n");
			},
		});

		strictEqual(result.status, "generated");
		// The untrusted page is gone and the trusted prior page is intact.
		ok(!existsSync(join(wikiDir(scratch), "garbage.md")));
		strictEqual(readFileSync(join(wikiDir(scratch), "quickstart.md"), "utf8"), pageBefore);
		const meta = readWikiMeta(scratch);
		ok(meta);
		ok(!meta.pages.some((page) => page.path === "garbage.md"));
		ok(!clioEntryNames(scratch).some((name) => name.startsWith("wiki-staging-")));
	});

	it("seeds staging for update runs: an edit promotes, an untouched run no-ops", async () => {
		writeProjectFile(scratch);
		writeWikiPage(scratch, "quickstart.md", "# Quickstart\n\nOriginal quickstart line.\n");
		writeWikiPage(scratch, "architecture.md", "# Architecture\n\nOriginal architecture body.\n");
		writeExistingWikiMeta(scratch);

		let seededPages: string[] = [];
		const editResult = await runWikiGenerate({
			cwd: scratch,
			model: "edit-model",
			generate: (input) => {
				seededPages = readdirSync(input.outputDir).sort();
				ok(readFileSync(join(input.outputDir, "quickstart.md"), "utf8").includes("Original quickstart line."));
				writeStagingPage(input.outputDir, "quickstart.md", "# Quickstart\n\nEdited quickstart line.\n");
			},
		});

		deepStrictEqual(seededPages, ["architecture.md", "quickstart.md"]);
		strictEqual(editResult.status, "generated");
		strictEqual(readWikiMeta(scratch)?.model, "edit-model");
		ok(readFileSync(join(wikiDir(scratch), "quickstart.md"), "utf8").includes("Edited quickstart line."));
		ok(readFileSync(join(wikiDir(scratch), "architecture.md"), "utf8").includes("Original architecture body."));

		const metaRaw = readFileSync(wikiMetaPath(scratch), "utf8");
		const noopResult = await runWikiGenerate({
			cwd: scratch,
			model: "noop-model",
			generate: () => {
				// Leave the seeded pages untouched: an accurate wiki is a no-op.
			},
		});
		strictEqual(noopResult.status, "noop");
		strictEqual(readFileSync(wikiMetaPath(scratch), "utf8"), metaRaw);
	});

	it("single-flights concurrent runs and reclaims a dead lock", async () => {
		writeProjectFile(scratch);
		let releaseGate!: () => void;
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		const firstPromise = runWikiGenerate({
			cwd: scratch,
			model: "test-model",
			generate: async (input) => {
				writeStagingPage(input.outputDir, "quickstart.md", "# Quickstart\n\nFirst run content.\n");
				await gate;
			},
		});
		// The lock is taken synchronously before the first run suspends, so a
		// concurrent run must fail while the first is parked in its callback.
		const second = await runWikiGenerate({
			cwd: scratch,
			model: "test-model",
			generate: (input) => {
				writeStagingPage(input.outputDir, "quickstart.md", "# Quickstart\n\nSecond run content.\n");
			},
		});
		strictEqual(second.status, "failed");
		ok(second.problems?.some((problem) => /already running/.test(problem)));

		releaseGate();
		strictEqual((await firstPromise).status, "generated");

		// The lock is released, so a later run succeeds.
		const third = await runWikiGenerate({
			cwd: scratch,
			model: "test-model",
			generate: (input) => {
				writeStagingPage(input.outputDir, "quickstart.md", "# Quickstart\n\nThird run content.\n");
			},
		});
		strictEqual(third.status, "generated");

		// A leftover lock left by a crashed run (dead pid) is reclaimed.
		writeFileSync(join(scratch, ".clio", "wiki.lock"), "999999999", "utf8");
		const fourth = await runWikiGenerate({
			cwd: scratch,
			model: "test-model",
			generate: (input) => {
				writeStagingPage(input.outputDir, "quickstart.md", "# Quickstart\n\nFourth run content.\n");
			},
		});
		strictEqual(fourth.status, "generated");
	});

	it("returns validation failures without writing metadata", async () => {
		writeProjectFile(scratch);

		const result = await runWikiGenerate({
			cwd: scratch,
			model: "test-model",
			generate: (input) => {
				writeStagingPage(input.outputDir, "notes.md", "# Notes\n");
			},
		});

		strictEqual(result.status, "failed");
		ok(result.problems?.some((problem) => problem.includes("quickstart.md")));
		strictEqual(existsSync(wikiMetaPath(scratch)), false);
	});

	it("returns a structured failure when no model runtime is injected", async () => {
		writeProjectFile(scratch);

		const result = await runWikiGenerate({ cwd: scratch, model: "test-model" });

		strictEqual(result.status, "failed");
		ok(result.problems?.some((problem) => /model runtime/i.test(problem)));
		strictEqual(existsSync(wikiMetaPath(scratch)), false);
	});

	it("auto-classifies wiki depth and distributes detailed research across the heaviest areas", () => {
		const small = planWikiGeneration(promptCodewiki());
		strictEqual(small.depth, "simple");
		strictEqual(small.researchAgents, 0);
		strictEqual(small.minPages, 1);
		strictEqual(small.maxPages, 5);
		strictEqual(small.minPageBytes, 0);

		const seed = promptCodewiki();
		const baseFile = seed.files[0];
		ok(baseFile);
		const areas = [
			"src/domains/dispatch",
			"src/domains/context",
			"tests/contracts",
			"src/interactive",
			"src/engine",
			"src/tools",
			"src/cli",
			"benchmarks/community",
		];
		const large: Codewiki = {
			...seed,
			files: Array.from({ length: 808 }, (_, index) => ({
				...baseFile,
				id: `f_${index}`,
				path: `${areas[index % areas.length]}/file-${index}.ts`,
				loc: areas.length - (index % areas.length),
			})),
			symbols: [],
			edges: [],
		};
		const detailed = planWikiGeneration(large);
		strictEqual(detailed.depth, "detailed");
		strictEqual(detailed.researchAgents, 8);
		strictEqual(detailed.minPages, 10);
		strictEqual(detailed.maxPages, 16);
		strictEqual(detailed.minPageBytes, 1_200);
		deepStrictEqual(detailed.focusAreas, areas);
	});

	it("composes init and update prompts from fragments, digest, and git evidence", () => {
		writeFileSync(join(scratch, "AGENTS.md"), "# Instructions\n\nUse docs/TRUTH.md as the authority.\n", "utf8");
		const outputDir = join(scratch, ".clio", "wiki-staging-xyz");
		const codewiki = promptCodewiki();
		const plan = planWikiGeneration(codewiki, "simple");
		const initPrompt = buildWikiPrompt({ cwd: scratch, mode: "init", codewiki, plan, outputDir });
		ok(initPrompt.includes("## Codewiki digest"));
		ok(initPrompt.includes("## Generation strategy"));
		ok(initPrompt.includes("Depth: simple"));
		ok(initPrompt.includes("## Repository guidance"));
		ok(initPrompt.includes("AGENTS.md"));
		ok(initPrompt.includes("## Working-tree evidence"));
		ok(initPrompt.includes("Structure requirements:"));
		ok(initPrompt.includes("Spend at most 10 tool calls choosing the outline"));
		ok(initPrompt.includes("source of truth or planning authority"));
		ok(initPrompt.includes("Component existence is not end-to-end evidence"));
		ok(initPrompt.includes("src/index.ts"));
		// The {{outputDir}} token is substituted with the staging path and never leaks.
		ok(initPrompt.includes(outputDir));
		ok(!initPrompt.includes("{{outputDir}}"));

		const updatePrompt = buildWikiPrompt({
			cwd: scratch,
			mode: "update",
			codewiki,
			plan,
			gitHead: "0000000000000000000000000000000000000000",
			outputDir,
		});
		ok(updatePrompt.includes("## Git evidence"));
		ok(updatePrompt.includes("Use no more than 10 tool calls to identify affected pages"));
		ok(updatePrompt.includes(outputDir));
		ok(updatePrompt.includes("Git evidence unavailable") || updatePrompt.includes("Git evidence is empty"));
	});

	it("surfaces safe instruction aliases and dirty working-tree paths in the prompt", () => {
		writeProjectFile(scratch);
		mkdirSync(join(scratch, ".claude"), { recursive: true });
		writeFileSync(join(scratch, ".claude", "CLAUDE.md"), "# Authority\n\nRead docs/TRUTH.md first.\n", "utf8");
		initGitRepo(scratch);
		writeFileSync(join(scratch, "src", "index.ts"), "export const main = false;\n", "utf8");
		writeFileSync(join(scratch, "src", "untracked.ts"), "export const newFact = true;\n", "utf8");

		const codewiki = promptCodewiki();
		const prompt = buildWikiPrompt({
			cwd: scratch,
			mode: "init",
			codewiki,
			plan: planWikiGeneration(codewiki, "simple"),
			outputDir: join(scratch, ".clio", "wiki-staging-xyz"),
		});

		ok(prompt.includes("- .claude/CLAUDE.md"));
		match(prompt, / M src\/index\.ts/);
		match(prompt, /\?\? src\/untracked\.ts/);
	});

	it("validates wiki depth and prints status with and without metadata", async () => {
		let captured = runContextHandler(scratch, ["wiki", "--depth", "enormous"]);
		strictEqual(captured.status, 2);
		match(captured.stderr, /--depth must be auto, simple, medium, or detailed/);

		captured = runContextHandler(scratch, ["wiki", "--status"]);
		strictEqual(captured.status, 0);
		strictEqual(captured.stderr, "");
		match(captured.stdout, /^wiki: absent \(0 pages\)$/m);

		writeWikiPage(scratch, "quickstart.md", "# Quickstart\n");
		writeWikiMeta(scratch, {
			version: 1,
			updatedAt: "2026-07-04T00:00:00.000Z",
			gitHead: "abc123",
			model: "test-model",
			contentHash: "1".repeat(64),
			pages: listWikiPages(scratch),
		});

		captured = runContextHandler(scratch, ["wiki", "--status"]);
		strictEqual(captured.status, 0);
		strictEqual(captured.stderr, "");
		match(captured.stdout, /^wiki: present \(1 page\)$/m);
		match(captured.stdout, /^updatedAt: 2026-07-04T00:00:00\.000Z$/m);
		match(captured.stdout, /^gitHead: abc123$/m);
		match(captured.stdout, /^staleness: gitHead differs from current HEAD \(none\)$/m);
	});
});
