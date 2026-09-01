import { ok, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, "scripts", "pin-skills.ts");

interface ScriptResult {
	code: number;
	stdout: string;
	stderr: string;
}

function runPinScript(args: ReadonlyArray<string>): Promise<ScriptResult> {
	return new Promise((resolve, reject) => {
		execFile(
			process.execPath,
			["--import", "tsx", SCRIPT, ...args],
			{ cwd: REPO_ROOT, timeout: 30_000 },
			(error, stdout, stderr) => {
				if (error && typeof error.code !== "number") {
					reject(error);
					return;
				}
				resolve({ code: error && typeof error.code === "number" ? error.code : 0, stdout, stderr });
			},
		);
	});
}

const scratchRoots: string[] = [];

function scratchCatalog(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-pin-skills-"));
	scratchRoots.push(root);
	return root;
}

function writeSkill(catalog: string, name: string, frontmatterLines: string[], options?: { evals?: boolean }): string {
	const dir = join(catalog, name);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "SKILL.md");
	writeFileSync(file, ["---", ...frontmatterLines, "---", "", "Body.", ""].join("\n"), "utf8");
	if (options?.evals !== false) {
		writeFileSync(join(dir, "evals.md"), "## S1 - smoke\n\nSetup: run it.\n\nExpected:\n- it runs\n", "utf8");
	}
	return file;
}

/** Full catalog-contract frontmatter for a valid fixture skill. */
function catalogFrontmatter(name: string, description: string, version: string): string[] {
	return [
		`name: "${name}"`,
		`description: "${description}"`,
		"triggers:",
		`  - "use ${name}"`,
		`  - "run ${name} workflow"`,
		`version: "${version}"`,
		"license: Apache-2.0",
		"clio:",
		"  registry-id: iowarp/clio-coder",
		`  source-url: https://example.invalid/skills/${name}`,
		"  audit: pass",
		"  provenance: designed",
		"  eval-status: scenarios-recorded",
	];
}

describe("contracts/pin-skills script", () => {
	// Nested inside the describe, not at module top level: under
	// --experimental-test-isolation=none every file shares one root test
	// context, so a top-level beforeEach/afterEach runs around every test in
	// every file, not just this one's.
	afterEach(() => {
		for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("fails loudly with the file path and YAML error on malformed frontmatter", async () => {
		const catalog = scratchCatalog();
		writeSkill(catalog, "good", catalogFrontmatter("good", "A fine skill.", "0.1.0"));
		// A colon-space inside a plain scalar is invalid YAML; the old script
		// silently pinned the folder name with version null for this case.
		const brokenPath = writeSkill(catalog, "broken", ["name: broken", "description: Use when: things break"]);
		const result = await runPinScript(["--dir", catalog]);
		strictEqual(result.code, 1);
		ok(result.stderr.includes(brokenPath));
		ok(/invalid YAML/i.test(result.stderr));
		// Nothing may be written when any file is malformed.
		strictEqual(existsSync(join(catalog, "registry.yaml")), false);

		const check = await runPinScript(["--dir", catalog, "--check"]);
		strictEqual(check.code, 1);
		ok(/invalid YAML/i.test(check.stderr));
	});

	it("pins a valid catalog, passes --check, and fails --check on drift", async () => {
		const catalog = scratchCatalog();
		writeSkill(catalog, "alpha", catalogFrontmatter("alpha", "Alpha skill.", "0.1.0"));
		writeSkill(catalog, "beta", catalogFrontmatter("beta", "Beta skill.", "0.2.0"));

		const pin = await runPinScript(["--dir", catalog]);
		strictEqual(pin.code, 0);
		ok(existsSync(join(catalog, "registry.yaml")));

		const clean = await runPinScript(["--dir", catalog, "--check"]);
		strictEqual(clean.code, 0);
		ok(clean.stdout.includes("registry pin check ok"));

		writeSkill(catalog, "beta", catalogFrontmatter("beta", "Beta skill, edited.", "0.2.1"));
		const drift = await runPinScript(["--dir", catalog, "--check"]);
		strictEqual(drift.code, 1);
		ok(drift.stderr.includes("does not match the catalog content hashes"));
		ok(drift.stderr.includes("beta: pin is stale"));
	});

	it("pins the provenance-stripped hash so install-lifecycle stamps are not drift", async () => {
		const catalog = scratchCatalog();
		const file = writeSkill(catalog, "alpha", catalogFrontmatter("alpha", "Alpha skill.", "0.1.0"));
		const pin = await runPinScript(["--dir", catalog]);
		strictEqual(pin.code, 0);

		// Stamp lifecycle fields the way `clio-coder skills install` does (nested in
		// the clio: block); the pinned hash must not change.
		const raw = readFileSync(file, "utf8");
		writeFileSync(
			file,
			raw.replace("  audit: pass\n", '  audit: pass\n  installed-at: "2026-07-02T00:00:00.000Z"\n'),
			"utf8",
		);
		const clean = await runPinScript(["--dir", catalog, "--check"]);
		strictEqual(clean.code, 0, clean.stderr);

		// A body edit is real drift.
		writeFileSync(file, readFileSync(file, "utf8").replace("Body.", "Edited body."), "utf8");
		const drift = await runPinScript(["--dir", catalog, "--check"]);
		strictEqual(drift.code, 1);
	});

	it("rejects catalog skills missing the publishing contract", async () => {
		const catalog = scratchCatalog();
		// Missing license, no clio: block at all, no evals.md.
		const bare = writeSkill(catalog, "bare", ['name: "bare"', 'description: "Bare skill."', 'version: "0.1.0"'], {
			evals: false,
		});
		// Has a clio: block, but it is missing keys and audit is not "pass".
		const half = writeSkill(catalog, "half", [
			'name: "half"',
			'description: "Half skill."',
			'version: "0.1.0"',
			"license: Apache-2.0",
			"clio:",
			"  registry-id: iowarp/clio-coder",
			"  audit: unknown",
		]);
		const result = await runPinScript(["--dir", catalog]);
		strictEqual(result.code, 1);
		ok(result.stderr.includes(bare));
		ok(result.stderr.includes('missing required catalog frontmatter "license"'));
		ok(result.stderr.includes('missing the required nested "clio:" frontmatter block'));
		ok(result.stderr.includes("evals.md"));
		ok(result.stderr.includes(half));
		ok(result.stderr.includes('missing required catalog frontmatter "clio.source-url"'));
		ok(result.stderr.includes('missing required catalog frontmatter "clio.provenance"'));
		ok(result.stderr.includes('"audit: pass"'));
		strictEqual(existsSync(join(catalog, "registry.yaml")), false);
	});

	it("publishes a marketplace index beside the manifest and checks it too", async () => {
		const catalog = scratchCatalog();
		writeSkill(catalog, "alpha", catalogFrontmatter("alpha", "Alpha skill.", "0.1.0"));
		const pin = await runPinScript(["--dir", catalog]);
		strictEqual(pin.code, 0, pin.stderr);

		const indexPath = join(catalog, "skill-marketplace.json");
		const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
			skills: Array<{
				name: string;
				description: string;
				triggers?: string[];
				sourceUrl: string;
				version?: string;
				audit?: string;
			}>;
		};
		strictEqual(index.skills.length, 1);
		const entry = index.skills[0];
		strictEqual(entry?.name, "alpha");
		strictEqual(entry?.description, "Alpha skill.");
		strictEqual(entry?.triggers?.join(" | "), "use alpha | run alpha workflow");
		strictEqual(entry?.sourceUrl, "https://example.invalid/skills/alpha");
		strictEqual(entry?.version, "0.1.0");
		strictEqual(entry?.audit, "pass");

		// The index is a checked artifact: hand-editing it is drift, even while
		// registry.yaml still matches the catalog byte for byte.
		writeFileSync(indexPath, JSON.stringify({ generatedBy: "hand", skills: [] }, null, "\t"), "utf8");
		const drift = await runPinScript(["--dir", catalog, "--check"]);
		strictEqual(drift.code, 1);
		ok(drift.stderr.includes("skill-marketplace.json does not match the catalog"), drift.stderr);
	});

	it("rejects malformed optional trigger metadata", async () => {
		const catalog = scratchCatalog();
		const malformed = writeSkill(catalog, "alpha", [
			'name: "alpha"',
			'description: "Alpha skill."',
			"triggers: alpha",
			'version: "0.1.0"',
			"license: Apache-2.0",
			"clio:",
			"  registry-id: iowarp/clio-coder",
			"  source-url: https://example.invalid/skills/alpha",
			"  audit: pass",
			"  provenance: designed",
			"  eval-status: scenarios-recorded",
		]);
		const result = await runPinScript(["--dir", catalog]);
		strictEqual(result.code, 1);
		ok(result.stderr.includes(malformed));
		ok(result.stderr.includes('optional frontmatter "triggers" must be a non-empty list of non-empty strings'));
	});

	it("rejects a source-url that has stopped matching the skill's catalog path", async () => {
		const catalog = scratchCatalog();
		const moved = writeSkill(catalog, "alpha", [
			'name: "alpha"',
			'description: "Alpha skill."',
			'version: "0.1.0"',
			"license: Apache-2.0",
			"clio:",
			"  registry-id: iowarp/clio-coder",
			"  source-url: https://example.invalid/skills/somewhere-else",
			"  audit: pass",
			"  provenance: designed",
			"  eval-status: scenarios-recorded",
		]);
		const result = await runPinScript(["--dir", catalog]);
		strictEqual(result.code, 1);
		ok(result.stderr.includes(moved));
		ok(result.stderr.includes('does not end with the catalog path "alpha"'), result.stderr);
	});

	it("rejects a tool surface spelled for another harness", async () => {
		const catalog = scratchCatalog();
		// `Bash` is Claude Code's spelling. Its allowed-tools GRANTS rather than
		// narrows, so shipping the capitalized name would auto-approve Bash for
		// anyone who dropped this skill into .claude/skills.
		const capitalized = writeSkill(catalog, "alpha", [
			...catalogFrontmatter("alpha", "Alpha skill.", "0.1.0"),
			"allowed-tools:",
			"  - Bash",
			"  - Glob",
		]);
		const result = await runPinScript(["--dir", catalog]);
		strictEqual(result.code, 1);
		ok(result.stderr.includes(capitalized));
		ok(result.stderr.includes('must be spelled "bash"'), result.stderr);
		ok(result.stderr.includes('"Glob" is not a Clio tool name'), result.stderr);
	});
});
