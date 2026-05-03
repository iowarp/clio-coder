import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { probeGit } from "../../../src/domains/session/workspace/git-probe.js";

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

function makeRepo(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "clio-git-probe-"));
	git(dir, "init", "--initial-branch=main", "-q");
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("probeGit", () => {
	it("returns isGit=false for a non-git directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-not-git-"));
		try {
			const out = probeGit(dir);
			strictEqual(out.isGit, false);
			strictEqual(out.branch, null);
			strictEqual(out.dirty, null);
			deepStrictEqual(out.recentCommits, []);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reads branch and clean state in a fresh repo with one commit", () => {
		const repo = makeRepo();
		try {
			writeFileSync(join(repo.dir, "a.txt"), "hi\n");
			git(repo.dir, "add", ".");
			git(repo.dir, "commit", "-m", "initial");
			const out = probeGit(repo.dir);
			strictEqual(out.isGit, true);
			strictEqual(out.branch, "main");
			strictEqual(out.dirty, false);
			strictEqual(out.recentCommits.length, 1);
			strictEqual(out.recentCommits[0]?.subject, "initial");
			ok((out.recentCommits[0]?.sha ?? "").length >= 7);
		} finally {
			repo.cleanup();
		}
	});

	it("reports dirty=true when working tree has untracked or modified files", () => {
		const repo = makeRepo();
		try {
			writeFileSync(join(repo.dir, "a.txt"), "hi\n");
			git(repo.dir, "add", ".");
			git(repo.dir, "commit", "-m", "initial");
			writeFileSync(join(repo.dir, "b.txt"), "untracked\n");
			const out = probeGit(repo.dir);
			strictEqual(out.dirty, true);
		} finally {
			repo.cleanup();
		}
	});

	it("returns null branch on detached HEAD", () => {
		const repo = makeRepo();
		try {
			writeFileSync(join(repo.dir, "a.txt"), "x");
			git(repo.dir, "add", ".");
			git(repo.dir, "commit", "-m", "c1");
			writeFileSync(join(repo.dir, "a.txt"), "y");
			git(repo.dir, "commit", "-am", "c2");
			const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.dir }).toString().trim();
			git(repo.dir, "checkout", sha);
			const out = probeGit(repo.dir);
			strictEqual(out.branch, null);
			strictEqual(out.isGit, true);
		} finally {
			repo.cleanup();
		}
	});

	it("normalizes git@github.com:owner/repo to https URL", () => {
		const repo = makeRepo();
		try {
			git(repo.dir, "remote", "add", "origin", "git@github.com:akougkas/clio-coder.git");
			const out = probeGit(repo.dir);
			strictEqual(out.remoteUrl, "https://github.com/akougkas/clio-coder");
		} finally {
			repo.cleanup();
		}
	});

	it("caps recent commits at 5 and emits subject only", () => {
		const repo = makeRepo();
		try {
			for (let i = 0; i < 7; i++) {
				writeFileSync(join(repo.dir, "f.txt"), `${i}`);
				git(repo.dir, "add", ".");
				git(repo.dir, "commit", "-m", `commit ${i}`);
			}
			const out = probeGit(repo.dir);
			strictEqual(out.recentCommits.length, 5);
			strictEqual(out.recentCommits[0]?.subject, "commit 6");
		} finally {
			repo.cleanup();
		}
	});
});
