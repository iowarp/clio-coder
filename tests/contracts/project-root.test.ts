import { strictEqual } from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { clioProjectRoot } from "../../src/core/project-root.js";
import { readLayeredSettings } from "../../src/core/settings-layers.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import { loadProjectRules, selectActiveRules } from "../../src/domains/context/project-rules.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

/** A repository with its `.git` marker as a file, the shape of a worktree, which the temp-root git guard allows. */
function repository(root: string): { repo: string; deep: string } {
	const repo = join(root, "repo");
	const deep = join(repo, "packages", "foo");
	mkdirSync(deep, { recursive: true });
	writeFileSync(join(repo, ".git"), "gitdir: /nowhere\n");
	return { repo, deep };
}

test("a project lookup walks to the repository root and no further", async (t) => {
	const env = await isolateClioEnv("project-root-");
	t.after(() => env.restore());
	const { repo, deep } = repository(env.dir);
	mkdirSync(join(env.dir, ".clio-coder", "skills"), { recursive: true });

	strictEqual(clioProjectRoot(deep, "skills"), repo, "a missing entry belongs at the repository root");

	mkdirSync(join(repo, ".clio-coder", "skills"), { recursive: true });
	strictEqual(clioProjectRoot(deep, "skills"), repo);

	// Generated files under the subdirectory must not hide the root's configuration.
	mkdirSync(join(deep, ".clio-coder", "runs"), { recursive: true });
	strictEqual(clioProjectRoot(deep, "skills"), repo);

	mkdirSync(join(deep, ".clio-coder", "skills"), { recursive: true });
	strictEqual(clioProjectRoot(deep, "skills"), deep, "the nearest entry wins");
});

test("a rule's paths stay rooted at the directory holding the rule", async (t) => {
	const env = await isolateClioEnv("project-root-");
	t.after(() => env.restore());
	const { repo, deep } = repository(env.dir);
	mkdirSync(join(repo, ".clio-coder", "rules"), { recursive: true });
	writeFileSync(join(repo, ".clio-coder", "rules", "foo.md"), '---\npaths: ["packages/foo/**"]\n---\nFoo rule.\n');
	const { rules } = loadProjectRules(deep);
	strictEqual(
		selectActiveRules(rules, ["src/index.ts"]).length,
		1,
		"a path under the session's cwd is under the rule's",
	);
	strictEqual(selectActiveRules(loadProjectRules(repo).rules, ["src/index.ts"]).length, 0);
});

test("outside a repository only the working directory counts", async (t) => {
	const env = await isolateClioEnv("project-root-");
	t.after(() => env.restore());
	const parent = join(env.dir, "plain");
	const child = join(parent, "child");
	mkdirSync(child, { recursive: true });
	mkdirSync(join(parent, ".clio-coder", "skills"), { recursive: true });
	strictEqual(clioProjectRoot(child, "skills"), child);
	strictEqual(clioProjectRoot(parent, "skills"), parent);
});

test("a subdirectory session reads the root's settings under the root's approval", async (t) => {
	const env = await isolateClioEnv("project-root-");
	t.after(() => env.restore());
	const { repo, deep } = repository(env.dir);
	mkdirSync(join(repo, ".clio-coder"), { recursive: true });
	writeFileSync(join(repo, ".clio-coder", "settings.yaml"), "interface:\n  exitSummary: off\n");

	const review = captureProjectSurface(repo, "settings");
	if (review.contentHash === null) throw new Error("the surface must hash");
	recordProjectSurfaceTrust(repo, "settings", review.contentHash);

	const fromSubdirectory = captureProjectSurface(deep, "settings");
	strictEqual(fromSubdirectory.workspaceRoot, realpathSync(repo));
	strictEqual(fromSubdirectory.verdict, "trusted");
	const layered = readLayeredSettings(deep);
	strictEqual(layered.settings.interface.exitSummary, "off");
	strictEqual(layered.sources["interface.exitSummary"], "project");
});
