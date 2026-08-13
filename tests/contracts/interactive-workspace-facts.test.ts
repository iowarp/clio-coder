import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { GitStatusProbeResult, WorkspaceSnapshot } from "../../src/domains/session/workspace/index.js";
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

function gitFacts(branch: string): GitStatusProbeResult {
	return {
		isGit: true,
		branch,
		dirty: true,
		remoteUrl: "https://git-probe.test/ignored",
	};
}

describe("interactive workspace facts", () => {
	it("refreshes volatile Git fields at construction while preserving session-bound facts", async () => {
		const boot = workspace({ cwd: "/boot", branch: "boot" });
		const bound = workspace();
		const probedCwds: string[] = [];
		const facts = createWorkspaceFacts({
			cwd: "/boot",
			getSessionWorkspace: () => bound,
			probeWorkspace: async (cwd) => {
				strictEqual(cwd, "/boot");
				return boot;
			},
			probeGitStatus: async (cwd) => {
				probedCwds.push(cwd);
				return gitFacts("live");
			},
			now: () => 1_000,
		});
		await facts.ready();

		strictEqual(facts.getWorkspaceSnapshot(), bound, "the dashboard retains the session-bound snapshot");
		// ahead/behind/recentCommits stay as session bind captured them: the polling
		// probe no longer spends two subprocesses on fields nothing paints.
		deepStrictEqual(facts.getLiveWorkspaceSnapshot(), {
			...bound,
			branch: "live",
			dirty: true,
		});
		deepStrictEqual(probedCwds, ["/work/project"]);
	});

	it("paints an empty workspace until the boot probe lands", async () => {
		let release: (snapshot: WorkspaceSnapshot) => void = () => {};
		const pending = new Promise<WorkspaceSnapshot>((resolve) => {
			release = resolve;
		});
		const facts = createWorkspaceFacts({
			cwd: "/work/project",
			getSessionWorkspace: () => null,
			probeWorkspace: () => pending,
			probeGitStatus: async () => gitFacts("late"),
		});

		// Construction must not have blocked on the probe.
		strictEqual(facts.getWorkspaceSnapshot().isGit, false);
		strictEqual(facts.getWorkspaceSnapshot().branch, null);
		strictEqual(facts.getWorkspaceSnapshot().cwd, "/work/project");

		release(workspace());
		await facts.ready();
		strictEqual(facts.getWorkspaceSnapshot().branch, "bound-branch");
		strictEqual(facts.getLiveWorkspaceSnapshot().branch, "late");
	});

	it("throttles ordinary refreshes for five seconds and lets force bypass the throttle", async () => {
		let now = 1_000;
		let branch = "initial";
		let gitProbes = 0;
		const facts = createWorkspaceFacts({
			cwd: "/work/project",
			getSessionWorkspace: () => null,
			probeWorkspace: async () => workspace(),
			probeGitStatus: async () => {
				gitProbes += 1;
				return gitFacts(branch);
			},
			now: () => now,
		});
		await facts.ready();
		strictEqual(gitProbes, 1);

		branch = "too-soon";
		now = 5_999;
		await facts.refreshLiveWorkspaceGit();
		strictEqual(gitProbes, 1);
		strictEqual(facts.getLiveWorkspaceSnapshot().branch, "initial");

		now = 6_000;
		await facts.refreshLiveWorkspaceGit();
		strictEqual(gitProbes, 2);
		strictEqual(facts.getLiveWorkspaceSnapshot().branch, "too-soon");

		branch = "forced";
		await facts.refreshLiveWorkspaceGit(true);
		strictEqual(gitProbes, 3);
		strictEqual(facts.getLiveWorkspaceSnapshot().branch, "forced");
	});

	it("collapses overlapping refreshes onto one in-flight probe", async () => {
		let gitProbes = 0;
		const gate: { release: () => void } = { release: () => {} };
		const facts = createWorkspaceFacts({
			cwd: "/work/project",
			getSessionWorkspace: () => workspace(),
			probeWorkspace: async () => workspace(),
			probeGitStatus: async () => {
				gitProbes += 1;
				await new Promise<void>((resolve) => {
					gate.release = resolve;
				});
				return gitFacts("slow");
			},
			now: () => 1_000,
		});

		const first = facts.refreshLiveWorkspaceGit(true);
		const second = facts.refreshLiveWorkspaceGit(true);
		const third = facts.refreshLiveWorkspaceGit(true);
		strictEqual(gitProbes, 1, "a probe already in flight absorbs later forced refreshes");
		gate.release();
		await Promise.all([first, second, third, facts.ready()]);
		strictEqual(gitProbes, 1);
		strictEqual(facts.getLiveWorkspaceSnapshot().branch, "slow");
	});

	it("forces a refresh when the session workspace cwd or capture identity changes", async () => {
		let current = workspace();
		const probedCwds: string[] = [];
		const facts = createWorkspaceFacts({
			cwd: "/boot",
			getSessionWorkspace: () => current,
			probeWorkspace: async () => workspace({ cwd: "/boot" }),
			probeGitStatus: async (cwd) => {
				probedCwds.push(cwd);
				return gitFacts(`live-${probedCwds.length}`);
			},
			now: () => 1_000,
		});
		await facts.ready();

		current = workspace({ capturedAt: "2026-08-09T00:00:01.000Z" });
		facts.getLiveWorkspaceSnapshot();
		await facts.refreshLiveWorkspaceGit(true);
		strictEqual(facts.getLiveWorkspaceSnapshot().branch, "live-2");

		current = workspace({ cwd: "/work/other", capturedAt: "2026-08-09T00:00:01.000Z" });
		facts.getLiveWorkspaceSnapshot();
		await facts.refreshLiveWorkspaceGit(true);
		strictEqual(facts.getLiveWorkspaceSnapshot().branch, "live-3");
		deepStrictEqual(probedCwds, ["/work/project", "/work/project", "/work/other"]);
	});

	it("uses a non-Git session snapshot directly without probing Git", async () => {
		const plain = workspace({ isGit: false, branch: null, dirty: null, ahead: null, behind: null, recentCommits: [] });
		let gitProbes = 0;
		const facts = createWorkspaceFacts({
			cwd: plain.cwd,
			getSessionWorkspace: () => plain,
			probeWorkspace: async () => plain,
			probeGitStatus: async () => {
				gitProbes += 1;
				return gitFacts("unexpected");
			},
		});
		await facts.ready();

		strictEqual(facts.getLiveWorkspaceSnapshot(), plain);
		await facts.refreshLiveWorkspaceGit(true);
		strictEqual(facts.getLiveWorkspaceSnapshot(), plain);
		strictEqual(gitProbes, 0);
	});

	it("counts all discovered extensions but only enabled effective extensions as active", async () => {
		const calls: Array<{ cwd?: string; all?: boolean }> = [];
		const facts = createWorkspaceFacts({
			cwd: "/work/project",
			getSessionWorkspace: () => null,
			probeWorkspace: async () => workspace({ isGit: false }),
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
		await facts.ready();

		deepStrictEqual(facts.getExtensionStats(), { active: 1, installed: 3 });
		deepStrictEqual(calls, [{ cwd: "/work/project", all: true }]);
	});

	it("serves extension counts from cache instead of walking the tree per frame", async () => {
		let listCalls = 0;
		let now = 1_000;
		const facts = createWorkspaceFacts({
			cwd: "/work/project",
			getSessionWorkspace: () => null,
			probeWorkspace: async () => workspace({ isGit: false }),
			now: () => now,
			extensions: {
				list: () => {
					listCalls += 1;
					return [{ enabled: true, effective: true }];
				},
			},
		});
		await facts.ready();

		for (let i = 0; i < 60; i += 1) facts.getExtensionStats();
		strictEqual(listCalls, 1, "sixty frames must not mean sixty directory walks");

		now = 6_001;
		deepStrictEqual(facts.getExtensionStats(), { active: 1, installed: 1 });
		strictEqual(listCalls, 2, "the cache expires so a newly installed extension still appears");
	});

	it("reports zero extension facts when the extension domain is absent", async () => {
		const facts = createWorkspaceFacts({
			cwd: "/work/project",
			getSessionWorkspace: () => null,
			probeWorkspace: async () => workspace({ isGit: false }),
		});
		await facts.ready();
		deepStrictEqual(facts.getExtensionStats(), { active: 0, installed: 0 });
	});
});
