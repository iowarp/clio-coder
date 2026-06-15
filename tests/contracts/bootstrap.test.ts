import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { parseClioMd, renderProjectContextFragment, serializeClioMd } from "../../src/domains/context/clio-md.js";
import { createContextBundle } from "../../src/domains/context/extension.js";
import { fallbackBootstrapOutput, runBootstrap, runContextClear } from "../../src/domains/context/index.js";
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
			modelId: "stub-model",
			now: () => new Date("2026-05-01T00:00:00.000Z"),
			generate: () => ({
				projectName: "Mock Project",
				identity: "Mock Project is a dynamic test project.",
				conventions: ["Keep files short."],
				invariants: [],
			}),
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

		const state = readClioState(scratch);
		strictEqual(state?.projectType, "typescript");
		strictEqual(state?.lastIndexedAt, "2026-05-01T00:00:00.000Z");
	});

	it("preserves existing CLIO.md by default without a model rewrite", async () => {
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

		await runBootstrap({
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
		strictEqual(generated, false);
		ok(phases.includes("codewiki:completed"));
		ok(phases.includes("clio-md:completed"));
		ok(phases.includes("done:completed"));
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
});
