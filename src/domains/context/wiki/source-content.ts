import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import {
	enumerateWorkspaceFiles,
	enumerateWorkspaceFilesAsync,
	WORKSPACE_EXCLUDED_DIRS,
} from "../../../core/workspace-files.js";
import { createSlicer } from "../codewiki/cooperative.js";

/** Shared, bounded byte evidence for the existing wiki checkpoint/publication. */
export type WikiSourceContent = Record<string, string | null>;
const MAX_FILES = 20_000;
const MAX_BYTES = 128 * 1024 * 1024;

export function parseWikiSourceContent(value: unknown): WikiSourceContent | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entries = Object.entries(value);
	if (entries.length > MAX_FILES) return undefined;
	if (
		entries.some(([path, hash]) => !path || (hash !== null && (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))))
	)
		return undefined;
	return Object.fromEntries(entries);
}

function capture(cwd: string, files: string[]): { content: WikiSourceContent; add: (path: string) => void } {
	const content: WikiSourceContent = Object.create(null);
	let remainingBytes = MAX_BYTES;
	const buffer = Buffer.alloc(64 * 1024);
	return {
		content,
		add(path) {
			if (files.length > MAX_FILES) return;
			let fd: number | undefined;
			content[path] = null;
			try {
				fd = openSync(join(cwd, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				const before = fstatSync(fd);
				if (!before.isFile() || before.size > remainingBytes) return;
				remainingBytes -= before.size;
				const hash = createHash("sha256");
				let remaining = before.size;
				while (remaining > 0) {
					const count = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
					if (count === 0) return;
					hash.update(buffer.subarray(0, count));
					remaining -= count;
				}
				const after = fstatSync(fd);
				if (after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs)
					content[path] = hash.digest("hex");
			} catch {
				// Missing, replaced, non-regular, and unreadable inputs remain unknown.
			} finally {
				if (fd !== undefined) closeSync(fd);
			}
		},
	};
}

/**
 * Enumeration shares the workspace's Git/ignore policy; capped evidence never
 * certifies a prefix. Before/after observations are not a filesystem snapshot:
 * an intervening edit followed by a revert can escape them.
 */
export function captureWikiSourceContent(cwd: string): WikiSourceContent {
	try {
		const files = enumerateWorkspaceFiles(cwd, WORKSPACE_EXCLUDED_DIRS);
		const snapshot = capture(cwd, files);
		for (const path of files) snapshot.add(path);
		return snapshot.content;
	} catch {
		return {};
	}
}

export async function captureWikiSourceContentAsync(cwd: string): Promise<WikiSourceContent> {
	try {
		const slicer = createSlicer();
		const files = await enumerateWorkspaceFilesAsync(cwd, WORKSPACE_EXCLUDED_DIRS, undefined, slicer);
		const snapshot = capture(cwd, files);
		for (const path of files) {
			snapshot.add(path);
			await slicer.tick();
		}
		return snapshot.content;
	} catch {
		return {};
	}
}

/** A directory claim compares every covered child, including additions and deletions. */
export function wikiSourcesMatch(
	previous: WikiSourceContent | undefined,
	current: WikiSourceContent,
	sources?: readonly string[],
): boolean {
	if (!previous || Object.keys(previous).length === 0 || Object.keys(current).length === 0) return false;
	const claimed = sources?.map((path) => path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, ""));
	const paths = [...new Set([...Object.keys(previous), ...Object.keys(current)])].filter(
		(path) => !claimed || claimed.some((source) => path === source || path.startsWith(`${source}/`)),
	);
	if (claimed?.some((source) => !paths.some((path) => path === source || path.startsWith(`${source}/`)))) return false;
	return paths.length > 0 && paths.every((path) => previous[path] != null && previous[path] === current[path]);
}
