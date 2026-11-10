import { type GitProbeResult, probeGit, probeGitAsync } from "./git-probe.js";
import { detectProjectTypeAsync, detectProjectTypeHint, type ProjectType } from "./project-type.js";

/**
 * Workspace snapshot captured at session bind. Read-only for the session's
 * lifetime; refreshed by /reset or /new. Surfaced via context(scope="workspace")
 * tool and the welcome dashboard's Workspace panel.
 */
export interface WorkspaceCommit {
	sha: string;
	subject: string;
}

export interface WorkspaceSnapshot {
	cwd: string;
	isGit: boolean;
	branch: string | null;
	dirty: boolean | null;
	ahead: number | null;
	behind: number | null;
	recentCommits: ReadonlyArray<WorkspaceCommit>;
	remoteUrl: string | null;
	/** HEAD names no branch: the abbreviated commit it sits on (`git-probe.ts`). */
	detachedAt?: string;
	projectType: ProjectType;
	capturedAt: string;
	/** Set only on the placeholder returned before the first probe lands: its Git fields are unknown, not absent. */
	pending?: true;
	/** Git did not answer in time, so whether this is a repository is unknown; the next probe asks again. */
	gitUnknown?: true;
}

export function emptyWorkspaceSnapshot(cwd: string): WorkspaceSnapshot {
	return {
		cwd,
		isGit: false,
		branch: null,
		dirty: null,
		ahead: null,
		behind: null,
		recentCommits: [],
		remoteUrl: null,
		projectType: "unknown",
		capturedAt: new Date().toISOString(),
		pending: true,
	};
}

/**
 * The full project type enumerates every workspace file (about 2 s on 200k
 * files), so a snapshot starts with the root-manifest hint and the full value
 * replaces it in place once an off-loop enumeration lands. One enumeration per
 * cwd at a time; snapshots taken meanwhile join it.
 */
const projectTypeRefinements = new Map<string, WorkspaceSnapshot[]>();

function refineProjectType(snapshot: WorkspaceSnapshot): void {
	const { cwd } = snapshot;
	const waiting = projectTypeRefinements.get(cwd);
	if (waiting) {
		waiting.push(snapshot);
		return;
	}
	const snapshots = [snapshot];
	projectTypeRefinements.set(cwd, snapshots);
	detectProjectTypeAsync(cwd)
		.then((projectType) => {
			for (const refined of snapshots) refined.projectType = projectType;
		})
		.catch(() => {
			// The hint stays; a workspace that cannot be enumerated is not an error state.
		})
		.finally(() => {
			if (projectTypeRefinements.get(cwd) === snapshots) projectTypeRefinements.delete(cwd);
		});
}

function snapshotFrom(cwd: string, git: GitProbeResult): WorkspaceSnapshot {
	const snapshot: WorkspaceSnapshot = {
		cwd,
		isGit: git.isGit,
		branch: git.branch,
		dirty: git.dirty,
		ahead: git.ahead,
		behind: git.behind,
		recentCommits: git.recentCommits,
		remoteUrl: git.remoteUrl,
		...(git.detachedAt !== undefined ? { detachedAt: git.detachedAt } : {}),
		projectType: detectProjectTypeHint(cwd),
		capturedAt: new Date().toISOString(),
		...(git.undetermined === true ? { gitUnknown: true as const } : {}),
	};
	refineProjectType(snapshot);
	return snapshot;
}

/**
 * How long a landed probe answers a caller that opts into reuse. A first
 * prompt used to probe the same tree three times inside a second: the welcome
 * dashboard at hydration, the session prompt's source capture, then session
 * bind's synchronous probe, which blocked the loop for about 80 ms (seven `git`
 * spawns and a file walk) right before the first request. Five seconds is the
 * footer's Git refresh period, so a reused snapshot is never older than the
 * branch and dirty state the footer is already showing.
 */
export const WORKSPACE_PROBE_REUSE_MS = 5_000;

export interface WorkspaceProbeOptions {
	/** Accept a snapshot of the same cwd that landed this recently, or join one in flight. */
	reuseWithinMs?: number;
}

const landedProbes = new Map<string, { snapshot: WorkspaceSnapshot; at: number }>();
const inFlightProbes = new Map<string, Promise<WorkspaceSnapshot>>();

function remember(cwd: string, snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
	// An unknown answer is not reused: the next caller asks Git again.
	if (snapshot.gitUnknown === true) return snapshot;
	landedProbes.set(cwd, { snapshot, at: performance.now() });
	return snapshot;
}

function recentProbe(cwd: string, options: WorkspaceProbeOptions): WorkspaceSnapshot | null {
	if (options.reuseWithinMs === undefined) return null;
	const landed = landedProbes.get(cwd);
	return landed && performance.now() - landed.at <= options.reuseWithinMs ? landed.snapshot : null;
}

/** Without `reuseWithinMs` this always probes; the context tool's refresh depends on that. */
export function probeWorkspace(cwd: string, options: WorkspaceProbeOptions = {}): WorkspaceSnapshot {
	return recentProbe(cwd, options) ?? remember(cwd, snapshotFrom(cwd, probeGit(cwd)));
}

/**
 * Same snapshot without blocking. Session bind runs before first paint, so the
 * interactive layer uses this to paint an empty workspace chip and fill it in
 * when the probe lands rather than holding the frame for ~280 ms.
 */
export async function probeWorkspaceAsync(
	cwd: string,
	options: WorkspaceProbeOptions = {},
): Promise<WorkspaceSnapshot> {
	const recent = recentProbe(cwd, options);
	if (recent) return recent;
	const pending = options.reuseWithinMs === undefined ? undefined : inFlightProbes.get(cwd);
	if (pending) return pending;
	const probe = probeGitAsync(cwd).then((git) => remember(cwd, snapshotFrom(cwd, git)));
	inFlightProbes.set(cwd, probe);
	try {
		return await probe;
	} finally {
		if (inFlightProbes.get(cwd) === probe) inFlightProbes.delete(cwd);
	}
}
