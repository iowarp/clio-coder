import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runWikiDispatch } from "../../src/cli/wiki-generate.js";
import { type Codewiki, readCodewiki } from "../../src/domains/context/codewiki/indexer.js";
import {
	buildWikiPagePrompt,
	buildWikiPlanPrompt,
	computeFingerprint,
	computeWikiContentHash,
	listWikiPages,
	planWikiGeneration,
	readWikiMeta,
	readWikiPage,
	runWikiGenerate,
	sanitizePagePath,
	sanitizeWikiPlan,
	validateWikiMeta,
	type WikiGenerateInput,
	type WikiPlan,
	wikiDir,
	wikiMarkdownFilesInDir,
	wikiMetaPath,
	wikiStaleness,
	writeWikiMeta,
	writeWikiPlanFile,
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
		`const code = await mod.runContextCommand(JSON.parse(process.env.CLIO_CODER_TEST_ARGS ?? "[]"));`,
		"process.exitCode = code;",
	].join("\n");
	const child = spawnSync(process.execPath, ["--import", TSX_LOADER, "--eval", script], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, CLIO_CODER_TEST_ARGS: JSON.stringify(args) },
	});
	if (child.error) throw child.error;
	return { status: child.status ?? 0, stdout: child.stdout, stderr: child.stderr };
}

function writeProjectFile(cwd: string): void {
	mkdirSync(join(cwd, "src"), { recursive: true });
	writeFileSync(join(cwd, "src", "index.ts"), "export const main = true;\n", "utf8");
}

function writeWikiPage(cwd: string, name: string, text: string): void {
	const target = join(wikiDir(cwd), name);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, text, "utf8");
}

// Writers target the harness-provided staging directory, mirroring how a page
// dispatch writes into input.outputDir rather than into .clio-coder/wiki directly.
function writeStagingPage(outputDir: string, name: string, text: string): void {
	const target = join(outputDir, name);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, text, "utf8");
}

/** Mark every planned page written, the way a completed dispatch loop would. */
function completePlan(input: WikiGenerateInput): void {
	writeWikiPlanFile(input.outputDir, {
		...input.plan,
		pages: input.plan.pages.map((page) => ({ ...page, status: "written" as const, attempts: 1 })),
	});
}

function clioEntryNames(cwd: string): string[] {
	return readdirSync(join(cwd, ".clio-coder"));
}

function stagingDirs(cwd: string): string[] {
	return clioEntryNames(cwd).filter((name) => name.startsWith("wiki-staging-"));
}

function writeExistingWikiMeta(cwd: string, plan?: WikiPlan): void {
	writeWikiMeta(cwd, {
		version: 1,
		updatedAt: "2026-07-04T00:00:00.000Z",
		gitHead: null,
		model: "seed-model",
		contentHash: computeWikiContentHash(cwd),
		pages: listWikiPages(cwd),
		...(plan ? { plan } : {}),
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

/**
 * The admission queue applies a 60s default when a request declares no
 * assignment deadline (`dispatch/extension.ts` admitAssignmentCapacity), while
 * a wiki page dispatch allows six minutes to run. Observed live on a 33-page
 * plan whose writers each took 110 to 125 seconds: `core.md` was refused at
 * 10/33 with `dispatch: admission timed_out` without ever starting, because it
 * waited longer than a minute for a capacity slot the caller was willing to
 * wait six minutes for.
 */
describe("contracts/wiki dispatch admission", () => {
	it("queues a page for as long as it is willing to run it", async () => {
		const requests: Array<Record<string, unknown>> = [];
		const dispatch = {
			async dispatch(request: Record<string, unknown>) {
				requests.push(request);
				return {
					runId: "run-1",
					events: (async function* () {})(),
					finalPromise: Promise.resolve({ exitCode: 0 } as never),
				};
			},
			abort() {},
		} as never;

		const before = Date.now();
		const outcome = await runWikiDispatch({
			dispatch,
			cwd: process.cwd(),
			outputDir: process.cwd(),
			task: "write one page",
			route: {},
			deadlineMs: 6 * 60 * 1000,
			label: "page core.md",
		});
		const after = Date.now();

		strictEqual(outcome.ok, true, outcome.detail);
		const deadline = requests[0]?.assignmentDeadlineAt;
		strictEqual(typeof deadline, "number", "the request must declare an assignment deadline");
		ok(
			(deadline as number) >= before + 6 * 60 * 1000 && (deadline as number) <= after + 6 * 60 * 1000,
			`assignment deadline ${String(deadline)} must match the six-minute execution budget`,
		);
	});
});

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
			gitHead: "abc123",
			model: "test-model",
			contentHash: "a".repeat(64),
			pages: [{ path: "quickstart.md", title: "Quickstart", summary: "Start here." }],
			generation: {
				requestedDepth: "auto" as const,
				depth: "simple" as const,
				sourceFiles: 3,
				sourceLines: 40,
				pagesPlanned: 2,
				pagesWritten: 1,
			},
		};
		const validated = validateWikiMeta(meta);
		ok(validated.ok);
		deepStrictEqual(validated.value.generation, meta.generation);
		strictEqual(validated.value.pages[0]?.summary, "Start here.");

		const bad = validateWikiMeta({ ...meta, contentHash: "nope" });
		ok(!bad.ok);
		ok(bad.problems.some((problem) => problem.includes("contentHash")));

		// A generation block this version does not recognize is a diagnostic
		// record, not corruption: dropping it keeps a usable wiki readable
		// instead of silently regenerating the whole thing.
		const legacy = validateWikiMeta({ ...meta, generation: { researchAgents: 0 } });
		ok(legacy.ok);
		strictEqual(legacy.value.generation, undefined);
	});

	describe("front matter", () => {
		it("repairs a page whose metadata is missing, malformed, or dangling", () => {
			writeProjectFile(scratch);
			const noFrontMatter = readWikiPage({ pagePath: "domains/dispatch.md", content: "# Dispatch\n\nBody text.\n" });
			strictEqual(noFrontMatter.metadata.title, "Dispatch");
			strictEqual(noFrontMatter.metadata.summary, "Body text.");

			const brokenYaml = readWikiPage({ pagePath: "a/b-c.md", content: "---\ntitle: [unclosed\n---\n\nProse.\n" });
			// Unparseable YAML falls back to the path, never to a thrown error.
			strictEqual(brokenYaml.metadata.title, "B c");

			const dangling = readWikiPage({
				pagePath: "x.md",
				sourceRoot: scratch,
				content: '---\ntitle: "X"\nsources: ["src/index.ts", "src/gone.ts"]\nsymbols: "notalist"\n---\n\nProse.\n',
			});
			deepStrictEqual(dangling.metadata.sources, ["src/index.ts"], "a path that is not there is dropped");
			deepStrictEqual(dangling.unresolvedPaths, ["src/gone.ts"], "and reported");
			deepStrictEqual(dangling.metadata.symbols, [], "a field of the wrong type degrades to empty");
		});

		it("accepts a TypeScript-authored .js module specifier as a real source", () => {
			writeProjectFile(scratch);
			const parsed = readWikiPage({
				pagePath: "x.md",
				sourceRoot: scratch,
				content: '---\ntitle: "X"\nsources: ["src/index.js"]\n---\n\nProse.\n',
			});
			deepStrictEqual(parsed.metadata.sources, ["src/index.js"]);
			deepStrictEqual(parsed.unresolvedPaths, []);
		});
	});

	describe("assembly", () => {
		it("generates quickstart and directory indexes from page front matter", async () => {
			writeProjectFile(scratch);
			const result = await runWikiGenerate({
				cwd: scratch,
				model: "test-model",
				generate: (input) => {
					writeStagingPage(
						input.outputDir,
						"domains/dispatch.md",
						'---\ntitle: "Dispatch"\nsummary: "How admission works."\nsources: ["src/index.ts"]\nsymbols: ["main"]\ntests: ["src/index.ts"]\nvalidate: ["npm run typecheck"]\n---\n\n# Dispatch\n\nAdmission is enforced in `src/index.ts`.\n',
					);
					completePlan(input);
				},
			});

			strictEqual(result.status, "generated");
			const quickstart = readFileSync(join(wikiDir(scratch), "quickstart.md"), "utf8");
			// Navigation and routing are derived, so they cannot miss a page or
			// describe one that does not exist.
			ok(quickstart.includes("[Dispatch](domains/dispatch.md)"), quickstart);
			ok(quickstart.includes("How admission works."));
			ok(quickstart.includes("## Task routing"));
			ok(quickstart.includes("`src/index.ts`") && quickstart.includes("`npm run typecheck`"));
			ok(existsSync(join(wikiDir(scratch), "index.md")), "the root index is generated");
			ok(existsSync(join(wikiDir(scratch), "domains", "index.md")), "each section gets one");
			ok(readFileSync(join(wikiDir(scratch), "domains", "index.md"), "utf8").includes("[Dispatch](dispatch.md)"));
		});

		it("keeps nested pages addressable by their relative path", async () => {
			writeProjectFile(scratch);
			await runWikiGenerate({
				cwd: scratch,
				model: "test-model",
				generate: (input) => {
					writeStagingPage(input.outputDir, "domains/dispatch.md", "# Dispatch\n\nBody.\n");
					writeStagingPage(input.outputDir, "cli.md", "# CLI\n\nBody.\n");
					completePlan(input);
				},
			});

			const pages = listWikiPages(scratch).map((page) => page.path);
			// index.md files are navigation, not content, so they are not pages.
			deepStrictEqual(pages, ["cli.md", "domains/dispatch.md", "quickstart.md"]);
			deepStrictEqual(
				readWikiMeta(scratch)?.pages.map((page) => page.path),
				["cli.md", "domains/dispatch.md", "quickstart.md"],
			);
		});

		it("repairs a missing H1 rather than failing the run over it", async () => {
			writeProjectFile(scratch);
			const result = await runWikiGenerate({
				cwd: scratch,
				model: "test-model",
				generate: (input) => {
					writeStagingPage(input.outputDir, "a.md", '---\ntitle: "Real Title"\n---\n\nProse with no heading.\n');
					completePlan(input);
				},
			});

			strictEqual(result.status, "generated");
			const page = readFileSync(join(wikiDir(scratch), "a.md"), "utf8");
			ok(page.includes("# Real Title"), page);
			strictEqual(listWikiPages(scratch).find((entry) => entry.path === "a.md")?.title, "Real Title");
		});

		it("promotes a page that cites something missing and records the repair inline", async () => {
			// Every one of these used to throw away the whole run. They are
			// mechanically repairable, so they are repaired and reported.
			writeProjectFile(scratch);
			const result = await runWikiGenerate({
				cwd: scratch,
				model: "test-model",
				generate: (input) => {
					writeStagingPage(input.outputDir, "a.md", "# A\n\nOwner is `src/missing.ts:20`. See [Invented](invented.md).\n");
					completePlan(input);
				},
			});

			strictEqual(result.status, "generated", "an unresolved reference is not a run failure");
			ok(result.problems?.some((problem) => problem.includes("src/missing.ts")));
			ok(result.problems?.some((problem) => problem.includes("invented.md")));
			const page = readFileSync(join(wikiDir(scratch), "a.md"), "utf8");
			match(page, /<!-- clio:wiki .*unresolved links: invented\.md/);
			match(page, /unresolved sources: src\/missing\.ts/);
			// The prose itself is left alone; only a marker is added.
			ok(page.includes("Owner is `src/missing.ts:20`."));
		});

		it("clears a repair marker once the reference resolves", async () => {
			writeProjectFile(scratch);
			await runWikiGenerate({
				cwd: scratch,
				model: "test-model",
				generate: (input) => {
					writeStagingPage(input.outputDir, "a.md", "# A\n\nOwner is `src/missing.ts`.\n");
					completePlan(input);
				},
			});
			ok(readFileSync(join(wikiDir(scratch), "a.md"), "utf8").includes("clio:wiki"));

			writeFileSync(join(scratch, "src", "missing.ts"), "export const found = true;\n", "utf8");
			const second = await runWikiGenerate({
				cwd: scratch,
				model: "test-model",
				generate: (input) => completePlan(input),
			});

			strictEqual(second.status, "generated");
			ok(!readFileSync(join(wikiDir(scratch), "a.md"), "utf8").includes("clio:wiki"), "the stale marker is gone");
		});

		it("drops an empty page and records it as still owed", async () => {
			writeProjectFile(scratch);
			const result = await runWikiGenerate({
				cwd: scratch,
				model: "test-model",
				generate: (input) => {
					writeStagingPage(input.outputDir, "real.md", "# Real\n\nSubstance.\n");
					writeStagingPage(input.outputDir, "hollow.md", "# Hollow\n");
					writeWikiPlanFile(input.outputDir, {
						version: 1,
						overview: "",
						pages: [
							{ path: "real.md", title: "Real", intent: "", sources: [], status: "written", attempts: 1 },
							{ path: "hollow.md", title: "Hollow", intent: "", sources: [], status: "written", attempts: 1 },
						],
					});
				},
			});

			strictEqual(result.status, "generated");
			ok(!existsSync(join(wikiDir(scratch), "hollow.md")), "a page with no body is not a page");
			strictEqual(result.pending, 1, "and the plan still owes it");
			strictEqual(readWikiMeta(scratch)?.generation?.pagesWritten, 1);
		});
	});

	describe("resumability", () => {
		it("promotes the pages a partial run wrote and reports what is left", async () => {
			writeProjectFile(scratch);
			const result = await runWikiGenerate({
				cwd: scratch,
				model: "test-model",
				generate: (input) => {
					// One page landed; the rest of the plan was never reached.
					writeStagingPage(input.outputDir, "a.md", "# A\n\nWritten.\n");
					writeWikiPlanFile(input.outputDir, {
						version: 1,
						overview: "",
						pages: [
							{ path: "a.md", title: "A", intent: "", sources: [], status: "written", attempts: 1 },
							{ path: "b.md", title: "B", intent: "cover b", sources: [], status: "pending", attempts: 0 },
						],
					});
				},
			});

			strictEqual(result.status, "generated", "a partial run ships what it wrote");
			strictEqual(result.pending, 1);
			ok(existsSync(join(wikiDir(scratch), "a.md")));
			const meta = readWikiMeta(scratch);
			strictEqual(meta?.generation?.pagesPlanned, 2);
			strictEqual(meta?.generation?.pagesWritten, 1);
			// The plan rides along in metadata so the next run knows what is owed.
			strictEqual(meta?.plan?.pages.find((page) => page.path === "b.md")?.status, "pending");
		});

		it("hands the next run only the pages the last one did not finish", async () => {
			writeProjectFile(scratch);
			await runWikiGenerate({
				cwd: scratch,
				model: "test-model",
				generate: (input) => {
					writeStagingPage(input.outputDir, "a.md", "# A\n\nWritten.\n");
					writeWikiPlanFile(input.outputDir, {
						version: 1,
						overview: "",
						pages: [
							{ path: "a.md", title: "A", intent: "", sources: [], status: "written", attempts: 1 },
							{ path: "b.md", title: "B", intent: "cover b", sources: [], status: "pending", attempts: 0 },
						],
					});
				},
			});

			let owed: string[] = [];
			await runWikiGenerate({
				cwd: scratch,
				model: "test-model",
				generate: (input) => {
					owed = input.plan.pages.filter((page) => page.status !== "written").map((page) => page.path);
					writeStagingPage(input.outputDir, "b.md", "# B\n\nWritten now.\n");
					completePlan(input);
				},
			});

			deepStrictEqual(owed, ["b.md"], "the finished page is not rewritten");
			ok(existsSync(join(wikiDir(scratch), "b.md")));
			strictEqual(readWikiMeta(scratch)?.generation?.pagesWritten, 2);
		});

		it("keeps a crashed run's staged work for resume and leaves the live wiki untouched", async () => {
			writeProjectFile(scratch);
			writeWikiPage(scratch, "quickstart.md", "# Quickstart\n\nStable trusted content.\n");
			writeExistingWikiMeta(scratch);
			const pageBefore = readFileSync(join(wikiDir(scratch), "quickstart.md"), "utf8");
			const metaBefore = readFileSync(wikiMetaPath(scratch), "utf8");

			const result = await runWikiGenerate({
				cwd: scratch,
				model: "test-model",
				generate: (input) => {
					writeStagingPage(input.outputDir, "a.md", "# A\n\nFinished before the crash.\n");
					throw new Error("writer crashed mid-run");
				},
			});

			strictEqual(result.status, "failed");
			ok(result.problems?.some((problem) => /writer crashed/.test(problem)));
			// An unexpected throw leaves the state of the staged tree unknown, so
			// the live wiki is not touched; the work is kept rather than deleted.
			strictEqual(readFileSync(join(wikiDir(scratch), "quickstart.md"), "utf8"), pageBefore);
			strictEqual(readFileSync(wikiMetaPath(scratch), "utf8"), metaBefore);
			const staging = stagingDirs(scratch);
			strictEqual(staging.length, 1, "the staging tree survives for the next run");

			const resumed = await runWikiGenerate({
				cwd: scratch,
				model: "test-model",
				generate: (input) => {
					ok(existsSync(join(input.outputDir, "a.md")), "the crashed run's page is still staged");
					completePlan(input);
				},
			});
			strictEqual(resumed.status, "generated");
			ok(existsSync(join(wikiDir(scratch), "a.md")), "and reaches the wiki on the next run");
			strictEqual(stagingDirs(scratch).length, 0);
		});
	});

	describe("update scoping", () => {
		it("rewrites only the pages whose recorded sources changed", async () => {
			writeProjectFile(scratch);
			writeFileSync(join(scratch, "src", "other.ts"), "export const other = true;\n", "utf8");
			writeFileSync(join(scratch, ".gitignore"), ".clio-coder/\n", "utf8");
			writeWikiPage(scratch, "a.md", '---\ntitle: "A"\nsources: ["src/index.ts"]\n---\n\n# A\n\nBody.\n');
			writeWikiPage(scratch, "b.md", '---\ntitle: "B"\nsources: ["src/other.ts"]\n---\n\n# B\n\nBody.\n');
			const head = initGitRepo(scratch);
			const plan: WikiPlan = {
				version: 1,
				overview: "",
				pages: [
					{ path: "a.md", title: "A", intent: "", sources: ["src/index.ts"], status: "written", attempts: 1 },
					{ path: "b.md", title: "B", intent: "", sources: ["src/other.ts"], status: "written", attempts: 1 },
				],
			};
			writeWikiMeta(scratch, {
				version: 1,
				updatedAt: "2026-07-04T00:00:00.000Z",
				gitHead: head,
				model: "seed-model",
				contentHash: computeWikiContentHash(scratch),
				pages: listWikiPages(scratch),
				plan,
			});

			writeFileSync(join(scratch, "src", "other.ts"), "export const other = false;\n", "utf8");
			let owed: string[] = [];
			await runWikiGenerate({
				cwd: scratch,
				model: "test-model",
				generate: (input) => {
					owed = input.plan.pages.filter((page) => page.status !== "written").map((page) => page.path);
					completePlan(input);
				},
			});

			// The scope of an update is computed from the sources each page
			// recorded, not guessed by a model reading a diff.
			deepStrictEqual(owed, ["b.md"]);
		});
	});

	describe("plan artifact", () => {
		it("derives a nested skeleton from indexed areas without targeting a page count", () => {
			const seed = promptCodewiki();
			const baseFile = seed.files[0];
			ok(baseFile);
			const areas = ["src/domains/dispatch", "src/domains/context", "src/cli", "tests/contracts"];
			const large: Codewiki = {
				...seed,
				files: Array.from({ length: 808 }, (_, index) => ({
					...baseFile,
					id: `f_${index}`,
					path: `${areas[index % areas.length]}/file-${index}.ts`,
					loc: 200,
				})),
				symbols: [],
				edges: [],
			};

			const detailed = planWikiGeneration(large);
			strictEqual(detailed.depth, "detailed");
			const paths = detailed.plan.pages.map((page) => page.path);
			// A leading src/ describes the language's layout, not a documentation
			// section, so nesting in the wiki follows nesting in the repository.
			ok(paths.includes("architecture.md"));
			ok(paths.includes("domains/dispatch.md"), paths.join(", "));
			ok(paths.includes("cli.md"));
			ok(paths.includes("tests/contracts.md"));
			ok(
				detailed.plan.pages.every((page) => page.status === "pending" && page.sources.length > 0),
				"every planned page starts owed and anchored",
			);

			// Depth changes how finely the repository is decomposed, not how many
			// pages a writer is told to hit.
			const simple = planWikiGeneration(large, "simple");
			ok(simple.plan.pages.length < detailed.plan.pages.length);
		});

		it("refuses a page path that escapes the wiki or collides with generated navigation", () => {
			strictEqual(sanitizePagePath("domains/dispatch.md"), "domains/dispatch.md");
			strictEqual(sanitizePagePath("./a.md"), "a.md");
			strictEqual(sanitizePagePath("../escape.md"), null);
			// A root-anchored path is the wiki-relative one a writer meant, so it is
			// repaired rather than dropped.
			strictEqual(sanitizePagePath("/abs.md"), "abs.md");
			strictEqual(sanitizePagePath("/quickstart.md"), null, "but it still cannot claim a generated file");
			strictEqual(sanitizePagePath("a/.hidden/b.md"), null);
			strictEqual(sanitizePagePath("notes.txt"), null);
			strictEqual(sanitizePagePath("quickstart.md"), null, "quickstart is generated");
			strictEqual(sanitizePagePath("domains/index.md"), null, "so is every directory index");
		});

		it("keeps progress out of an authored plan and falls back when one is unusable", () => {
			const previous: WikiPlan = {
				version: 1,
				overview: "Prior overview.",
				pages: [{ path: "a.md", title: "A", intent: "", sources: [], status: "written", attempts: 2 }],
			};
			const authored = sanitizeWikiPlan(
				{ pages: [{ path: "a.md", title: "A2", intent: "new intent", status: "pending", attempts: 0 }] },
				previous,
			);
			ok(authored);
			strictEqual(authored.pages[0]?.title, "A2", "authored content is taken");
			strictEqual(authored.pages[0]?.status, "written", "authored progress is not");
			strictEqual(authored.pages[0]?.attempts, 2);
			strictEqual(authored.overview, "Prior overview.");

			strictEqual(sanitizeWikiPlan({ pages: [] }), null);
			strictEqual(sanitizeWikiPlan("not a plan"), null);
			strictEqual(sanitizeWikiPlan({ pages: [{ path: "../escape.md" }] }), null);
		});

		it("does not promote the working plan file into the wiki", async () => {
			writeProjectFile(scratch);
			await runWikiGenerate({
				cwd: scratch,
				model: "test-model",
				generate: (input) => {
					ok(existsSync(join(input.outputDir, "_plan.json")), "the writer receives a plan on disk");
					writeStagingPage(input.outputDir, "a.md", "# A\n\nBody.\n");
					completePlan(input);
				},
			});

			ok(!existsSync(join(wikiDir(scratch), "_plan.json")), "it is harness state, not a wiki page");
			ok(readWikiMeta(scratch)?.plan, "and lives in metadata instead");
		});
	});

	describe("prompts", () => {
		it("puts the repository-wide payload in the plan prompt only", () => {
			writeProjectFile(scratch);
			writeFileSync(join(scratch, "AGENTS.md"), "# Instructions\n\nUse docs/TRUTH.md as the authority.\n", "utf8");
			const outputDir = join(scratch, ".clio-coder", "wiki-staging-xyz");
			const codewiki = promptCodewiki();
			const generation = planWikiGeneration(codewiki, "simple");

			const planPrompt = buildWikiPlanPrompt({ cwd: scratch, mode: "init", codewiki, generation, outputDir });
			ok(planPrompt.includes("## Codewiki digest"));
			ok(planPrompt.includes("## Candidate plan"));
			ok(planPrompt.includes("## Repository guidance") && planPrompt.includes("AGENTS.md"));
			ok(planPrompt.includes("## Working-tree evidence"));
			ok(planPrompt.includes(join(outputDir, "_plan.json")), "the exact file to rewrite is named");
			ok(!planPrompt.includes("{{"), "no substitution token leaks");

			const page = generation.plan.pages[0];
			ok(page);
			const pagePrompt = buildWikiPagePrompt({
				cwd: scratch,
				mode: "init",
				codewiki,
				page,
				siblings: generation.plan.pages,
				outputDir,
				seeded: false,
			});
			ok(pagePrompt.includes(join(outputDir, page.path)));
			ok(pagePrompt.includes("## Anchor sources") && pagePrompt.includes("src/index.ts"));
			ok(pagePrompt.includes("main const src/index.ts:1"), "symbols are scoped to this page's sources");
			// The digest is what made every round of every dispatch expensive.
			ok(!pagePrompt.includes("## Codewiki digest"));
			ok(!pagePrompt.includes("{{"));
		});

		it("skips an empty repository instruction file instead of asking for a read that returns nothing", () => {
			writeProjectFile(scratch);
			writeFileSync(join(scratch, "CLIO-CODER.md"), "", "utf8");
			const codewiki = promptCodewiki();
			const prompt = buildWikiPlanPrompt({
				cwd: scratch,
				mode: "init",
				codewiki,
				generation: planWikiGeneration(codewiki, "simple"),
				outputDir: join(scratch, ".clio-coder", "wiki-staging-xyz"),
			});
			ok(!prompt.includes("- CLIO-CODER.md"), prompt.slice(0, 400));
		});

		it("surfaces safe instruction aliases and dirty working-tree paths", () => {
			writeProjectFile(scratch);
			mkdirSync(join(scratch, ".claude"), { recursive: true });
			writeFileSync(join(scratch, ".claude", "CLAUDE.md"), "# Authority\n\nRead docs/TRUTH.md first.\n", "utf8");
			initGitRepo(scratch);
			writeFileSync(join(scratch, "src", "index.ts"), "export const main = false;\n", "utf8");
			writeFileSync(join(scratch, "src", "untracked.ts"), "export const newFact = true;\n", "utf8");

			const codewiki = promptCodewiki();
			const prompt = buildWikiPlanPrompt({
				cwd: scratch,
				mode: "init",
				codewiki,
				generation: planWikiGeneration(codewiki, "simple"),
				outputDir: join(scratch, ".clio-coder", "wiki-staging-xyz"),
			});

			ok(prompt.includes("- .claude/CLAUDE.md"));
			match(prompt, / M src\/index\.ts/);
			match(prompt, /\?\? src\/untracked\.ts/);
		});
	});

	describe("staleness", () => {
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
			writeFileSync(join(scratch, ".gitignore"), ".clio-coder/\n", "utf8");
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
	});

	describe("run lifecycle", () => {
		it("generates pages with a fake callback and preserves metadata on noop", async () => {
			writeProjectFile(scratch);
			const modes: string[] = [];
			const cannedGenerate = (input: WikiGenerateInput): void => {
				modes.push(input.mode);
				writeStagingPage(
					input.outputDir,
					"architecture.md",
					'---\ntitle: "Architecture"\nsummary: "Runtime map."\n---\n\n# Architecture\n\nThe entry point is `src/index.ts`.\n',
				);
				completePlan(input);
			};

			const first = await runWikiGenerate({ cwd: scratch, model: "test-model", generate: cannedGenerate });

			strictEqual(first.status, "generated");
			strictEqual(first.pages, 2, "the written page plus the generated quickstart");
			const meta = readWikiMeta(scratch);
			ok(meta);
			strictEqual(meta.model, "test-model");
			strictEqual(meta.generation?.depth, "simple");
			strictEqual(meta.generation?.sourceFiles, 1);
			match(meta.sourceTreeHash ?? "", /^[a-f0-9]{64}$/);
			strictEqual(meta.contentHash, computeWikiContentHash(scratch));
			const rawMeta = readFileSync(wikiMetaPath(scratch), "utf8");
			const updatedAt = meta.updatedAt;

			await new Promise((resolve) => setTimeout(resolve, 5));
			const second = await runWikiGenerate({ cwd: scratch, model: "test-model", generate: cannedGenerate });

			strictEqual(second.status, "noop");
			strictEqual(readFileSync(wikiMetaPath(scratch), "utf8"), rawMeta);
			strictEqual(readWikiMeta(scratch)?.updatedAt, updatedAt);
			deepStrictEqual(modes, ["init", "update"]);
		});

		it("rebuilds a stale codewiki before grounding the writer prompt and reuses a fresh one", async () => {
			writeProjectFile(scratch);
			const generate = (input: WikiGenerateInput): void => {
				writeStagingPage(input.outputDir, "a.md", "# A\n\nSee `src/index.ts`.\n");
				completePlan(input);
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
			await runWikiGenerate({ cwd: scratch, model: "test-model", generate });
			const rebuilt = readCodewiki(scratch);
			ok(rebuilt?.files.some((file) => file.path === "src/extra.ts"));
			ok(readClioState(scratch)?.lastIndexedAt !== initialState.lastIndexedAt);
		});

		it("promotes an init run and leaves no staging or wiki-prev directories", async () => {
			writeProjectFile(scratch);

			const result = await runWikiGenerate({
				cwd: scratch,
				model: "test-model",
				generate: (input) => {
					writeStagingPage(input.outputDir, "a.md", "# A\n\nSee `src/index.ts`.\n");
					completePlan(input);
				},
			});

			strictEqual(result.status, "generated");
			ok(existsSync(join(wikiDir(scratch), "quickstart.md")));
			const entries = clioEntryNames(scratch);
			ok(!entries.some((name) => name.startsWith("wiki-staging-")), `unexpected staging dir: ${entries.join(", ")}`);
			ok(!entries.includes("wiki-prev"));
			ok(!entries.includes("wiki.lock"));
		});

		it("restores the assembled seed when a writer bypasses staging and taints the live wiki", async () => {
			writeProjectFile(scratch);
			await runWikiGenerate({
				cwd: scratch,
				model: "test-model",
				generate: (input) => {
					writeStagingPage(input.outputDir, "a.md", "# A\n\nTrusted seeded content.\n");
					completePlan(input);
				},
			});
			const pageBefore = readFileSync(join(wikiDir(scratch), "a.md"), "utf8");

			const result = await runWikiGenerate({
				cwd: scratch,
				model: "test-model",
				generate: (input) => {
					// Bypass outputDir and write directly into .clio-coder/wiki. Only the
					// staged copy is trusted, so the tainted live wiki is overwritten.
					writeWikiPage(scratch, "garbage.md", "# Garbage\n\nuntrusted direct write\n");
					completePlan(input);
				},
			});

			strictEqual(result.status, "generated");
			ok(!existsSync(join(wikiDir(scratch), "garbage.md")));
			strictEqual(readFileSync(join(wikiDir(scratch), "a.md"), "utf8"), pageBefore);
			ok(!readWikiMeta(scratch)?.pages.some((page) => page.path === "garbage.md"));
			ok(!clioEntryNames(scratch).some((name) => name.startsWith("wiki-staging-")));
		});

		it("seeds staging for update runs: an edit promotes, an untouched run no-ops", async () => {
			writeProjectFile(scratch);
			await runWikiGenerate({
				cwd: scratch,
				model: "seed-model",
				generate: (input) => {
					writeStagingPage(input.outputDir, "a.md", "# A\n\nOriginal body.\n");
					writeStagingPage(input.outputDir, "b.md", "# B\n\nOriginal architecture body.\n");
					completePlan(input);
				},
			});

			let seeded: string[] = [];
			const editResult = await runWikiGenerate({
				cwd: scratch,
				model: "edit-model",
				generate: (input) => {
					seeded = wikiMarkdownFilesInDir(input.outputDir);
					ok(readFileSync(join(input.outputDir, "a.md"), "utf8").includes("Original body."));
					writeStagingPage(input.outputDir, "a.md", "# A\n\nEdited body.\n");
					completePlan(input);
				},
			});

			ok(seeded.includes("a.md") && seeded.includes("b.md"), seeded.join(", "));
			strictEqual(editResult.status, "generated");
			strictEqual(readWikiMeta(scratch)?.model, "edit-model");
			ok(readFileSync(join(wikiDir(scratch), "a.md"), "utf8").includes("Edited body."));
			ok(readFileSync(join(wikiDir(scratch), "b.md"), "utf8").includes("Original architecture body."));

			const metaRaw = readFileSync(wikiMetaPath(scratch), "utf8");
			const noopResult = await runWikiGenerate({
				cwd: scratch,
				model: "noop-model",
				generate: (input) => completePlan(input),
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
					writeStagingPage(input.outputDir, "a.md", "# A\n\nFirst run content.\n");
					completePlan(input);
					await gate;
				},
			});
			// The lock is taken synchronously before the first run suspends, so a
			// concurrent run must fail while the first is parked in its callback.
			const second = await runWikiGenerate({
				cwd: scratch,
				model: "test-model",
				generate: (input) => completePlan(input),
			});
			strictEqual(second.status, "failed");
			ok(second.problems?.some((problem) => /already running/.test(problem)));

			releaseGate();
			strictEqual((await firstPromise).status, "generated");

			const third = await runWikiGenerate({
				cwd: scratch,
				model: "test-model",
				generate: (input) => {
					writeStagingPage(input.outputDir, "a.md", "# A\n\nThird run content.\n");
					completePlan(input);
				},
			});
			strictEqual(third.status, "generated");

			// A leftover lock left by a crashed run (dead pid) is reclaimed.
			writeFileSync(join(scratch, ".clio-coder", "wiki.lock"), "999999999", "utf8");
			const fourth = await runWikiGenerate({
				cwd: scratch,
				model: "test-model",
				generate: (input) => {
					writeStagingPage(input.outputDir, "a.md", "# A\n\nFourth run content.\n");
					completePlan(input);
				},
			});
			strictEqual(fourth.status, "generated");
		});

		it("returns a structured failure when no model runtime is injected", async () => {
			writeProjectFile(scratch);

			const result = await runWikiGenerate({ cwd: scratch, model: "test-model" });

			strictEqual(result.status, "failed");
			ok(result.problems?.some((problem) => /model runtime/i.test(problem)));
			strictEqual(existsSync(wikiMetaPath(scratch)), false);
		});
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
			generation: {
				requestedDepth: "auto",
				depth: "simple",
				sourceFiles: 1,
				sourceLines: 1,
				pagesPlanned: 3,
				pagesWritten: 1,
			},
		});

		captured = runContextHandler(scratch, ["wiki", "--status"]);
		strictEqual(captured.status, 0);
		strictEqual(captured.stderr, "");
		match(captured.stdout, /^wiki: present \(1 page\)$/m);
		match(captured.stdout, /^updatedAt: 2026-07-04T00:00:00\.000Z$/m);
		match(captured.stdout, /^gitHead: abc123$/m);
		match(captured.stdout, /1\/3 planned pages written/);
		match(captured.stdout, /^pending: 2 page\(s\)/m);
		match(captured.stdout, /^staleness: gitHead differs from current HEAD \(none\)$/m);
	});
});
