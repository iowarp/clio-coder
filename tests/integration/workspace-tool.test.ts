import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ok, strictEqual } from "node:assert/strict";
import { workspaceContextTool } from "../../src/tools/workspace-context.js";
import { probeWorkspace } from "../../src/domains/session/workspace/index.js";
import type { WorkspaceSnapshot } from "../../src/domains/session/workspace/index.js";

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, {
		cwd,
		env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
		stdio: "ignore",
	});
}

describe("workspaceContextTool", () => {
	it("returns the cached snapshot from getSnapshot", async () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-wctool-"));
		try {
			git(dir, "init", "--initial-branch=main", "-q");
			writeFileSync(join(dir, "package.json"), "{}");
			git(dir, "add", ".");
			git(dir, "commit", "-m", "initial");
			const cached = probeWorkspace(dir);
			let lazyCalled = 0;
			const tool = workspaceContextTool({
				getSnapshot: () => cached,
				probeWorkspace: () => {
					lazyCalled += 1;
					return cached;
				},
				saveSnapshot: () => {},
				hasSession: () => true,
			});
			const result = await tool.run({});
			strictEqual(result.kind, "ok");
			strictEqual(lazyCalled, 0);
			if (result.kind === "ok") {
				const parsed = JSON.parse(result.output) as WorkspaceSnapshot;
				strictEqual(parsed.projectType, "node");
				strictEqual(parsed.branch, "main");
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("lazy-probes when no cached snapshot exists", async () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-wctool-lazy-"));
		try {
			git(dir, "init", "--initial-branch=main", "-q");
			writeFileSync(join(dir, "go.mod"), "module x");
			git(dir, "add", ".");
			git(dir, "commit", "-m", "initial");
			const probed = probeWorkspace(dir);
			let saved: WorkspaceSnapshot | null = null;
			const tool = workspaceContextTool({
				getSnapshot: () => null,
				probeWorkspace: () => probed,
				saveSnapshot: (snap) => {
					saved = snap;
				},
				hasSession: () => true,
			});
			const result = await tool.run({});
			strictEqual(result.kind, "ok");
			ok(saved !== null);
			if (saved !== null) strictEqual((saved as WorkspaceSnapshot).projectType, "go");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns an error when there is no current session", async () => {
		const tool = workspaceContextTool({
			getSnapshot: () => null,
			probeWorkspace: () => probeWorkspace("/tmp"),
			saveSnapshot: () => {},
			hasSession: () => false,
		});
		const result = await tool.run({});
		strictEqual(result.kind, "error");
	});
});
