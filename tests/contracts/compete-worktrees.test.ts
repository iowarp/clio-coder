import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createMuxRuntime, type MuxRuntime } from "../../src/domains/mux/contract.js";
import { detectMux } from "../../src/domains/mux/detect.js";
import { createMuxClient } from "../../src/domains/mux/socket-client.js";
import {
	claimCompeteGroup,
	cleanupCompeteGroup,
	createCandidateWorktreeMapped,
	removeCandidateWorktreeMapped,
} from "../../src/tools/compete-worktrees.js";
import { type FakeHerdrRequest, type FakeHerdrServer, startFakeHerdrServer } from "../harness/fake-herdr-server.js";

const roots: string[] = [];
const runtimes: MuxRuntime[] = [];
const servers: FakeHerdrServer[] = [];

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.stop().catch(() => undefined);
	for (const server of servers.splice(0)) await server.stop().catch(() => undefined);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function repo(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-mux-compete-"));
	roots.push(root);
	git(root, "init", "-b", "main");
	git(root, "config", "user.name", "test");
	git(root, "config", "user.email", "test@local");
	writeFileSync(join(root, "README.md"), "baseline\n");
	git(root, "add", "-A");
	git(root, "commit", "-m", "baseline");
	return root;
}

function pane(paneId: string, tabId: string, workspaceId: string): Record<string, unknown> {
	return {
		pane_id: paneId,
		terminal_id: `term-${paneId}`,
		workspace_id: workspaceId,
		tab_id: tabId,
		focused: false,
		agent_status: "unknown",
		revision: 1,
		label: null,
		title: null,
		cwd: "/tmp",
		agent: null,
		tokens: {},
		state_labels: {},
	};
}

function tab(tabId: string, workspaceId: string): Record<string, unknown> {
	return {
		tab_id: tabId,
		workspace_id: workspaceId,
		number: 1,
		label: "candidate",
		focused: false,
		pane_count: 1,
		agent_status: "unknown",
	};
}

function worktree(path: string, branch: string, workspaceId: string): Record<string, unknown> {
	return {
		path,
		branch,
		is_bare: false,
		is_detached: false,
		is_prunable: false,
		is_linked_worktree: true,
		open_workspace_id: workspaceId,
		label: branch,
	};
}

async function muxBackedByGit(root: string): Promise<{ runtime: MuxRuntime; fake: FakeHerdrServer }> {
	const fake = await startFakeHerdrServer();
	servers.push(fake);
	const paths = new Map<string, string>();
	let nextWorkspace = 1;
	fake.setHandler("worktree.create", (request: FakeHerdrRequest) => {
		const path = String(request.params.path);
		const branch = String(request.params.branch);
		const base = String(request.params.base);
		git(root, "worktree", "add", "-b", branch, path, base);
		nextWorkspace += 1;
		const workspaceId = `w${nextWorkspace}`;
		paths.set(workspaceId, path);
		const tabId = `${workspaceId}:t1`;
		const paneId = `${workspaceId}:p1`;
		return {
			result: {
				type: "worktree_created",
				workspace: {
					workspace_id: workspaceId,
					number: nextWorkspace,
					label: branch,
					focused: false,
					pane_count: 1,
					tab_count: 1,
					active_tab_id: tabId,
					agent_status: "unknown",
					tokens: {},
				},
				tab: tab(tabId, workspaceId),
				root_pane: pane(paneId, tabId, workspaceId),
				worktree: worktree(path, branch, workspaceId),
			},
		};
	});
	fake.setHandler("worktree.remove", (request: FakeHerdrRequest) => {
		const workspaceId = String(request.params.workspace_id);
		const path = paths.get(workspaceId);
		if (!path) return { error: { code: "worktree_not_found", message: "missing worktree" } };
		git(root, "worktree", "remove", "--force", path);
		paths.delete(workspaceId);
		return {
			result: { type: "worktree_removed", workspace_id: workspaceId, path, forced: request.params.force === true },
		};
	});

	const detected = await detectMux({
		env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: fake.socketPath, HERDR_WORKSPACE_ID: "w1" },
		openClient: (socketPath) =>
			createMuxClient({
				socketPath,
				requestTimeoutMs: 750,
				connectTimeoutMs: 250,
				backoff: { initialDelayMs: 5, maxDelayMs: 10, factor: 2 },
			}),
	});
	ok(detected.client);
	const runtime = createMuxRuntime({ detection: detected.detection, client: detected.client });
	runtimes.push(runtime);
	return { runtime, fake };
}

function competeBranches(root: string): string[] {
	return git(root, "branch", "--list", "clio/compete/*", "--format=%(refname:short)").split("\n").filter(Boolean);
}

describe("compete worktree mux mapping", () => {
	it("creates and removes a candidate through the fake herdr lifecycle", async () => {
		const root = repo();
		const { runtime, fake } = await muxBackedByGit(root);
		const ownership = claimCompeteGroup(root, "mux-lifecycle");
		const candidate = await createCandidateWorktreeMapped(ownership, 1, "HEAD", runtime.contract);

		strictEqual(candidate.provenance?.backend, "herdr");
		strictEqual(candidate.provenance?.workspaceId, "w2");
		strictEqual(existsSync(candidate.path), true);
		strictEqual(fake.requestsFor("worktree.create").length, 1);

		await removeCandidateWorktreeMapped(ownership, candidate, true, runtime.contract);
		strictEqual(fake.requestsFor("worktree.remove").length, 1);
		strictEqual(existsSync(candidate.path), false);
		deepStrictEqual(competeBranches(root), []);
		cleanupCompeteGroup(ownership);
	});

	it("falls back natively after mux loss partway through one competition", async () => {
		const root = repo();
		const { runtime, fake } = await muxBackedByGit(root);
		const ownership = claimCompeteGroup(root, "mux-loss");
		const first = await createCandidateWorktreeMapped(ownership, 1, "HEAD", runtime.contract);
		strictEqual(first.provenance?.backend, "herdr");

		await fake.stop();
		servers.splice(servers.indexOf(fake), 1);
		const second = await createCandidateWorktreeMapped(ownership, 2, "HEAD", runtime.contract);
		deepStrictEqual(second.provenance, {
			backend: "native",
			path: second.path,
			branch: second.branch,
			fallback: "mux-operation-failed",
		});
		strictEqual(existsSync(first.path), true);
		strictEqual(existsSync(second.path), true);

		await removeCandidateWorktreeMapped(ownership, first, true, runtime.contract);
		await removeCandidateWorktreeMapped(ownership, second, true, runtime.contract);
		cleanupCompeteGroup(ownership);
		strictEqual(existsSync(first.path), false);
		strictEqual(existsSync(second.path), false);
		deepStrictEqual(competeBranches(root), []);
	});
});
