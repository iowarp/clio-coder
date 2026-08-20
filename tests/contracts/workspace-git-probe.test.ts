import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	probeGit,
	probeGitAsync,
	probeGitStatusAsync,
	probeWorkspace,
	probeWorkspaceAsync,
} from "../../src/domains/session/workspace/index.js";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function createRepository(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-workspace-git-"));
	git(root, ["init", "--quiet", "--initial-branch=main"]);
	git(root, ["config", "user.email", "workspace-probe@example.test"]);
	git(root, ["config", "user.name", "Workspace Probe"]);
	return root;
}

function commitAll(root: string, subject: string): string {
	git(root, ["add", "."]);
	git(root, ["commit", "--quiet", "--message", subject]);
	return git(root, ["rev-parse", "HEAD"]);
}

const NON_GIT = {
	isGit: false,
	branch: null,
	dirty: null,
	ahead: null,
	behind: null,
	recentCommits: [],
	remoteUrl: null,
};

describe("workspace Git probe truthfulness", () => {
	it("reports an ignored nested workspace as non-Git", async () => {
		const root = createRepository();
		try {
			writeFileSync(join(root, ".gitignore"), "scratch/\n");
			writeFileSync(join(root, "tracked.txt"), "tracked\n");
			commitAll(root, "initial commit");

			const workspace = join(root, "scratch", "nested");
			mkdirSync(workspace, { recursive: true });
			writeFileSync(join(workspace, "notes.txt"), "ignored\n");
			const ignored = spawnSync("git", ["check-ignore", "--quiet", "--", "."], { cwd: workspace });
			strictEqual(ignored.status, 0, "the fixture workspace must be ignored according to Git");

			deepStrictEqual(probeGit(workspace), NON_GIT);
			deepStrictEqual(await probeGitAsync(workspace), NON_GIT);
			deepStrictEqual(await probeGitStatusAsync(workspace), {
				isGit: false,
				branch: null,
				dirty: null,
				remoteUrl: null,
			});

			const snapshot = probeWorkspace(workspace);
			strictEqual(snapshot.cwd, workspace, "the exact workspace cwd remains the snapshot authority");
			strictEqual(snapshot.isGit, false);
			const asyncSnapshot = await probeWorkspaceAsync(workspace);
			strictEqual(asyncSnapshot.cwd, workspace);
			strictEqual(asyncSnapshot.isGit, false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses enclosing-repository facts but scopes status and log to an unignored subdirectory", async () => {
		const root = createRepository();
		try {
			const workspace = join(root, "packages", "alpha");
			const sibling = join(root, "packages", "beta");
			mkdirSync(workspace, { recursive: true });
			mkdirSync(sibling, { recursive: true });
			writeFileSync(join(workspace, "alpha.txt"), "alpha v1\n");
			writeFileSync(join(sibling, "beta.txt"), "beta v1\n");
			writeFileSync(join(root, "README.md"), "root v1\n");
			commitAll(root, "baseline");

			writeFileSync(join(workspace, "alpha.txt"), "alpha v2\n");
			const workspaceCommit = commitAll(root, "workspace change");
			writeFileSync(join(sibling, "beta.txt"), "beta v2\n");
			const siblingCommit = commitAll(root, "sibling-only change");
			writeFileSync(join(root, "README.md"), "root v2\n");
			const rootCommit = commitAll(root, "root-only change");
			git(root, ["remote", "add", "origin", "https://example.test/org/monorepo.git"]);

			writeFileSync(join(sibling, "beta.txt"), "uncommitted sibling change\n");
			const syncProbe = probeGit(workspace);
			strictEqual(syncProbe.isGit, true);
			strictEqual(syncProbe.branch, "main");
			strictEqual(syncProbe.dirty, false, "changes outside the exact workspace must not mark it dirty");
			strictEqual(syncProbe.remoteUrl, "https://example.test/org/monorepo");
			deepStrictEqual(
				syncProbe.recentCommits.map(({ sha, subject }) => ({ sha, subject })),
				[
					{ sha: workspaceCommit, subject: "workspace change" },
					{ sha: git(root, ["rev-list", "--max-parents=0", "HEAD"]), subject: "baseline" },
				],
			);
			strictEqual(
				syncProbe.recentCommits.some(({ sha }) => sha === siblingCommit || sha === rootCommit),
				false,
			);

			const asyncProbe = await probeGitAsync(workspace);
			strictEqual(asyncProbe.dirty, false);
			deepStrictEqual(asyncProbe.recentCommits, syncProbe.recentCommits);
			strictEqual((await probeGitStatusAsync(workspace)).dirty, false);

			const snapshot = probeWorkspace(workspace);
			strictEqual(snapshot.cwd, workspace, "the enclosing Git root must not replace workspace identity");
			strictEqual((await probeWorkspaceAsync(workspace)).cwd, workspace);
			strictEqual(
				JSON.stringify({ syncProbe, asyncProbe }).includes(root),
				false,
				"Git facts must not expose an enclosing-repository path",
			);

			writeFileSync(join(workspace, "alpha.txt"), "uncommitted workspace change\n");
			strictEqual(probeGit(workspace).dirty, true);
			strictEqual((await probeGitStatusAsync(workspace)).dirty, true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
