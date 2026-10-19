import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installInternalGitPolicy } from "../../src/core/internal-git.js";
import { createGitHooksFingerprinter } from "../../src/core/sandbox/git-hooks-fingerprint.js";
import { createGitHookDriftGuard } from "../../src/domains/safety/hook-drift.js";
import { createInternalGitPolicy, type InternalGitDriftRecord } from "../../src/domains/safety/internal-git-policy.js";
import { probeGit } from "../../src/domains/session/workspace/git-probe.js";
import { createTaskWorktree, snapshotTaskWorktree } from "../../src/tools/task-worktree.js";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A repository with one commit, and a scratch directory beside it for markers. */
function repository(): { root: string; scratch: string } {
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "clio-internal-git-")));
	const root = join(scratch, "repo");
	strictEqual(spawnSync("git", ["init", "-q", root]).status, 0);
	writeFileSync(join(root, "a.txt"), "one\n");
	git(root, "add", "a.txt");
	git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
	return { root, scratch };
}

/** An executable script that creates `marker` when it runs. */
function markerScript(file: string, marker: string, tail = ""): string {
	writeFileSync(file, `#!/bin/sh\ntouch '${marker}'\n${tail}`);
	chmodSync(file, 0o755);
	return file;
}

/** The orchestrator's wiring: a drift guard baselined now, and the policy installed over it. */
function session(root: string, scratch: string, autonomy: "default" | "yolo" = "default") {
	const fingerprinter = createGitHooksFingerprinter(root);
	const guard = createGitHookDriftGuard({
		workspace: root,
		fingerprint: () => fingerprinter.fingerprint(),
		config: (dir) => fingerprinter.config(dir),
	});
	const records: InternalGitDriftRecord[] = [];
	installInternalGitPolicy(
		createInternalGitPolicy({
			workspace: root,
			guard,
			autonomy: () => autonomy,
			emptyHooksDir: join(scratch, "no-hooks"),
			onDrift: (record) => records.push(record),
		}),
	);
	return { guard, records };
}

test("a post-checkout hook planted after the baseline does not run in Clio's worktree add, and one in the baseline does", (t) => {
	t.after(() => installInternalGitPolicy(null));
	const planted = repository();
	const late = join(planted.scratch, "late-hook-ran");
	const drifted = session(planted.root, planted.scratch);
	markerScript(join(planted.root, ".git", "hooks", "post-checkout"), late);
	createTaskWorktree(planted.root, "run-drift");
	strictEqual(existsSync(late), false, "the hook planted during the session did not run");
	strictEqual(drifted.records.length, 1);
	strictEqual(drifted.records[0]?.operation, "git worktree add");
	strictEqual(drifted.records[0]?.hardened, true);
	match(drifted.records[0]?.message ?? "", /hooks off.*added \.git\/hooks\/post-checkout/u);

	const baseline = repository();
	const early = join(baseline.scratch, "baseline-hook-ran");
	markerScript(join(baseline.root, ".git", "hooks", "post-checkout"), early);
	const steady = session(baseline.root, baseline.scratch);
	createTaskWorktree(baseline.root, "run-steady");
	ok(existsSync(early), "the hook the session started with ran");
	deepStrictEqual(steady.records, []);
	rmSync(planted.scratch, { recursive: true, force: true });
	rmSync(baseline.scratch, { recursive: true, force: true });
});

test("Clio's status probe does not run a configured core.fsmonitor command", () => {
	const { root, scratch } = repository();
	const marker = join(scratch, "fsmonitor-ran");
	git(root, "config", "core.fsmonitor", markerScript(join(scratch, "fsmonitor.sh"), marker, "exit 1\n"));
	strictEqual(probeGit(root).isGit, true);
	strictEqual(existsSync(marker), false, "the internal status probe did not run it");
	spawnSync("git", ["-C", root, "status", "--porcelain"]);
	ok(existsSync(marker), "a plain git status runs it, so the fixture is live");
	rmSync(scratch, { recursive: true, force: true });
});

test("Clio's receipt diff does not run a changed diff.external", () => {
	const { root, scratch } = repository();
	const worktree = createTaskWorktree(root, "run-diff");
	const marker = join(scratch, "external-diff-ran");
	git(root, "config", "diff.external", markerScript(join(scratch, "external.sh"), marker));
	writeFileSync(join(worktree.path, "a.txt"), "two\n");
	const receipt = snapshotTaskWorktree(worktree, "preserve");
	deepStrictEqual(receipt.changedPaths, ["a.txt"]);
	strictEqual(existsSync(marker), false, "the internal diff did not run it");
	spawnSync("git", ["-C", worktree.path, "diff"]);
	ok(existsSync(marker), "a plain git diff runs it, so the fixture is live");
	rmSync(scratch, { recursive: true, force: true });
});

test("an executable git config value set after the baseline is drift, and a plain one is not", () => {
	const { root, scratch } = repository();
	const fingerprinter = createGitHooksFingerprinter(root);
	const guard = createGitHookDriftGuard({ workspace: root, fingerprint: () => fingerprinter.fingerprint() });
	git(root, "config", "user.name", "someone");
	strictEqual(guard.check(), null);
	git(root, "config", "core.sshCommand", "ssh -o ProxyCommand=evil");
	const drift = guard.check();
	deepStrictEqual(
		drift?.changes.map(({ path, kind, key }) => ({ path, kind, key })),
		[{ path: join(root, ".git", "config"), kind: "added", key: "core.sshcommand" }],
	);
	match(drift?.summary ?? "", /added core\.sshcommand in \.git\/config \('ssh -o ProxyCommand=evil'\)/u);
	rmSync(scratch, { recursive: true, force: true });
});

/** Maps a.txt to filter `name` and moves its mtime, so the next status passes it through the clean filter. */
function filtered(root: string, name: string): void {
	writeFileSync(join(root, ".git", "info", "attributes"), `a.txt filter=${name}\n`);
	const later = new Date(Date.now() + 10_000);
	utimesSync(join(root, "a.txt"), later, later);
}

test("a clean filter added after the baseline does not run in Clio's status probe, and a baseline lfs filter does", (t) => {
	t.after(() => installInternalGitPolicy(null));
	const planted = repository();
	const late = join(planted.scratch, "planted-filter-ran");
	const drifted = session(planted.root, planted.scratch);
	git(planted.root, "config", "filter.x.clean", markerScript(join(planted.scratch, "clean.sh"), late, "cat\n"));
	filtered(planted.root, "x");
	strictEqual(probeGit(planted.root).isGit, true);
	strictEqual(existsSync(late), false, "the filter planted during the session did not run");
	strictEqual(drifted.records[0]?.outcome, "overridden");
	spawnSync("git", ["-C", planted.root, "status", "--porcelain"]);
	ok(existsSync(late), "a plain git status runs it, so the fixture is live");

	const baseline = repository();
	const lfs = join(baseline.scratch, "lfs-filter-ran");
	git(baseline.root, "config", "filter.lfs.clean", markerScript(join(baseline.scratch, "lfs.sh"), lfs, "cat\n"));
	git(baseline.root, "config", "filter.lfs.required", "true");
	const steady = session(baseline.root, baseline.scratch);
	filtered(baseline.root, "lfs");
	strictEqual(probeGit(baseline.root).isGit, true);
	ok(existsSync(lfs), "the filter the session started with ran");
	deepStrictEqual(steady.records, []);
	rmSync(planted.scratch, { recursive: true, force: true });
	rmSync(baseline.scratch, { recursive: true, force: true });
});
