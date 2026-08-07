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
import { installSkillFromSource, parseSkillSourceSpec } from "../../src/domains/resources/skills/install.js";

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
		ok(existsSync(join(project, ".clio", "skills", "review", "scripts", "check.sh")), "assets install beside SKILL.md");
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
		const dest = join(project, ".clio", "skills", "review");

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
		const leftovers = readdirSync(join(project, ".clio", "skills")).filter(
			(entry) => entry.includes(".clio-staging-") || entry.includes(".clio-backup-"),
		);
		deepStrictEqual(leftovers, []);
	});
});
