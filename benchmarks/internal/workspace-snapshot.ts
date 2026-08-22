/**
 * A content snapshot of a live driver's temporary workspace, and the diff that
 * decides whether the run changed it.
 *
 * The binary writes two files of its own into any project it runs in:
 * `.clio-coder/codewiki.json` (src/domains/context/codewiki/artifact.ts) and
 * `.clio-coder/state.json` (src/domains/context/state.ts). Both are Clio's
 * bookkeeping, not the model acting on the workspace, so a workspace-unchanged
 * assertion excludes exactly those two paths and the `.clio-coder/` directory
 * entry that exists to hold them. Anything else under `.clio-coder/` (a rule,
 * a handoff, a proposal, a settings file) still counts as a change, which is
 * why the exclusion is a list of files rather than a directory.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type WorkspaceSnapshot = Map<string, string>;

/** Workspace-relative paths, posix-separated, exactly as the snapshot keys them. */
export const CLIO_MANAGED_WORKSPACE_PATHS: ReadonlySet<string> = new Set([
	".clio-coder/",
	".clio-coder/codewiki.json",
	".clio-coder/state.json",
]);

const sha256 = (text: Buffer): string => createHash("sha256").update(text).digest("hex");

/** Every entry under `workspaceDir` except `.git/`, keyed by relative path; directories end in `/`. */
export function workspaceSnapshot(workspaceDir: string): WorkspaceSnapshot {
	const snapshot: WorkspaceSnapshot = new Map();
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (dir === workspaceDir && entry.name === ".git") continue;
			const path = join(dir, entry.name);
			const key = relative(workspaceDir, path).split(sep).join("/");
			if (entry.isDirectory()) {
				snapshot.set(`${key}/`, "directory");
				walk(path);
			} else if (entry.isSymbolicLink()) snapshot.set(key, `symlink:${readlinkSync(path)}`);
			else if (entry.isFile()) snapshot.set(key, `file:${sha256(readFileSync(path))}`);
			else snapshot.set(key, "other");
		}
	};
	walk(workspaceDir);
	return snapshot;
}

/** Sorted keys that differ between two snapshots, ignoring Clio's own artifacts. */
export function workspaceChanges(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
	return [...new Set([...before.keys(), ...after.keys()])]
		.filter((key) => !CLIO_MANAGED_WORKSPACE_PATHS.has(key) && before.get(key) !== after.get(key))
		.sort();
}
