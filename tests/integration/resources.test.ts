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
