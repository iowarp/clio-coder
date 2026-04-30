import { probeGit } from "./git-probe.js";
import { detectProjectType } from "./project-type.js";

/**
 * Workspace snapshot captured at session bind. Read-only for the session's
 * lifetime; refreshed by /reset or /new. Surfaced via the workspace_context
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
	projectType: "node" | "python" | "rust" | "go" | "dotfiles" | "unknown";
	capturedAt: string;
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
	};
}

export function probeWorkspace(cwd: string): WorkspaceSnapshot {
	const git = probeGit(cwd);
	let projectType: WorkspaceSnapshot["projectType"];
	try {
		projectType = detectProjectType(cwd);
	} catch {
		projectType = "unknown";
	}
	return {
		cwd,
		isGit: git.isGit,
		branch: git.branch,
		dirty: git.dirty,
		ahead: git.ahead,
		behind: git.behind,
		recentCommits: git.recentCommits,
		remoteUrl: git.remoteUrl,
		projectType,
		capturedAt: new Date().toISOString(),
	};
}
