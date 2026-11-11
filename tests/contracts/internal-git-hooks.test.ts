import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { installInternalGitPolicy, internalGitArgv } from "../../src/core/internal-git.js";
import { createGitHooksFingerprinter } from "../../src/core/sandbox/git-hooks-fingerprint.js";
import { git as researchGit } from "../../src/domains/research/git.js";
import { createGitHookDriftGuard } from "../../src/domains/safety/hook-drift.js";
import { createInternalGitPolicy, type InternalGitDriftRecord } from "../../src/domains/safety/internal-git-policy.js";
import { probeGit } from "../../src/domains/session/workspace/git-probe.js";
import { createTaskWorktree, snapshotTaskWorktree } from "../../src/tools/task-worktree.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

let env: IsolatedClioEnv;
beforeEach(async () => {
	env = await isolateClioEnv("internal-git-hooks-");
	// Inherited command-scope config must not shadow the fixture's live hooks.
	delete process.env.GIT_CONFIG_PARAMETERS;
	process.env.GIT_CONFIG_COUNT = "0";
	process.env.GIT_CONFIG_GLOBAL = "/dev/null";
	process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterEach(() => env.restore());

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

test("a filter the repository's own config names does not run in Clio's status probe, even at session start, and a global one does", (t) => {
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

	// A pre-seeded .git/config is no drift, and yolo trusts drift, but its filter still does not run.
	const seeded = repository();
	const early = join(seeded.scratch, "seeded-filter-ran");
	git(seeded.root, "config", "filter.x.clean", markerScript(join(seeded.scratch, "clean.sh"), early, "cat\n"));
	git(seeded.root, "config", "filter.x.required", "true");
	const quiet = session(seeded.root, seeded.scratch, "yolo");
	filtered(seeded.root, "x");
	strictEqual(probeGit(seeded.root).isGit, true);
	strictEqual(existsSync(early), false, "the filter the repository started with did not run");
	deepStrictEqual(quiet.records, []);
	spawnSync("git", ["-C", seeded.root, "status", "--porcelain"]);
	ok(existsSync(early), "a plain git status runs it, so the fixture is live");

	const global = repository();
	const lfs = join(global.scratch, "lfs-filter-ran");
	const globalConfig = join(global.scratch, "gitconfig");
	writeFileSync(
		globalConfig,
		`[filter "lfs"]\n\tclean = ${markerScript(join(global.scratch, "lfs.sh"), lfs, "cat\n")}\n\trequired = true\n`,
	);
	process.env.GIT_CONFIG_GLOBAL = globalConfig;
	const steady = session(global.root, global.scratch);
	filtered(global.root, "lfs");
	strictEqual(probeGit(global.root).isGit, true);
	ok(existsSync(lfs), "the operator's global filter ran");
	deepStrictEqual(steady.records, []);
	rmSync(planted.scratch, { recursive: true, force: true });
	rmSync(seeded.scratch, { recursive: true, force: true });
	rmSync(global.scratch, { recursive: true, force: true });
});

/** Puts a `git` first on PATH that rejects `--show-scope` the way git before 2.26 does, and runs the real one otherwise. */
function gitWithoutShowScope(t: { after: (fn: () => void) => void }, scratch: string): void {
	const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
	const bin = join(scratch, "old-git");
	execFileSync("mkdir", ["-p", bin]);
	writeFileSync(
		join(bin, "git"),
		`#!/bin/sh\nfor a; do [ "$a" = --show-scope ] && { echo "error: unknown option \\\`show-scope'" >&2; exit 129; }; done\nexec '${real}' "$@"\n`,
	);
	chmodSync(join(bin, "git"), 0o755);
	const prior = process.env.PATH;
	process.env.PATH = `${bin}:${prior ?? ""}`;
	t.after(() => {
		process.env.PATH = prior;
	});
}

test("on a git without --show-scope the drift guard still sees config and a repository's filter still does not run", (t) => {
	t.after(() => installInternalGitPolicy(null));
	const { root, scratch } = repository();
	gitWithoutShowScope(t, scratch);
	const marker = join(scratch, "old-git-filter-ran");
	git(root, "config", "filter.x.clean", markerScript(join(scratch, "clean.sh"), marker, "cat\n"));
	const { guard } = session(root, scratch);
	filtered(root, "x");
	strictEqual(probeGit(root).isGit, true);
	strictEqual(existsSync(marker), false, "the repository's filter did not run");
	git(root, "config", "core.sshCommand", "ssh -o ProxyCommand=evil");
	deepStrictEqual(
		guard.check()?.changes.map(({ kind, key }) => ({ kind, key })),
		[{ kind: "added", key: "core.sshcommand" }],
	);
	spawnSync("git", ["-C", root, "status", "--porcelain"]);
	ok(existsSync(marker), "a plain git status runs it, so the fixture is live");
	rmSync(scratch, { recursive: true, force: true });
});

test("a repository filter whose key no -c can name refuses Clio's read at every autonomy, drift or not", (t) => {
	t.after(() => installInternalGitPolicy(null));
	for (const autonomy of ["default", "yolo"] as const) {
		const { root, scratch } = repository();
		const marker = join(scratch, "unnamed-filter-ran");
		git(root, "config", "filter.a=b.clean", markerScript(join(scratch, "clean.sh"), marker, "cat\n"));
		const { records } = session(root, scratch, autonomy);
		filtered(root, "a=b");
		probeGit(root);
		strictEqual(existsSync(marker), false, `the filter did not run at ${autonomy}`);
		deepStrictEqual(
			records.map(({ outcome, unneutralized }) => ({ outcome, unneutralized })),
			[{ outcome: "skipped", unneutralized: ["filter.a=b.clean"] }],
		);
		match(records[0]?.message ?? "", /own config sets a filter driver .*filter\.a=b\.clean/u);
		spawnSync("git", ["-C", root, "status", "--porcelain"]);
		ok(existsSync(marker), "a plain git status runs it, so the fixture is live");
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("a repository config git cannot list within its bounds refuses Clio's read and runs its worktree add with hooks off", (t) => {
	t.after(() => installInternalGitPolicy(null));
	const { root, scratch } = repository();
	const filterRan = join(scratch, "oversized-filter-ran");
	const hookRan = join(scratch, "oversized-hook-ran");
	git(root, "config", "filter.big.clean", markerScript(join(scratch, "clean.sh"), filterRan, "cat\n"));
	markerScript(join(root, ".git", "hooks", "post-checkout"), hookRan);
	// Over the listing's 4 MiB output bound, from before the baseline.
	appendFileSync(join(root, ".git", "config"), `[padding]\n${"\tkey = ".padEnd(1024, "x")}\n`.repeat(5 * 1024));
	const { records } = session(root, scratch);
	filtered(root, "big");
	probeGit(root);
	strictEqual(existsSync(filterRan), false, "the filter in the unlistable config did not run");
	createTaskWorktree(root, "run-unlisted");
	strictEqual(existsSync(hookRan), false, "the hook did not run");
	deepStrictEqual(
		records.map(({ outcome, unneutralized }) => ({ outcome, unneutralized })),
		[
			{ outcome: "skipped", unneutralized: ["(unlisted git config)"] },
			{ outcome: "hooks-off", unneutralized: ["(unlisted git config)"] },
		],
	);
	match(records[0]?.message ?? "", /cannot list .*git config/u);
	spawnSync("git", ["-C", root, "status", "--porcelain"]);
	ok(existsSync(filterRan), "a plain git status runs the filter, so the fixture is live");
	rmSync(scratch, { recursive: true, force: true });
});

test("an include target missing at the baseline is watched, so a filter it gains later does not run in Clio's read", (t) => {
	t.after(() => installInternalGitPolicy(null));
	const { root, scratch } = repository();
	const marker = join(scratch, "included-filter-ran");
	git(root, "config", "include.path", "../extra.cfg");
	session(root, scratch);
	probeGit(root);
	writeFileSync(
		join(root, "extra.cfg"),
		`[filter "late"]\n\tclean = ${markerScript(join(scratch, "clean.sh"), marker, "cat\n")}\n`,
	);
	filtered(root, "late");
	probeGit(root);
	strictEqual(existsSync(marker), false, "the filter the include gained did not run");
	spawnSync("git", ["-C", root, "status", "--porcelain"]);
	ok(existsSync(marker), "a plain git status runs it, so the fixture is live");
	rmSync(scratch, { recursive: true, force: true });
});

test("a repository's stock git-lfs filter stays on for Clio's reads, and one with a second line or an extension command does not", () => {
	const { root, scratch } = repository();
	const fingerprinter = createGitHooksFingerprinter(root);
	const guard = createGitHookDriftGuard({
		workspace: root,
		fingerprint: () => fingerprinter.fingerprint(),
		config: (dir) => fingerprinter.config(dir),
	});
	const policy = createInternalGitPolicy({
		workspace: root,
		guard,
		// Yolo skips the drift check, so only the repository-filter rule speaks.
		autonomy: () => "yolo",
		emptyHooksDir: join(scratch, "no-hooks"),
	});
	const read = () => policy.read?.({ repository: root, operation: "status" }) ?? [];
	git(root, "config", "filter.lfs.clean", "git-lfs clean -- %f");
	git(root, "config", "filter.lfs.process", "git-lfs filter-process");
	deepStrictEqual(read(), []);
	git(root, "config", "filter.lfs.clean", "git-lfs clean -- %f\ntouch /tmp/x");
	ok(read().includes("filter.lfs.clean="), "a stock-looking first line with more after it is off");
	ok(!read().includes("filter.lfs.process="));
	git(root, "config", "filter.lfs.clean", "git-lfs clean -- %f");
	// git-lfs runs an extension's command from inside the stock filter, and no -c turns one off.
	git(root, "config", "lfs.extension.planted.clean", "touch /tmp/x");
	strictEqual(
		policy.read?.({ repository: root, operation: "status" }),
		null,
		"a repository lfs extension refuses the read",
	);
	rmSync(scratch, { recursive: true, force: true });
});

test("Clio's own checkouts that pin hooks off still smudge through the repository's filter: a reproduce worktree add and a fleet merge", (t) => {
	t.after(() => installInternalGitPolicy(null));
	const { root, scratch } = repository();
	const base = git(root, "rev-parse", "HEAD");
	// A git-crypt or git-annex style repository: its own config names the driver that turns stored bytes into files.
	const smudge = join(scratch, "smudge.sh");
	writeFileSync(smudge, "#!/bin/sh\ntr a-z A-Z\n");
	chmodSync(smudge, 0o755);
	git(root, "config", "filter.crypt.smudge", smudge);
	git(root, "config", "filter.crypt.clean", "cat");
	writeFileSync(join(root, ".gitattributes"), "b.txt filter=crypt\n");
	writeFileSync(join(root, "b.txt"), "two\n");
	git(root, "add", ".gitattributes", "b.txt");
	git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "filtered");
	const head = git(root, "rev-parse", "HEAD");
	const landing = join(scratch, "landing");
	git(root, "worktree", "add", "-q", "--detach", landing, base);
	session(root, scratch);

	const tree = join(scratch, "reproduce");
	const pinned = ["-c", "core.hooksPath=/dev/null"];
	execFileSync("git", internalGitArgv(["-C", root, ...pinned, "worktree", "add", "--detach", "--quiet", tree, head]));
	strictEqual(readFileSync(join(tree, "b.txt"), "utf8"), "TWO\n", "the reproduce worktree holds smudged files");
	execFileSync("git", internalGitArgv(["-C", landing, ...pinned, "merge", "--ff-only", "--no-edit", head]));
	strictEqual(readFileSync(join(landing, "b.txt"), "utf8"), "TWO\n", "the fleet merge lands smudged files");
	ok(internalGitArgv(["-C", root, "status"]).includes("filter.crypt.smudge="), "Clio's reads still turn it off");
	rmSync(scratch, { recursive: true, force: true });
});

test("a filter in a submodule's own config does not run from Clio's status probe of the superproject", (t) => {
	t.after(() => installInternalGitPolicy(null));
	const top = repository();
	const inner = repository();
	git(top.root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner.root, "sub");
	git(top.root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "sub");
	const marker = join(top.scratch, "submodule-filter-ran");
	session(top.root, top.scratch);
	const modules = join(top.root, ".git", "modules", "sub");
	git(join(top.root, "sub"), "config", "filter.x.clean", markerScript(join(top.scratch, "clean.sh"), marker, "cat\n"));
	mkdirSync(join(modules, "info"), { recursive: true });
	writeFileSync(join(modules, "info", "attributes"), "a.txt filter=x\n");
	const later = new Date(Date.now() + 10_000);
	utimesSync(join(top.root, "sub", "a.txt"), later, later);
	strictEqual(probeGit(top.root).isGit, true);
	strictEqual(existsSync(marker), false, "the submodule's filter did not run");
	spawnSync("git", ["-C", top.root, "status", "--porcelain"]);
	ok(existsSync(marker), "a plain git status in the superproject runs it, so the fixture is live");
	rmSync(top.scratch, { recursive: true, force: true });
	rmSync(inner.scratch, { recursive: true, force: true });
});

test("Clio's diff and show of a moved submodule do not run the submodule's diff.external under diff.submodule=diff", (t) => {
	t.after(() => installInternalGitPolicy(null));
	const top = repository();
	const inner = repository();
	git(top.root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner.root, "sub");
	git(top.root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "sub");
	const sub = join(top.root, "sub");
	writeFileSync(join(sub, "a.txt"), "moved\n");
	git(sub, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "move");
	git(top.root, "config", "diff.submodule", "diff");
	const marker = join(top.scratch, "submodule-external-ran");
	git(sub, "config", "diff.external", markerScript(join(top.scratch, "external.sh"), marker));
	session(top.root, top.scratch);
	execFileSync("git", internalGitArgv(["-C", top.root, "diff"]));
	strictEqual(existsSync(marker), false, "the working-tree diff did not run it");
	git(top.root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "bump");
	execFileSync("git", internalGitArgv(["-C", top.root, "show", "HEAD"]));
	execFileSync("git", internalGitArgv(["-C", top.root, "log", "-p", "-1"]));
	strictEqual(existsSync(marker), false, "show and log -p of the bump did not run it");
	spawnSync("git", ["-C", top.root, "show", "HEAD"]);
	ok(existsSync(marker), "a plain git show runs it, so the fixture is live");
	rmSync(top.scratch, { recursive: true, force: true });
	rmSync(inner.scratch, { recursive: true, force: true });
});

test("Clio's internal git writers ignore a GIT_DIR a git-driven runner exported", () => {
	const fixture = repository();
	const other = repository();
	const saved = process.env.GIT_DIR;
	process.env.GIT_DIR = join(other.root, ".git");
	try {
		strictEqual(researchGit(fixture.root, ["rev-parse", "--absolute-git-dir"]), join(fixture.root, ".git"));
	} finally {
		if (saved === undefined) delete process.env.GIT_DIR;
		else process.env.GIT_DIR = saved;
		rmSync(fixture.scratch, { recursive: true, force: true });
		rmSync(other.scratch, { recursive: true, force: true });
	}
});
