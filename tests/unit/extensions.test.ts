import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resetXdgCache } from "../../src/core/xdg.js";
import {
	disableExtension,
	discoverExtensionPackages,
	enabledExtensionResourceRoots,
	enableExtension,
	installExtension,
	listInstalledExtensions,
	removeExtension,
} from "../../src/domains/extensions/index.js";
import { createResourcesLoader } from "../../src/domains/resources/index.js";

let scratch: string;
let oldEnv: NodeJS.ProcessEnv;
let oldCwd: string;

function writeExtension(root: string, id: string, description: string): void {
	mkdirSync(join(root, "skills", "review"), { recursive: true });
	mkdirSync(join(root, "prompts"), { recursive: true });
	writeFileSync(
		join(root, "clio-extension.yaml"),
		[
			"manifestVersion: 1",
			`id: ${id}`,
			`name: ${id}`,
			"version: 1.0.0",
			`description: ${description}`,
			"resources:",
			"  skills: skills",
			"  prompts: prompts",
			"",
		].join("\n"),
		"utf8",
	);
	writeFileSync(
		join(root, "skills", "review", "SKILL.md"),
		"---\nname: review\ndescription: Extension review\n---\nUse extension review.\n",
		"utf8",
	);
	writeFileSync(join(root, "prompts", "review.md"), "---\ndescription: Extension prompt\n---\nExtension $1\n", "utf8");
}

beforeEach(() => {
	oldEnv = { ...process.env };
	oldCwd = process.cwd();
	scratch = mkdtempSync(join(tmpdir(), "clio-ext-"));
	process.env.CLIO_HOME = join(scratch, "home");
	process.env.CLIO_CONFIG_DIR = join(scratch, "config");
	process.env.CLIO_DATA_DIR = join(scratch, "data");
	process.env.CLIO_CACHE_DIR = join(scratch, "cache");
	resetXdgCache();
	process.chdir(scratch);
});

afterEach(() => {
	process.env = oldEnv;
	process.chdir(oldCwd);
	resetXdgCache();
	rmSync(scratch, { recursive: true, force: true });
});

describe("extensions domain", () => {
	it("tracks install, disable, enable, and remove state", () => {
		const source = join(scratch, "source");
		writeExtension(source, "lab-pack", "Lab package");

		const installed = installExtension(source);
		strictEqual(installed.diagnostics.length, 0);
		strictEqual(installed.extension?.id, "lab-pack");
		strictEqual(listInstalledExtensions().length, 1);

		const disabled = disableExtension("lab-pack");
		strictEqual(disabled.extension?.enabled, false);
		strictEqual(enabledExtensionResourceRoots("skills").length, 0);

		const enabled = enableExtension("lab-pack");
		strictEqual(enabled.extension?.enabled, true);
		strictEqual(enabledExtensionResourceRoots("skills").length, 1);

		const removed = removeExtension("lab-pack");
		strictEqual(removed.removed?.id, "lab-pack");
		strictEqual(listInstalledExtensions().length, 0);
	});

	it("uses project extensions ahead of user extensions with the same id", () => {
		const userSource = join(scratch, "user-source");
		const projectSource = join(scratch, "project-source");
		const repo = join(scratch, "repo");
		mkdirSync(repo, { recursive: true });
		writeExtension(userSource, "shared-pack", "User package");
		writeExtension(projectSource, "shared-pack", "Project package");

		installExtension(userSource, { scope: "user", cwd: repo });
		installExtension(projectSource, { scope: "project", cwd: repo });

		const all = listInstalledExtensions(repo, { all: true });
		strictEqual(all.length, 2);
		strictEqual(all.find((entry) => entry.scope === "project")?.effective, true);
		strictEqual(all.find((entry) => entry.scope === "user")?.overriddenBy, "project");
		const roots = enabledExtensionResourceRoots("skills", repo);
		strictEqual(roots.length, 1);
		strictEqual(roots[0]?.scope, "project");
	});

	it("reports malformed packages during discovery", () => {
		const source = join(scratch, "bad");
		mkdirSync(source, { recursive: true });
		writeFileSync(join(source, "clio-extension.yaml"), "manifestVersion: 1\nid: Bad Id\n", "utf8");

		const candidates = discoverExtensionPackages(source);

		strictEqual(candidates.length, 1);
		strictEqual(candidates[0]?.valid, false);
		ok(candidates[0]?.diagnostics.some((diag) => diag.type === "error"));
	});

	it("loads extension resources while preserving user and project override precedence", () => {
		const source = join(scratch, "source");
		const repo = join(scratch, "repo");
		mkdirSync(join(repo, ".clio", "prompts"), { recursive: true });
		writeExtension(source, "lab-pack", "Lab package");
		writeFileSync(
			join(repo, ".clio", "prompts", "review.md"),
			"---\ndescription: Project prompt\n---\nProject $1\n",
			"utf8",
		);
		installExtension(source, { cwd: repo });

		const resources = createResourcesLoader({ cwd: repo });
		const skills = resources.skills(repo);
		const prompts = resources.prompts(repo);

		strictEqual(skills.items[0]?.sourceInfo.scope, "package");
		strictEqual(prompts.items.find((entry) => entry.name === "review")?.description, "Project prompt");
		ok(prompts.diagnostics.some((diag) => diag.type === "collision"));
	});
});
