import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Value } from "typebox/value";
import { Id } from "../../../contracts/common.js";
import { AppProblem } from "../../services/problem.js";

/** Bound and contain durable artifact reads before a canonical reader opens them. */
export function containedFile(root: string, ...parts: string[]): string | null {
	try {
		const base = realpathSync(root),
			path = realpathSync(resolve(base, ...parts));
		const rel = relative(base, path),
			stat = statSync(path);
		if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || !stat.isFile() || stat.size > 8 * 1024 * 1024)
			return null;
		return path;
	} catch {
		return null;
	}
}
export function readArtifact(root: string, ...parts: string[]): unknown {
	const path = containedFile(root, ...parts);
	if (!path) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}
/** A stable newest-first keyset shared by file-backed inventories. */
export function artifactPage<T extends { id: string; startedAt: string }>(rows: T[], limit: number, cursor?: string) {
	let before: { id: string; startedAt: string } | undefined;
	if (cursor) {
		try {
			const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
			if (
				!parsed ||
				typeof parsed !== "object" ||
				!Value.Check(Id, parsed.id) ||
				typeof parsed.startedAt !== "string" ||
				!Number.isFinite(Date.parse(parsed.startedAt))
			)
				throw new Error();
			before = parsed;
		} catch {
			throw new AppProblem("validation", "Invalid artifact cursor.");
		}
	}
	const compare = (a: { id: string; startedAt: string }, b: { id: string; startedAt: string }) =>
		Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.id.localeCompare(a.id);
	const ordered = rows.sort(compare).filter((row) => !before || compare(row, before) > 0);
	const items = ordered.slice(0, limit),
		last = items.at(-1);
	return {
		items,
		nextCursor:
			ordered.length > items.length && last
				? Buffer.from(JSON.stringify({ id: last.id, startedAt: last.startedAt })).toString("base64url")
				: null,
	};
}
