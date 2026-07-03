import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

// BUG-011: `skills validate` computed success as "at least one skill and no error
// diagnostic". Malformed files load nothing but only warn, and a name collision
// drops a skill while emitting a collision diagnostic, so a mixed or colliding
// catalog exited 0 with ok:true. Validation now fails when a scanned file loads
// nothing or a collision drops a skill, while still passing benign warnings.

function seedCatalog(root: string, files: Record<string, string>): string {
	for (const [rel, content] of Object.entries(files)) {
		const full = join(root, rel);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
	return root;
}

describe("contracts/skills-cli validate", () => {
	const scratch = makeScratchHome("clio-skills-cli-");
	after(() => scratch.cleanup());

	it("fails a catalog with a malformed file or a name collision, passing clean diagnostics", async () => {
		const mixed = seedCatalog(join(scratch.dir, "mixed"), {
			"valid/SKILL.md": "---\nname: valid-skill\ndescription: valid description\n---\nBody\n",
			"bad/SKILL.md": "# missing frontmatter\n",
		});
		const collide = seedCatalog(join(scratch.dir, "collide"), {
			"one/SKILL.md": "---\nname: duplicate\ndescription: first description\n---\nFirst\n",
			"two/SKILL.md": "---\nname: duplicate\ndescription: second description\n---\nSecond\n",
		});

		for (const path of [mixed, collide]) {
			const result = await runCli(["skills", "validate", path, "--json"], { env: scratch.env });
			strictEqual(result.code, 1, `stderr=${result.stderr}`);
			strictEqual(result.stderr, "", `unexpected stderr: ${result.stderr}`);
			const payload = JSON.parse(result.stdout);
			strictEqual(payload.ok, false);
			ok(payload.diagnostics.some((diag: { type: string }) => diag.type === "warning" || diag.type === "collision"));
		}
	});

	// A clean skill whose folder differs from its frontmatter name loads with only
	// an informational warning and must still validate.
	it("passes a valid skill even when its folder name differs from the frontmatter name", async () => {
		const good = seedCatalog(join(scratch.dir, "good"), {
			"folderx/SKILL.md": "---\nname: named-skill\ndescription: a valid description here\n---\nBody\n",
		});
		const result = await runCli(["skills", "validate", good, "--json"], { env: scratch.env });
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		strictEqual(JSON.parse(result.stdout).ok, true);
	});
});

describe("contracts/skills-cli install by marketplace name", () => {
	const scratch = makeScratchHome("clio-skills-install-");
	after(() => scratch.cleanup());

	const catalogBody = "---\nname: demo-skill\ndescription: demo skill from the catalog\n---\nCatalog body\n";

	function seedMarketplace(): NodeJS.ProcessEnv {
		const catalog = seedCatalog(join(scratch.dir, "catalog"), { "demo-skill/SKILL.md": catalogBody });
		return { ...scratch.env, CLIO_SKILL_CATALOG_DIR: catalog };
	}

	it("resolves a bare name through the local marketplace into the project scope", async () => {
		const project = join(scratch.dir, "project-bare");
		mkdirSync(project, { recursive: true });

		const result = await runCli(["skills", "install", "demo-skill"], { env: seedMarketplace(), cwd: project });
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		const installed = readFileSync(join(project, ".clio", "skills", "demo-skill", "SKILL.md"), "utf8");
		ok(installed.includes("demo skill from the catalog"), "installed copy must come from the catalog entry");
	});

	it("fails a bare name that is neither a local path nor a marketplace entry", async () => {
		const project = join(scratch.dir, "project-missing");
		mkdirSync(project, { recursive: true });

		const result = await runCli(["skills", "install", "no-such-skill"], { env: seedMarketplace(), cwd: project });
		strictEqual(result.code, 1, `stdout=${result.stdout}`);
		ok(
			result.stderr.includes("neither an existing local path nor available in the local marketplace"),
			`stderr=${result.stderr}`,
		);
	});

	it("prefers an existing local path over a same-named marketplace entry", async () => {
		const project = join(scratch.dir, "project-local");
		seedCatalog(project, {
			"demo-skill/SKILL.md": "---\nname: demo-skill\ndescription: demo skill from the local path\n---\nLocal body\n",
		});

		const result = await runCli(["skills", "install", "demo-skill"], { env: seedMarketplace(), cwd: project });
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		const installed = readFileSync(join(project, ".clio", "skills", "demo-skill", "SKILL.md"), "utf8");
		ok(installed.includes("demo skill from the local path"), "a local path must win over the marketplace entry");
	});

	it("never overwrites an existing install without --force", async () => {
		const project = join(scratch.dir, "project-force");
		mkdirSync(project, { recursive: true });
		const env = seedMarketplace();

		const first = await runCli(["skills", "install", "demo-skill"], { env, cwd: project });
		strictEqual(first.code, 0, `stderr=${first.stderr}`);
		const second = await runCli(["skills", "install", "demo-skill"], { env, cwd: project });
		strictEqual(second.code, 1, "reinstalling without --force must fail");
		ok(second.stderr.includes("already installed"), `stderr=${second.stderr}`);
		const forced = await runCli(["skills", "install", "demo-skill", "--force"], { env, cwd: project });
		strictEqual(forced.code, 0, `stderr=${forced.stderr}`);
	});
});

describe("contracts/skills-cli search diagnostics", () => {
	const scratch = makeScratchHome("clio-skills-search-");
	after(() => scratch.cleanup());

	function seedEnv(): { env: NodeJS.ProcessEnv; project: string } {
		const catalog = seedCatalog(join(scratch.dir, "catalog"), {
			"demo-skill/SKILL.md": "---\nname: demo-skill\ndescription: demo skill from the catalog\n---\nCatalog body\n",
		});
		const brokenIndex = join(scratch.dir, "skill-marketplace.json");
		writeFileSync(brokenIndex, "{ not json", "utf8");
		const project = join(scratch.dir, "project");
		mkdirSync(project, { recursive: true });
		return {
			env: { ...scratch.env, CLIO_SKILL_CATALOG_DIR: catalog, CLIO_SKILL_MARKETPLACE_INDEX: brokenIndex },
			project,
		};
	}

	it("surfaces marketplace discovery diagnostics on stderr without hiding matches", async () => {
		const { env, project } = seedEnv();
		const result = await runCli(["skills", "search", "demo"], { env, cwd: project });
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		ok(result.stdout.includes("demo-skill"), "catalog match must still be listed");
		ok(result.stderr.includes("skill marketplace index unreadable"), `stderr=${result.stderr}`);
	});

	it("returns marketplace diagnostics in the --json payload", async () => {
		const { env, project } = seedEnv();
		const result = await runCli(["skills", "search", "demo", "--json"], { env, cwd: project });
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		const payload = JSON.parse(result.stdout);
		strictEqual(payload.marketplace.length, 1);
		ok(Array.isArray(payload.diagnostics), "loader diagnostics must be part of the payload");
		ok(
			payload.marketplaceDiagnostics.some((message: string) => message.includes("index unreadable")),
			`marketplaceDiagnostics=${JSON.stringify(payload.marketplaceDiagnostics)}`,
		);
	});
});
