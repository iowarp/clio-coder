import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { clioDataDir } from "../../core/xdg.js";
import { atomicWrite, cwdHash, sessionPaths } from "../../engine/session.js";
import type { SessionMeta } from "./contract.js";

/**
 * Walks `clioDataDir()/sessions/<cwdHash>/` and returns every session meta
 * for the given cwd, sorted by createdAt descending (newest first).
 */
export function listSessionsForCwd(cwd: string): SessionMeta[] {
	const hash = cwdHash(cwd);
	const dir = join(clioDataDir(), "sessions", hash);
	if (!existsSync(dir)) return [];
	const metas: SessionMeta[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const metaPath = join(dir, entry.name, "meta.json");
		if (!existsSync(metaPath)) continue;
		try {
			if (!statSync(metaPath).isFile()) continue;
			const raw = readFileSync(metaPath, "utf8");
			metas.push(JSON.parse(raw) as SessionMeta);
		} catch {
			// skip unreadable / malformed meta files
		}
	}
	metas.sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt > b.createdAt ? -1 : 1));
	return metas;
}

/**
 * Applies fork pointers to a freshly-created session's meta. Mutates the meta
 * object in place so the engine writer's `close()` (which spreads `...meta`
 * when rewriting meta.json with endedAt) preserves the parent pointers, then
 * atomically rewrites meta.json so the marker survives crashes before close.
 */
export function enrichForkMeta(meta: SessionMeta, parentSessionId: string, parentTurnId: string): void {
	Object.assign(meta, { parentSessionId, parentTurnId });
	const paths = sessionPaths(meta);
	atomicWrite(paths.meta, JSON.stringify(meta, null, 2));
}
