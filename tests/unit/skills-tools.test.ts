import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createReadSkillTool, createSkillTool } from "../../src/tools/skills.js";

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "clio-skills-tool-"));
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

describe("skills tools", () => {
	it("reads a project skill by name from .clio/skills", async () => {
		const skillDir = join(scratch, ".clio", "skills", "review-checks");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: review-checks\ndescription: Review checks\n---\n\nRun review checks before merge.\n",
			"utf8",
		);
		const readSkill = createReadSkillTool({ getCwd: () => scratch });

		const result = await readSkill.run({ name: "review-checks" });
		strictEqual(result.kind, "ok");
		if (result.kind === "ok") {
			const expectedPath = join(skillDir, "SKILL.md");
			ok(result.output.includes(`<skill name="review-checks" scope="project">`));
			ok(result.output.includes(`path: ${expectedPath}`));
			ok(result.output.includes("Run review checks before merge."));
			strictEqual(result.details?.path, expectedPath);
			strictEqual(result.details?.baseDir, skillDir);
		}
	});

	it("creates a project-scope skill and blocks overwrite unless requested", async () => {
		const createSkill = createSkillTool({ getCwd: () => scratch });

		const first = await createSkill.run({
			name: "onboarding-flow",
			description: "Reusable onboarding workflow steps.",
			body: "Initial body for onboarding.\n",
		});
		strictEqual(first.kind, "ok");
		if (first.kind !== "ok") return;

		const skillPath = join(scratch, ".clio", "skills", "onboarding-flow", "SKILL.md");
		strictEqual(first.details?.path, skillPath);
		strictEqual(first.details?.scope, "project");
		strictEqual(existsSync(skillPath), true);
		strictEqual(readFileSync(skillPath, "utf8").includes("Initial body for onboarding."), true);

		const blocked = await createSkill.run({
			name: "onboarding-flow",
			description: "Another description.",
			body: "Second body should not write.\n",
		});
		strictEqual(blocked.kind, "error");
		if (blocked.kind === "error") {
			strictEqual(blocked.message, `create_skill: skill already exists: ${skillPath}`);
		}

		const overwritten = await createSkill.run({
			name: "onboarding-flow",
			description: "Reusable onboarding workflow steps.",
			body: "Overwritten body for onboarding.\n",
			overwrite: true,
		});
		strictEqual(overwritten.kind, "ok");
		strictEqual(readFileSync(skillPath, "utf8").includes("Overwritten body for onboarding."), true);
	});
});
