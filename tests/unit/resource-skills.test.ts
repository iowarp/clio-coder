import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { expandSkillInvocationInput, loadSkills } from "../../src/domains/resources/index.js";

let scratch: string;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "clio-skills-"));
});

afterEach(() => {
	rmSync(scratch, { recursive: true, force: true });
});

describe("resources skills", () => {
	it("loads skill directories and lets project roots override user roots", () => {
		const userRoot = join(scratch, "user");
		const projectRoot = join(scratch, "project");
		mkdirSync(join(userRoot, "review"), { recursive: true });
		mkdirSync(join(projectRoot, "review"), { recursive: true });
		writeFileSync(
			join(userRoot, "review", "SKILL.md"),
			"---\nname: review\ndescription: User review\n---\nUse user review.\n",
			"utf8",
		);
		writeFileSync(
			join(projectRoot, "review", "SKILL.md"),
			"---\nname: review\ndescription: Project review\n---\nUse project review.\n",
			"utf8",
		);

		const skills = loadSkills({
			roots: [
				{ path: userRoot, scope: "user" },
				{ path: projectRoot, scope: "project" },
			],
		});

		strictEqual(skills.items.length, 1);
		strictEqual(skills.items[0]?.name, "review");
		strictEqual(skills.items[0]?.description, "Project review");
		strictEqual(skills.items[0]?.sourceInfo.scope, "project");
		strictEqual(skills.diagnostics.filter((diag) => diag.type === "collision").length, 1);
	});

	it("skips skills without descriptions but records a diagnostic", () => {
		const root = join(scratch, "skills");
		mkdirSync(join(root, "empty"), { recursive: true });
		writeFileSync(join(root, "empty", "SKILL.md"), "---\nname: empty\n---\nbody\n", "utf8");

		const skills = loadSkills({ roots: [{ path: root, scope: "user" }] });

		strictEqual(skills.items.length, 0);
		ok(skills.diagnostics.some((diag) => diag.message.includes("description is required")));
	});

	it("expands explicit skill invocations into a skill block plus raw args", () => {
		const root = join(scratch, "skills");
		mkdirSync(join(root, "review"), { recursive: true });
		writeFileSync(
			join(root, "review", "SKILL.md"),
			"---\nname: review\ndescription: Review files\n---\nRead references before reviewing.\n",
			"utf8",
		);
		const skills = loadSkills({ roots: [{ path: root, scope: "user" }] });

		const expanded = expandSkillInvocationInput("/skill:review src/app.ts", skills);

		strictEqual(expanded.expanded, true);
		strictEqual(expanded.args, "src/app.ts");
		ok(expanded.text.includes('<skill name="review"'), expanded.text);
		ok(expanded.text.includes("References are relative to"), expanded.text);
		ok(expanded.text.includes("Read references before reviewing."), expanded.text);
		ok(expanded.text.endsWith("\n\nsrc/app.ts"), expanded.text);
	});
});
