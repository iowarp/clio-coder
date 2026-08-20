import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 1000;

export interface GitProbeResult {
	isGit: boolean;
	branch: string | null;
	dirty: boolean | null;
	ahead: number | null;
	behind: number | null;
	recentCommits: ReadonlyArray<{ sha: string; subject: string }>;
	remoteUrl: string | null;
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

function gitOk(cwd: string, args: string[]): string | null {
	try {
		const out = execFileSync("git", args, { cwd, timeout: TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
		return out.toString().trim();
	} catch {
		return null;
	}
}

async function gitOkAsync(cwd: string, args: string[]): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd, timeout: TIMEOUT_MS, encoding: "utf8" });
		return stdout.trim();
	} catch {
		return null;
	}
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
	const inside = gitOk(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside !== "true") return EMPTY_PROBE;
	const ignored = gitOk(cwd, ["check-ignore", "--quiet", "--", "."]);
	if (ignored !== null) return EMPTY_PROBE;
	const branch = branchFrom(gitOk(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]));
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
	const inside = await gitOkAsync(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside !== "true") return EMPTY_PROBE;
	const ignored = await gitOkAsync(cwd, ["check-ignore", "--quiet", "--", "."]);
	if (ignored !== null) return EMPTY_PROBE;
	const [branchRaw, status, aheadBehindRaw, log, remoteRaw] = await Promise.all([
		gitOkAsync(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
		gitOkAsync(cwd, ["status", "--porcelain", "--", "."]),
		gitOkAsync(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]),
		gitOkAsync(cwd, ["log", "-5", "--format=%H%x09%s", "--", "."]),
		gitOkAsync(cwd, ["remote", "get-url", "origin"]),
	]);
	const { ahead, behind } = aheadBehindFrom(aheadBehindRaw);
	return {
		isGit: true,
		branch: branchFrom(branchRaw),
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
	const inside = await gitOkAsync(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside !== "true") return EMPTY_STATUS_PROBE;
	const ignored = await gitOkAsync(cwd, ["check-ignore", "--quiet", "--", "."]);
	if (ignored !== null) return EMPTY_STATUS_PROBE;
	const [branchRaw, status, remoteRaw] = await Promise.all([
		gitOkAsync(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
		gitOkAsync(cwd, ["status", "--porcelain", "--", "."]),
		gitOkAsync(cwd, ["remote", "get-url", "origin"]),
	]);
	return {
		isGit: true,
		branch: branchFrom(branchRaw),
		dirty: dirtyFrom(status),
		remoteUrl: remoteFrom(remoteRaw),
	};
}
