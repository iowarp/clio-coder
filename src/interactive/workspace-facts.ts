import type { GitStatusProbeResult, WorkspaceSnapshot } from "../domains/session/workspace/index.js";
import {
	emptyWorkspaceSnapshot,
	probeGitStatusAsync,
	probeWorkspaceAsync,
} from "../domains/session/workspace/index.js";

export interface WorkspaceFactsDeps {
	cwd: string;
	getSessionWorkspace: () => WorkspaceSnapshot | null;
	extensions?:
		| {
				list(cwd?: string, options?: { all?: boolean }): ReadonlyArray<{ enabled: boolean; effective: boolean }>;
		  }
		| undefined;
	now?: () => number;
	probeWorkspace?: typeof probeWorkspaceAsync;
	probeGitStatus?: typeof probeGitStatusAsync;
	/** Called when an off-frame probe lands, so the layer that owns the frame can ask for one. */
	onRefreshed?: () => void;
}

export interface ExtensionStats {
	active: number;
	installed: number;
}

export interface WorkspaceFacts {
	/** The session-bound snapshot used by the welcome dashboard. */
	getWorkspaceSnapshot(): WorkspaceSnapshot;
	/** The session snapshot with volatile Git facts refreshed for the footer. */
	getLiveWorkspaceSnapshot(): WorkspaceSnapshot;
	/**
	 * Kicks a probe and resolves when it has landed. Callers on a render path
	 * ignore the promise; it exists so boot and tests have something to await.
	 */
	refreshLiveWorkspaceGit(force?: boolean): Promise<void>;
	/** Resolves once the boot workspace probe has landed. */
	ready(): Promise<void>;
	getExtensionStats(): ExtensionStats;
}

const EXTENSION_STATS_TTL_MS = 5_000;

/**
 * Live workspace facts for the footer and banner, none of which block a frame.
 *
 * Every probe here used to be synchronous: `probeWorkspace` at construction cost
 * about 280 ms before first paint, and the six-subprocess `probeGit` cost 63-100 ms
 * on a five-second ticker and again at the end of every turn. The footer already
 * knew how to paint a branch chip that arrives late, so all of it moved off the
 * loop and the surfaces fill in.
 */
export function createWorkspaceFacts(deps: WorkspaceFactsDeps): WorkspaceFacts {
	const workspaceProbe = deps.probeWorkspace ?? probeWorkspaceAsync;
	const gitProbe = deps.probeGitStatus ?? probeGitStatusAsync;
	const now = deps.now ?? Date.now;
	let bootWorkspace = emptyWorkspaceSnapshot(deps.cwd);
	let liveWorkspaceSnapshot = deps.getSessionWorkspace() ?? bootWorkspace;
	let lastWorkspaceProbeAt = 0;
	// Single-flight: a probe slower than the five-second ticker must not stack.
	let inFlight: Promise<void> | null = null;

	const applyGitStatus = (base: WorkspaceSnapshot, git: GitStatusProbeResult): void => {
		// ahead/behind/recentCommits stay as session bind captured them. The polling
		// probe does not read them (two subprocesses for fields the footer never
		// paints), and the workspace context tool reads the bound snapshot, not this one.
		liveWorkspaceSnapshot = { ...base, branch: git.branch, dirty: git.dirty };
	};

	const refreshLiveWorkspaceGit = (force = false): Promise<void> => {
		const base = deps.getSessionWorkspace() ?? bootWorkspace;
		if (!force && now() - lastWorkspaceProbeAt < 5_000) return Promise.resolve();
		if (inFlight) return inFlight;
		lastWorkspaceProbeAt = now();
		if (!base.isGit) {
			liveWorkspaceSnapshot = base;
			return Promise.resolve();
		}
		inFlight = gitProbe(base.cwd)
			.then((git) => {
				applyGitStatus(deps.getSessionWorkspace() ?? bootWorkspace, git);
				deps.onRefreshed?.();
			})
			.catch(() => {
				// A failed probe leaves the last known branch on screen and retries on
				// the next tick; the footer is not worth surfacing a git error for.
			})
			.finally(() => {
				inFlight = null;
			});
		return inFlight;
	};

	const bootReady = workspaceProbe(deps.cwd)
		.then((snapshot) => {
			bootWorkspace = snapshot;
			if (deps.getSessionWorkspace() === null) liveWorkspaceSnapshot = snapshot;
			deps.onRefreshed?.();
		})
		.catch(() => {
			// Keep the empty snapshot; a workspace we cannot probe is not an error state.
		})
		.then(() => refreshLiveWorkspaceGit(true));

	const getWorkspaceSnapshot = (): WorkspaceSnapshot => deps.getSessionWorkspace() ?? bootWorkspace;

	const getLiveWorkspaceSnapshot = (): WorkspaceSnapshot => {
		const base = deps.getSessionWorkspace() ?? bootWorkspace;
		if (liveWorkspaceSnapshot.cwd !== base.cwd || liveWorkspaceSnapshot.capturedAt !== base.capturedAt) {
			liveWorkspaceSnapshot = base;
			void refreshLiveWorkspaceGit(true);
		}
		return liveWorkspaceSnapshot;
	};

	// The welcome banner and footer share these counts. Active means enabled
	// and effective after precedence; installed includes every discovery.
	// Cached because both callers ask per frame and the answer costs a directory
	// walk plus a manifest read per installed extension.
	let cachedExtensionStats: { at: number; stats: ExtensionStats } | null = null;
	const getExtensionStats = (): ExtensionStats => {
		const at = now();
		if (cachedExtensionStats && at - cachedExtensionStats.at < EXTENSION_STATS_TTL_MS) return cachedExtensionStats.stats;
		const items = deps.extensions?.list(deps.cwd, { all: true }) ?? [];
		const stats = {
			active: items.filter((entry) => entry.enabled && entry.effective).length,
			installed: items.length,
		};
		cachedExtensionStats = { at, stats };
		return stats;
	};

	return {
		getWorkspaceSnapshot,
		getLiveWorkspaceSnapshot,
		refreshLiveWorkspaceGit,
		ready: () => bootReady,
		getExtensionStats,
	};
}
