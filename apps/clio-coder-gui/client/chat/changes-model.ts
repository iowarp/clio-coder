// What a task changed on disk, as far as the transcript can honestly say. Every number here comes
// from the edit and write calls the agent made and the diffs those calls carried. The browser never
// reads the file system, so a file edited by another process, or by a call whose diff was capped, is
// not counted, and a proposed edit that was never applied is shown as pending rather than counted.

import type { TimelineItem } from "../../contracts/sessions.js";
import type { DiffPanel } from "./diff-model.js";
import { basename, presentTool } from "./tool-presentation.js";

export interface ChangeCall {
	readonly id: string;
	readonly panel: DiffPanel;
	readonly status: string;
}

export interface FileChange {
	/** The path as the tool reported it. */
	readonly path: string;
	/** The path relative to the project when it sits inside it, otherwise as reported. */
	readonly label: string;
	readonly name: string;
	/** Directory part of `label`, empty for a file at the project root. */
	readonly dir: string;
	readonly adds: number;
	readonly dels: number;
	/** At least one edit to this file is proposed and not yet applied. */
	readonly pending: boolean;
	/** At least one edit to this file landed. A file with only proposals has not changed. */
	readonly applied: boolean;
	readonly calls: readonly ChangeCall[];
}

export interface ChangeSummary {
	readonly files: readonly FileChange[];
	readonly adds: number;
	readonly dels: number;
	/** Files an edit actually changed. */
	readonly applied: number;
	/** Files that only have a proposed edit so far. */
	readonly pending: number;
}

export const NO_CHANGES: ChangeSummary = { files: [], adds: 0, dels: 0, applied: 0, pending: 0 };

export function relativeTo(path: string, root: string | undefined): string {
	if (root !== undefined && root.length > 0) {
		const prefix = root.endsWith("/") ? root : `${root}/`;
		if (path.startsWith(prefix)) return path.slice(prefix.length);
	}
	return path;
}

function dirname(label: string): string {
	const cut = label.lastIndexOf("/");
	return cut < 0 ? "" : label.slice(0, cut);
}

/** `tools` in the order the calls were made. */
export function summarizeChanges(tools: readonly TimelineItem[], workspaceRoot?: string): ChangeSummary {
	const byPath = new Map<
		string,
		{ adds: number; dels: number; pending: boolean; applied: boolean; calls: ChangeCall[] }
	>();
	for (const item of tools) {
		const card = presentTool(item, workspaceRoot === undefined ? {} : { workspaceRoot });
		if (card.body !== "diff" || card.diff === null) continue;
		const { provenance } = card.diff;
		// A refused or unfinished edit changed nothing the transcript can vouch for.
		if (provenance !== "applied" && provenance !== "proposed") continue;
		const path = card.diff.path ?? item.locations?.[0]?.path;
		if (path === undefined || path === null || path.trim() === "") continue;
		const entry = byPath.get(path) ?? { adds: 0, dels: 0, pending: false, applied: false, calls: [] };
		if (provenance === "applied") {
			entry.applied = true;
			entry.adds += card.diff.diff?.adds ?? 0;
			entry.dels += card.diff.diff?.dels ?? 0;
		} else entry.pending = true;
		entry.calls.push({ id: item.id, panel: card.diff, status: item.status });
		byPath.set(path, entry);
	}
	const files: FileChange[] = [...byPath.entries()].map(([path, entry]) => {
		const label = relativeTo(path, workspaceRoot);
		return { path, label, name: basename(label), dir: dirname(label), ...entry };
	});
	return {
		files,
		adds: files.reduce((sum, file) => sum + file.adds, 0),
		dels: files.reduce((sum, file) => sum + file.dels, 0),
		applied: files.filter((file) => file.applied).length,
		pending: files.filter((file) => !file.applied && file.pending).length,
	};
}

/** `+12 −3` with the real minus sign, or an empty string when nothing was counted. */
export function changeCounts(summary: Pick<ChangeSummary, "adds" | "dels">): string {
	return summary.adds === 0 && summary.dels === 0 ? "" : `+${summary.adds} −${summary.dels}`;
}

/** Up to four letters of the extension, for the tile beside a file's name. */
export function extensionBadge(name: string): string {
	const extension = /\.([A-Za-z0-9]{1,4})$/u.exec(name)?.[1];
	return extension ? extension.toUpperCase() : "FILE";
}

export interface TouchedFile {
	readonly path: string;
	readonly label: string;
	readonly name: string;
	readonly dir: string;
	/** Tool calls that reported this path. */
	readonly calls: number;
}

/**
 * Paths tools reported that no edit changed: files Clio read, searched or ran against. Newest call
 * first. `changed` is the set of paths `summarizeChanges` already lists.
 */
export function touchedFiles(
	tools: readonly TimelineItem[],
	workspaceRoot: string | undefined,
	changed: ReadonlySet<string>,
): TouchedFile[] {
	const counts = new Map<string, number>();
	for (const item of tools)
		for (const location of item.locations ?? []) {
			const path = location.path;
			if (path.trim() === "" || changed.has(path)) continue;
			const seen = counts.get(path) ?? 0;
			// Re-insert so Map order tracks the most recent call.
			counts.delete(path);
			counts.set(path, seen + 1);
		}
	return [...counts.entries()].reverse().map(([path, calls]) => {
		const label = relativeTo(path, workspaceRoot);
		return { path, label, name: basename(label), dir: dirname(label), calls };
	});
}
