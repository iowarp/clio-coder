import { existsSync, readdirSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { clioStateDir } from "../../../../../src/core/xdg.js";
import {
	endAbandonedSession,
	listSessionsForCwd,
	listSessionWorkspaces,
} from "../../../../../src/domains/session/history.js";
import {
	liveSessionView,
	readTreeBundle,
	renderTranscriptMarkdown,
	sessionLiveOwner,
} from "../../../../../src/domains/session/index.js";
import { AppProblem } from "../../services/problem.js";

/** Fails closed when session storage links outside the state directory; false when there is no ledger yet. */
export function preflightLedger() {
	const state = clioStateDir(),
		directory = join(state, "sessions");
	if (!existsSync(directory)) return false;
	const root = realpathSync(state);
	const inspect = (path: string, depth: number) => {
		const resolved = realpathSync(path),
			part = relative(root, resolved);
		if (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part))
			throw new AppProblem("validation", "Session storage escapes its state directory.");
		if (depth > 0)
			for (const child of readdirSync(path, { withFileTypes: true })) {
				const target = join(path, child.name);
				if (child.isDirectory()) inspect(target, depth - 1);
				else {
					const file = realpathSync(target),
						diff = relative(root, file);
					if (diff === ".." || diff.startsWith(`..${sep}`) || isAbsolute(diff))
						throw new AppProblem("validation", "Session storage escapes its state directory.");
				}
			}
	};
	// The domain owns cwd hashing; preflight its session tree without copying that identity algorithm.
	inspect(directory, 3);
	return true;
}
/** Every project the ledger knows, so the app shows the terminal's projects without a list of its own. */
export function sessionWorkspaces() {
	return preflightLedger() ? listSessionWorkspaces() : [];
}
type StoredSession = ReturnType<typeof listSessionsForCwd>[number];
/** One saved session as ACP `session/list` would describe it, before the server adds its workspace id. */
type HistoryRow = {
	id: string;
	createdAt: string;
	endedAt: string | null;
	target: string | null;
	model: string | null;
	name?: string;
	firstMessagePreview?: string;
	messageCount?: number;
	lastActivityAt: string;
	liveElsewhere?: LiveElsewhereRow;
};
type LiveElsewhereRow = {
	surface: "terminal" | "headless" | "app" | "process";
	since: string;
	host: string;
	pid: number;
	stale: boolean;
	canTakeOver: boolean;
};
const SURFACES = { tui: "terminal", run: "headless", acp: "app" } as const;
// The engine's wire bounds (src/engine/acp/server.ts ACP_MAX_SESSION_ID_BYTES and ACP_MAX_LABEL_BYTES,
// src/engine/acp/types.ts ACP_MAX_TARGET_ID_BYTES and ACP_MAX_MODEL_ID_BYTES); adapters cannot import either module.
const MAX_SESSION_ID_BYTES = 128,
	MAX_LABEL_BYTES = 256,
	MAX_TARGET_ID_BYTES = 128,
	MAX_MODEL_ID_BYTES = 256;
const TRUNCATION_SUFFIX = "…[truncated]";
const HISTORY_LIMIT = 2_000;
const unreadable = () => new AppProblem("unavailable", "The saved task list could not be read.");
const hasControlCharacters = (value: string) => {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
	}
	return false;
};
const sliceToBytes = (value: string, maxBytes: number) => {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const buffer = Buffer.allocUnsafe(maxBytes);
	return buffer.toString("utf8", 0, buffer.write(value, 0, maxBytes, "utf8"));
};
const boundString = (value: string, maxBytes: number) => {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const budget = maxBytes - Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");
	return budget <= 0 ? sliceToBytes(value, maxBytes) : `${sliceToBytes(value, budget)}${TRUNCATION_SUFFIX}`;
};
const storedString = (value: unknown, maxBytes: number) => {
	if (typeof value !== "string") return "";
	let safe = "";
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		safe += codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f) ? " " : character;
	}
	return boundString(safe, maxBytes);
};
const storedIdentifier = (value: unknown, maxBytes: number) =>
	typeof value !== "string" ||
	value.length === 0 ||
	hasControlCharacters(value) ||
	Buffer.byteLength(value, "utf8") > maxBytes
		? null
		: value;
// The engine fails the whole list on a configured route it cannot represent; so does this read.
const configuredIdentifier = (value: unknown, maxBytes: number) => {
	if (value === null || value === undefined) return null;
	const safe = storedIdentifier(value, maxBytes);
	if (safe === null) throw unreadable();
	return safe;
};
const iso = (value: unknown) => {
	if (typeof value === "string" && !hasControlCharacters(value)) {
		const timestamp = Date.parse(value);
		if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
	}
	return new Date(0).toISOString();
};
const count = (value: unknown) =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
/**
 * The process that holds this session open, when it is another one: its live record names the surface and when it
 * opened. This app's own engine children are live too; the server, which knows their pids, drops those.
 */
function liveElsewhere(meta: StoredSession): LiveElsewhereRow | undefined {
	const owner = sessionLiveOwner(meta);
	if (owner === null) return undefined;
	const view = liveSessionView(meta.id);
	const record = view?.record;
	return {
		surface: record ? SURFACES[record.surface] : "process",
		since: iso(record?.startedAt ?? meta.lastActivityAt ?? meta.createdAt),
		host: storedString(owner.host, 255),
		pid: owner.pid,
		stale: view?.stale ?? false,
		canTakeOver: view !== null,
	};
}
function historyRow(meta: StoredSession): HistoryRow {
	const label = storedString(meta.name, MAX_LABEL_BYTES).trim();
	const messageCount = count(meta.messageCount);
	const live = liveElsewhere(meta);
	return {
		id: meta.id,
		createdAt: iso(meta.createdAt),
		endedAt: meta.endedAt === null ? null : iso(meta.endedAt),
		target: configuredIdentifier(meta.target, MAX_TARGET_ID_BYTES),
		model: configuredIdentifier(meta.model, MAX_MODEL_ID_BYTES),
		...(label.length > 0 ? { name: label } : {}),
		...(meta.firstMessagePreview !== undefined
			? { firstMessagePreview: storedString(meta.firstMessagePreview, MAX_LABEL_BYTES) }
			: {}),
		...(messageCount !== undefined ? { messageCount } : {}),
		lastActivityAt: iso(meta.lastActivityAt ?? meta.endedAt ?? meta.createdAt),
		...(live ? { liveElsewhere: live } : {}),
	};
}
/**
 * A workspace's saved sessions, read from the ledger in this thread rather than by booting an engine for ACP
 * `session/list`. It mirrors that method line by line (src/engine/acp/server.ts `workspaceHistory` and the
 * `session/list` handler): a safe stored id, a recorded cwd that resolves to this workspace, and a transcript
 * holding a model turn, newest activity first, with each field bounded as the engine bounds it on the wire. The
 * engine also scrubs URL credentials from names and previews (`redactUrlCredentials`), a module adapters may not
 * import. `cwd` is the workspace's canonical path.
 */
export function listSessionHistory(cwd: string): HistoryRow[] {
	let stored: StoredSession[];
	try {
		if (!preflightLedger()) return [];
		stored = listSessionsForCwd(cwd);
	} catch (error) {
		// A ledger that escapes its state directory keeps preflight's own answer; anything else is unreadable.
		if (error instanceof AppProblem) throw error;
		throw unreadable();
	}
	const rows: HistoryRow[] = [];
	for (const meta of stored) {
		if (storedIdentifier(meta.id, MAX_SESSION_ID_BYTES) === null || meta.hasModelTurn === false) continue;
		try {
			// The engine resolves a relative record against its own cwd, which is this workspace.
			if (realpathSync(resolve(cwd, meta.cwd)) !== cwd) continue;
		} catch {
			// A recorded directory that no longer resolves cannot belong to this workspace; the engine skips it too.
			continue;
		}
		rows.push(historyRow(meta));
		if (rows.length === HISTORY_LIMIT) break;
	}
	return rows;
}
const TRANSCRIPT_LIMIT = 1_048_576;
/**
 * A saved session's history as the terminal's `/export` Markdown, read from the ledger in this thread, so a
 * session another process holds open can be read without loading it. Only a session this workspace's ledger
 * lists is read; a long transcript keeps its latest part, cut at a line.
 */
export function readStoredTranscript(cwd: string, id: string) {
	if (!listSessionHistory(cwd).some((row) => row.id === id))
		throw new AppProblem("not_found", "Session was not found in this workspace's ledger.");
	let rendered: { text: string; turns: number };
	try {
		const bundle = readTreeBundle(id);
		rendered = renderTranscriptMarkdown({
			sessionId: id,
			exportedAt: new Date().toISOString(),
			entries: bundle.entries,
			leafTurnId: bundle.meta.pinnedLeafTurnId ?? null,
		});
	} catch {
		throw unreadable();
	}
	const bytes = Buffer.from(rendered.text, "utf8");
	if (bytes.length <= TRANSCRIPT_LIMIT) return { markdown: rendered.text, turns: rendered.turns, truncated: false };
	const tail = bytes.subarray(bytes.length - TRANSCRIPT_LIMIT + 1024).toString("utf8");
	const markdown = tail.slice(tail.indexOf("\n") + 1);
	return { markdown, turns: rendered.turns, truncated: true };
}
/**
 * Ends a session ledger record the caller has proven abandoned, only while the dead child `pid` is still its
 * recorded owner; the ops worker is its only caller.
 */
export function recoverSession(cwd: string, sessionId: string, pid: number, birth: string | null) {
	return preflightLedger() ? endAbandonedSession(cwd, sessionId, { host: hostname(), pid, birth }) : false;
}
