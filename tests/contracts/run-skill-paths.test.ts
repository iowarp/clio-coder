import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { explicitSkillPathErrors, runClioRun } from "../../src/cli/run.js";

const scratchRoots: string[] = [];

afterEach(() => {
	for (const root of scratchRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function scratchSkillDir(frontmatter: string[]): string {
	const root = mkdtempSync(join(tmpdir(), "clio-run-skill-"));
	scratchRoots.push(root);
	const dir = join(root, "scratch-skill");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), ["---", ...frontmatter, "---", "", "Body.", ""].join("\n"), "utf8");
	return dir;
}

describe("clio run explicit --skill path preflight", () => {
	it("reports a missing path with the resolved location", () => {
		const errors = explicitSkillPathErrors(["/no/such/skill-path"]);
		strictEqual(errors.length, 1);
		ok(errors[0]?.includes("does not exist"), `message explains the failure: ${errors[0]}`);
		ok(errors[0]?.includes("/no/such/skill-path"), "message names the missing path");
	});

	it("reports a path that exists but fails skill validation", () => {
		const dir = scratchSkillDir(['name: "broken-skill"']);
		const errors = explicitSkillPathErrors([dir]);
		strictEqual(errors.length, 1);
		ok(errors[0]?.includes("description is required"), `validation error surfaces: ${errors[0]}`);
	});

	it("accepts a valid skill directory", () => {
		const dir = scratchSkillDir(['name: "scratch-skill"', 'description: "Valid scratch skill."']);
		strictEqual(explicitSkillPathErrors([dir]).length, 0);
	});

	it("fails clio run with exit 2 and a diagnostic before any model invocation (BT04-2)", async () => {
		const stderrChunks: string[] = [];
		const originalWrite = process.stderr.write.bind(process.stderr);
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		}) as typeof process.stderr.write;
		try {
			// A missing --skill path fails during preflight, before the prompt is
			// assembled or any domain (and therefore any model runtime) boots.
			const code = await runClioRun(["--skill", "/no/such/skill-path", "say hi"]);
			strictEqual(code, 2);
		} finally {
			process.stderr.write = originalWrite;
		}
		const stderr = stderrChunks.join("");
		ok(stderr.includes("clio run: --skill"), `diagnostic uses the clio run voice: ${stderr}`);
		ok(stderr.includes("/no/such/skill-path"), "diagnostic names the missing path");
	});
});
