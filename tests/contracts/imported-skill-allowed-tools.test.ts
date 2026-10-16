import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSkills } from "../../src/domains/resources/skills/loader.js";

// An imported Claude skill speaks Claude's tool names: `Bash(git status:*)`
// grants a scoped shell there and named no Clio tool here, so the skill's
// allowed-tools dropped bash. Native skills still resolve as declared.

test("an imported skill's Bash(...) entry maps to bash while a native skill resolves as declared", () => {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-imported-skill-tools-"));
	try {
		const frontmatter = "allowed-tools: Bash(git status:*), Read";
		for (const [dir, name] of [
			["imported", "status-check"],
			["native", "native-check"],
		] as const) {
			mkdirSync(join(root, dir, name), { recursive: true });
			writeFileSync(
				join(root, dir, name, "SKILL.md"),
				`---\nname: ${name}\ndescription: Check status.\n${frontmatter}\n---\nRun it.\n`,
			);
		}
		const { items } = loadSkills({
			roots: [
				{ path: join(root, "imported"), scope: "package", trusted: true, foreign: true },
				{ path: join(root, "native"), scope: "project", trusted: true },
			],
		});
		assert.deepEqual(items.find((skill) => skill.name === "status-check")?.allowedTools, ["bash", "read"]);
		assert.deepEqual(items.find((skill) => skill.name === "native-check")?.allowedTools, ["read"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
