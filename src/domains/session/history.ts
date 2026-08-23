import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { clioStateDir } from "../../core/xdg.js";
import { atomicWrite, cwdHash, readSessionFileEntries, sessionPaths } from "../../engine/session.js";
import { collectSessionEntries } from "./compaction/session-entries.js";
import type { SessionMeta } from "./contract.js";
import { isSessionHeader, type LabelEntry, type SessionInfoEntry } from "./entries.js";

/**
 * Walks `clioStateDir()/sessions/<cwdHash>/` and returns every session meta
 * for the given cwd, sorted by last-activity descending (newest activity
 * first). Falls back to createdAt when no entries carry timestamps.
 */
export function listSessionsForCwd(cwd: string): SessionMeta[] {
	const hash = cwdHash(cwd);
	const dir = join(clioStateDir(), "sessions", hash);
	if (!existsSync(dir)) return [];
	const metas: SessionMeta[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const sessionDir = join(dir, entry.name);
		const metaPath = join(sessionDir, "meta.json");
		if (!existsSync(metaPath)) continue;
		let meta: SessionMeta;
		try {
			if (!statSync(metaPath).isFile()) continue;
			const raw = readFileSync(metaPath, "utf8");
			meta = JSON.parse(raw) as SessionMeta;
		} catch {
			// Skip unreadable or malformed metadata files.
			continue;
		}
		enrichMetaForListing(meta, join(sessionDir, "current.jsonl"));
		metas.push(meta);
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
 * Pull the first non-empty piece of text out of a message payload. Structured
 * message payloads may contain a bare string, a text property, or pi-ai
 * content blocks.
 */
function rawMessageText(payload: unknown): string | null {
	if (typeof payload === "string") return payload.trim().length > 0 ? payload : null;
	if (!payload || typeof payload !== "object") return null;
	const obj = payload as Record<string, unknown>;
	if (typeof obj.text === "string" && obj.text.trim().length > 0) return obj.text;
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
		const joined = parts.join("\n");
		if (joined.trim().length > 0) return joined;
	}
	return null;
}

function extractMessageText(payload: unknown): string | null {
	const raw = rawMessageText(payload);
	if (raw === null) return null;
	const collapsed = collapseWhitespace(raw);
	return collapsed.length > 0 ? collapsed : null;
}

/**
 * What the operator typed for a user turn, for the picker preview.
 *
 * The persisted text is the composed prompt: a `<system-reminder>` block and
 * any `[Skill request]` preamble ride ahead of the operator's words as visible
 * text the model receives. Reading that verbatim made every row of the
 * `/resume` picker read `<system-reminder> [Skills] 9 installed…`, so sessions
 * were indistinguishable and the type-to-filter matched them all (issue #188).
 * Entries written since the operator text was persisted carry it as
 * `operatorText`; older ones drop the leading scaffolding. Null when nothing
 * operator-authored remains, so the caller moves on to the next turn.
 */
export function operatorTextOfUserPayload(payload: unknown): string | null {
	if (
		payload &&
		typeof payload === "object" &&
		typeof (payload as { operatorText?: unknown }).operatorText === "string"
	) {
		const collapsed = collapseWhitespace((payload as { operatorText: string }).operatorText);
		return collapsed.length > 0 ? collapsed : null;
	}
	// Strip before collapsing: the preamble's line structure is what the
	// patterns anchor on.
	const text = rawMessageText(payload);
	if (text === null) return null;
	const stripped = collapseWhitespace(stripInjectedPreamble(text));
	return stripped.length > 0 ? stripped : null;
}

const LEADING_SYSTEM_REMINDER = /^\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/u;
const LEADING_SKILL_REQUEST =
	/^\s*\[Skill request\][\s\S]*?Only these pending skill names are allowed this turn\.[^\n]*\s*/u;

function stripInjectedPreamble(text: string): string {
	let current = text;
	for (;;) {
		const next = current.replace(LEADING_SYSTEM_REMINDER, "").replace(LEADING_SKILL_REQUEST, "");
		if (next === current) return current;
		current = next;
	}
}

interface ScanResult {
	firstUserMessage: string | null;
	/** The first assistant text, the preview when no turn carries operator words. */
	firstAssistantMessage: string | null;
	messageCount: number;
	lastTimestamp: string | null;
	name: string | null;
	labels: Map<string, { label: string; timestamp: string }>;
}

function scanCurrentJsonl(currentPath: string): ScanResult {
	const result: ScanResult = {
		firstUserMessage: null,
		firstAssistantMessage: null,
		messageCount: 0,
		lastTimestamp: null,
		name: null,
		labels: new Map(),
	};
	if (!existsSync(currentPath)) return result;
	const records = readSessionFileEntries(currentPath).filter((entry) => !isSessionHeader(entry));
	for (const parsed of collectSessionEntries(records, currentPath)) {
		if (result.lastTimestamp === null || parsed.timestamp > result.lastTimestamp) {
			result.lastTimestamp = parsed.timestamp;
		}
		if (parsed.kind === "message" && parsed.role === "user") {
			result.messageCount += 1;
			if (result.firstUserMessage === null) {
				const text = operatorTextOfUserPayload(parsed.payload);
				if (text !== null) result.firstUserMessage = text;
			}
		}
		if (parsed.kind === "message" && parsed.role === "assistant" && result.firstAssistantMessage === null) {
			const text = extractMessageText(parsed.payload);
			if (text !== null) result.firstAssistantMessage = text;
		}
		if (parsed.kind === "sessionInfo") {
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
		if (parsed.kind === "label") {
			const label = parsed as LabelEntry;
			const existing = result.labels.get(label.targetTurnId);
			if (!existing || existing.timestamp <= label.timestamp) {
				result.labels.set(label.targetTurnId, { label: label.label ?? "", timestamp: label.timestamp });
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
	const preview = scan.firstUserMessage ?? scan.firstAssistantMessage;
	if (preview) {
		meta.firstMessagePreview =
			preview.length > PREVIEW_MAX_CHARS ? `${preview.slice(0, PREVIEW_MAX_CHARS - 1)}…` : preview;
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
