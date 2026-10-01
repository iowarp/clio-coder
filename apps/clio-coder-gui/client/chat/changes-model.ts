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

/** One call's contribution to a file's change, or null when the call changed nothing the transcript can vouch for. */
interface ChangeEntry {
	readonly path: string;
	readonly provenance: "applied" | "proposed";
	readonly adds: number;
	readonly dels: number;
	readonly call: ChangeCall;
}

// A timeline item keeps its identity until it changes, so what it contributes is read once per item
// and project root. A streamed delta then costs a map lookup per call instead of presenting every call
// again. The cache is keyed weakly, so it never outlives the snapshot that held the item.
const entries = new WeakMap<TimelineItem, { root: string | undefined; entry: ChangeEntry | null }>();

function changeEntry(item: TimelineItem, workspaceRoot: string | undefined): ChangeEntry | null {
	const cached = entries.get(item);
	if (cached !== undefined && cached.root === workspaceRoot) return cached.entry;
	const card = presentTool(item, workspaceRoot === undefined ? {} : { workspaceRoot });
	let entry: ChangeEntry | null = null;
	if (card.body === "diff" && card.diff !== null) {
		const { provenance } = card.diff;
		const path = card.diff.path ?? item.locations?.[0]?.path;
		// A refused or unfinished edit changed nothing the transcript can vouch for.
		if (
			(provenance === "applied" || provenance === "proposed") &&
			path !== undefined &&
			path !== null &&
			path.trim() !== ""
		)
			entry = {
				path,
				provenance,
				adds: provenance === "applied" ? (card.diff.diff?.adds ?? 0) : 0,
				dels: provenance === "applied" ? (card.diff.diff?.dels ?? 0) : 0,
				call: { id: item.id, panel: card.diff, status: item.status },
			};
	}
	entries.set(item, { root: workspaceRoot, entry });
	return entry;
}

// Four views read the same summary of the same tool list, so one computation serves them all.
const summaries = new WeakMap<readonly TimelineItem[], Map<string, ChangeSummary>>();

/** `tools` in the order the calls were made. */
export function summarizeChanges(tools: readonly TimelineItem[], workspaceRoot?: string): ChangeSummary {
	const memo = summaries.get(tools) ?? new Map<string, ChangeSummary>();
	const key = workspaceRoot ?? "";
	const hit = memo.get(key);
	if (hit !== undefined) return hit;
	const byPath = new Map<
		string,
		{ adds: number; dels: number; pending: boolean; applied: boolean; calls: ChangeCall[] }
	>();
	for (const item of tools) {
		const entry = changeEntry(item, workspaceRoot);
		if (entry === null) continue;
		const file = byPath.get(entry.path) ?? { adds: 0, dels: 0, pending: false, applied: false, calls: [] };
		if (entry.provenance === "applied") {
			file.applied = true;
			file.adds += entry.adds;
			file.dels += entry.dels;
		} else file.pending = true;
		file.calls.push(entry.call);
		byPath.set(entry.path, file);
	}
	const files: FileChange[] = [...byPath.entries()].map(([path, file]) => {
		const label = relativeTo(path, workspaceRoot);
		return { path, label, name: basename(label), dir: dirname(label), ...file };
	});
	const summary: ChangeSummary = {
		files,
		adds: files.reduce((sum, file) => sum + file.adds, 0),
		dels: files.reduce((sum, file) => sum + file.dels, 0),
		applied: files.filter((file) => file.applied).length,
		pending: files.filter((file) => !file.applied && file.pending).length,
	};
	memo.set(key, summary);
	summaries.set(tools, memo);
	return summary;
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
