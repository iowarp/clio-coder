import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { isSkillActivation, skillActivationFromToolDetails } from "../../src/core/skill-activation.js";
import { inspectInstalledNamingResources } from "../../src/domains/lifecycle/naming-resources.js";
import {
	installSkillFromSource,
	normalizedSkillHash,
	parseSkillSourceSpec,
} from "../../src/domains/resources/skills/install.js";
import { loadSkills, parsePendingSkillRequests } from "../../src/domains/resources/skills/loader.js";

const roots: string[] = [];

function scratchRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-skill-contract-"));
	roots.push(root);
	return root;
}

function writeSkill(root: string, name: string, description: string | null, body: string): string {
	const directory = join(root, name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "SKILL.md"),
		["---", `name: ${name}`, ...(description === null ? [] : [`description: ${description}`]), "---", "", body, ""].join(
			"\n",
		),
		"utf8",
	);
	return directory;
}

function rewriteTextTree(root: string, transform: (raw: string, path: string) => string): void {
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const target = join(root, entry.name);
		if (entry.isDirectory()) rewriteTextTree(target, transform);
		else if (entry.isFile()) writeFileSync(target, transform(readFileSync(target, "utf8"), target), "utf8");
	}
}

describe("skill install and activation boundary", () => {
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("refuses repository sources that escape their clone", () => {
		for (const source of [
			"https://github.com/o/r/blob/main/../../../etc/passwd",
			"https://github.com/o/r/tree/main/skills/../../..",
			"https://raw.githubusercontent.com/o/r/main/../../secrets",
		]) {
			strictEqual(parseSkillSourceSpec(source), null);
		}
		deepStrictEqual(parseSkillSourceSpec("https://github.com/o/r/tree/main/skills/review"), {
			kind: "github",
			cloneUrl: "https://github.com/o/r.git",
			branch: "main",
			filePath: "skills/review",
			original: "https://github.com/o/r/tree/main/skills/review",
		});
	});

	it("installs a complete directory atomically and records content provenance", () => {
		const root = scratchRoot();
		const source = writeSkill(root, "review", "Reviews changes.", "Review the requested change.");
		mkdirSync(join(source, "scripts"));
		writeFileSync(join(source, "scripts", "check.sh"), "#!/bin/sh\nexit 0\n");
		const project = join(root, "project");
		mkdirSync(project);

		const result = installSkillFromSource({ source, scope: "project", cwd: project });
		ok(existsSync(join(project, ".clio-coder", "skills", "review", "scripts", "check.sh")));
		const loaded = loadSkills({ cwd: project }).items.find((skill) => skill.name === "review");
		ok(loaded !== undefined);
		strictEqual(loaded.provenance?.installUrl, source);
		strictEqual(loaded.provenance?.installedHash, result.installedHash);
		strictEqual(loaded.normalizedHash, normalizedSkillHash(readFileSync(join(source, "SKILL.md"), "utf8")));
		match(readFileSync(result.path, "utf8"), /^clio-coder:$/mu);
	});

	it("renames only a provenance-proven shipped legacy skill and canonicalizes its metadata", () => {
		const root = scratchRoot();
		const project = join(root, "project");
		const legacy = join(project, ".clio-coder", "skills", "clio-dev");
		const packageRoot = process.cwd();
		cpSync(join(packageRoot, "skills", "meta", "clio-coder-dev"), legacy, { recursive: true });
		rewriteTextTree(legacy, (raw, file) => {
			let released = raw
				.replaceAll("clio-coder-dev", "clio-dev")
				.replaceAll("clio-coder-test", "clio-test")
				.replace(/^clio-coder:/gmu, "clio:");
			if (file.endsWith("SKILL.md")) {
				const hash = normalizedSkillHash(released);
				released = released.replace(/^clio:$/mu, `clio:\n  installed-hash: "${hash}"`);
			}
			return released;
		});

		const reports = inspectInstalledNamingResources({
			cwd: project,
			configDir: join(root, "config"),
			packageRoot,
			fix: true,
		});
		ok(reports.some((entry) => entry.legacyPath === legacy && entry.status === "renamed"));
		strictEqual(existsSync(legacy), false);
		const canonical = join(project, ".clio-coder", "skills", "clio-coder-dev", "SKILL.md");
		match(readFileSync(canonical, "utf8"), /^name: clio-coder-dev$/mu);
		match(readFileSync(canonical, "utf8"), /^clio-coder:$/mu);
		const loaded = loadSkills({ cwd: project }).items.find((skill) => skill.name === "clio-coder-dev");
		ok(loaded !== undefined);
		strictEqual(loaded.source, "clio-coder");
		ok(typeof loaded.metadata.clioCoder === "object");
	});

	it("preserves the installed copy when a forced replacement is invalid", () => {
		const root = scratchRoot();
		const source = writeSkill(root, "review", "Reviews changes.", "Original body.");
		const project = join(root, "project");
		mkdirSync(project);
		const installed = installSkillFromSource({ source, scope: "project", cwd: project });
		const before = readFileSync(installed.path, "utf8");
		const invalid = writeSkill(root, "invalid", null, "Invalid replacement.");

		throws(() =>
			installSkillFromSource({ source: invalid, scope: "project", cwd: project, name: "review", force: true }),
		);
		strictEqual(readFileSync(installed.path, "utf8"), before);
		deepStrictEqual(
			loadSkills({ cwd: project })
				.items.filter((skill) => skill.name === "review")
				.map((skill) => skill.content),
			["Original body."],
		);
	});

	it("loads an explicit skill path and carries it through request and activation provenance", () => {
		const root = scratchRoot();
		const explicit = writeSkill(root, "explicit", "Explicit workflow.", "Run the explicit workflow.");
		const list = loadSkills({
			cwd: root,
			disableDiscovery: true,
			explicitSkillPaths: [explicit],
		});
		strictEqual(list.items.length, 1);
		strictEqual(list.items[0]?.source, "path");

		const pending = parsePendingSkillRequests("/skill explicit focus on tests", list, { cwd: root });
		strictEqual(pending.text, "focus on tests");
		strictEqual(pending.pendingSkillRequests[0]?.installed, true);
		strictEqual(pending.pendingSkillRequests[0]?.filePath, list.items[0]?.filePath);

		const skill = list.items[0];
		ok(skill !== undefined);
		const activation = skillActivationFromToolDetails(
			{
				name: skill.name,
				filePath: skill.filePath,
				hash: skill.hash,
				source: skill.source,
				sourceOrigin: skill.sourceInfo.source,
			},
			"turn-1",
		);
		ok(activation !== null);
		strictEqual(isSkillActivation(activation), true);
		strictEqual(activation.turnId, "turn-1");
		strictEqual(activation.filePath, skill.filePath);
	});

	it("reports missing and invalid explicit paths without falling back to discovery", () => {
		const root = scratchRoot();
		const invalid = writeSkill(root, "broken", null, "Broken.");
		const list = loadSkills({
			cwd: root,
			disableDiscovery: true,
			explicitSkillPaths: [join(root, "missing"), invalid],
		});
		strictEqual(list.items.length, 0);
		ok(list.diagnostics.some((diagnostic) => diagnostic.message.includes("does not exist")));
		ok(list.diagnostics.some((diagnostic) => diagnostic.message.includes("description is required")));
	});
});
