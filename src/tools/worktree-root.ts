/**
 * Where a task worktree's working tree lives (`fleet.worktrees.root`).
 *
 * `disk` is the project-root location, `<root>/.clio-coder/worktrees`, and the
 * default. `tmpfs` puts the working tree on a RAM-backed mount, `auto` does so
 * when one exists and has room, and an absolute path names any other
 * directory. Only the working tree moves: git objects, the index, the branch,
 * and the ownership claim stay with the parent repository on disk, so a tmpfs
 * root lost at reboot loses uncommitted files and nothing else.
 *
 * An off-disk root applies to local placement only. A remote node reaches a
 * worktree by the same path the orchestrator uses, and doctor's preflight
 * proves path parity for the project root alone, so a fleet with nodes keeps
 * every task worktree under the project root.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, statfsSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type WorktreeRootSetting = "auto" | "tmpfs" | "disk" | (string & {});

/** Headroom on top of twice the tracked tree: a worker builds in its worktree. */
export const WORKTREE_FREE_SPACE_MARGIN_BYTES = 256 * 1024 * 1024;

/** Host facts the resolver reads, injectable so tests need no tmpfs and no full disk. */
export interface WorktreeRootFacts {
	/** Directories to try for `tmpfs` and `auto`, in order. */
	tmpfsCandidates(): string[];
	/** Filesystem type of the mount holding `path`, or null when unknown. */
	filesystemType(path: string): string | null;
	/** Bytes available to this user on the filesystem holding `path`, or null. */
	freeBytes(path: string): number | null;
	/** Bytes of the tracked files a new worktree checks out, or null. */
	workingTreeBytes(projectRoot: string): number | null;
	/** Stable per-user segment, so users sharing /dev/shm never share a directory. */
	userSegment(): string;
}

function unescapeMountField(field: string): string {
	return field.replace(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** Longest mount point that is `path` or an ancestor of it, from /proc/mounts. */
function procMountsType(path: string): string | null {
	let text: string;
	try {
		text = readFileSync("/proc/mounts", "utf8");
	} catch {
		return null;
	}
	const target = resolve(path);
	let best: { point: string; type: string } | null = null;
	for (const line of text.split("\n")) {
		const fields = line.split(" ");
		const point = unescapeMountField(fields[1] ?? "");
		const type = fields[2];
		if (point.length === 0 || type === undefined) continue;
		const covers = target === point || target.startsWith(point === "/" ? "/" : `${point}/`);
		// A later line for the same point is the mount on top.
		if (covers && (best === null || point.length >= best.point.length)) best = { point, type };
	}
	return best?.type ?? null;
}

export const HOST_WORKTREE_ROOT_FACTS: WorktreeRootFacts = {
	tmpfsCandidates() {
		const runtime = process.env.XDG_RUNTIME_DIR;
		return [...(runtime !== undefined && isAbsolute(runtime) ? [runtime] : []), "/dev/shm"];
	},
	filesystemType: procMountsType,
	freeBytes(path) {
		try {
			const stats = statfsSync(path);
			return stats.bavail * stats.bsize;
		} catch {
			return null;
		}
	},
	workingTreeBytes(projectRoot) {
		try {
			const listing = execFileSync("git", ["-C", projectRoot, "ls-tree", "-r", "-l", "-z", "HEAD"], {
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 30_000,
				maxBuffer: 256 * 1024 * 1024,
			}).toString("utf8");
			let total = 0;
			for (const entry of listing.split("\0")) {
				// `<mode> <type> <object> <size>\t<path>`; a submodule's size is `-`.
				const size = Number.parseInt(entry.slice(0, entry.indexOf("\t")).trim().split(/\s+/u)[3] ?? "", 10);
				if (Number.isSafeInteger(size)) total += size;
			}
			return total;
		} catch {
			return null;
		}
	},
	userSegment() {
		try {
			return `clio-coder-${userInfo().uid}`;
		} catch {
			return "clio-coder";
		}
	},
};

export interface ResolvedWorktreeRoot {
	/** Directory a task worktree is created in, as `<parent>/<runId>`. */
	parent: string;
	kind: "disk" | "tmpfs" | "path";
	/** The mount or configured directory `parent` sits under; absent for disk. */
	base?: string;
	/** Why the setting did not get what it asked for; absent when it did. */
	notice?: string;
}

export function diskWorktreeParent(projectRoot: string): string {
	return join(projectRoot, ".clio-coder", "worktrees");
}

/** Worktrees of different checkouts never share a directory under a shared root. */
function repositoryKey(projectRoot: string): string {
	return createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
}

function tmpfsParent(base: string, projectRoot: string, facts: WorktreeRootFacts): string {
	return join(base, facts.userSegment(), "worktrees", repositoryKey(projectRoot));
}

function customParent(base: string, projectRoot: string): string {
	return join(resolve(base), repositoryKey(projectRoot));
}

/**
 * Every directory a task worktree of this checkout may live in: the disk
 * location, this user's directory on each tmpfs candidate, and the configured
 * absolute path. Ownership checks accept a path under one of these and nothing
 * else. The tmpfs directories count whatever the setting says now, so a
 * worktree created under `tmpfs` is still recognized after a switch to `disk`.
 */
export function allowedWorktreeParents(
	setting: WorktreeRootSetting,
	projectRoot: string,
	facts: WorktreeRootFacts = HOST_WORKTREE_ROOT_FACTS,
): string[] {
	const parents = [diskWorktreeParent(projectRoot)];
	for (const base of facts.tmpfsCandidates()) parents.push(tmpfsParent(base, projectRoot, facts));
	if (isAbsolute(setting)) parents.push(customParent(setting, projectRoot));
	return parents;
}

function formatMiB(bytes: number): string {
	return `${Math.ceil(bytes / (1024 * 1024))} MiB`;
}

/** Null when `base` has room for a worktree of this checkout, else why not. */
function shortOfSpace(base: string, projectRoot: string, facts: WorktreeRootFacts): string | null {
	const tree = facts.workingTreeBytes(projectRoot);
	const free = facts.freeBytes(base);
	if (tree === null) return "the working tree could not be sized";
	if (free === null) return `free space on ${base} could not be read`;
	const needed = tree * 2 + WORKTREE_FREE_SPACE_MARGIN_BYTES;
	return free >= needed ? null : `${base} has ${formatMiB(free)} free and a worktree needs ${formatMiB(needed)}`;
}

export interface ResolveWorktreeRootInput {
	setting: WorktreeRootSetting;
	/** Canonical checkout root. */
	projectRoot: string;
	/** True when the fleet has nodes, so the run may be placed on another host. */
	remoteEligible: boolean;
	facts?: WorktreeRootFacts;
}

/**
 * Pick the parent directory for the next task worktree. Every way an off-disk
 * root can fall through lands on the disk location with a notice naming why,
 * so a worktree is always created somewhere it can be used.
 */
export function resolveWorktreeRoot(input: ResolveWorktreeRootInput): ResolvedWorktreeRoot {
	const facts = input.facts ?? HOST_WORKTREE_ROOT_FACTS;
	const disk: ResolvedWorktreeRoot = { parent: diskWorktreeParent(input.projectRoot), kind: "disk" };
	const { setting } = input;
	if (setting === "disk") return disk;
	if (input.remoteEligible) {
		return { ...disk, notice: "fleet nodes are configured, so task worktrees stay under the project root" };
	}
	if (isAbsolute(setting)) {
		const short = shortOfSpace(setting, input.projectRoot, facts);
		if (short !== null) return { ...disk, notice: `${short}; using the project root` };
		return { parent: customParent(setting, input.projectRoot), kind: "path", base: resolve(setting) };
	}
	const reasons: string[] = [];
	let sawTmpfs = false;
	for (const base of facts.tmpfsCandidates()) {
		const type = facts.filesystemType(base);
		if (type !== "tmpfs") {
			reasons.push(`${base} is ${type ?? "not a readable mount"}, not tmpfs`);
			continue;
		}
		sawTmpfs = true;
		const short = shortOfSpace(base, input.projectRoot, facts);
		if (short !== null) {
			reasons.push(short);
			continue;
		}
		return { parent: tmpfsParent(base, input.projectRoot, facts), kind: "tmpfs", base };
	}
	// `auto` means "tmpfs when it is there": on a host without one, disk is its
	// second answer, not a failure. A tmpfs that is short of room is reported.
	if (setting === "auto" && !sawTmpfs) return disk;
	return { ...disk, notice: `no usable tmpfs (${reasons.join("; ") || "no candidates"}); using the project root` };
}

/**
 * Create an off-disk parent so that it is ours alone. `/dev/shm` is
 * world-writable, so another user can plant `clio-coder-<uid>` there first as
 * a link or as a directory they own, and a worktree created beneath it would
 * be theirs to read and rewrite. Every directory between the base and the
 * parent must be a real directory owned by this user; each one created here
 * is mode 0700. Returns why the parent cannot be trusted, or null.
 */
export function prepareWorktreeParent(resolved: ResolvedWorktreeRoot): string | null {
	if (resolved.kind === "disk" || resolved.base === undefined) return null;
	const rel = relative(resolved.base, resolved.parent);
	if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel))
		return `${resolved.parent} is not under ${resolved.base}`;
	const uid = typeof process.getuid === "function" ? process.getuid() : null;
	let cursor = resolved.base;
	for (const segment of rel.split(sep)) {
		cursor = join(cursor, segment);
		try {
			mkdirSync(cursor, { mode: 0o700 });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				return `${cursor} could not be created: ${(error as Error).message}`;
			}
		}
		let stats: ReturnType<typeof lstatSync>;
		try {
			stats = lstatSync(cursor);
		} catch (error) {
			return `${cursor} could not be inspected: ${(error as Error).message}`;
		}
		if (!stats.isDirectory()) return `${cursor} is not a plain directory`;
		if (uid !== null && stats.uid !== uid) return `${cursor} belongs to another user`;
		if ((stats.mode & 0o022) !== 0) return `${cursor} is writable by other users`;
	}
	return null;
}
