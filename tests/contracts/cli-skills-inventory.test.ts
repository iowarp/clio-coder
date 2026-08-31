/**
 * `clio-coder skills inventory --json`, the fixed read a GUI host may run.
 *
 * The defect this command exists to fix: `skills list --json` without `--all`
 * returns `modelVisibleSkills`, which is `trusted && !disableModelInvocation`.
 * A surface built on that payload renders trust and invocability off rows that
 * were selected for having both, so it prints "trusted" and "allowed" on every
 * card and structurally cannot print anything else. These assert that the
 * inventory reports every installed skill, says which the model can reach, and
 * carries no body, path, hash, or install URL while doing it.
 */

import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

interface Inventory {
	version: number;
	valid: boolean;
	invalidReason: string | null;
	total: number;
	modelVisible: number;
	diagnostics: { errors: number; warnings: number; collisions: number };
	skills: ReadonlyArray<{
		name: string;
		trusted: boolean;
		modelInvocable: boolean;
		modelVisible: boolean;
		allowedTools: string[];
		disallowedTools: string[];
		installedByWorker: boolean;
		updatable: boolean;
		audit: string;
		installedAt: string | null;
		diagnostics: { errors: number; warnings: number; collisions: number };
	}>;
	skillsTruncated: boolean;
}

function skill(root: string, relative: string, frontmatter: string, body = "Body\n"): void {
	const full = join(root, relative, "SKILL.md");
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, `---\n${frontmatter}---\n${body}`);
}

describe("contracts/skills inventory", () => {
	const scratch = makeScratchHome("clio-skills-inventory-");
	after(() => scratch.cleanup());
	// The loader also scans user compat roots under $HOME, one per interop agent
	// kind. Without repointing it these cases would count whichever skills the
	// machine running the suite happens to have installed.
	const env = { ...scratch.env, HOME: scratch.dir, USERPROFILE: scratch.dir };

	it("reports the skills the model cannot see, which a filtered listing cannot", async () => {
		const project = join(scratch.dir, "project");
		// Model-visible: a trusted root, invocation not disabled.
		skill(project, ".clio-coder/skills/reachable", "name: reachable\ndescription: The model may load this one.\n");
		// Trusted root, but the skill's own frontmatter reserves it for the operator.
		skill(
			project,
			".clio-coder/skills/operator-only",
			"name: operator-only\ndescription: Reserved for the operator by frontmatter.\ndisable-model-invocation: true\n",
		);
		// A compatibility project root, which is untrusted unless the operator opts
		// in, so the model never sees it however its frontmatter reads.
		skill(project, ".claude/skills/compat", "name: compat\ndescription: Lives under an untrusted compat root.\n");

		const result = await runCli(["skills", "inventory", "--json"], { cwd: project, env });
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		const inventory = JSON.parse(result.stdout) as Inventory;

		strictEqual(inventory.total, 3);
		strictEqual(inventory.modelVisible, 1);
		const byName = new Map(inventory.skills.map((entry) => [entry.name, entry]));

		const reachable = byName.get("reachable");
		ok(reachable !== undefined);
		strictEqual(reachable.modelVisible, true);

		const reserved = byName.get("operator-only");
		ok(reserved !== undefined, "a skill the model cannot invoke must still be reported");
		strictEqual(reserved.trusted, true);
		strictEqual(reserved.modelInvocable, false);
		strictEqual(reserved.modelVisible, false);

		const compat = byName.get("compat");
		ok(compat !== undefined, "a skill under an untrusted root must still be reported");
		strictEqual(compat.trusted, false);
		strictEqual(compat.modelVisible, false);

		// Visibility is trust and invocation together, everywhere.
		for (const entry of inventory.skills) {
			strictEqual(entry.modelVisible, entry.trusted && entry.modelInvocable, `${entry.name} visibility`);
		}
	});

	it("carries no body, path, hash, or install URL", async () => {
		const project = join(scratch.dir, "redaction");
		skill(
			project,
			".clio-coder/skills/redacted",
			[
				"name: redacted\n",
				"description: A skill whose provenance points at a private remote.\n",
				"allowed-tools: [read, web_fetch]\n",
				"disallowed-tools: [bash]\n",
				"install-url: https://token@example.invalid/private.git\n",
				"installed-by: worker\n",
				"installed-at: 2026-07-04T10:00:00.000Z\n",
				"audit: warn\n",
			].join(""),
			"PRIVATE-SKILL-BODY-MARKER\n",
		);

		const result = await runCli(["skills", "inventory", "--json"], { cwd: project, env });
		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		const inventory = JSON.parse(result.stdout) as Inventory;
		const entry = inventory.skills.find((item) => item.name === "redacted");
		ok(entry !== undefined);

		// Tool policy is an identifier list, the same class an agent recipe carries.
		ok(entry.allowedTools.includes("read"));
		ok(entry.disallowedTools.includes("bash"));
		// That an upstream exists crosses; where it is does not.
		strictEqual(entry.updatable, true);
		strictEqual(entry.installedByWorker, true);
		strictEqual(entry.audit, "warn");
		strictEqual(entry.installedAt, "2026-07-04T10:00:00.000Z");

		for (const forbidden of [
			"PRIVATE-SKILL-BODY-MARKER",
			"SKILL.md",
			"example.invalid",
			"token@",
			project,
			scratch.dir,
		]) {
			strictEqual(result.stdout.includes(forbidden), false, `the read leaked ${forbidden}`);
		}
	});

	it("reaches the same verdict the terminal's own validate reaches", async () => {
		const project = join(scratch.dir, "malformed");
		skill(project, ".clio-coder/skills/good", "name: good\ndescription: A skill that loads cleanly.\n");
		// A scanned file that produces no skill is malformed. It only warns, so a
		// verdict computed from errors alone would have called this catalog valid.
		const bad = join(project, ".clio-coder/skills/bad/SKILL.md");
		mkdirSync(join(bad, ".."), { recursive: true });
		writeFileSync(bad, "# no frontmatter at all\n");

		const inventory = JSON.parse(
			(await runCli(["skills", "inventory", "--json"], { cwd: project, env })).stdout,
		) as Inventory;
		const validate = await runCli(["skills", "validate", "--json"], { cwd: project, env });

		strictEqual(inventory.valid, false);
		strictEqual(inventory.invalidReason, "unloadable-file");
		// Both callers share one rule, so a verdict cannot drift between the
		// terminal and the browser.
		strictEqual(JSON.parse(validate.stdout).ok, inventory.valid);
		// The diagnostic text quotes the path; only its shape crosses.
		ok(inventory.diagnostics.warnings > 0);
		strictEqual(JSON.stringify(inventory).includes(project), false);
	});

	it("says a name collision dropped a skill rather than calling the catalog clean", async () => {
		const project = join(scratch.dir, "collision");
		skill(project, ".clio-coder/skills/one", "name: duplicate\ndescription: The first declaration of this name.\n");
		skill(project, ".clio-coder/skills/two", "name: duplicate\ndescription: The second declaration of this name.\n");

		const inventory = JSON.parse(
			(await runCli(["skills", "inventory", "--json"], { cwd: project, env })).stdout,
		) as Inventory;
		strictEqual(inventory.valid, false);
		strictEqual(inventory.invalidReason, "collision");
		ok(inventory.diagnostics.collisions > 0, "a named collision must be counted");
	});

	it("emits nothing but a usage error for any argv other than the fixed one", async () => {
		for (const args of [
			["skills", "inventory"],
			["skills", "inventory", "--all"],
			["skills", "inventory", "reachable"],
		]) {
			const result = await runCli(args, { cwd: scratch.dir, env });
			strictEqual(result.code, 2, `${args.join(" ")} must be a usage error`);
			ok(result.stderr.includes("usage:"), `${args.join(" ")} stderr=${result.stderr}`);
			strictEqual(result.stdout, "");
		}
	});
});
