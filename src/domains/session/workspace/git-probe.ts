import { execFileSync } from "node:child_process";

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

function gitOk(cwd: string, args: string[]): string | null {
	try {
		const out = execFileSync("git", args, { cwd, timeout: TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
		return out.toString().trim();
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

export function probeGit(cwd: string): GitProbeResult {
	const inside = gitOk(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside !== "true") {
		return {
			isGit: false,
			branch: null,
			dirty: null,
			ahead: null,
			behind: null,
			recentCommits: [],
			remoteUrl: null,
		};
	}
	const branchRaw = gitOk(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const branch = branchRaw && branchRaw !== "HEAD" ? branchRaw : null;
	const status = gitOk(cwd, ["status", "--porcelain"]);
	const dirty = status === null ? null : status.length > 0;
	const aheadBehindRaw = gitOk(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
	let ahead: number | null = null;
	let behind: number | null = null;
	if (aheadBehindRaw) {
		const parts = aheadBehindRaw.split(/\s+/);
		const a = Number.parseInt(parts[0] ?? "", 10);
		const b = Number.parseInt(parts[1] ?? "", 10);
		ahead = Number.isFinite(a) ? a : null;
		behind = Number.isFinite(b) ? b : null;
	}
	const log = gitOk(cwd, ["log", "-5", "--format=%H%x09%s"]);
	const recentCommits = log
		? log
				.split("\n")
				.map((line) => {
					const tab = line.indexOf("\t");
					if (tab < 0) return null;
					return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
				})
				.filter((commit): commit is { sha: string; subject: string } => commit !== null)
		: [];
	const remoteRaw = gitOk(cwd, ["remote", "get-url", "origin"]);
	const remoteUrl = remoteRaw ? normalizeRemote(remoteRaw) : null;
	return { isGit: true, branch, dirty, ahead, behind, recentCommits, remoteUrl };
}
