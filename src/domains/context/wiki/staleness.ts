import { execFileSync } from "node:child_process";
import { computeFingerprint } from "../fingerprint.js";
import { readWikiMeta, type WikiMeta } from "./meta.js";

export type WikiStaleness =
	| { state: "absent"; warning?: string }
	| { state: "fresh"; warning?: string }
	| { state: "stale"; changedFiles: number; warning?: string };

const GIT_DIFF_LINE_CAP = 200;

function splitNullTerminatedPaths(output: string): string[] {
	return output.split("\0").filter((path) => path.length > 0);
}

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

function collectChangedPaths(cwd: string, gitHead: string): Set<string> {
	const committed = execFileSync("git", ["diff", "--name-only", "-z", `${gitHead}..HEAD`], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const trackedWorking = execFileSync("git", ["diff", "--name-only", "-z", "HEAD"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	return new Set([
		...splitNullTerminatedPaths(committed),
		...splitNullTerminatedPaths(trackedWorking),
		...splitNullTerminatedPaths(untracked),
	]);
}

/**
 * Repository-relative paths that changed since the wiki was written, committed
 * and working-tree alike. This is what scopes an update run: a page is rewritten
 * when one of the sources its front matter claims appears here, which replaces
 * asking a model to guess which pages a diff invalidates. Uncapped, because a
 * capped list would silently mark changed pages current. Empty on any git
 * failure, which leaves the plan's own statuses in charge.
 */
export function changedPathsSince(cwd: string, gitHead: string | null): string[] {
	if (!gitHead) return [];
	try {
		return [...collectChangedPaths(cwd, gitHead)];
	} catch {
		return [];
	}
}

function changedFileCount(cwd: string, gitHead: string): { count: number; warning?: string } | { warning: string } {
	try {
		const paths = collectChangedPaths(cwd, gitHead);
		const capped = [...paths].slice(0, GIT_DIFF_LINE_CAP);
		return {
			count: capped.length,
			...(paths.size > capped.length ? { warning: `changed file count capped at ${GIT_DIFF_LINE_CAP}` } : {}),
		};
	} catch {
		return { warning: "wiki staleness unavailable: git diff failed for the recorded wiki gitHead" };
	}
}

export interface WikiCompleteness {
	pagesPlanned: number;
	pagesWritten: number;
	/** Planned pages the promoted wiki has not written yet. */
	owed: number;
}

/**
 * How much of the plan the promoted wiki actually covers. A page is the unit of
 * work now, so a run that loses pages to a deadline still promotes what it
 * finished and records the rest as owed. That makes "incomplete" a normal
 * resting state, distinct from "stale": an incomplete wiki can be perfectly
 * current with the tree and still be missing most of its pages.
 *
 * Null when no wiki exists or when its metadata predates generation counts,
 * which is indistinguishable from complete and must not be reported as owing.
 */
export function wikiCompletenessFromMeta(meta: WikiMeta | null): WikiCompleteness | null {
	const generation = meta?.generation;
	if (!generation) return null;
	return {
		pagesPlanned: generation.pagesPlanned,
		pagesWritten: generation.pagesWritten,
		owed: Math.max(0, generation.pagesPlanned - generation.pagesWritten),
	};
}

export function wikiCompleteness(cwd: string): WikiCompleteness | null {
	return wikiCompletenessFromMeta(readWikiMeta(cwd));
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
	if (meta.sourceTreeHash && computeFingerprint(cwd).treeHash === meta.sourceTreeHash && head === meta.gitHead) {
		return { state: "fresh" };
	}
	if (!meta.sourceTreeHash && head === meta.gitHead) return { state: "fresh" };
	const diff = changedFileCount(cwd, meta.gitHead);
	if (!("count" in diff)) return { state: "fresh", warning: diff.warning };
	return { state: "stale", changedFiles: diff.count, ...(diff.warning ? { warning: diff.warning } : {}) };
}
