import { strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { getCurrentBranch } from "../../src/utils/git.js";

describe("utils/git", () => {
	let scratch: string;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-utils-git-"));
	});
	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("returns the branch name for a real git repo", async () => {
		execFileSync("git", ["-C", scratch, "init", "-q", "-b", "main"]);
		execFileSync("git", ["-C", scratch, "config", "user.email", "test@example.com"]);
		execFileSync("git", ["-C", scratch, "config", "user.name", "test"]);
		writeFileSync(join(scratch, "x"), "");
		execFileSync("git", ["-C", scratch, "add", "."]);
		execFileSync("git", ["-C", scratch, "commit", "-q", "-m", "init"]);
		execFileSync("git", ["-C", scratch, "switch", "-q", "-c", "feat/branch-test"]);
		const branch = await getCurrentBranch(scratch);
		strictEqual(branch, "feat/branch-test");
	});

	it("returns null for a directory that is not a git repo", async () => {
		const branch = await getCurrentBranch(scratch);
		strictEqual(branch, null);
	});

	it("returns null for a missing path", async () => {
		const branch = await getCurrentBranch(join(scratch, "does-not-exist"));
		strictEqual(branch, null);
	});
});
