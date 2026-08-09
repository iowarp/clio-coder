import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorkspaceSnapshot } from "../../src/domains/session/workspace/index.js";
import { createWorkspaceFacts } from "../../src/interactive/workspace-facts.js";

function workspace(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
	return {
		cwd: "/work/project",
		isGit: true,
		branch: "bound-branch",
		dirty: false,
		ahead: 0,
		behind: 0,
		recentCommits: [{ sha: "bound", subject: "bound snapshot" }],
		remoteUrl: "https://example.test/project",
		projectType: "typescript",
		capturedAt: "2026-08-09T00:00:00.000Z",
		...overrides,
	};
}

function gitFacts(branch: string) {
	return {
		isGit: true,
		branch,
		dirty: true,
		ahead: 3,
		behind: 2,
		recentCommits: [{ sha: branch, subject: `commit on ${branch}` }],
		remoteUrl: "https://git-probe.test/ignored",
	};
}

describe("interactive workspace facts", () => {
	it("refreshes volatile Git fields at construction while preserving session-bound facts", () => {
		const boot = workspace({ cwd: "/boot", branch: "boot" });
		const bound = workspace();
		const probedCwds: string[] = [];
		const facts = createWorkspaceFacts({
			cwd: "/boot",
			getSessionWorkspace: () => bound,
			probeWorkspace: (cwd) => {
				strictEqual(cwd, "/boot");
				return boot;
			},
			probeGit: (cwd) => {
				probedCwds.push(cwd);
				return gitFacts("live");
			},
			now: () => 1_000,
		});

		strictEqual(facts.getWorkspaceSnapshot(), bound, "the dashboard retains the session-bound snapshot");
		deepStrictEqual(facts.getLiveWorkspaceSnapshot(), {
			...bound,
			branch: "live",
			dirty: true,
			ahead: 3,
			behind: 2,
			recentCommits: [{ sha: "live", subject: "commit on live" }],
		});
		deepStrictEqual(probedCwds, ["/work/project"]);
	});

	it("throttles ordinary refreshes for five seconds and lets force bypass the throttle", () => {
		let now = 1_000;
		let branch = "initial";
		let gitProbes = 0;
		const facts = createWorkspaceFacts({
			cwd: "/work/project",
			getSessionWorkspace: () => null,
			probeWorkspace: () => workspace(),
			probeGit: () => {
				gitProbes += 1;
				return gitFacts(branch);
			},
			now: () => now,
		});
		strictEqual(gitProbes, 1);

		branch = "too-soon";
		now = 5_999;
		facts.refreshLiveWorkspaceGit();
		strictEqual(gitProbes, 1);
		strictEqual(facts.getLiveWorkspaceSnapshot().branch, "initial");

		now = 6_000;
		facts.refreshLiveWorkspaceGit();
		strictEqual(gitProbes, 2);
		strictEqual(facts.getLiveWorkspaceSnapshot().branch, "too-soon");

		branch = "forced";
		facts.refreshLiveWorkspaceGit(true);
		strictEqual(gitProbes, 3);
		strictEqual(facts.getLiveWorkspaceSnapshot().branch, "forced");
	});

	it("forces a refresh when the session workspace cwd or capture identity changes", () => {
		let current = workspace();
		const probedCwds: string[] = [];
		const facts = createWorkspaceFacts({
			cwd: "/boot",
			getSessionWorkspace: () => current,
			probeWorkspace: () => workspace({ cwd: "/boot" }),
			probeGit: (cwd) => {
				probedCwds.push(cwd);
				return gitFacts(`live-${probedCwds.length}`);
			},
			now: () => 1_000,
		});

		current = workspace({ capturedAt: "2026-08-09T00:00:01.000Z" });
		strictEqual(facts.getLiveWorkspaceSnapshot().branch, "live-2");
		current = workspace({ cwd: "/work/other", capturedAt: "2026-08-09T00:00:01.000Z" });
		strictEqual(facts.getLiveWorkspaceSnapshot().branch, "live-3");
		deepStrictEqual(probedCwds, ["/work/project", "/work/project", "/work/other"]);
	});

	it("uses a non-Git session snapshot directly without probing Git", () => {
		const plain = workspace({ isGit: false, branch: null, dirty: null, ahead: null, behind: null, recentCommits: [] });
		let gitProbes = 0;
		const facts = createWorkspaceFacts({
			cwd: plain.cwd,
			getSessionWorkspace: () => plain,
			probeWorkspace: () => plain,
			probeGit: () => {
				gitProbes += 1;
				return gitFacts("unexpected");
			},
		});

		strictEqual(facts.getLiveWorkspaceSnapshot(), plain);
		facts.refreshLiveWorkspaceGit(true);
		strictEqual(facts.getLiveWorkspaceSnapshot(), plain);
		strictEqual(gitProbes, 0);
	});

	it("counts all discovered extensions but only enabled effective extensions as active", () => {
		const calls: Array<{ cwd?: string; all?: boolean }> = [];
		const facts = createWorkspaceFacts({
			cwd: "/work/project",
			getSessionWorkspace: () => null,
			probeWorkspace: () => workspace({ isGit: false }),
			extensions: {
				list: (cwd, options) => {
					calls.push({ ...(cwd ? { cwd } : {}), ...(options?.all !== undefined ? { all: options.all } : {}) });
					return [
						{ enabled: true, effective: true },
						{ enabled: true, effective: false },
						{ enabled: false, effective: true },
					];
				},
			},
		});

		deepStrictEqual(facts.getExtensionStats(), { active: 1, installed: 3 });
		deepStrictEqual(calls, [{ cwd: "/work/project", all: true }]);
	});

	it("reports zero extension facts when the extension domain is absent", () => {
		const facts = createWorkspaceFacts({
			cwd: "/work/project",
			getSessionWorkspace: () => null,
			probeWorkspace: () => workspace({ isGit: false }),
		});
		deepStrictEqual(facts.getExtensionStats(), { active: 0, installed: 0 });
	});
});
