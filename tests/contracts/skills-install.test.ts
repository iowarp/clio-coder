import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { stripProvenanceFrontmatter } from "../../src/domains/resources/skills/content-hash.js";
import {
	installSkillFromSource,
	normalizedSkillHash,
	parseSkillSourceSpec,
	updateSkills,
} from "../../src/domains/resources/skills/install.js";
import { loadSkills } from "../../src/domains/resources/skills/loader.js";
import { checkSkillDrift } from "../../src/domains/resources/skills/provenance-pin.js";

const scratchDirs: string[] = [];

function scratchDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "clio-skill-install-"));
	scratchDirs.push(dir);
	return dir;
}

function writeSkillSource(dir: string, name: string, body: string, extras: Record<string, string> = {}): string {
	const skillDir = join(dir, name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		["---", `name: ${name}`, `description: ${body}`, "---", "", body, ""].join("\n"),
		"utf8",
	);
	for (const [rel, content] of Object.entries(extras)) {
		const full = join(skillDir, rel);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content, "utf8");
	}
	return skillDir;
}

describe("contracts/skills install containment", () => {
	after(() => {
		for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
	});

	it("refuses a repository path that climbs out of the clone", () => {
		// The URL tail is free-form, so this would have joined out of the temp
		// clone and installed from the operator's own disk instead of the repo.
		for (const climbing of [
			"https://github.com/o/r/blob/main/../../../etc/passwd",
			"https://github.com/o/r/tree/main/skills/../../..",
			"https://raw.githubusercontent.com/o/r/main/../../secrets",
		]) {
			strictEqual(parseSkillSourceSpec(climbing), null, `expected refusal for ${climbing}`);
		}

		const inside = parseSkillSourceSpec("https://github.com/o/r/tree/main/skills/review");
		ok(inside);
		strictEqual(inside.kind, "github");
		strictEqual(inside.kind === "github" ? inside.filePath : null, "skills/review");
	});

	it("installs a skill directory with its referenced assets and recorded provenance", () => {
		const workspace = scratchDir();
		const source = writeSkillSource(workspace, "review", "Reviews things.", {
			"scripts/check.sh": "#!/bin/sh\nexit 0\n",
		});
		const project = join(workspace, "project");
		mkdirSync(project, { recursive: true });

		const result = installSkillFromSource({ source, scope: "project", cwd: project });
		strictEqual(result.name, "review");
		const installed = readFileSync(result.path, "utf8");
		ok(installed.includes("audit: unknown"), "an install lands unreviewed");
		ok(installed.includes(`source-url: "${source}"`));
		ok(
			existsSync(join(project, ".clio-coder", "skills", "review", "scripts", "check.sh")),
			"assets install beside SKILL.md",
		);
	});

	it("writes install lifecycle nested in the clio block and keeps registry identity", () => {
		const workspace = scratchDir();
		const skillDir = join(workspace, "review");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			[
				"---",
				"name: review",
				"description: Reviews things.",
				"clio:",
				"  registry-id: iowarp/clio-coder",
				'  source-url: "https://example.invalid/skills/review"',
				"  audit: pass",
				"  provenance: designed",
				"---",
				"",
				"Body.",
				"",
			].join("\n"),
			"utf8",
		);
		const project = join(workspace, "project");
		mkdirSync(project, { recursive: true });

		const result = installSkillFromSource({ source: skillDir, scope: "project", cwd: project });
		const installed = readFileSync(result.path, "utf8");
		// One clio block: stamps merged into it, not a duplicate key.
		strictEqual(installed.match(/^clio:/gm)?.length, 1, installed);
		ok(installed.includes("  registry-id: iowarp/clio-coder"), "registry identity survives the install");
		ok(installed.includes("  provenance: designed"), "clio content keys survive the install");
		ok(installed.includes(`  source-url: "${skillDir}"`), "lifecycle source-url is rewritten, nested");
		ok(installed.includes("  audit: unknown"), "audit resets to unknown, nested");
		ok(!installed.includes("audit: pass"), "the catalog audit assertion does not survive the install");

		// The installed copy still hash-matches its source: nested lifecycle
		// stamps are provenance, not content.
		const skill = loadSkills({ cwd: project }).items.find((entry) => entry.name === "review");
		ok(skill);
		strictEqual(skill.normalizedHash, normalizedSkillHash(readFileSync(join(skillDir, "SKILL.md"), "utf8")));
		// The loader reads the nested block as provenance.
		strictEqual(skill.provenance?.registryId, "iowarp/clio-coder");
		strictEqual(skill.provenance?.audit, "unknown");
		strictEqual(skill.provenance?.installUrl, skillDir);
	});

	it("still reads flat provenance keys from copies installed before the nested form", () => {
		const workspace = scratchDir();
		const project = join(workspace, "project");
		const dir = join(project, ".clio-coder", "skills", "legacy");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "SKILL.md"),
			[
				"---",
				"name: legacy",
				"description: Installed before the nested clio block existed.",
				"registry-id: iowarp/clio-coder",
				'source-url: "https://example.invalid/skills/legacy"',
				"audit: unknown",
				"---",
				"",
				"Body.",
				"",
			].join("\n"),
			"utf8",
		);
		const skill = loadSkills({ cwd: project }).items.find((entry) => entry.name === "legacy");
		ok(skill);
		strictEqual(skill.provenance?.registryId, "iowarp/clio-coder");
		strictEqual(skill.provenance?.audit, "unknown");
	});

	it("refuses to overwrite an installed skill without force", () => {
		const workspace = scratchDir();
		const source = writeSkillSource(workspace, "review", "Reviews things.");
		const project = join(workspace, "project");
		mkdirSync(project, { recursive: true });

		installSkillFromSource({ source, scope: "project", cwd: project });
		throws(() => installSkillFromSource({ source, scope: "project", cwd: project }), /already installed .*--force/);
	});

	it("leaves the installed skill intact when a forced reinstall fails", () => {
		const workspace = scratchDir();
		const good = writeSkillSource(workspace, "review", "The original.");
		const project = join(workspace, "project");
		mkdirSync(project, { recursive: true });
		const dest = join(project, ".clio-coder", "skills", "review");

		installSkillFromSource({ source: good, scope: "project", cwd: project });
		const before = readFileSync(join(dest, "SKILL.md"), "utf8");

		// A source whose asset tree cannot be read fails partway through the
		// copy. Before the staged swap the destination was removed first, so a
		// failure here destroyed the operator's only local copy.
		const doomed = writeSkillSource(workspace, "doomed", "Will fail.", { "assets/keep.txt": "x" });
		chmodSync(join(doomed, "assets"), 0o000);
		try {
			throws(() =>
				installSkillFromSource({ source: doomed, scope: "project", cwd: project, name: "review", force: true }),
			);
		} finally {
			chmodSync(join(doomed, "assets"), 0o755);
		}

		const survived = readFileSync(join(dest, "SKILL.md"), "utf8");
		strictEqual(survived, before, "a failed forced reinstall leaves the installed skill byte-identical");
		ok(survived.includes("The original."));

		// No staging or backup directory survives a completed install.
		const leftovers = readdirSync(join(project, ".clio-coder", "skills")).filter(
			(entry) => entry.includes(".clio-coder-staging-") || entry.includes(".clio-coder-backup-"),
		);
		deepStrictEqual(leftovers, []);
	});
});

describe("contracts/skills update lifecycle", () => {
	after(() => {
		for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
	});

	function installed(project: string, name: string) {
		const skill = loadSkills({ cwd: project }).items.find((entry) => entry.name === name);
		ok(skill, `expected ${name} to be installed`);
		return skill;
	}

	it("keeps an updated copy hash-equal to the source it was updated from", () => {
		const workspace = scratchDir();
		const source = writeSkillSource(workspace, "review", "The first version.");
		const project = join(workspace, "project");
		mkdirSync(project, { recursive: true });
		installSkillFromSource({ source, scope: "project", cwd: project });

		writeFileSync(
			join(source, "SKILL.md"),
			["---", "name: review", "description: The second version.", "---", "", "The second version.", ""].join("\n"),
			"utf8",
		);
		deepStrictEqual(updateSkills({ name: "review", cwd: project }), [{ name: "review", status: "updated" }]);

		// An update writes updated-at, which a fresh install does not. The
		// normalized hash has to ignore that too, or every updated skill reads as
		// drifted from the source it was just updated from.
		strictEqual(
			installed(project, "review").normalizedHash,
			normalizedSkillHash(readFileSync(join(source, "SKILL.md"), "utf8")),
		);
	});

	it("refuses to replace a working skill with an upstream that no longer loads", () => {
		const workspace = scratchDir();
		const source = writeSkillSource(workspace, "review", "The original.");
		const project = join(workspace, "project");
		mkdirSync(project, { recursive: true });
		installSkillFromSource({ source, scope: "project", cwd: project });
		const before = readFileSync(join(project, ".clio-coder", "skills", "review", "SKILL.md"), "utf8");

		// Upstream drops the description, so the skill would install and then
		// silently stop existing while the operator is told it updated.
		writeFileSync(join(source, "SKILL.md"), ["---", "name: review", "---", "", "No description.", ""].join("\n"), "utf8");
		const [report] = updateSkills({ name: "review", cwd: project });
		strictEqual(report?.status, "error");

		strictEqual(
			readFileSync(join(project, ".clio-coder", "skills", "review", "SKILL.md"), "utf8"),
			before,
			"a refused update leaves the installed skill byte-identical",
		);
	});

	it("reports drift against the install record for a skill no catalog pins", () => {
		const workspace = scratchDir();
		const source = writeSkillSource(workspace, "review", "The audited content.");
		const project = join(workspace, "project");
		mkdirSync(project, { recursive: true });
		installSkillFromSource({ source, scope: "project", cwd: project });

		strictEqual(checkSkillDrift(installed(project, "review"), project)?.verdict, "match");

		const file = join(project, ".clio-coder", "skills", "review", "SKILL.md");
		writeFileSync(file, `${readFileSync(file, "utf8")}\nSomething nobody audited.\n`, "utf8");

		// No registry-id and no pinned manifest, so the manifest cannot speak for
		// this skill at all. Its own install record still can, and this is the
		// case the manifest could never see: content edited on disk afterwards.
		const report = checkSkillDrift(installed(project, "review"), project);
		strictEqual(report?.verdict, "mismatch");
		strictEqual(report?.authority, "install-record");
	});

	it("strips the lines a multi-line provenance value owns", () => {
		const raw = [
			"---",
			"name: review",
			"description: Reviews things.",
			"audit: >",
			"  a value",
			"  spanning lines",
			"license: MIT",
			"---",
			"",
			"Body.",
			"",
		].join("\n");
		const stripped = stripProvenanceFrontmatter(raw);
		// Filtering only the key line left the continuation behind, where YAML
		// then read it as part of whatever key preceded it.
		ok(!stripped.includes("spanning lines"), `orphan continuation survived:\n${stripped}`);
		ok(stripped.includes("license: MIT"), "an unrelated key after the block must survive");
		ok(stripped.includes("description: Reviews things."));
	});

	it("strips lifecycle keys nested under clio: but keeps clio content keys", () => {
		const raw = [
			"---",
			"name: review",
			"description: Reviews things.",
			"clio:",
			"  registry-id: iowarp/clio-coder",
			'  source-url: "https://example.invalid/skills/review"',
			"  audit: pass",
			"  provenance: designed",
			"metadata:",
			"  audit: this one is content, not lifecycle",
			"---",
			"",
			"Body.",
			"",
		].join("\n");
		const stripped = stripProvenanceFrontmatter(raw);
		ok(!stripped.includes("example.invalid"), "nested source-url is lifecycle");
		ok(!stripped.includes("audit: pass"), "nested audit is lifecycle");
		ok(stripped.includes("  registry-id: iowarp/clio-coder"), "nested registry identity is content");
		ok(stripped.includes("  provenance: designed"), "nested provenance classification is content");
		ok(stripped.includes("this one is content"), "the same key under another mapping survives");
	});
});
