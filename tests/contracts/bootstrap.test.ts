import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseClioMd, renderProjectContextFragment, serializeClioMd } from "../../src/domains/context/clio-md.js";
import { runBootstrap } from "../../src/domains/context/index.js";
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

	it("rejects more than six convention bullets", () => {
		const bullets = Array.from({ length: 7 }, (_, index) => `- rule ${index}`).join("\n");
		const parsed = parseClioMd(`# Sample\n\nSample is a project with too many rules.\n\n## Conventions\n\n${bullets}\n`);
		strictEqual(parsed.ok, false);
	});

	it("bootstraps a directory, generates state, CLIO.md, and ignores .clio in gitignore", async () => {
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
		ok(readFileSync(join(scratch, ".gitignore"), "utf8").includes(".clio/"));

		strictEqual(result.projectType, "typescript");
		strictEqual(result.summary.action, "wrote");

		const state = readClioState(scratch);
		strictEqual(state?.projectType, "typescript");
		strictEqual(state?.lastIndexedAt, "2026-05-01T00:00:00.000Z");
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
