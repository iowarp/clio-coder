import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { clioDataDir } from "../../core/xdg.js";
import { atomicWrite, cwdHash, sessionPaths } from "../../engine/session.js";
import type { SessionMeta } from "./contract.js";
import { isSessionEntry, type SessionInfoEntry } from "./entries.js";

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
			const meta = JSON.parse(raw) as SessionMeta;
			enrichMetaFromSessionInfo(meta, join(dir, entry.name, "current.jsonl"));
			metas.push(meta);
		} catch {
			// skip unreadable / malformed meta files
		}
	}
	metas.sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt > b.createdAt ? -1 : 1));
	return metas;
}

function enrichMetaFromSessionInfo(meta: SessionMeta, currentPath: string): void {
	if (!existsSync(currentPath)) return;
	const labels = new Map<string, { label: string; timestamp: string }>();
	let name: string | undefined;
	try {
		const raw = readFileSync(currentPath, "utf8");
		for (const line of raw.split("\n")) {
			if (line.length === 0) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if (!isSessionEntry(parsed) || parsed.kind !== "sessionInfo") continue;
			const info = parsed as SessionInfoEntry;
			if (info.name !== undefined) {
				const trimmed = info.name.trim();
				name = trimmed.length > 0 ? trimmed : undefined;
			}
			if (!info.targetTurnId || info.label === undefined) continue;
			const existing = labels.get(info.targetTurnId);
			if (existing && existing.timestamp > info.timestamp) continue;
			labels.set(info.targetTurnId, { label: info.label, timestamp: info.timestamp });
		}
	} catch {
		return;
	}
	if (name) meta.name = name;
	const labelValues = [...labels.values()].map((entry) => entry.label.trim()).filter((label) => label.length > 0);
	if (labelValues.length > 0) meta.labels = labelValues;
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
