import { spawnSync } from "node:child_process";
import { type Dirent, existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { internalGitArgv } from "../../core/internal-git.js";

/** Variables that point git at another repository or index than the one the protected path sits in. */
const REDIRECTING_GIT_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"] as const;

/** Most entries read under a protected directory while looking for a nested repository. */
const MAX_SCANNED_ENTRIES = 4096;

/**
 * Whether `git reset --hard <target>` leaves a protected path as it is (M-27). A hard reset rewrites only what git
 * tracks: a path in HEAD, the index or the target whose working copy differs from the target. It never touches an
 * untracked or ignored file there, so a desk's records directory under an ignored tree does not stop a branch move.
 * The reading is made in the repository that owns the path, the only one whose reset can rewrite it. Any doubt
 * answers false: no repository, a variable redirecting git, a target git cannot resolve, a repository nested under
 * the path, or a git call that fails.
 */
export function resetLeavesPath(protectedPath: string, target: string): boolean {
	if (REDIRECTING_GIT_VARIABLES.some((name) => process.env[name] !== undefined)) return false;
	if (target.startsWith("-") || /[$`\s]/u.test(target)) return false;
	const located = existingLocation(path.resolve(protectedPath));
	if (located === null) return false;
	const top = gitOutput(located.dir, ["rev-parse", "--show-toplevel"]);
	if (top === null) return false;
	let topReal: string;
	try {
		topReal = realpathSync(top.trim());
	} catch {
		return false;
	}
	const relative = path.relative(topReal, located.real);
	if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
	if (holdsNestedRepository(located.real)) return false;
	const commit = gitOutput(topReal, ["rev-parse", "--verify", "--quiet", `${target}^{commit}`]);
	if (commit === null || !/^[0-9a-f]{40,64}$/u.test(commit.trim())) return false;
	const changed = gitOutput(topReal, [
		"--literal-pathspecs",
		"diff",
		"--name-only",
		"-z",
		"--no-renames",
		commit.trim(),
		"--",
		relative === "" ? "." : relative,
	]);
	return changed === "";
}

/** The nearest directory on disk at or above `location`, and `location` read through its links. */
function existingLocation(location: string): { dir: string; real: string } | null {
	let probe = location;
	const missing: string[] = [];
	while (!existsSync(probe)) {
		const parent = path.dirname(probe);
		if (parent === probe) return null;
		missing.unshift(path.basename(probe));
		probe = parent;
	}
	try {
		const real = realpathSync(probe);
		const dir = statSync(real).isDirectory() ? real : path.dirname(real);
		return { dir, real: path.join(real, ...missing) };
	} catch {
		return null;
	}
}

/** Whether a `.git` lies under a protected directory: that repository's own reset could rewrite the path. */
function holdsNestedRepository(location: string): boolean {
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(location);
	} catch {
		return false;
	}
	if (!stat.isDirectory()) return false;
	const pending = [location];
	let seen = 0;
	while (pending.length > 0) {
		const dir = pending.pop() as string;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return true;
		}
		for (const entry of entries) {
			seen += 1;
			if (seen > MAX_SCANNED_ENTRIES || entry.name === ".git") return true;
			if (entry.isDirectory()) pending.push(path.join(dir, entry.name));
		}
	}
	return false;
}

/** Git's standard output for `args` run in `dir` as an internal read, or null when it failed. */
function gitOutput(dir: string, args: ReadonlyArray<string>): string | null {
	let argv: string[];
	try {
		argv = internalGitArgv(args, dir);
	} catch {
		return null;
	}
	const result = spawnSync("git", argv, {
		cwd: dir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		timeout: 2_000,
		maxBuffer: 1 << 20,
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
	});
	if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") return null;
	return result.stdout;
}
