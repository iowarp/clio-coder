import { deepEqual, equal, ok } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { scratchClioEnvVars } from "../harness/scratch-env.js";

// Doctor, `run --read-only` and read-only workers promise to change nothing, yet
// all of them load skills (DOG-001). Only a process that opened writes persists
// parsed frontmatter, and never inside a read-only scope. Opening is one-way per
// process, so the cases below run in order: closed first, then opened.
const home = mkdtempSync(join(tmpdir(), "clio-coder-skill-fm-gate-"));
Object.assign(process.env, scratchClioEnvVars(home), { HOME: home });
const { resetXdgCache, clioConfigDir } = await import("../../src/core/xdg.js");
resetXdgCache();
const { readClioVersion } = await import("../../src/core/package-root.js");
const { loadSkills } = await import("../../src/domains/resources/skills/loader.js");
const { enableFrontmatterCacheWrites } = await import("../../src/domains/resources/skills/frontmatter-cache.js");
const { withReadOnlyMode } = await import("../../src/core/read-only-mode.js");
const { collectDoctorFindings } = await import("../../src/cli/doctor.js");
after(() => rmSync(home, { recursive: true, force: true }));

const cacheRoot = join(home, "cache");
const cacheFile = join(cacheRoot, "skill-frontmatter.json");

function skillAt(root: string, name: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Parsed ${name}.\n---\nBody.\n`);
	return dir;
}

function describeSkill(dir: string, name: string): string | undefined {
	return loadSkills({ disableDiscovery: true, explicitSkillPaths: [dir] }).items.find((skill) => skill.name === name)
		?.description;
}

function persistedPaths(): string[] {
	return Object.keys((JSON.parse(readFileSync(cacheFile, "utf8")) as { entries: Record<string, unknown> }).entries);
}

const alpha = skillAt(join(home, "explicit"), "alpha");
const beta = skillAt(join(home, "explicit"), "beta");

describe("skill frontmatter cache write gate", () => {
	it("a process that never opened writes answers from an existing cache and changes nothing", () => {
		equal(describeSkill(alpha, "alpha"), "Parsed alpha.");
		ok(!existsSync(cacheRoot), "a reader creates no cache root");

		const file = join(alpha, "SKILL.md");
		const stat = statSync(file);
		const planted = { mtimeMs: stat.mtimeMs, size: stat.size, text: "name: alpha\ndescription: Parsed alpha." };
		const entries = {
			[file]: { ...planted, json: JSON.stringify({ name: "alpha", description: "From cache." }) },
			[join(home, "gone", "SKILL.md")]: { ...planted, json: "{}" },
		};
		mkdirSync(cacheRoot);
		writeFileSync(cacheFile, JSON.stringify({ format: 1, clioVersion: readClioVersion(), entries }));
		const before = readFileSync(cacheFile, "utf8");

		equal(describeSkill(alpha, "alpha"), "From cache.", "reading the cache stays possible");
		equal(describeSkill(beta, "beta"), "Parsed beta.");
		equal(readFileSync(cacheFile, "utf8"), before, "no parse is persisted and no entry is pruned");
	});

	it("after writes open, doctor and a read-only scope persist nothing and leak nothing into a later write", async () => {
		enableFrontmatterCacheWrites();
		rmSync(cacheRoot, { recursive: true, force: true });
		skillAt(join(clioConfigDir(), "skills"), "gamma");

		// The terminal's `/doctor` runs in a process that opened writes.
		await collectDoctorFindings({ deep: false });
		ok(!existsSync(cacheFile), "doctor writes no cache");
		await withReadOnlyMode(async () => {
			await Promise.resolve();
			equal(describeSkill(alpha, "alpha"), "Parsed alpha.");
		});
		ok(!existsSync(cacheFile), "a read-only scope holds across an await");

		equal(describeSkill(beta, "beta"), "Parsed beta.");
		deepEqual(persistedPaths(), [join(beta, "SKILL.md")], "only the writable load's parse is persisted");
	});
});
