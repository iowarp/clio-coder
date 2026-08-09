import type { WorkspaceSnapshot } from "../domains/session/workspace/index.js";
import { probeGit, probeWorkspace } from "../domains/session/workspace/index.js";

export interface WorkspaceFactsDeps {
	cwd: string;
	getSessionWorkspace: () => WorkspaceSnapshot | null;
	extensions?:
		| {
				list(cwd?: string, options?: { all?: boolean }): ReadonlyArray<{ enabled: boolean; effective: boolean }>;
		  }
		| undefined;
	now?: () => number;
	probeWorkspace?: typeof probeWorkspace;
	probeGit?: typeof probeGit;
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
	refreshLiveWorkspaceGit(force?: boolean): void;
	getExtensionStats(): ExtensionStats;
}

export function createWorkspaceFacts(deps: WorkspaceFactsDeps): WorkspaceFacts {
	const workspaceProbe = deps.probeWorkspace ?? probeWorkspace;
	const gitProbe = deps.probeGit ?? probeGit;
	const now = deps.now ?? Date.now;
	const bootWorkspace = workspaceProbe(deps.cwd);
	let liveWorkspaceSnapshot = deps.getSessionWorkspace() ?? bootWorkspace;
	let lastWorkspaceProbeAt = 0;

	const refreshLiveWorkspaceGit = (force = false): void => {
		const base = deps.getSessionWorkspace() ?? bootWorkspace;
		if (!force && now() - lastWorkspaceProbeAt < 5_000) return;
		lastWorkspaceProbeAt = now();
		if (!base.isGit) {
			liveWorkspaceSnapshot = base;
			return;
		}
		const git = gitProbe(base.cwd);
		liveWorkspaceSnapshot = {
			...base,
			branch: git.branch,
			dirty: git.dirty,
			ahead: git.ahead,
			behind: git.behind,
			recentCommits: git.recentCommits,
		};
	};

	const getWorkspaceSnapshot = (): WorkspaceSnapshot => deps.getSessionWorkspace() ?? bootWorkspace;

	const getLiveWorkspaceSnapshot = (): WorkspaceSnapshot => {
		const base = deps.getSessionWorkspace() ?? bootWorkspace;
		if (liveWorkspaceSnapshot.cwd !== base.cwd || liveWorkspaceSnapshot.capturedAt !== base.capturedAt) {
			liveWorkspaceSnapshot = base;
			refreshLiveWorkspaceGit(true);
		}
		return liveWorkspaceSnapshot;
	};

	// The welcome banner and footer share these counts. Active means enabled
	// and effective after precedence; installed includes every discovery.
	const getExtensionStats = (): ExtensionStats => {
		const items = deps.extensions?.list(deps.cwd, { all: true }) ?? [];
		return {
			active: items.filter((entry) => entry.enabled && entry.effective).length,
			installed: items.length,
		};
	};

	refreshLiveWorkspaceGit(true);

	return {
		getWorkspaceSnapshot,
		getLiveWorkspaceSnapshot,
		refreshLiveWorkspaceGit,
		getExtensionStats,
	};
}
