import { execFile, execFileSync } from "node:child_process";
import { internalGitArgv } from "../../../core/internal-git.js";

const TIMEOUT_MS = 1000;
/**
 * A gate question that ran out its first second is asked once more with this much room. Under load the one-second probe
 * timed out and the launchpad said `No Git repository` for a real repository: a timeout is not an answer.
 */
const GATE_RETRY_TIMEOUT_MS = 5000;

export interface GitProbeResult {
	isGit: boolean;
	branch: string | null;
	dirty: boolean | null;
	ahead: number | null;
	behind: number | null;
	recentCommits: ReadonlyArray<{ sha: string; subject: string }>;
	remoteUrl: string | null;
	/** Git did not answer whether this is a repository in time, so that is unknown rather than no. */
	undetermined?: true;
}

/**
 * The subset a live status surface actually paints. Deliberately narrower than
 * `GitProbeResult`: ahead/behind and recent commits cost two more subprocesses
 * per poll and are only ever read by the workspace context tool, which probes
 * once at session bind rather than on a timer.
 */
export interface GitStatusProbeResult {
	isGit: boolean;
	branch: string | null;
	dirty: boolean | null;
	remoteUrl: string | null;
	/** Git did not answer whether this is a repository in time, so that is unknown rather than no. */
	undetermined?: true;
}

const EMPTY_PROBE: GitProbeResult = {
	isGit: false,
	branch: null,
	dirty: null,
	ahead: null,
	behind: null,
	recentCommits: [],
	remoteUrl: null,
};

const EMPTY_STATUS_PROBE: GitStatusProbeResult = { isGit: false, branch: null, dirty: null, remoteUrl: null };
const UNDETERMINED_PROBE: GitProbeResult = { ...EMPTY_PROBE, undetermined: true };
const UNDETERMINED_STATUS_PROBE: GitStatusProbeResult = { ...EMPTY_STATUS_PROBE, undetermined: true };

/** What a gate question got back: Git's answer, or nothing because it ran out of time. */
type GateAnswer = { out: string | null; timedOut: boolean };

/**
 * Whether Git gave no answer at all: it ran out of time, or the process could not start (`EAGAIN`, `EMFILE`, `ENOMEM`
 * under load carry a string code, where Git's own refusal carries its numeric exit status). Either is unknown, never no:
 * a spawn that failed under load left the footer reading `no Git branch` in a real repository.
 */
function timedOut(err: unknown): boolean {
	const error = err as { killed?: boolean; code?: unknown; signal?: unknown } | null;
	return (
		error?.killed === true ||
		error?.code === "ETIMEDOUT" ||
		error?.signal === "SIGTERM" ||
		(typeof error?.code === "string" && error.code !== "ENOENT")
	);
}

function gateSync(cwd: string, args: string[]): GateAnswer {
	for (const timeout of [TIMEOUT_MS, GATE_RETRY_TIMEOUT_MS]) {
		try {
			const out = execFileSync("git", internalGitArgv(args, cwd), { cwd, timeout, stdio: ["ignore", "pipe", "ignore"] });
			return { out: out.toString().trim(), timedOut: false };
		} catch (err) {
			if (!timedOut(err)) return { out: null, timedOut: false };
		}
	}
	return { out: null, timedOut: true };
}

/**
 * One Git question off the loop, with Clio's own timer instead of `execFile`'s. When the event loop stalls past the
 * timeout (a busy launch, a long synchronous render), `execFile` fires its timer after Git already exited, destroys
 * stdout unread, and then reports success with empty output: `rev-parse --is-inside-work-tree` answered `""`, the
 * probe read that as no repository, and session bind kept it. Here the timer only signals the child; output is never
 * cut, so an exit Git finished on its own keeps every byte, and a child that the timer actually stopped is unknown.
 */
function askGit(cwd: string, args: string[], timeout: number): Promise<GateAnswer> {
	return new Promise((resolve) => {
		let argv: string[];
		try {
			argv = internalGitArgv(args, cwd);
		} catch {
			resolve({ out: null, timedOut: false });
			return;
		}
		let stopped = false;
		const child = execFile("git", argv, { cwd, encoding: "utf8" }, (err, stdout) => {
			clearTimeout(timer);
			if (err === null) {
				resolve({ out: stdout.trim(), timedOut: false });
				return;
			}
			resolve({ out: null, timedOut: (stopped && err.signal !== null) || timedOut(err) });
		});
		const timer = setTimeout(() => {
			stopped = child.exitCode === null && child.signalCode === null;
			if (stopped) child.kill("SIGTERM");
		}, timeout);
	});
}

async function gateAsync(cwd: string, args: string[]): Promise<GateAnswer> {
	for (const timeout of [TIMEOUT_MS, GATE_RETRY_TIMEOUT_MS]) {
		const answer = await askGit(cwd, args, timeout);
		if (!answer.timedOut) return answer;
	}
	return { out: null, timedOut: true };
}

function gitOk(cwd: string, args: string[]): string | null {
	try {
		const out = execFileSync("git", internalGitArgv(args, cwd), {
			cwd,
			timeout: TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return out.toString().trim();
	} catch {
		return null;
	}
}

async function gitOkAsync(cwd: string, args: string[]): Promise<string | null> {
	return (await askGit(cwd, args, TIMEOUT_MS)).out;
}

function normalizeRemote(url: string): string {
	let out = url.trim();
	if (out.endsWith(".git")) out = out.slice(0, -4);
	const sshMatch = /^git@([^:]+):(.+)$/.exec(out);
	if (sshMatch) {
		const [, host, path] = sshMatch;
		return `https://${host}/${path}`;
	}
	return out;
}

function branchFrom(raw: string | null): string | null {
	return raw && raw !== "HEAD" ? raw : null;
}

function dirtyFrom(status: string | null): boolean | null {
	return status === null ? null : status.length > 0;
}

function aheadBehindFrom(raw: string | null): { ahead: number | null; behind: number | null } {
	if (!raw) return { ahead: null, behind: null };
	const parts = raw.split(/\s+/);
	const a = Number.parseInt(parts[0] ?? "", 10);
	const b = Number.parseInt(parts[1] ?? "", 10);
	return { ahead: Number.isFinite(a) ? a : null, behind: Number.isFinite(b) ? b : null };
}

function recentCommitsFrom(log: string | null): ReadonlyArray<{ sha: string; subject: string }> {
	if (!log) return [];
	return log
		.split("\n")
		.map((line) => {
			const tab = line.indexOf("\t");
			if (tab < 0) return null;
			return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
		})
		.filter((commit): commit is { sha: string; subject: string } => commit !== null);
}

function remoteFrom(raw: string | null): string | null {
	return raw ? normalizeRemote(raw) : null;
}

export function probeGit(cwd: string): GitProbeResult {
	const inside = gateSync(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside.timedOut) return UNDETERMINED_PROBE;
	if (inside.out !== "true") return EMPTY_PROBE;
	const ignored = gateSync(cwd, ["check-ignore", "--quiet", "--", "."]);
	if (ignored.timedOut) return UNDETERMINED_PROBE;
	if (ignored.out !== null) return EMPTY_PROBE;
	const asked = gateSync(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (asked.timedOut) return UNDETERMINED_PROBE;
	const branch = branchFrom(asked.out);
	const dirty = dirtyFrom(gitOk(cwd, ["status", "--porcelain", "--", "."]));
	const { ahead, behind } = aheadBehindFrom(gitOk(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]));
	const recentCommits = recentCommitsFrom(gitOk(cwd, ["log", "-5", "--format=%H%x09%s", "--", "."]));
	const remoteUrl = remoteFrom(gitOk(cwd, ["remote", "get-url", "origin"]));
	return { isGit: true, branch, dirty, ahead, behind, recentCommits, remoteUrl };
}

/**
 * The full probe without blocking the event loop. Once Git confirms the exact
 * workspace is both inside a work tree and not ignored, the remaining five
 * subprocesses are independent and run concurrently.
 */
export async function probeGitAsync(cwd: string): Promise<GitProbeResult> {
	const inside = await gateAsync(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside.timedOut) return UNDETERMINED_PROBE;
	if (inside.out !== "true") return EMPTY_PROBE;
	const ignored = await gateAsync(cwd, ["check-ignore", "--quiet", "--", "."]);
	if (ignored.timedOut) return UNDETERMINED_PROBE;
	if (ignored.out !== null) return EMPTY_PROBE;
	const [branch, status, aheadBehindRaw, log, remoteRaw] = await Promise.all([
		gateAsync(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
		gitOkAsync(cwd, ["status", "--porcelain", "--", "."]),
		gitOkAsync(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]),
		gitOkAsync(cwd, ["log", "-5", "--format=%H%x09%s", "--", "."]),
		gitOkAsync(cwd, ["remote", "get-url", "origin"]),
	]);
	// A branch question that ran out of time is unknown, not detached: the footer read `no Git branch` under load.
	if (branch.timedOut) return UNDETERMINED_PROBE;
	const { ahead, behind } = aheadBehindFrom(aheadBehindRaw);
	return {
		isGit: true,
		branch: branchFrom(branch.out),
		dirty: dirtyFrom(status),
		ahead,
		behind,
		recentCommits: recentCommitsFrom(log),
		remoteUrl: remoteFrom(remoteRaw),
	};
}

/**
 * Branch, dirty flag, and remote only. After the work-tree and ignored-workspace
 * gates, the three fact probes run concurrently and off the loop. This is what
 * the interactive footer polls and re-reads at the end of every turn.
 */
export async function probeGitStatusAsync(cwd: string): Promise<GitStatusProbeResult> {
	const inside = await gateAsync(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside.timedOut) return UNDETERMINED_STATUS_PROBE;
	if (inside.out !== "true") return EMPTY_STATUS_PROBE;
	const ignored = await gateAsync(cwd, ["check-ignore", "--quiet", "--", "."]);
	if (ignored.timedOut) return UNDETERMINED_STATUS_PROBE;
	if (ignored.out !== null) return EMPTY_STATUS_PROBE;
	const [branch, status, remoteRaw] = await Promise.all([
		gateAsync(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
		gitOkAsync(cwd, ["status", "--porcelain", "--", "."]),
		gitOkAsync(cwd, ["remote", "get-url", "origin"]),
	]);
	if (branch.timedOut) return UNDETERMINED_STATUS_PROBE;
	return {
		isGit: true,
		branch: branchFrom(branch.out),
		dirty: dirtyFrom(status),
		remoteUrl: remoteFrom(remoteRaw),
	};
}

export interface GitChanges {
	files: number;
	insertions: number;
	deletions: number;
}

/**
 * Working-tree changes against HEAD as `git diff --shortstat` counts them.
 * Null outside a work tree or when Git fails, never zeros: an unknown is not
 * an empty diff.
 */
export async function probeGitChangesAsync(cwd: string): Promise<GitChanges | null> {
	const inside = await gitOkAsync(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside !== "true") return null;
	const stat = await gitOkAsync(cwd, ["diff", "--shortstat", "HEAD", "--", "."]);
	if (stat === null) return null;
	const read = (pattern: RegExp): number => {
		const match = pattern.exec(stat);
		return match?.[1] ? Number.parseInt(match[1], 10) : 0;
	};
	return {
		files: read(/(\d+) files? changed/u),
		insertions: read(/(\d+) insertions?/u),
		deletions: read(/(\d+) deletions?/u),
	};
}
