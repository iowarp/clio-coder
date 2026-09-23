import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { taskWorktreeFindings } from "../../src/cli/doctor-task-worktrees.js";
import { validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import {
	applyTaskWorktree,
	cleanupTaskWorktree,
	createTaskWorktree,
	recoverTaskWorktrees,
} from "../../src/tools/task-worktree.js";
import {
	allowedWorktreeParents,
	diskWorktreeParent,
	prepareWorktreeParent,
	resolveWorktreeRoot,
	WORKTREE_FREE_SPACE_MARGIN_BYTES,
	type WorktreeRootFacts,
} from "../../src/tools/worktree-root.js";

/**
 * `fleet.worktrees.root`. A directory stands in for the tmpfs mount and the
 * host facts are injected, so every mode and the fallback run without a real
 * tmpfs and without filling a disk.
 */
describe("task worktree root", () => {
	let scratch: string;
	let root: string;
	let shm: string;

	function git(cwd: string, ...args: string[]): string {
		return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
	}

	function facts(overrides: Partial<WorktreeRootFacts> = {}): WorktreeRootFacts {
		return {
			tmpfsCandidates: () => [shm],
			filesystemType: (path) => (path === shm ? "tmpfs" : "ext4"),
			freeBytes: () => 8 * 1024 ** 3,
			workingTreeBytes: () => 10 * 1024 ** 2,
			userSegment: () => "clio-coder-test",
			...overrides,
		};
	}

	beforeEach(() => {
		scratch = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-worktree-root-")));
		root = join(scratch, "repo");
		shm = join(scratch, "shm");
		mkdirSync(root);
		mkdirSync(shm);
		git(root, "init", "-q", "-b", "main");
		git(root, "config", "user.email", "t@local");
		git(root, "config", "user.name", "t");
		writeFileSync(join(root, ".gitignore"), ".clio-coder/\n");
		writeFileSync(join(root, "a.txt"), "a\n");
		git(root, "add", ".");
		git(root, "commit", "-q", "-m", "init");
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("defaults to disk, which is today's location", () => {
		strictEqual(DEFAULT_SETTINGS.fleet.worktrees.root, "disk");
		deepStrictEqual(resolveWorktreeRoot({ setting: "disk", projectRoot: root, remoteEligible: false, facts: facts() }), {
			parent: join(root, ".clio-coder", "worktrees"),
			kind: "disk",
		});
	});

	it("parses auto, tmpfs, disk, and an absolute path, and names the key for anything else", () => {
		strictEqual(validateSettings({ version: 2, fleet: {} }).settings.fleet.worktrees.root, "disk");
		for (const value of ["auto", "tmpfs", "disk", "/mnt/scratch/worktrees"]) {
			const result = validateSettings({ version: 2, fleet: { worktrees: { root: value } } });
			deepStrictEqual(result.issues, [], value);
			strictEqual(result.settings.fleet.worktrees.root, value);
		}
		for (const value of ["ram", "relative/dir", 3, null]) {
			const result = validateSettings({ version: 2, fleet: { worktrees: { root: value } } });
			deepStrictEqual(
				result.issues.map((issue) => issue.path),
				["fleet.worktrees.root"],
				String(value),
			);
			strictEqual(result.settings.fleet.worktrees.root, "disk");
		}
		deepStrictEqual(
			validateSettings({ version: 2, fleet: { worktrees: { dir: "x" } } }).issues.map((issue) => issue.path),
			["fleet.worktrees.dir"],
		);
	});

	it("resolves tmpfs and auto to this user's directory for this checkout on the tmpfs mount", () => {
		for (const setting of ["tmpfs", "auto"]) {
			const resolved = resolveWorktreeRoot({ setting, projectRoot: root, remoteEligible: false, facts: facts() });
			strictEqual(resolved.kind, "tmpfs", setting);
			match(resolved.parent, new RegExp(`^${shm}/clio-coder-test/worktrees/[0-9a-f]{16}$`, "u"));
			strictEqual(resolved.notice, undefined);
		}
		const other = resolveWorktreeRoot({ setting: "tmpfs", projectRoot: scratch, remoteEligible: false, facts: facts() });
		ok(
			other.parent !==
				resolveWorktreeRoot({ setting: "tmpfs", projectRoot: root, remoteEligible: false, facts: facts() }).parent,
		);
	});

	it("falls back to disk with a notice when the tmpfs is short of room, and silently under auto when there is none", () => {
		const needed = 10 * 1024 ** 2 * 2 + WORKTREE_FREE_SPACE_MARGIN_BYTES;
		const short = facts({ freeBytes: () => needed - 1 });
		for (const setting of ["tmpfs", "auto"]) {
			const resolved = resolveWorktreeRoot({ setting, projectRoot: root, remoteEligible: false, facts: short });
			strictEqual(resolved.kind, "disk", setting);
			match(resolved.notice ?? "", /has \d+ MiB free and a worktree needs \d+ MiB/u, setting);
		}
		strictEqual(
			resolveWorktreeRoot({
				setting: "tmpfs",
				projectRoot: root,
				remoteEligible: false,
				facts: facts({ freeBytes: () => needed }),
			}).kind,
			"tmpfs",
		);
		const none = facts({ filesystemType: () => "ext4" });
		deepStrictEqual(resolveWorktreeRoot({ setting: "auto", projectRoot: root, remoteEligible: false, facts: none }), {
			parent: diskWorktreeParent(root),
			kind: "disk",
		});
		match(
			resolveWorktreeRoot({ setting: "tmpfs", projectRoot: root, remoteEligible: false, facts: none }).notice ?? "",
			/no usable tmpfs \(.*is ext4, not tmpfs\)/u,
		);
	});

	it("keeps remote-eligible runs under the project root whatever the setting", () => {
		for (const setting of ["tmpfs", "auto", join(scratch, "elsewhere")]) {
			const resolved = resolveWorktreeRoot({ setting, projectRoot: root, remoteEligible: true, facts: facts() });
			strictEqual(resolved.parent, diskWorktreeParent(root), setting);
			match(resolved.notice ?? "", /fleet nodes are configured/u);
		}
	});

	it("uses an absolute path, keyed by checkout, with the same free-space check", () => {
		const custom = join(scratch, "elsewhere");
		mkdirSync(custom);
		const resolved = resolveWorktreeRoot({ setting: custom, projectRoot: root, remoteEligible: false, facts: facts() });
		strictEqual(resolved.kind, "path");
		match(resolved.parent, new RegExp(`^${custom}/[0-9a-f]{16}$`, "u"));
		strictEqual(
			resolveWorktreeRoot({
				setting: custom,
				projectRoot: root,
				remoteEligible: false,
				facts: facts({ freeBytes: () => 1 }),
			}).kind,
			"disk",
		);
	});

	it("creates, applies, and cleans a worktree off the project root while the claim stays in the project", () => {
		const resolved = resolveWorktreeRoot({ setting: "tmpfs", projectRoot: root, remoteEligible: false, facts: facts() });
		strictEqual(prepareWorktreeParent(resolved), null);
		strictEqual(statSync(join(shm, "clio-coder-test")).mode & 0o777, 0o700);
		const task = createTaskWorktree(root, "run-tmpfs", undefined, "merge", resolved.parent);
		strictEqual(task.path, join(resolved.parent, "run-tmpfs"));
		ok(existsSync(join(task.path, "a.txt")));
		const claim = join(root, ".clio-coder", "worktrees", "run-tmpfs.task-owner.json");
		strictEqual((JSON.parse(readFileSync(claim, "utf8")) as { path: string }).path, task.path);
		strictEqual(existsSync(`${task.path}.task-owner.json`), false);

		writeFileSync(join(task.path, "a.txt"), "changed in the worktree\n");
		strictEqual(applyTaskWorktree({ worktree: task, apply: "merge" }).applied, true);
		strictEqual(readFileSync(join(root, "a.txt"), "utf8"), "changed in the worktree\n");
		cleanupTaskWorktree(task, true);
		strictEqual(existsSync(task.path), false);
		strictEqual(existsSync(claim), false);
		strictEqual(git(root, "branch", "--list", "clio-coder/task/*"), "");
	});

	it("refuses ownership of a path outside the parent it was created under", () => {
		const resolved = resolveWorktreeRoot({ setting: "tmpfs", projectRoot: root, remoteEligible: false, facts: facts() });
		prepareWorktreeParent(resolved);
		const task = createTaskWorktree(root, "run-owned", undefined, "merge", resolved.parent);
		const outside = join(scratch, "victim");
		mkdirSync(outside);
		throws(() => cleanupTaskWorktree({ ...task, path: outside }, true), /invalid ownership path/u);
		throws(
			() => cleanupTaskWorktree({ ...task, parent: scratch, path: join(scratch, "run-owned") }, true),
			/do not match/u,
		);
		ok(existsSync(outside));
		ok(existsSync(task.path));
	});

	it("refuses a tmpfs directory another user could have planted", () => {
		const resolved = resolveWorktreeRoot({ setting: "tmpfs", projectRoot: root, remoteEligible: false, facts: facts() });
		mkdirSync(join(scratch, "planted"));
		symlinkSync(join(scratch, "planted"), join(shm, "clio-coder-test"));
		match(prepareWorktreeParent(resolved) ?? "", /is not a plain directory/u);
		// unlink, not rmSync: Node 24.9's rmSync refuses a link to a directory with EISDIR.
		unlinkSync(join(shm, "clio-coder-test"));
		mkdirSync(join(shm, "clio-coder-test"), { mode: 0o777 });
		spawnSync("chmod", ["777", join(shm, "clio-coder-test")]);
		match(prepareWorktreeParent(resolved) ?? "", /is writable by other users/u);
	});

	function crash(claimPath: string): void {
		const marker = JSON.parse(readFileSync(claimPath, "utf8")) as { owner: { host: string } };
		const dead = spawnSync(process.execPath, ["-e", ""]);
		writeFileSync(
			claimPath,
			JSON.stringify({ ...marker, owner: { host: marker.owner.host, pid: dead.pid, birthToken: "linux:1" } }),
		);
	}

	it("recovers a worktree under the configured root, and one whose tmpfs was lost at reboot", () => {
		const resolved = resolveWorktreeRoot({ setting: "tmpfs", projectRoot: root, remoteEligible: false, facts: facts() });
		prepareWorktreeParent(resolved);
		const allowed = allowedWorktreeParents("tmpfs", root, facts());
		const claimOf = (runId: string) => join(root, ".clio-coder", "worktrees", `${runId}.task-owner.json`);

		const clean = createTaskWorktree(root, "run-clean", undefined, "merge", resolved.parent);
		crash(claimOf("run-clean"));
		const lost = createTaskWorktree(root, "run-lost", undefined, "merge", resolved.parent);
		writeFileSync(join(lost.path, "uncommitted.txt"), "gone with the mount\n");
		crash(claimOf("run-lost"));
		const kept = createTaskWorktree(root, "run-kept", undefined, "merge", resolved.parent);
		writeFileSync(join(kept.path, "a.txt"), "committed\n");
		git(kept.path, "-c", "user.name=w", "-c", "user.email=w@local", "commit", "-qam", "work");
		crash(claimOf("run-kept"));
		// The reboot: the mount comes back empty.
		rmSync(lost.path, { recursive: true, force: true });
		rmSync(kept.path, { recursive: true, force: true });

		// Without the configured root the sweep does not recognize any of them.
		deepStrictEqual(recoverTaskWorktrees(root), { removed: [], preserved: [], failed: [] });
		const result = recoverTaskWorktrees(root, allowed);
		deepStrictEqual(result.removed.sort(), ["run-clean", "run-lost"]);
		deepStrictEqual(result.failed, []);
		strictEqual(result.preserved.length, 1);
		match(result.preserved[0]?.reason ?? "", /1 commit\(s\) beyond its base \(its working tree is gone\)/u);
		strictEqual(existsSync(clean.path), false);
		strictEqual(
			git(root, "branch", "--list", "clio-coder/task/*", "--format=%(refname:short)"),
			"clio-coder/task/run-kept",
		);
		strictEqual(git(root, "worktree", "list", "--porcelain").includes("run-lost"), false, "stale git metadata is pruned");
	});

	it("never believes a claim that points outside the allowed parents", () => {
		const victim = join(scratch, "victim");
		git(root, "worktree", "add", "-q", "-b", "clio-coder/task/run-forged", victim);
		mkdirSync(join(root, ".clio-coder", "worktrees"), { recursive: true });
		const honest = createTaskWorktree(root, "run-honest");
		const claimPath = join(root, ".clio-coder", "worktrees", "run-forged.task-owner.json");
		const marker = JSON.parse(readFileSync(join(root, ".clio-coder", "worktrees", "run-honest.task-owner.json"), "utf8"));
		writeFileSync(
			claimPath,
			JSON.stringify({
				...marker,
				runId: "run-forged",
				branch: "clio-coder/task/run-forged",
				path: victim,
				owner: { ...marker.owner, pid: spawnSync(process.execPath, ["-e", ""]).pid, birthToken: "linux:1" },
			}),
		);
		deepStrictEqual(recoverTaskWorktrees(root, allowedWorktreeParents("tmpfs", root, facts())), {
			removed: [],
			preserved: [],
			failed: [],
		});
		ok(existsSync(victim));
		ok(existsSync(honest.path));
	});

	it("doctor reports the resolved root, its filesystem, and free space, and warns on a fallback", () => {
		const [ok1] = taskWorktreeFindings(root, { rootSetting: "tmpfs", remoteEligible: false, facts: facts() });
		deepStrictEqual([ok1?.name, ok1?.level], ["task worktree root", "ok"]);
		match(
			ok1?.detail ?? "",
			/fleet\.worktrees\.root tmpfs: .*\/shm\/clio-coder-test\/worktrees\/[0-9a-f]{16} \(tmpfs, 8\.0 GiB free\)$/u,
		);
		const [short] = taskWorktreeFindings(root, {
			rootSetting: "tmpfs",
			remoteEligible: false,
			facts: facts({ freeBytes: () => 1 }),
		});
		strictEqual(short?.level, "warn");
		match(short?.detail ?? "", /\.clio-coder\/worktrees \(ext4, .*\); .* using the project root$/u);
	});
});
