import { ok, strictEqual } from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function writeSkill(catalog: string, name: string, frontmatterLines: string[]): string {
	const dir = join(catalog, name);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "SKILL.md");
	writeFileSync(file, ["---", ...frontmatterLines, "---", "", "Body.", ""].join("\n"), "utf8");
	return file;
}

afterEach(() => {
	for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("contracts/pin-skills script", () => {
	it("fails loudly with the file path and YAML error on malformed frontmatter", async () => {
		const catalog = scratchCatalog();
		writeSkill(catalog, "good", ['name: "good"', 'description: "A fine skill."', 'version: "0.1.0"']);
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
		writeSkill(catalog, "alpha", ['name: "alpha"', 'description: "Alpha skill."', 'version: "0.1.0"']);
		writeSkill(catalog, "beta", ['name: "beta"', 'description: "Beta skill."', 'version: "0.2.0"']);

		const pin = await runPinScript(["--dir", catalog]);
		strictEqual(pin.code, 0);
		ok(existsSync(join(catalog, "registry.yaml")));

		const clean = await runPinScript(["--dir", catalog, "--check"]);
		strictEqual(clean.code, 0);
		ok(clean.stdout.includes("registry pin check ok"));

		writeSkill(catalog, "beta", ['name: "beta"', 'description: "Beta skill, edited."', 'version: "0.2.1"']);
		const drift = await runPinScript(["--dir", catalog, "--check"]);
		strictEqual(drift.code, 1);
		ok(drift.stderr.includes("does not match the catalog content hashes"));
		ok(drift.stderr.includes("beta: pin is stale"));
	});
});
