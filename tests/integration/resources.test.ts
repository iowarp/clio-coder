import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadDomains } from "../../src/core/domain-loader.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { ConfigDomainModule } from "../../src/domains/config/index.js";
import { ContextDomainModule } from "../../src/domains/context/index.js";
import { ensureClioState } from "../../src/domains/lifecycle/index.js";
import { ModesDomainModule } from "../../src/domains/modes/index.js";
import { createPromptsDomainModule, type PromptsContract } from "../../src/domains/prompts/index.js";
import { type ResourcesContract, ResourcesDomainModule } from "../../src/domains/resources/index.js";
import { SafetyDomainModule } from "../../src/domains/safety/index.js";

let scratch: string;
let oldEnv: NodeJS.ProcessEnv;
let oldCwd: string;

beforeEach(() => {
	oldEnv = { ...process.env };
	oldCwd = process.cwd();
	scratch = mkdtempSync(join(tmpdir(), "clio-resources-"));
	process.chdir(scratch);
	process.env.CLIO_HOME = join(scratch, "home");
	process.env.CLIO_DATA_DIR = join(scratch, "data");
	process.env.CLIO_CONFIG_DIR = join(scratch, "config");
	process.env.CLIO_CACHE_DIR = join(scratch, "cache");
	resetXdgCache();
	ensureClioState();
});

afterEach(() => {
	process.env = oldEnv;
	process.chdir(oldCwd);
	resetXdgCache();
	rmSync(scratch, { recursive: true, force: true });
});

describe("resources domain", () => {
	it("loads before context and exposes the context-file primitive", async () => {
		const repo = join(scratch, "repo");
		mkdirSync(repo, { recursive: true });
		writeFileSync(join(repo, "AGENTS.md"), "resource context", "utf8");

		const loaded = await loadDomains([ConfigDomainModule, ResourcesDomainModule, ContextDomainModule]);
		try {
			strictEqual(loaded.loaded.join("|"), "config|resources|context");
			const resources = loaded.getContract<ResourcesContract>("resources");
			ok(resources, "resources contract should be available");
			const files = resources.contextFiles(repo);
			strictEqual(files.length, 1);
			strictEqual(files[0]?.name, "AGENTS.md");
			const rendered = resources.renderContextFiles(files, repo);
			ok(rendered.includes("resource context"), rendered);
		} finally {
			await loaded.stop();
		}
	});

	it("loads prompt templates from user and project resource roots with project override", async () => {
		const repo = join(scratch, "repo");
		const configDir = process.env.CLIO_CONFIG_DIR;
		ok(configDir, "CLIO_CONFIG_DIR should be set by the test harness");
		mkdirSync(join(configDir, "prompts"), { recursive: true });
		mkdirSync(join(repo, ".clio", "prompts"), { recursive: true });
		writeFileSync(
			join(configDir, "prompts", "review.md"),
			"---\ndescription: User review\nargument-hint: <file>\n---\nuser review $1\n",
			"utf8",
		);
		writeFileSync(
			join(configDir, "prompts", "explain.md"),
			"---\ndescription: Explain code\nargument-hint: <symbol>\n---\nExplain $1.\n",
			"utf8",
		);
		writeFileSync(
			join(repo, ".clio", "prompts", "review.md"),
			"---\ndescription: Project review\nargument-hint: <file> [focus]\n---\nProject review $1 with $" + "{@:2}.\n",
			"utf8",
		);

		const loaded = await loadDomains([ConfigDomainModule, ResourcesDomainModule]);
		try {
			const resources = loaded.getContract<ResourcesContract>("resources");
			ok(resources, "resources contract should be available");
			const prompts = resources.prompts(repo);
			strictEqual(prompts.items.map((prompt) => prompt.name).join(","), "explain,review");
			const review = prompts.items.find((prompt) => prompt.name === "review");
			strictEqual(review?.description, "Project review");
			strictEqual(review?.argumentHint, "<file> [focus]");
			strictEqual(review?.sourceInfo.scope, "project");
			strictEqual(prompts.diagnostics.filter((diag) => diag.type === "collision").length, 1);

			const expanded = resources.expandPromptTemplate('/review "src/app.ts" performance security', repo);
			strictEqual(expanded.expanded, true);
			strictEqual(expanded.text, "Project review src/app.ts with performance security.");
		} finally {
			await loaded.stop();
		}
	});

	it("loads skills from user and project resource roots and expands explicit invocations", async () => {
		const repo = join(scratch, "repo");
		const configDir = process.env.CLIO_CONFIG_DIR;
		ok(configDir, "CLIO_CONFIG_DIR should be set by the test harness");
		mkdirSync(join(configDir, "skills", "review"), { recursive: true });
		mkdirSync(join(repo, ".clio", "skills", "review"), { recursive: true });
		writeFileSync(
			join(configDir, "skills", "review", "SKILL.md"),
			"---\nname: review\ndescription: User review\n---\nUse user review.\n",
			"utf8",
		);
		writeFileSync(
			join(repo, ".clio", "skills", "review", "SKILL.md"),
			"---\nname: review\ndescription: Project review\n---\nUse project review.\n",
			"utf8",
		);

		const loaded = await loadDomains([ConfigDomainModule, ResourcesDomainModule]);
		try {
			const resources = loaded.getContract<ResourcesContract>("resources");
			ok(resources, "resources contract should be available");
			const skills = resources.skills(repo);
			strictEqual(skills.items.length, 1);
			strictEqual(skills.items[0]?.description, "Project review");
			strictEqual(skills.items[0]?.sourceInfo.scope, "project");
			strictEqual(skills.diagnostics.filter((diag) => diag.type === "collision").length, 1);

			const expanded = resources.expandSkillInvocation("/skill:review src/app.ts", repo);
			strictEqual(expanded.expanded, true);
			ok(expanded.text.includes('<skill name="review"'), expanded.text);
			ok(expanded.text.includes("Use project review."), expanded.text);
			ok(expanded.text.endsWith("\n\nsrc/app.ts"), expanded.text);
		} finally {
			await loaded.stop();
		}
	});

	it("keeps CLIO.md-first prompt compilation while the resources domain is loaded", async () => {
		const repo = join(scratch, "repo");
		mkdirSync(repo, { recursive: true });
		writeFileSync(
			join(repo, "CLIO.md"),
			[
				"# Resource Test",
				"",
				"Use the CLIO project guide.",
				"",
				"## Conventions",
				"",
				"- Prefer the local guide.",
				"",
			].join("\n"),
			"utf8",
		);
		writeFileSync(join(repo, "AGENTS.md"), "this sibling file must not be injected after bootstrap", "utf8");

		const loaded = await loadDomains([
			ConfigDomainModule,
			ResourcesDomainModule,
			ContextDomainModule,
			SafetyDomainModule,
			ModesDomainModule,
			createPromptsDomainModule(),
		]);
		try {
			const prompts = loaded.getContract<PromptsContract>("prompts");
			ok(prompts, "prompts contract should be available");
			const compiled = await prompts.compileForTurn({
				cwd: repo,
				overrideMode: "default",
				safetyLevel: "auto-edit",
				dynamicInputs: {},
			});
			ok(compiled.text.includes("Use the CLIO project guide."), compiled.text);
			strictEqual(compiled.text.includes("this sibling file must not be injected"), false);
		} finally {
			await loaded.stop();
		}
	});

	it("preserves no-context-files suppression through prompts options", async () => {
		const repo = join(scratch, "repo");
		mkdirSync(repo, { recursive: true });
		writeFileSync(join(repo, "CLIO.md"), "# Suppressed\n\nThis should not appear.\n", "utf8");

		const loaded = await loadDomains([
			ConfigDomainModule,
			ResourcesDomainModule,
			ContextDomainModule,
			SafetyDomainModule,
			ModesDomainModule,
			createPromptsDomainModule({ noContextFiles: true }),
		]);
		try {
			const prompts = loaded.getContract<PromptsContract>("prompts");
			ok(prompts, "prompts contract should be available");
			const compiled = await prompts.compileForTurn({
				cwd: repo,
				overrideMode: "default",
				safetyLevel: "auto-edit",
				dynamicInputs: {},
			});
			strictEqual(compiled.text.includes("This should not appear."), false);
			strictEqual(compiled.text.includes("# Project"), false);
		} finally {
			await loaded.stop();
		}
	});
});
