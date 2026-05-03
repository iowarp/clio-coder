import { ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { probeWorkspace } from "../../../src/domains/session/workspace/snapshot.js";

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
		stdio: "ignore",
	});
}

describe("probeWorkspace", () => {
	it("aggregates git + project-type for a TypeScript repo", () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-pw-"));
		try {
			git(dir, "init", "--initial-branch=main", "-q");
			writeFileSync(join(dir, "package.json"), "{}");
			git(dir, "add", ".");
			git(dir, "commit", "-m", "initial");
			const snap = probeWorkspace(dir);
			strictEqual(snap.cwd, dir);
			strictEqual(snap.isGit, true);
			strictEqual(snap.branch, "main");
			strictEqual(snap.projectType, "typescript");
			ok(snap.recentCommits.length === 1);
			ok(typeof snap.capturedAt === "string");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns the empty snapshot shape for a non-git, non-recognized directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-pw-empty-"));
		try {
			const snap = probeWorkspace(dir);
			strictEqual(snap.isGit, false);
			strictEqual(snap.branch, null);
			strictEqual(snap.projectType, "unknown");
			strictEqual(snap.recentCommits.length, 0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("never throws even when cwd does not exist", () => {
		const snap = probeWorkspace("/definitely/not/here/clio-test-xyzzy");
		strictEqual(snap.isGit, false);
		strictEqual(snap.projectType, "unknown");
	});
});
