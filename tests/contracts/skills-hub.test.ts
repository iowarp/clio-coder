import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ResourceList, Skill } from "../../src/domains/resources/index.js";
import { buildDiagnosticItems, buildInstalledItems } from "../../src/interactive/overlays/skills-hub.js";

function makeSkill(overrides: Partial<Skill> & { name: string }): Skill {
	const base = {
		description: `${overrides.name} description`,
		filePath: `/repo/skills/${overrides.name}/SKILL.md`,
		baseDir: `/repo/skills/${overrides.name}`,
		content: `---\nname: ${overrides.name}\n---\nBody of ${overrides.name}`,
		sourceInfo: { path: `/repo/skills/${overrides.name}/SKILL.md`, scope: "project" } as Skill["sourceInfo"],
		disableModelInvocation: false,
		source: "clio" as Skill["source"],
		scope: "project" as Skill["scope"],
		hash: "0".repeat(64),
		pathSubject: `/repo/skills/${overrides.name}`,
		trusted: true,
		precedence: 0,
		metadata: {},
	};
	return { ...base, ...overrides } as Skill;
}

function makeList(items: Skill[], diagnostics: ResourceList<Skill>["diagnostics"] = []): ResourceList<Skill> {
	return { items, diagnostics };
}

describe("contracts/skills-hub", () => {
	it("groups installed skills by scope with origin meta", () => {
		const items = buildInstalledItems(
			makeList([
				makeSkill({ name: "clio-dev", scope: "project" as Skill["scope"] }),
				makeSkill({ name: "hlab", scope: "user" as Skill["scope"], source: "claude" as Skill["source"] }),
			]),
		);
		deepStrictEqual(
			items.map((item) => item.group),
			["Project", "User"],
		);
		strictEqual(items[0]?.meta, "project/clio");
		strictEqual(items[1]?.meta, "user/claude");
	});

	it("marks untrusted skills and diagnostic-affected skills in meta", () => {
		const skill = makeSkill({ name: "sketchy", trusted: false });
		const items = buildInstalledItems(
			makeList([skill], [{ type: "warning", message: "bad frontmatter", path: skill.filePath }]),
		);
		strictEqual(items[0]?.meta, "project/clio · untrusted · !");
	});

	it("detail pane includes invocation, source path, diagnostics, and body", () => {
		const skill = makeSkill({ name: "clio-test" });
		const items = buildInstalledItems(
			makeList([skill], [{ type: "warning", message: "stale pin", path: skill.filePath }]),
		);
		const detail = items[0]?.detail?.() ?? [];
		const joined = detail.join("\n");
		ok(joined.includes("/skill:clio-test [task]"));
		ok(joined.includes(skill.filePath));
		ok(joined.includes("stale pin"));
		ok(joined.includes("Body of clio-test"));
	});

	it("diagnostics render as their own group", () => {
		const items = buildDiagnosticItems(
			makeList([], [{ type: "error", message: "unreadable SKILL.md", path: "/repo/broken/SKILL.md" }]),
		);
		strictEqual(items.length, 1);
		strictEqual(items[0]?.group, "Diagnostics");
		strictEqual(items[0]?.meta, "/repo/broken/SKILL.md");
		ok((items[0]?.detail?.() ?? []).join("\n").includes("unreadable SKILL.md"));
	});
});
