import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { WorkspaceEnumerationIncompleteError } from "../../src/core/workspace-files.js";
import {
	BOOTSTRAP_INPUT_MAX_CHARS,
	BOOTSTRAP_SIBLING_CONTENT_MAX_CHARS,
	buildBootstrapPrompt,
} from "../../src/domains/context/bootstrap-prompt.js";
import { parseClioMd, renderProjectContextFragment, serializeClioMd } from "../../src/domains/context/clio-md.js";
import { createContextBundle } from "../../src/domains/context/extension.js";
import {
	adoptionSourcesChanged,
	computeFingerprint,
	fallbackBootstrapOutput,
	isStale,
	readCodewiki,
	runBootstrap,
	runContextClear,
	scanAgentConfigs,
} from "../../src/domains/context/index.js";
import { readClioState } from "../../src/domains/context/state.js";

const fingerprint = {
	initAt: "2026-05-01T00:00:00.000Z",
	model: "test-model",
	gitHead: null,
	treeHash: "0".repeat(64),
	loc: 12,
};

describe("contracts/bootstrap", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-bootstrap-"));
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	/**
	 * The verification section used to hardcode `npm run` and to name whichever
	 * `lint`/`format` script existed. In a pnpm repository whose `lint` script is
	 * `eslint . --fix`, that produced a handbook telling the agent to run a command
	 * the repo cannot run, and to close out a task by rewriting the working tree
	 * with an autofixer instead of judging it. Both are worse than saying nothing.
	 */
	it("names verification commands the repository can actually run", async () => {
		writeFileSync(
			join(scratch, "package.json"),
			JSON.stringify({
				name: "pnpm-fixture",
				type: "module",
				scripts: {
					typecheck: "tsc --noEmit",
					lint: "eslint . --fix",
					"lint:check": "eslint .",
					format: "prettier --write .",
					"format:check": "prettier --check .",
					test: "vitest run",
				},
			}),
			"utf8",
		);
		writeFileSync(join(scratch, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
		writeFileSync(join(scratch, "index.ts"), "export const fixture = true;\n", "utf8");

		const result = await runBootstrap({ cwd: scratch, confirmGitignore: () => true });
		const verification = result.output.sections?.find((section) => section.title === "Verification expectations");
		ok(verification, "a repository with scripts must get a verification section");

		strictEqual(/(?<!p)npm run/.test(verification.body), false, verification.body);
		ok(verification.body.includes("`pnpm run typecheck`"), verification.body);
		ok(verification.body.includes("`pnpm run lint:check`"), verification.body);
		ok(verification.body.includes("`pnpm run format:check`"), verification.body);
		strictEqual(verification.body.includes("`pnpm run lint`"), false, verification.body);
		strictEqual(verification.body.includes("`pnpm run format`"), false, verification.body);
	});

	it("parses and serializes CLIO.md content and metadata footer", () => {
		const text = serializeClioMd({
			projectName: "Sample",
			identity: "Sample is a TypeScript project. It exists to test CLIO.md parsing.",
			conventions: ["Local imports end in `.js`."],
			invariants: ["Engine boundary. Only `src/engine/**` may value-import `@earendil-works/pi-*`."],
			fingerprint,
		});
		const parsed = parseClioMd(text);
		ok(parsed.ok);
		if (parsed.ok) {
			strictEqual(parsed.value.projectName, "Sample");
			strictEqual(parsed.value.firstInit, false);
			strictEqual(parsed.value.fingerprint?.treeHash, fingerprint.treeHash);
			strictEqual(parsed.value.conventions.length, 1);
			strictEqual(parsed.value.invariants.length, 1);
		}
	});

	it("preserves custom CLIO.md sections in project context", () => {
		const text = serializeClioMd({
			projectName: "Sample",
			identity: "Sample is a TypeScript project with custom agent guidance.",
			conventions: [],
			invariants: [],
			sections: [{ title: "Architecture traps", body: "Do not cross the engine boundary for SDK details." }],
			fingerprint,
		});
		const parsed = parseClioMd(text);
		ok(parsed.ok);
		if (parsed.ok) {
			strictEqual(parsed.value.sections.length, 1);
			strictEqual(parsed.value.sections[0]?.title, "Architecture traps");
			strictEqual(parsed.value.sections[0]?.body, "Do not cross the engine boundary for SDK details.");
			ok(renderProjectContextFragment(parsed.value).includes("## Architecture traps"));
		}
	});

	it("builds bootstrap prompt text with real code navigation guidance", () => {
		const prompt = buildBootstrapPrompt({
			cwd: scratch,
			expectedProjectName: "Private Project",
			projectType: "typescript",
			siblingFiles: [],
			adoption: {
				cwd: scratch,
				homeDir: scratch,
				includeGlobal: false,
				sources: [],
				rejected: [],
				importedRules: [],
				conflicts: [],
				sourceHash: "0".repeat(64),
				sourceSnapshots: [],
			},
		});

		ok(prompt.includes("code_nav"), prompt);
	});

	it("bounds aggregate sibling context and uses display paths in the Scout payload", () => {
		const sources = Array.from({ length: 30 }, (_, index) => ({
			path: `/home/private/.agents/skills/skill-${index}/SKILL.md`,
			displayPath: `.agents/skills/skill-${index}/SKILL.md`,
			scope: "project" as const,
			provider: "agents" as const,
			providerLabel: "Agent Skills",
			kind: "skill" as const,
			kindLabel: "skill",
			content: `rule ${index} ${"x".repeat(10_000)}`,
			contentSha256: "a".repeat(64),
			byteLength: 10_000,
			itemCount: 1,
			order: index,
		}));
		const prompt = buildBootstrapPrompt({
			cwd: scratch,
			expectedProjectName: "Private Project",
			projectType: "typescript",
			siblingFiles: sources.map((source) => ({ source: source.scope, path: source.path, content: source.content })),
			adoption: {
				cwd: scratch,
				homeDir: "/home/private",
				includeGlobal: false,
				sources,
				rejected: [],
				importedRules: sources.slice(0, 20).map((source) => ({
					text: source.content,
					sources: [source.path],
					providers: [source.provider],
				})),
				conflicts: [],
				sourceHash: "b".repeat(64),
				sourceSnapshots: sources.map((source) => ({
					path: source.path,
					scope: source.scope,
					provider: source.provider,
					kind: source.kind,
					sha256: source.contentSha256,
				})),
			},
			existingClioMdText: `# Existing\n\n${"z".repeat(20_000)}`,
		});
		const serialized = /<bootstrap-input>\n([^\n]+)\n<\/bootstrap-input>/.exec(prompt)?.[1];
		ok(serialized);
		ok(serialized.length <= BOOTSTRAP_INPUT_MAX_CHARS, `${serialized.length}`);
		const payload = JSON.parse(serialized) as {
			projectRoot: string;
			expectedProjectName: string;
			siblingFiles: Array<{ path: string; content: string }>;
			adoption: { sourceCount: number; presentedSourceCount: number };
		};
		strictEqual(payload.projectRoot, ".");
		strictEqual(payload.expectedProjectName, "Private Project");
		strictEqual(serialized.includes(scratch), false);
		strictEqual(payload.adoption.sourceCount, 30);
		ok(payload.adoption.presentedSourceCount <= 12);
		strictEqual(
			payload.siblingFiles.some((source) => source.path.startsWith("/home/private")),
			false,
		);
		ok(
			payload.siblingFiles.reduce((total, source) => total + source.content.length, 0) <=
				BOOTSTRAP_SIBLING_CONTENT_MAX_CHARS,
		);
	});

	it("demotes nested generated headings so CLIO.md keeps one H1", async () => {
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "mock-project", type: "module" }), "utf8");

		await runBootstrap({
			cwd: scratch,
			confirmGitignore: () => true,
			modelId: "stub-model",
			now: () => new Date("2026-05-01T00:00:00.000Z"),
			generate: () => ({
				projectName: "Mock Project",
				identity: "Mock Project is a dynamic test project.",
				conventions: ["Use the local test runner.\n# Do not create another top-level heading."],
				invariants: [],
				sections: [
					{
						title: "Architecture notes",
						body: "# Boundary\n\n## Trap\n\nKeep nested headings inside the section body.",
					},
				],
				importedAgentContext: "# Imported\n\n## Source provenance\n\n- Synthetic import for regression coverage.",
			}),
		});

		const text = readFileSync(join(scratch, "CLIO.md"), "utf8");
		const h1Count = [...text.matchAll(/^#\s+/gm)].length;
		strictEqual(h1Count, 1, text);
		ok(text.includes("### Boundary"), text);
		ok(text.includes("### Trap"), text);
		ok(text.includes("### Imported"), text);
		const parsed = parseClioMd(text);
		ok(parsed.ok);
	});

	/**
	 * Scout enrichment used to be extractive: a line survived only when it was a
	 * verbatim member of the sibling-file corpus. The rule now is that a line must
	 * cite the repository and every citation must be real, so Scout can describe
	 * what it read instead of copying what someone already wrote.
	 */
	it("keeps identity and hard rules evidence-owned while Scout contributes bounded sections", async () => {
		const citedRule = "The run entry point is `index.ts`.";
		const inventedCommand = "Publish partner builds with `npm publish --tag partners`.";
		const uncitedClaim = "A dedicated team owns every change.";
		writeFileSync(
			join(scratch, "package.json"),
			JSON.stringify({
				name: "grounded-project",
				type: "module",
				description: "an HPC workflow engine for scientific data",
			}),
			"utf8",
		);
		writeFileSync(join(scratch, "index.ts"), "export const grounded = true;\n", "utf8");
		writeFileSync(join(scratch, "AGENTS.md"), "- Always run tests before handing results to partners.\n", "utf8");

		const result = await runBootstrap({
			cwd: scratch,
			confirmGitignore: () => true,
			generate: (input) => {
				input.reportGeneration?.({
					mode: "scout",
					parserOutcome: "parsed",
					scout: { structuredOutputMode: "native-schema", promptBytes: 100, outputBytes: 100 },
				});
				return {
					projectName: scratch,
					identity: "Generic helper",
					conventions: ["python", "Always invent a framework."],
					invariants: ["Dependency list is a hard invariant."],
					sections: [
						{ title: "Architecture & Ownership", body: uncitedClaim },
						{
							title: "Operational workflow",
							body: [inventedCommand, ...Array.from({ length: 40 }, () => citedRule)].join("\n"),
						},
					],
				};
			},
		});

		strictEqual(result.output.projectName, "Grounded Project");
		match(result.output.identity, /HPC workflow engine for scientific data/i);
		deepStrictEqual(result.output.conventions, ["Always run tests before handing results to partners."]);
		deepStrictEqual(result.output.invariants, []);
		const sectionTitles = result.output.sections?.map((section) => section.title) ?? [];
		ok(sectionTitles.includes("Context retrieval"));
		ok(sectionTitles.includes("Repository shape"));
		ok(sectionTitles.includes("Operational workflow"));
		// Every line cites nothing, so the whole section goes, title included. No
		// word-level surgery on the title is needed to reach that outcome.
		strictEqual(sectionTitles.includes("Architecture & Ownership"), false);
		const workflow = result.output.sections?.find((section) => section.title === "Operational workflow");
		ok(workflow);
		ok(workflow.body.length <= 1200);
		ok(workflow.body.split("\n").every((line) => line === citedRule));
		strictEqual(workflow.body.includes("npm publish"), false);
		strictEqual(readFileSync(join(scratch, "CLIO.md"), "utf8").includes(scratch), false);
		strictEqual(result.telemetry.generation.mode, "scout");
	});

	/**
	 * The cold-start case, and the one `context init` exists for: no sibling agent
	 * context, no prior handbook. Under the old extractive rule the evidence corpus
	 * held only paths and symbol names, so no Scout sentence could ever match one
	 * verbatim and every model-authored section was deleted before it was written.
	 */
	it("keeps Scout sections that cite the repository when no sibling context exists", async () => {
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "cold-start", type: "module" }), "utf8");
		writeFileSync(join(scratch, "index.ts"), "export const coldStart = true;\n", "utf8");

		const result = await runBootstrap({
			cwd: scratch,
			confirmGitignore: () => true,
			generate: (input) => {
				input.reportGeneration?.({
					mode: "scout",
					parserOutcome: "parsed",
					scout: { structuredOutputMode: "native-schema", promptBytes: 100, outputBytes: 100 },
				});
				return {
					projectName: "Ignored",
					identity: "Ignored",
					conventions: [],
					invariants: [],
					sections: [
						{
							title: "Architecture",
							body: [
								"`index.ts` is the only module and exports the run flag directly.",
								"A dedicated team reviews every change before merge.",
							].join("\n"),
						},
					],
				};
			},
		});

		const architecture = result.output.sections?.find((section) => section.title === "Architecture");
		ok(architecture, "a cited Scout section must survive a bootstrap with no sibling files");
		ok(architecture.body.includes("`index.ts`"), architecture.body);
		strictEqual(architecture.body.includes("dedicated team"), false, architecture.body);
		strictEqual(result.telemetry.generation.mode, "scout");
	});

	it("records a parsed Scout draft as heuristic when no enrichment survives grounding", async () => {
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "grounding-floor", type: "module" }), "utf8");
		writeFileSync(join(scratch, "AGENTS.md"), "- Always keep generated context concise.\n", "utf8");

		const result = await runBootstrap({
			cwd: scratch,
			confirmGitignore: () => true,
			generate: (input) => {
				input.reportGeneration?.({
					mode: "scout",
					parserOutcome: "parsed",
					scout: { structuredOutputMode: "native-schema", promptBytes: 100, outputBytes: 100 },
				});
				return {
					projectName: "Ignored",
					identity: "Ignored",
					conventions: [],
					invariants: [],
					sections: [],
				};
			},
		});

		strictEqual(result.telemetry.generation.mode, "heuristic");
		strictEqual(result.telemetry.generation.parserOutcome, "parsed");
		strictEqual(
			result.telemetry.generation.fallbackReason,
			"Scout draft contributed no evidence-grounded custom sections",
		);
		strictEqual(readClioState(scratch)?.lastBootstrap?.mode, "heuristic");
	});

	it("does not attribute a Scout section that is removed by the final section limit", async () => {
		const groundedRule = "Always run the saturated handbook verifier before handoff.";
		writeFileSync(join(scratch, "index.ts"), "export const saturated = true;\n", "utf8");
		writeFileSync(join(scratch, "AGENTS.md"), `- ${groundedRule}\n`, "utf8");
		writeFileSync(
			join(scratch, "CLIO.md"),
			serializeClioMd({
				projectName: "Saturated Handbook",
				identity: "Saturated Handbook has a full set of curated project sections.",
				conventions: [],
				invariants: [],
				sections: Array.from({ length: 7 }, (_, index) => ({
					title: `Curated section ${index + 1}`,
					body: `Curated body ${index + 1} remains human-owned.`,
				})),
				fingerprint,
			}),
			"utf8",
		);

		const result = await runBootstrap({
			cwd: scratch,
			applyClioMd: true,
			confirmGitignore: () => true,
			generate: (input) => {
				input.reportGeneration?.({
					mode: "scout",
					parserOutcome: "parsed",
					scout: { structuredOutputMode: "native-schema", promptBytes: 100, outputBytes: 100 },
				});
				return {
					projectName: "Ignored",
					identity: "Ignored",
					conventions: [],
					invariants: [],
					sections: [{ title: "Scout appendix", body: groundedRule }],
				};
			},
		});

		strictEqual(
			result.output.sections?.some((section) => section.title === "Scout appendix"),
			false,
		);
		strictEqual(result.telemetry.generation.mode, "heuristic");
		strictEqual(
			result.telemetry.generation.fallbackReason,
			"Scout draft contributed no evidence-grounded custom sections",
		);
	});

	it("parses more than six convention bullets with a warning", () => {
		const bullets = Array.from({ length: 7 }, (_, index) => `- rule ${index}`).join("\n");
		const parsed = parseClioMd(`# Sample\n\nSample is a project with too many rules.\n\n## Conventions\n\n${bullets}\n`);
		ok(parsed.ok);
		if (parsed.ok) {
			strictEqual(parsed.value.conventions.length, 7);
			ok(parsed.value.warnings.some((warning) => warning.includes("conventions exceed")));
		}
	});

	it("bootstraps a directory, generates state, CLIO.md, and ignores .clio by default", async () => {
		// Dynamically write files to make a mock TypeScript project
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "mock-project", type: "module" }), "utf8");
		writeFileSync(join(scratch, "tsconfig.json"), "{}", "utf8");

		const result = await runBootstrap({
			cwd: scratch,
			confirmGitignore: () => true,
			now: () => new Date("2026-05-01T00:00:00.000Z"),
		});

		ok(existsSync(join(scratch, "CLIO.md")));
		ok(existsSync(join(scratch, ".clio", "state.json")));
		ok(existsSync(join(scratch, ".clio", "codewiki.json")));
		const gitignore = readFileSync(join(scratch, ".gitignore"), "utf8");
		ok(gitignore.split(/\r?\n/).includes(".clio/"));
		strictEqual(gitignore.includes(".clio/codewiki.json"), false);
		strictEqual(gitignore.includes(".clio/state.json"), false);
		strictEqual(gitignore.includes(".clio/handoffs/"), false);

		strictEqual(existsSync(join(scratch, ".clio", "handoffs")), false);

		strictEqual(result.projectType, "typescript");
		strictEqual(result.summary.action, "wrote");
		strictEqual(result.telemetry.generation.mode, "heuristic");
		strictEqual(result.telemetry.generation.parserOutcome, "not-run");
		// The handbook describes the user's repository. Clio's own `.clio/` bookkeeping
		// is enforced by the .gitignore this run just wrote, not by prose repeated
		// verbatim into every handbook Clio ever generates.
		strictEqual(result.output.sections?.some((section) => section.title === "Context artifacts"), false);
		strictEqual(readFileSync(join(scratch, "CLIO.md"), "utf8").includes("## Context artifacts"), false);
		ok(readFileSync(join(scratch, ".gitignore"), "utf8").split(/\r?\n/).includes(".clio/"));

		const state = readClioState(scratch);
		strictEqual(state?.projectType, "typescript");
		strictEqual(state?.lastIndexedAt, "2026-05-01T00:00:00.000Z");
		strictEqual(state?.lastBootstrap?.mode, "heuristic");
	});

	/**
	 * This used to assert a separate "source-sparse heuristic floor": a second
	 * mechanism, with its own risk-word regex, that replaced a whole Scout draft
	 * when the repository had no sibling context. The citation rule already covers
	 * the case it was built for, so the floor and its disclosure string are gone
	 * and the same input reaches the same outcome through one mechanism.
	 */
	it("discloses a parsed Scout draft that cites nothing as a heuristic handbook", async () => {
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "floor-project", type: "module" }), "utf8");
		writeFileSync(join(scratch, "index.ts"), "export const floor = true;\n", "utf8");

		const result = await runBootstrap({
			cwd: scratch,
			confirmGitignore: () => true,
			generate: (input) => {
				input.reportGeneration?.({
					mode: "scout",
					parserOutcome: "parsed",
					scout: { structuredOutputMode: "native-schema", promptBytes: 10, outputBytes: 20 },
				});
				return {
					projectName: "Invented Ownership",
					identity: "An unsupported identity from a source-sparse model response.",
					conventions: [],
					invariants: [],
					sections: [{ title: "Workflow traps", body: "A dedicated team owns every change." }],
				};
			},
		});

		strictEqual(result.output.projectName, "Floor Project");
		strictEqual(result.telemetry.generation.mode, "heuristic");
		strictEqual(result.telemetry.generation.parserOutcome, "parsed");
		strictEqual(
			result.telemetry.generation.fallbackReason,
			"Scout draft contributed no evidence-grounded custom sections",
		);
		strictEqual(readClioState(scratch)?.lastBootstrap?.mode, "heuristic");
		strictEqual(readClioState(scratch)?.lastBootstrap?.parserOutcome, "parsed");
	});

	it("publishes a fresh codewiki checkpoint before the scout generator runs", async () => {
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "staged-context", type: "module" }), "utf8");
		writeFileSync(join(scratch, "index.ts"), "export const staged = true;\n", "utf8");

		await runBootstrap({
			cwd: scratch,
			confirmGitignore: () => true,
			now: () => new Date("2026-05-01T00:00:00.000Z"),
			generate: () => {
				const codewiki = readCodewiki(scratch);
				const state = readClioState(scratch);
				ok(codewiki, "codewiki must be visible to the scout worker before generation");
				ok(state, "matching freshness state must be visible before generation");
				strictEqual(isStale(state.fingerprint, computeFingerprint(scratch, codewiki)), false);
				strictEqual(state.lastInitAt, undefined, "the checkpoint must not claim init completed early");
				return {
					projectName: "Staged Context",
					identity: "Staged Context exercises the pre-generation index checkpoint.",
					conventions: [],
					invariants: [],
				};
			},
		});

		strictEqual(readClioState(scratch)?.lastInitAt, "2026-05-01T00:00:00.000Z");
	});

	it("keeps preview strictly write-free before and after generation", async () => {
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "preview-context", type: "module" }), "utf8");
		let confirmationRequested = false;

		const result = await runBootstrap({
			cwd: scratch,
			preview: true,
			confirmGitignore: () => {
				confirmationRequested = true;
				return true;
			},
			generate: () => ({
				projectName: "Preview Context",
				identity: "Preview Context verifies that orientation can be inspected without writes.",
				conventions: [],
				invariants: [],
			}),
		});

		strictEqual(confirmationRequested, false);
		strictEqual(existsSync(join(scratch, ".clio")), false);
		strictEqual(existsSync(join(scratch, "CLIO.md")), false);
		strictEqual(existsSync(join(scratch, ".gitignore")), false);
		strictEqual(result.telemetry.generation.mode, "heuristic");
	});

	// The old contract skipped generation whenever CLIO.md existed, even when the
	// caller supplied a generator. That made a model-capable init indistinguishable
	// from one with no route: nothing was dispatched, nothing was said, and
	// lastBootstrap recorded mode "existing" for a run that never tried. The
	// handbook is still handed to the generator as source, so this refreshes it.
	it("hands an existing CLIO.md to the generator instead of skipping generation", async () => {
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "mock-project", type: "module" }), "utf8");
		writeFileSync(join(scratch, "tsconfig.json"), "{}", "utf8");
		writeFileSync(
			join(scratch, "CLIO.md"),
			serializeClioMd({
				projectName: "Rich Context",
				identity: "Rich Context is a TypeScript project with curated agent guidance.",
				conventions: ["Keep the curated convention intact."],
				invariants: ["Never erase custom CLIO.md sections during a bootstrap fallback."],
				sections: [
					{
						title: "Architecture traps",
						body: "Preserve this section when scout or model generation is unavailable.",
					},
				],
				fingerprint,
			}),
			"utf8",
		);
		const phases: string[] = [];
		let generated = false;

		const result = await runBootstrap({
			cwd: scratch,
			confirmGitignore: () => true,
			modelId: "stub-model",
			now: () => new Date("2026-05-01T00:00:00.000Z"),
			onProgress: (event) => phases.push(`${event.phase}:${event.status}`),
			generate: (input) => {
				generated = true;
				const fallback = fallbackBootstrapOutput(input);
				strictEqual(fallback.mode, "existing");
				return fallback.output;
			},
		});

		const parsed = parseClioMd(readFileSync(join(scratch, "CLIO.md"), "utf8"));
		ok(parsed.ok);
		if (parsed.ok) {
			strictEqual(parsed.value.projectName, "Rich Context");
			strictEqual(parsed.value.conventions[0], "Keep the curated convention intact.");
			strictEqual(parsed.value.sections[0]?.title, "Architecture traps");
			strictEqual(parsed.value.sections[0]?.body, "Preserve this section when scout or model generation is unavailable.");
		}
		strictEqual(generated, true, "a supplied generator is the request to generate");
		strictEqual(result.telemetry.generation.mode, "heuristic", "a run that generated never records mode 'existing'");
		ok(phases.includes("codewiki:completed"));
		ok(phases.includes("clio-md:completed"));
		ok(phases.includes("done:completed"));
	});

	it("skips generation only when no generator is supplied", async () => {
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "mock-project", type: "module" }), "utf8");
		writeFileSync(join(scratch, "tsconfig.json"), "{}", "utf8");
		writeFileSync(
			join(scratch, "CLIO.md"),
			serializeClioMd({
				projectName: "Rich Context",
				identity: "Rich Context is a TypeScript project with curated agent guidance.",
				conventions: ["Keep the curated convention intact."],
				invariants: ["Never erase custom CLIO.md sections during a bootstrap fallback."],
				sections: [{ title: "Architecture traps", body: "Preserve this section when no generator runs." }],
				fingerprint,
			}),
			"utf8",
		);

		// --heuristic and --preview are the paths that withhold `generate`.
		const result = await runBootstrap({
			cwd: scratch,
			confirmGitignore: () => true,
			now: () => new Date("2026-05-01T00:00:00.000Z"),
		});

		const parsed = parseClioMd(readFileSync(join(scratch, "CLIO.md"), "utf8"));
		ok(parsed.ok);
		if (parsed.ok) {
			strictEqual(parsed.value.projectName, "Rich Context");
			strictEqual(parsed.value.sections[0]?.title, "Architecture traps");
		}
		strictEqual(result.telemetry.generation.mode, "existing");
	});

	it("invalidates cached context state after contract bootstrap", async () => {
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "mock-project", type: "module" }), "utf8");
		writeFileSync(join(scratch, "tsconfig.json"), "{}", "utf8");
		const bundle = createContextBundle({
			bus: createSafeEventBus(),
			getContract: () => undefined,
		});

		strictEqual(bundle.contract.contextState(scratch).clioMd, "none");
		await bundle.contract.runBootstrap({
			cwd: scratch,
			confirmGitignore: () => true,
			modelId: "stub-model",
			now: () => new Date("2026-05-01T00:00:00.000Z"),
			generate: () => ({
				projectName: "Mock Project",
				identity: "Mock Project is a dynamic test project.",
				conventions: ["Keep files short."],
				invariants: [],
			}),
		});

		strictEqual(bundle.contract.contextState(scratch).clioMd, "ok");
	});

	it("preserves an existing blanket .clio gitignore entry", async () => {
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "mock-project", type: "module" }), "utf8");
		writeFileSync(join(scratch, "tsconfig.json"), "{}", "utf8");
		writeFileSync(join(scratch, ".gitignore"), "node_modules\n.clio/\n", "utf8");

		await runBootstrap({
			cwd: scratch,
			confirmGitignore: () => false,
			modelId: "stub-model",
			now: () => new Date("2026-05-01T00:00:00.000Z"),
			generate: () => ({
				projectName: "Mock Project",
				identity: "Mock Project is a dynamic test project.",
				conventions: [],
				invariants: [],
			}),
		});

		const gitignore = readFileSync(join(scratch, ".gitignore"), "utf8");
		strictEqual(gitignore.includes("node_modules"), true);
		ok(gitignore.split(/\r?\n/).includes(".clio/"));
		strictEqual(gitignore.includes(".clio/codewiki.json"), false);
		strictEqual(gitignore.includes(".clio/state.json"), false);
		strictEqual(gitignore.includes(".clio/handoffs/"), false);
	});

	it("recognizes root-anchored .clio gitignore entries as blanket ignores", async () => {
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "mock-project", type: "module" }), "utf8");
		writeFileSync(join(scratch, "tsconfig.json"), "{}", "utf8");
		writeFileSync(join(scratch, ".gitignore"), "node_modules\n/.clio/\n", "utf8");

		await runBootstrap({
			cwd: scratch,
			confirmGitignore: () => false,
			modelId: "stub-model",
			now: () => new Date("2026-05-01T00:00:00.000Z"),
			generate: () => ({
				projectName: "Mock Project",
				identity: "Mock Project is a dynamic test project.",
				conventions: [],
				invariants: [],
			}),
		});

		const gitignore = readFileSync(join(scratch, ".gitignore"), "utf8");
		strictEqual(gitignore.includes("/.clio/"), true);
		strictEqual(gitignore.split(/\r?\n/).filter((line) => line.endsWith(".clio/")).length, 1);
		strictEqual(gitignore.includes(".clio/codewiki.json"), false);
	});

	it("migrates a dynamic-only .clio gitignore block back to blanket .clio", async () => {
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "mock-project", type: "module" }), "utf8");
		writeFileSync(join(scratch, "tsconfig.json"), "{}", "utf8");
		writeFileSync(
			join(scratch, ".gitignore"),
			"node_modules\n.clio/codewiki.json\n.clio/state.json\n.clio/handoffs/\n",
			"utf8",
		);

		await runBootstrap({
			cwd: scratch,
			confirmGitignore: () => false,
			modelId: "stub-model",
			now: () => new Date("2026-05-01T00:00:00.000Z"),
			generate: () => ({
				projectName: "Mock Project",
				identity: "Mock Project is a dynamic test project.",
				conventions: [],
				invariants: [],
			}),
		});

		const gitignore = readFileSync(join(scratch, ".gitignore"), "utf8");
		ok(gitignore.split(/\r?\n/).includes(".clio/"));
		strictEqual(gitignore.includes(".clio/codewiki.json"), false);
		strictEqual(gitignore.includes(".clio/state.json"), false);
		strictEqual(gitignore.includes(".clio/handoffs/"), false);
	});

	it("context-clear removes accumulated artifacts while preserving user-authored context assets", async () => {
		mkdirSync(join(scratch, ".clio", "handoffs"), { recursive: true });
		mkdirSync(join(scratch, ".clio", "proposals"), { recursive: true });
		mkdirSync(join(scratch, ".clio", "agents"), { recursive: true });
		mkdirSync(join(scratch, ".clio", "skills"), { recursive: true });
		writeFileSync(join(scratch, "CLIO.md"), "# Project\n", "utf8");
		writeFileSync(join(scratch, ".clio", "codewiki.json"), "{}\n", "utf8");
		writeFileSync(join(scratch, ".clio", "state.json"), "{}\n", "utf8");
		writeFileSync(join(scratch, ".clio", "handoffs", "handoff-2026-05-01.md"), "handoff\n", "utf8");
		writeFileSync(join(scratch, ".clio", "proposals", "clio-md-2026-05-01.md"), "proposal\n", "utf8");
		writeFileSync(join(scratch, ".clio", "agents", "helper.md"), "# Helper\n", "utf8");
		writeFileSync(join(scratch, ".clio", "skills", "skill.md"), "# Skill\n", "utf8");

		const result = await runContextClear({ cwd: scratch, confirmContext: () => true });

		strictEqual(result.action, "cleared");
		strictEqual(existsSync(join(scratch, ".clio", "codewiki.json")), false);
		strictEqual(existsSync(join(scratch, ".clio", "state.json")), false);
		strictEqual(existsSync(join(scratch, ".clio", "handoffs")), false);
		strictEqual(existsSync(join(scratch, ".clio", "proposals")), false);
		strictEqual(existsSync(join(scratch, "CLIO.md")), true);
		strictEqual(existsSync(join(scratch, ".clio", "agents", "helper.md")), true);
		strictEqual(existsSync(join(scratch, ".clio", "skills", "skill.md")), true);
	});

	it("context-clear --all removes CLIO.md only after the extra confirmation", async () => {
		writeFileSync(join(scratch, "CLIO.md"), "# Project\n", "utf8");
		let result = await runContextClear({
			cwd: scratch,
			all: true,
			confirmContext: () => true,
			confirmAll: () => false,
		});
		strictEqual(result.action, "cleared");
		strictEqual(existsSync(join(scratch, "CLIO.md")), true);

		result = await runContextClear({
			cwd: scratch,
			all: true,
			confirmContext: () => true,
			confirmAll: () => true,
		});
		strictEqual(result.action, "cleared");
		strictEqual(existsSync(join(scratch, "CLIO.md")), false);
	});

	it("adopts provenance-rich agent context into CLIO.md and records source fingerprints", async () => {
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "mock-project", type: "module" }), "utf8");
		writeFileSync(join(scratch, "CLAUDE.md"), "- Prefer pnpm for package management.\n", "utf8");
		writeFileSync(join(scratch, "AGENTS.md"), "- Prefer npm for package management.\n", "utf8");
		mkdirSync(join(scratch, ".claude", "skills", "claude-skill"), { recursive: true });
		writeFileSync(
			join(scratch, ".claude", "skills", "claude-skill", "SKILL.md"),
			[
				"---",
				"name: claude-skill",
				"description: Use when reviewing Claude workflows.",
				"---",
				"",
				"- Prefer project-local Claude workflows when asked about Claude automation.",
				"",
			].join("\n"),
			"utf8",
		);
		mkdirSync(join(scratch, ".agents", "skills", "review-skill"), { recursive: true });
		writeFileSync(
			join(scratch, ".agents", "skills", "review-skill", "SKILL.md"),
			[
				"---",
				"name: review-skill",
				"description: Use when reviewing this project.",
				"---",
				"",
				"- Always run the local verification command before summarizing.",
				"",
			].join("\n"),
			"utf8",
		);
		mkdirSync(join(scratch, ".opencode", "skills", "opencode-skill"), { recursive: true });
		writeFileSync(
			join(scratch, ".opencode", "skills", "opencode-skill", "SKILL.md"),
			[
				"---",
				"name: opencode-skill",
				"description: Use when reviewing OpenCode workflows.",
				"---",
				"",
				"- Keep OpenCode skill resources local to the repository.",
				"",
			].join("\n"),
			"utf8",
		);
		mkdirSync(join(scratch, ".github", "skills", "copilot-skill"), { recursive: true });
		writeFileSync(
			join(scratch, ".github", "skills", "copilot-skill", "SKILL.md"),
			[
				"---",
				"name: copilot-skill",
				"description: Use when reviewing Copilot workflows.",
				"---",
				"",
				"- Keep Copilot skill guidance review focused.",
				"",
			].join("\n"),
			"utf8",
		);

		const result = await runBootstrap({
			cwd: scratch,
			adopt: true,
			confirmGitignore: () => true,
			modelId: "stub-model",
			now: () => new Date("2026-05-01T00:00:00.000Z"),
		});

		const clio = readFileSync(join(scratch, "CLIO.md"), "utf8");
		ok(clio.includes("## Imported agent context"), clio);
		ok(clio.includes("Sources: `CLAUDE.md`"), clio);
		ok(clio.includes("Claude Code skill (project): `.claude/skills/claude-skill/SKILL.md`"), clio);
		ok(clio.includes("Agent Skills skill (project): `.agents/skills/review-skill/SKILL.md`"), clio);
		ok(clio.includes("OpenCode skill (project): `.opencode/skills/opencode-skill/SKILL.md`"), clio);
		ok(clio.includes("GitHub Copilot skill (project): `.github/skills/copilot-skill/SKILL.md`"), clio);
		ok(clio.includes("Skipped conflicts"), clio);

		const state = readClioState(scratch);
		ok(state?.contextSources && state.contextSources.length >= 2);
		ok(state.contextSources.some((source) => source.provider === "claude-code" && source.kind === "skill"));
		ok(state.contextSources.some((source) => source.provider === "agents" && source.kind === "skill"));
		ok(state.contextSources.some((source) => source.provider === "opencode" && source.kind === "skill"));
		ok(state.contextSources.some((source) => source.provider === "copilot" && source.kind === "skill"));
		ok(state?.contextSourceHash);
		strictEqual(result.summary.adoption.mode, "adopt");
	});

	it("reserves the import budget for constitutions and retains nested directory scope", () => {
		writeFileSync(join(scratch, "AGENTS.md"), "- Always run the root verification command.\n", "utf8");
		mkdirSync(join(scratch, "src", "solver"), { recursive: true });
		writeFileSync(join(scratch, "src", "solver", "AGENTS.md"), "- Prefer MPI-aware tests for solver changes.\n", "utf8");
		for (let index = 0; index < 8; index += 1) {
			const dir = join(scratch, ".claude", "agents");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, `generic-${index}.md`),
				Array.from({ length: 4 }, (_, rule) => `- Always use generic helper ${index}-${rule}.`).join("\n"),
				"utf8",
			);
		}

		const scan = scanAgentConfigs({ cwd: scratch });
		const rootRule = scan.importedRules.find((rule) => rule.text.includes("root verification"));
		const nestedRule = scan.importedRules.find((rule) => rule.text.includes("MPI-aware"));
		ok(rootRule, "the root constitution survives a saturated auxiliary-source budget");
		deepStrictEqual(rootRule.directoryScopes, ["."]);
		deepStrictEqual(nestedRule?.directoryScopes, ["src/solver"]);
		ok(scan.sources.some((source) => source.displayPath === "src/solver/AGENTS.md"));
	});

	it("does not adopt bare filename or path inventory entries as agent rules", () => {
		writeFileSync(
			join(scratch, "AGENTS.md"),
			[
				"- permission-allow-once.png",
				"- `screens/permission-deny.png`",
				"- Allow the operator to review the proposed patch before writing.",
				"- Deny destructive commands unless the operator approves them.",
			].join("\n"),
			"utf8",
		);

		const scan = scanAgentConfigs({ cwd: scratch });
		deepStrictEqual(
			scan.importedRules.map((rule) => rule.text),
			[
				"Allow the operator to review the proposed patch before writing.",
				"Deny destructive commands unless the operator approves them.",
			],
		);
	});

	it("does not turn an incomplete workspace walk into a partial adoption snapshot", () => {
		const missing = join(scratch, "missing-workspace");
		throws(
			() => scanAgentConfigs({ cwd: missing }),
			(error: unknown) =>
				error instanceof WorkspaceEnumerationIncompleteError &&
				error.code === "WORKSPACE_ENUMERATION_INCOMPLETE" &&
				error.operation === "open-root",
		);
	});

	it("does not adopt unresolved skill-template variables as project rules", () => {
		mkdirSync(join(scratch, ".claude", "skills", "templated"), { recursive: true });
		writeFileSync(
			join(scratch, ".claude", "skills", "templated", "SKILL.md"),
			"- Always build `$APP_DIR` before continuing.\n- Prefer project-local verification.\n",
			"utf8",
		);

		const scan = scanAgentConfigs({ cwd: scratch });
		strictEqual(
			scan.importedRules.some((rule) => rule.text.includes("$APP_DIR")),
			false,
		);
		ok(scan.importedRules.some((rule) => rule.text.includes("project-local verification")));
	});

	it("filters README comments, banners, badges, and HTML before deriving identity", async () => {
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "banner-project", type: "module" }), "utf8");
		writeFileSync(
			join(scratch, "README.md"),
			[
				"<!-- mcp-name: should-not-be-identity -->",
				'<picture><img src="banner.png" alt="banner" /></picture>',
				"[![Build](https://example.invalid/badge.svg)](https://example.invalid/build)",
				"",
				"<p><strong>Banner Project</strong> is a scientific workflow engine for MPI applications.</p>",
			].join("\n"),
			"utf8",
		);

		await runBootstrap({ cwd: scratch, confirmGitignore: () => false });
		const clio = readFileSync(join(scratch, "CLIO.md"), "utf8");
		ok(clio.includes("scientific workflow engine for MPI applications"), clio);
		strictEqual(clio.includes("mcp-name"), false);
		strictEqual(clio.includes("badge.svg"), false);
		strictEqual(clio.includes("<picture>"), false);
	});

	it("detects supported agent context sources added after the recorded snapshot", () => {
		writeFileSync(join(scratch, "CLAUDE.md"), "- Prefer pnpm for package management.\n", "utf8");
		const recorded = scanAgentConfigs({ cwd: scratch }).sourceSnapshots;

		strictEqual(adoptionSourcesChanged(recorded), false);
		writeFileSync(join(scratch, "AGENTS.md"), "- Always run focused tests before handoff.\n", "utf8");
		strictEqual(adoptionSourcesChanged(recorded), true);
	});

	it("records an empty adoption baseline so the first supported source makes context stale", async () => {
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "empty-adoption", type: "module" }), "utf8");

		await runBootstrap({
			cwd: scratch,
			adopt: true,
			confirmGitignore: () => true,
			now: () => new Date("2026-05-01T00:00:00.000Z"),
		});

		const state = readClioState(scratch);
		ok(state?.contextSources);
		strictEqual(state.contextSources.length, 0);
		ok(state.contextSourceHash);
		strictEqual(adoptionSourcesChanged(state.contextSources, { cwd: scratch }), false);

		writeFileSync(join(scratch, "CLAUDE.md"), "- Always run focused tests before handoff.\n", "utf8");
		strictEqual(adoptionSourcesChanged(state.contextSources, { cwd: scratch }), true);

		const bundle = createContextBundle({ bus: createSafeEventBus(), getContract: () => undefined });
		strictEqual(bundle.contract.contextState(scratch).clioMd, "stale");
	});

	it("tracks rejected agent context so changed rejection provenance becomes stale", async () => {
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "rejected-adoption", type: "module" }), "utf8");
		writeFileSync(join(scratch, "AGENTS.md"), 'api_key = "not-a-real-secret-value"\n', "utf8");

		await runBootstrap({
			cwd: scratch,
			adopt: true,
			confirmGitignore: () => true,
		});

		const clio = readFileSync(join(scratch, "CLIO.md"), "utf8");
		ok(clio.includes("### Rejected sources"), clio);
		ok(clio.includes("skipped secret-like content"), clio);
		const state = readClioState(scratch);
		ok(state?.contextSources);
		strictEqual(state.contextSources.length, 1);
		strictEqual(state.contextSources[0]?.status, "rejected");
		strictEqual(adoptionSourcesChanged(state.contextSources, { cwd: scratch }), false);

		writeFileSync(join(scratch, "AGENTS.md"), 'api_key = "another-fake-secret-value"\n', "utf8");
		strictEqual(adoptionSourcesChanged(state.contextSources, { cwd: scratch }), true);
	});

	it("rejects bare adoption for malformed CLIO.md without changing it or recording sources", async () => {
		writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "malformed-adoption", type: "module" }), "utf8");
		writeFileSync(join(scratch, "CLAUDE.md"), "- Always run focused tests before handoff.\n", "utf8");
		const malformed = "This handbook has no project heading.\n";
		writeFileSync(join(scratch, "CLIO.md"), malformed, "utf8");
		const stdout: string[] = [];

		await rejects(
			() =>
				runBootstrap({
					cwd: scratch,
					adopt: true,
					confirmGitignore: () => true,
					io: { stdout: (text) => stdout.push(text), stderr: () => {} },
				}),
			/cannot refresh Imported agent context because CLIO\.md is malformed.*--apply or --rewrite/,
		);

		strictEqual(readFileSync(join(scratch, "CLIO.md"), "utf8"), malformed);
		strictEqual(readClioState(scratch)?.contextSources, undefined);
		strictEqual(readClioState(scratch)?.contextSourceHash, undefined);
		strictEqual(
			stdout.some((line) => line.includes("adoption imported")),
			false,
		);
	});
});
