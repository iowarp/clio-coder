import { ok, strictEqual } from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { capabilityWorthNaming, createCapabilityGate } from "../../src/domains/middleware/capability-gate.js";
import { loadSkills } from "../../src/domains/resources/skills/loader.js";

const library = join(import.meta.dirname, "..", "..", "library");

function skillDirs(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) return [];
		const child = join(dir, entry.name);
		return readdirSync(child).includes("SKILL.md") ? [child] : skillDirs(child);
	});
}

/** The reminder's ranking over every skill the library ships, as the session ranks its ready skills. */
function rankLibrarySkills(task: string) {
	const skills = loadSkills({ disableDiscovery: true, explicitSkillPaths: skillDirs(library) }).items;
	ok(skills.length > 30, `loaded ${skills.length} library skills`);
	return createCapabilityGate().rank({
		kind: "skills",
		task,
		candidates: skills.map((skill) => ({
			id: skill.name,
			description: skill.description,
			triggers: Array.isArray(skill.metadata.triggers)
				? skill.metadata.triggers.filter((value): value is string => typeof value === "string")
				: [],
		})),
	});
}

describe("library skill ranking", () => {
	it("offers science-data first for a question about simulation output", () => {
		const task = "What variables are in the simulation output?";
		const [top] = rankLibrarySkills(task);
		strictEqual(top?.id, "science-data", JSON.stringify(top));
		ok(capabilityWorthNaming(top, task), `coverage ${top.coverage}`);
	});
});
