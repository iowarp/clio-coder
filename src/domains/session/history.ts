import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { clioDataDir } from "../../core/xdg.js";
import { atomicWrite, cwdHash, sessionPaths } from "../../engine/session.js";
import type { SessionMeta } from "./contract.js";
import { isSessionEntry, type SessionInfoEntry } from "./entries.js";

/**
 * Walks `clioDataDir()/sessions/<cwdHash>/` and returns every session meta
 * for the given cwd, sorted by last-activity descending (newest activity
 * first). Falls back to createdAt when no entries carry timestamps.
 */
export function listSessionsForCwd(cwd: string): SessionMeta[] {
	const hash = cwdHash(cwd);
	const dir = join(clioDataDir(), "sessions", hash);
	if (!existsSync(dir)) return [];
	const metas: SessionMeta[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const sessionDir = join(dir, entry.name);
		const metaPath = join(sessionDir, "meta.json");
		if (!existsSync(metaPath)) continue;
		try {
			if (!statSync(metaPath).isFile()) continue;
			const raw = readFileSync(metaPath, "utf8");
			const meta = JSON.parse(raw) as SessionMeta;
			enrichMetaForListing(meta, join(sessionDir, "current.jsonl"));
			metas.push(meta);
		} catch {
			// skip unreadable / malformed meta files
		}
	}
	metas.sort((a, b) => {
		const aKey = a.lastActivityAt ?? a.createdAt ?? "";
		const bKey = b.lastActivityAt ?? b.createdAt ?? "";
		return aKey === bKey ? 0 : aKey > bKey ? -1 : 1;
	});
	return metas;
}

const PREVIEW_MAX_CHARS = 240;

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Pull the first non-empty piece of user-authored text out of a payload.
 * Handles three shapes the engine has used over time:
 *   - bare string (oldest)
 *   - `{ text: string }` (legacy turn payload, current chat-loop output)
 *   - `{ content: [{ type: "text", text }] }` (pi-ai message shape that some
 *     dispatch glue persists verbatim)
 */
function extractUserText(payload: unknown): string | null {
	if (typeof payload === "string") {
		const collapsed = collapseWhitespace(payload);
		return collapsed.length > 0 ? collapsed : null;
	}
	if (!payload || typeof payload !== "object") return null;
	const obj = payload as Record<string, unknown>;
	if (typeof obj.text === "string") {
		const collapsed = collapseWhitespace(obj.text);
		if (collapsed.length > 0) return collapsed;
	}
	if (Array.isArray(obj.content)) {
		const parts: string[] = [];
		for (const part of obj.content) {
			if (
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string"
			) {
				parts.push((part as { text: string }).text);
			}
		}
		const joined = collapseWhitespace(parts.join(" "));
		if (joined.length > 0) return joined;
	}
	return null;
}

interface ScanResult {
	firstUserMessage: string | null;
	messageCount: number;
	lastTimestamp: string | null;
	name: string | null;
	labels: Map<string, { label: string; timestamp: string }>;
}

function scanCurrentJsonl(currentPath: string): ScanResult {
	const result: ScanResult = {
		firstUserMessage: null,
		messageCount: 0,
		lastTimestamp: null,
		name: null,
		labels: new Map(),
	};
	if (!existsSync(currentPath)) return result;
	let raw: string;
	try {
		raw = readFileSync(currentPath, "utf8");
	} catch {
		return result;
	}
	for (const line of raw.split("\n")) {
		if (line.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!parsed || typeof parsed !== "object") continue;
		const obj = parsed as Record<string, unknown>;
		const ts = typeof obj.timestamp === "string" ? obj.timestamp : typeof obj.at === "string" ? obj.at : null;
		if (ts !== null && (result.lastTimestamp === null || ts > result.lastTimestamp)) {
			result.lastTimestamp = ts;
		}
		const isLegacyUser = obj.kind === "user";
		const isV2UserMessage =
			obj.kind === "message" &&
			(obj as { role?: unknown }).role === "user" &&
			(obj as { dispatch?: unknown }).dispatch !== true;
		if (isLegacyUser || isV2UserMessage) {
			result.messageCount += 1;
			if (result.firstUserMessage === null) {
				const text = extractUserText(obj.payload);
				if (text !== null) result.firstUserMessage = text;
			}
		}
		if (isSessionEntry(parsed) && parsed.kind === "sessionInfo") {
			const info = parsed as SessionInfoEntry;
			if (info.name !== undefined) {
				const trimmed = info.name.trim();
				result.name = trimmed.length > 0 ? trimmed : null;
			}
			if (info.targetTurnId && info.label !== undefined) {
				const existing = result.labels.get(info.targetTurnId);
				if (!existing || existing.timestamp <= info.timestamp) {
					result.labels.set(info.targetTurnId, { label: info.label, timestamp: info.timestamp });
				}
			}
		}
	}
	return result;
}

function enrichMetaForListing(meta: SessionMeta, currentPath: string): void {
	const scan = scanCurrentJsonl(currentPath);
	if (scan.name) meta.name = scan.name;
	const labelValues = [...scan.labels.values()].map((entry) => entry.label.trim()).filter((label) => label.length > 0);
	if (labelValues.length > 0) meta.labels = labelValues;
	if (scan.firstUserMessage) {
		meta.firstMessagePreview =
			scan.firstUserMessage.length > PREVIEW_MAX_CHARS
				? `${scan.firstUserMessage.slice(0, PREVIEW_MAX_CHARS - 1)}…`
				: scan.firstUserMessage;
	}
	if (scan.messageCount > 0) meta.messageCount = scan.messageCount;
	const fallbackMtime = readMtimeIso(currentPath);
	const activity = scan.lastTimestamp ?? fallbackMtime ?? meta.endedAt ?? meta.createdAt ?? null;
	if (activity) meta.lastActivityAt = activity;
}

function readMtimeIso(path: string): string | null {
	try {
		return statSync(path).mtime.toISOString();
	} catch {
		return null;
	}
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
