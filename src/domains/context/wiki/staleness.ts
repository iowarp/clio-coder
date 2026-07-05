import { execFileSync } from "node:child_process";
import { readWikiMeta } from "./meta.js";

export type WikiStaleness =
	| { state: "absent"; warning?: string }
	| { state: "fresh"; warning?: string }
	| { state: "stale"; changedFiles: number; warning?: string };

const GIT_DIFF_LINE_CAP = 200;

function currentGitHead(cwd: string): string | null {
	try {
		const out = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return out.length > 0 ? out : null;
	} catch {
		return null;
	}
}

function changedFileCount(cwd: string, gitHead: string): { count: number; warning?: string } | { warning: string } {
	try {
		const out = execFileSync("git", ["diff", "--name-only", `${gitHead}..HEAD`], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const lines = out.length === 0 ? [] : out.split(/\r?\n/).filter((line) => line.length > 0);
		const capped = lines.slice(0, GIT_DIFF_LINE_CAP);
		return {
			count: capped.length,
			...(lines.length > capped.length ? { warning: `changed file count capped at ${GIT_DIFF_LINE_CAP}` } : {}),
		};
	} catch {
		return { warning: "wiki staleness unavailable: git diff failed for the recorded wiki gitHead" };
	}
}

export function wikiStaleness(cwd: string): WikiStaleness {
	const meta = readWikiMeta(cwd);
	if (!meta) return { state: "absent" };
	if (!meta.gitHead) {
		return { state: "fresh", warning: "wiki staleness unavailable: recorded gitHead is missing" };
	}
	const head = currentGitHead(cwd);
	if (!head) {
		return { state: "fresh", warning: "wiki staleness unavailable: current git HEAD is missing" };
	}
	if (head === meta.gitHead) return { state: "fresh" };
	const diff = changedFileCount(cwd, meta.gitHead);
	if (!("count" in diff)) return { state: "fresh", warning: diff.warning };
	return { state: "stale", changedFiles: diff.count, ...(diff.warning ? { warning: diff.warning } : {}) };
}
