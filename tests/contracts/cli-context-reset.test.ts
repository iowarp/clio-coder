import { strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

// `clio context reset` confirmed through a readline prompt that answers false
// whenever stdin is not a TTY, so every scripted or CI invocation cancelled
// while reporting success. The reset had no non-interactive expression at all.

function makeProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "clio-reset-project-"));
	mkdirSync(join(dir, ".clio"), { recursive: true });
	writeFileSync(join(dir, ".clio", "codewiki.json"), "{}");
	writeFileSync(join(dir, ".clio", "state.json"), "{}");
	mkdirSync(join(dir, ".clio", "wiki"), { recursive: true });
	writeFileSync(join(dir, ".clio", "wiki", "index.md"), "# Wiki\n");
	writeFileSync(join(dir, "CLIO.md"), "# Handbook\n");
	return dir;
}

describe("contracts/cli-context-reset", () => {
	const scratch = makeScratchHome("clio-reset-home-");
	const projects: string[] = [];
	after(() => {
		for (const dir of projects) rmSync(dir, { recursive: true, force: true });
		scratch.cleanup();
	});
	const project = (): string => {
		const dir = makeProject();
		projects.push(dir);
		return dir;
	};

	it("clears the accumulated artifacts without a TTY when --yes is given", async () => {
		const cwd = project();
		const result = await runCli(["context", "reset", "--yes"], { env: scratch.env, cwd });

		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		strictEqual(existsSync(join(cwd, ".clio", "codewiki.json")), false);
		strictEqual(existsSync(join(cwd, ".clio", "state.json")), false);
		// The wiki is the expensive artifact and stays without --all.
		strictEqual(existsSync(join(cwd, ".clio", "wiki", "index.md")), true);
		strictEqual(existsSync(join(cwd, "CLIO.md")), true);
	});

	it("removes the handbook only when --all joins --yes", async () => {
		const cwd = project();
		const result = await runCli(["context", "reset", "--all", "--yes"], { env: scratch.env, cwd });

		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		strictEqual(existsSync(join(cwd, ".clio", "codewiki.json")), false);
		strictEqual(existsSync(join(cwd, "CLIO.md")), false);
	});

	it("cancels without --yes and names the flag that would have worked", async () => {
		const cwd = project();
		const result = await runCli(["context", "reset"], { env: scratch.env, cwd });

		strictEqual(result.code, 0, `stderr=${result.stderr}`);
		strictEqual(existsSync(join(cwd, ".clio", "codewiki.json")), true);
		strictEqual(/--yes/.test(result.stdout + result.stderr), true, "expected the hint to name --yes");
	});
});
