import { enumerateWorkspaceFilesAsync } from "../../../../../src/core/workspace-files.js";
import type { FileCompletion } from "../../../contracts/sessions.js";
import { buildFileIndex, type FileIndex, matchWorkspaceFiles } from "../../services/file-match.js";

/** A list read for one keystroke serves the next few; a file created since shows up after this long. */
const INDEX_TTL_MS = 4_000;
const INDEX_KEPT = 6;
const indexes = new Map<string, { expiresAt: number; index: Promise<FileIndex> }>();

/**
 * Matches for one `@` reference, from the same enumeration the terminal completes against. Null
 * when the workspace could not be enumerated (a tree outside Git past the walk's bounds), which
 * the caller answers with a plain folder listing instead.
 */
export async function completeWorkspaceFiles(cwd: string, input: string): Promise<FileCompletion | null> {
	const now = Date.now();
	let cached = indexes.get(cwd);
	if (cached === undefined || cached.expiresAt <= now) {
		cached = { expiresAt: now + INDEX_TTL_MS, index: enumerateWorkspaceFilesAsync(cwd).then(buildFileIndex) };
		indexes.delete(cwd);
		indexes.set(cwd, cached);
		while (indexes.size > INDEX_KEPT) {
			const oldest = indexes.keys().next().value;
			if (oldest === undefined) break;
			indexes.delete(oldest);
		}
	}
	try {
		return matchWorkspaceFiles(await cached.index, input);
	} catch {
		if (indexes.get(cwd) === cached) indexes.delete(cwd);
		return null;
	}
}
