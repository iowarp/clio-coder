import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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
