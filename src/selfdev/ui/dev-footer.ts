import { execFileSync } from "node:child_process";
import type { HarnessIntrospection } from "../../harness/state.js";

export interface SelfDevFooterDeps {
	repoRoot: string;
	getHarnessIntrospection: () => HarnessIntrospection;
	now?: () => number;
}

const CACHE_MS = 1000;

function readGit(repoRoot: string, args: ReadonlyArray<string>): string | null {
	try {
		return execFileSync("git", ["-C", repoRoot, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

function statusCount(repoRoot: string): number {
	const raw = readGit(repoRoot, ["status", "--short"]);
	if (!raw) return 0;
	return raw.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function harnessVerdict(state: HarnessIntrospection): string {
	if (state.last_restart_required_paths.length > 0) return "restart-required";
	if (state.queue_depth > 0) return `worker-pending:${state.queue_depth}`;
	if (state.last_hot_failed) return "hot-failed";
	if (state.last_hot_succeeded) return "hot-succeeded";
	return "idle";
}

function lastHot(state: HarnessIntrospection): string {
	if (!state.last_hot_succeeded) return "none";
	return `${state.last_hot_succeeded.path}:${state.last_hot_succeeded.elapsedMs}`;
}

export function createSelfDevFooterLine(deps: SelfDevFooterDeps): () => string {
	let cache: { at: number; line: string } | null = null;
	const now = deps.now ?? (() => Date.now());
	return () => {
		const at = now();
		if (cache && at - cache.at < CACHE_MS) return cache.line;
		const branch = readGit(deps.repoRoot, ["branch", "--show-current"]) || "unknown";
		const harness = deps.getHarnessIntrospection();
		const line = `selfdev branch=${branch} dirty=${statusCount(deps.repoRoot)} harness=${harnessVerdict(harness)} last=${lastHot(harness)}`;
		cache = { at, line };
		return line;
	};
}
