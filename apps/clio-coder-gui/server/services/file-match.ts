import type { FileCompletion } from "../../contracts/sessions.js";

/**
 * Matching for the composer's `@` references, over the list of files the workspace shows (the
 * enumeration the terminal completes against, so both name the same set). Three readings of what
 * was typed, the terminal's own: nothing typed lists the root; a path whose folder exists lists
 * that folder's children, narrowed by the rest; anything else is searched across the whole tree.
 */

export const FILE_MATCH_LIMIT = 50;

export interface FileIndex {
	/** Every file, relative to the root with `/` separators. */
	readonly files: readonly string[];
	/** Every folder that holds a file, without a trailing slash. */
	readonly directories: ReadonlySet<string>;
	/** Folder to the names directly inside it; the root is the empty string. */
	readonly children: ReadonlyMap<string, readonly { name: string; directory: boolean }[]>;
}

export function buildFileIndex(files: readonly string[]): FileIndex {
	const directories = new Set<string>();
	const children = new Map<string, Map<string, boolean>>();
	const add = (parent: string, name: string, directory: boolean) => {
		let rows = children.get(parent);
		if (rows === undefined) {
			rows = new Map();
			children.set(parent, rows);
		}
		if (!rows.has(name)) rows.set(name, directory);
	};
	for (const file of files) {
		const segments = file.split("/");
		let parent = "";
		for (let index = 0; index < segments.length; index += 1) {
			const name = segments[index] ?? "";
			const last = index === segments.length - 1;
			add(parent, name, !last);
			if (last) break;
			parent = parent === "" ? name : `${parent}/${name}`;
			directories.add(parent);
		}
	}
	return {
		files,
		directories,
		children: new Map(
			[...children].map(([parent, rows]) => [parent, [...rows].map(([name, directory]) => ({ name, directory }))]),
		),
	};
}

/**
 * Lower is better; null does not match. A name that starts with the query beats one that contains
 * it, which beats a path that contains it, which beats letters merely in order; among in-order
 * matches the tighter one wins.
 */
export function fuzzyRank(query: string, path: string): number | null {
	if (query === "") return 0;
	const target = path.toLowerCase();
	const name = target.slice(target.lastIndexOf("/") + 1);
	if (name.startsWith(query)) return 0;
	if (name.includes(query)) return 1;
	const at = target.indexOf(query);
	if (at >= 0) return at === 0 || target[at - 1] === "/" ? 2 : 3;
	let from = 0;
	let first = -1;
	for (const character of query) {
		const found = target.indexOf(character, from);
		if (found < 0) return null;
		if (first < 0) first = found;
		from = found + 1;
	}
	// The span the letters were found across, beyond the query's own length, is the looseness.
	return 4 + (from - first - query.length);
}

interface Candidate {
	readonly path: string;
	readonly directory: boolean;
}

function ordered(candidates: Iterable<Candidate>, query: string, key: (candidate: Candidate) => string): Candidate[] {
	const needle = query.toLowerCase();
	const ranked: { candidate: Candidate; rank: number }[] = [];
	for (const candidate of candidates) {
		const rank = fuzzyRank(needle, key(candidate));
		if (rank !== null) ranked.push({ candidate, rank });
	}
	return ranked
		.sort(
			(a, b) =>
				a.rank - b.rank ||
				// With nothing typed a listing reads as a tree, folders first; a search ranks on the match alone.
				(needle === "" ? Number(b.candidate.directory) - Number(a.candidate.directory) : 0) ||
				(needle === "" ? 0 : a.candidate.path.length - b.candidate.path.length) ||
				a.candidate.path.localeCompare(b.candidate.path, undefined, { numeric: true, sensitivity: "base" }),
		)
		.map((row) => row.candidate);
}

export function matchWorkspaceFiles(index: FileIndex, input: string): FileCompletion {
	const query = input.startsWith("./") ? input.slice(2) : input;
	const slash = query.lastIndexOf("/");
	const parent = slash < 0 ? "" : query.slice(0, slash);
	let rows: Candidate[];
	if (query === "" || (slash >= 0 && index.directories.has(parent))) {
		const prefix = parent === "" ? "" : `${parent}/`;
		rows = ordered(
			(index.children.get(parent) ?? []).map((row) => ({ path: `${prefix}${row.name}`, directory: row.directory })),
			query.slice(slash + 1),
			(candidate) => candidate.path.slice(prefix.length),
		);
	} else {
		const all = function* (): Generator<Candidate> {
			for (const path of index.directories) yield { path, directory: true };
			for (const path of index.files) yield { path, directory: false };
		};
		rows = ordered(all(), query, (candidate) => candidate.path);
	}
	return {
		matches: rows.slice(0, FILE_MATCH_LIMIT).map((row) => ({
			name: row.path.slice(row.path.lastIndexOf("/") + 1),
			path: row.directory ? `${row.path}/` : row.path,
			directory: row.directory,
		})),
		truncated: rows.length > FILE_MATCH_LIMIT,
	};
}
