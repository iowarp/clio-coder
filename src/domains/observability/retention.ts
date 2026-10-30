import { existsSync } from "node:fs";
import { lstat, readdir, readFile, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { scanTelemetrySegment } from "../../core/telemetry/segment.js";
import { liveSessionOwner } from "../session/live-owner.js";
import { CONTENT_SUBJECTS, collectRefs } from "./bundle.js";
import type { JournalFileName } from "./call-journal.js";
import { journalFiles } from "./call-journal.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const GIB = 1024 * 1024 * 1024;
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const OBJECT_FILE = /^obj_[0-9a-f]{64}\.json$/;

/** O5 (#434): standard journals 90 days or 1 GiB, research content 30 days or 4 GiB, oldest first. */
export interface PrunePolicy {
	days: number;
	maxBytes: number;
	researchDays: number;
	researchMaxBytes: number;
}
export const DEFAULT_PRUNE_POLICY: PrunePolicy = {
	days: 90,
	maxBytes: GIB,
	researchDays: 30,
	researchMaxBytes: 4 * GIB,
};

export type PruneReason = "expired" | "over-size" | "research-expired" | "research-over-size" | "unreferenced-object";

export interface PruneAction {
	path: string;
	bytes: number;
	mtimeMs: number;
	reason: PruneReason;
	/** The session or run whose ownership is re-checked immediately before the delete. */
	owner: { kind: "session"; directory: string } | { kind: "run"; directory: string } | { kind: "research" };
}

export interface PruneHold {
	path: string;
	reason: "live" | "unknown-owner" | "fork-parent" | "referenced-run" | "receipt" | "unreadable" | "symlink";
}

export interface PrunePlan {
	remove: PruneAction[];
	held: PruneHold[];
	standardBytes: number;
	researchBytes: number;
}

interface FileInfo {
	path: string;
	bytes: number;
	mtimeMs: number;
}

interface SessionTelemetry {
	directory: string;
	sessionId: string;
	segments: FileInfo[];
	objects: Map<string, FileInfo>;
	lastWriteMs: number;
	bytes: number;
	refs: Map<string, string>;
	runs: Set<string>;
	parent: string | null;
	hold: PruneHold["reason"] | null;
	/** A record this version cannot read may cite an object, so nothing in the session is collected or expired by reference. */
	partial: boolean;
}

interface RunTelemetry {
	runId: string;
	directory: string;
	segments: FileInfo[];
	lastWriteMs: number;
	bytes: number;
	hold: PruneHold["reason"] | null;
}

async function info(path: string): Promise<FileInfo | null> {
	try {
		const stat = await lstat(path);
		return stat.isFile() ? { path, bytes: stat.size, mtimeMs: stat.mtimeMs } : null;
	} catch {
		return null;
	}
}

async function names(directory: string): Promise<string[]> {
	try {
		return await readdir(directory);
	} catch {
		return [];
	}
}

/** Every path prune removes stays under the state root: a directory reached through a symlink is never entered. */
async function realDirectory(path: string): Promise<boolean> {
	try {
		const stat = await lstat(path);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch {
		return false;
	}
}

/** A writer holds `<journal>.lock` for its whole life; a lock, live or stale, keeps every file of that journal. */
function locked(directory: string, fileName: JournalFileName): boolean {
	return existsSync(join(directory, `${fileName}.lock`));
}

async function readSessionTelemetry(directory: string, sessionId: string): Promise<SessionTelemetry | null> {
	const entries = await names(directory);
	const segmentNames = journalFiles(entries, "calls.jsonl");
	const objectsDirectory = join(directory, "objects");
	const objectNames = (await realDirectory(objectsDirectory))
		? (await names(objectsDirectory)).filter((name) => OBJECT_FILE.test(name))
		: [];
	if (segmentNames.length === 0 && objectNames.length === 0) return null;
	const session: SessionTelemetry = {
		directory,
		sessionId,
		segments: [],
		objects: new Map(),
		lastWriteMs: 0,
		bytes: 0,
		refs: new Map(),
		runs: new Set(),
		parent: null,
		hold: null,
		partial: false,
	};
	for (const name of segmentNames) {
		const file = await info(join(directory, name));
		if (!file) continue;
		session.segments.push(file);
		session.lastWriteMs = Math.max(session.lastWriteMs, file.mtimeMs);
		session.bytes += file.bytes;
		let bytes: Buffer;
		try {
			bytes = await readFile(file.path);
		} catch {
			session.partial = true;
			continue;
		}
		const scan = scanTelemetrySegment(bytes);
		// Interior damage or a record this version cannot read may hide a reference (R12).
		if (scan.corruptOffset !== null) session.partial = true;
		for (const row of scan.rows) {
			if (row.kind === "skipped") {
				session.partial = true;
				continue;
			}
			if (row.kind !== "record") continue;
			const record = row.record;
			collectRefs(record.data, session.refs);
			if (record.k === "call.ref" || record.k === "run.ref") session.runs.add(record.data.runId);
			if (record.k === "session.forked_from") session.parent = record.data.parentSessionId;
		}
	}
	for (const name of objectNames) {
		const file = await info(join(directory, "objects", name));
		if (file) session.objects.set(name.slice(0, -".json".length), file);
	}
	if (session.lastWriteMs === 0)
		session.lastWriteMs = Math.max(0, ...[...session.objects.values()].map((file) => file.mtimeMs));
	if (locked(directory, "calls.jsonl")) session.hold = "live";
	else {
		try {
			const meta = JSON.parse(await readFile(join(directory, "meta.json"), "utf8")) as Parameters<
				typeof liveSessionOwner
			>[0];
			if (liveSessionOwner(meta) !== null) session.hold = "live";
		} catch {
			// Without its meta the session's owner cannot be ruled out.
			session.hold ??= "unknown-owner";
		}
	}
	return session;
}

async function readRunTelemetry(stateDir: string, runId: string): Promise<RunTelemetry | null> {
	const directory = join(stateDir, "runs", runId);
	const segmentNames = journalFiles(await names(directory), "events.ndjson");
	if (segmentNames.length === 0) return null;
	const run: RunTelemetry = { runId, directory, segments: [], lastWriteMs: 0, bytes: 0, hold: null };
	for (const name of segmentNames) {
		const file = await info(join(directory, name));
		if (!file) continue;
		run.segments.push(file);
		run.lastWriteMs = Math.max(run.lastWriteMs, file.mtimeMs);
		run.bytes += file.bytes;
	}
	if (locked(directory, "events.ndjson")) run.hold = "live";
	else if (existsSync(join(stateDir, "receipts", `${runId}.json`))) run.hold = "receipt";
	return run;
}

/**
 * Read-only: what a prune under `policy` would remove and what it must keep (#434). A live or
 * unreadable session keeps every file; a fork parent with a kept child, a run a kept journal or a
 * receipt references, and an object a kept record cites are never collected. Research retention is
 * the one exception by decision (O5): content preimages expire after their research window while the
 * records citing them stay, and those references then read as missing.
 */
export async function planTelemetryPrune(
	stateDir: string,
	policy: PrunePolicy,
	nowMs = Date.now(),
): Promise<PrunePlan> {
	const plan: PrunePlan = { remove: [], held: [], standardBytes: 0, researchBytes: 0 };
	const sessions: SessionTelemetry[] = [];
	const sessionsRoot = join(stateDir, "sessions");
	for (const cwdHash of await names(sessionsRoot)) {
		if (!SAFE_ID.test(cwdHash) || !(await realDirectory(join(sessionsRoot, cwdHash)))) continue;
		for (const sessionId of await names(join(sessionsRoot, cwdHash))) {
			if (!SAFE_ID.test(sessionId)) continue;
			const directory = join(sessionsRoot, cwdHash, sessionId);
			if (!(await realDirectory(directory))) {
				plan.held.push({ path: directory, reason: "symlink" });
				continue;
			}
			const session = await readSessionTelemetry(directory, sessionId);
			if (session) sessions.push(session);
		}
	}
	const runs: RunTelemetry[] = [];
	for (const runId of await names(join(stateDir, "runs"))) {
		if (!SAFE_ID.test(runId)) continue;
		if (!(await realDirectory(join(stateDir, "runs", runId)))) {
			plan.held.push({ path: join(stateDir, "runs", runId), reason: "symlink" });
			continue;
		}
		const run = await readRunTelemetry(stateDir, runId);
		if (run) runs.push(run);
	}
	// Content preimages count toward the research budget, everything else in a journal toward the standard one.
	const sessionBytes = (session: SessionTelemetry) =>
		[...session.objects].reduce(
			(sum, [id, file]) => sum + (CONTENT_SUBJECTS.has(session.refs.get(id) ?? "") ? 0 : file.bytes),
			session.bytes,
		);
	plan.standardBytes =
		sessions.reduce((sum, session) => sum + sessionBytes(session), 0) + runs.reduce((sum, run) => sum + run.bytes, 0);

	// Standard retention: whole session journals, oldest first; age first, then size.
	const doomed = new Set<SessionTelemetry>();
	const cutoff = nowMs - policy.days * DAY_MS;
	let standing = plan.standardBytes;
	const candidates = sessions.filter((session) => session.hold === null).sort((a, b) => a.lastWriteMs - b.lastWriteMs);
	for (const session of candidates) {
		if (session.lastWriteMs >= cutoff && standing <= policy.maxBytes) break;
		doomed.add(session);
		standing -= sessionBytes(session);
	}
	// A kept child resolves its inherited prefix from its parent's journal (#434), so the parent stays.
	for (let changed = true; changed; ) {
		changed = false;
		const keptParents = new Set(
			sessions.filter((session) => !doomed.has(session)).flatMap((session) => session.parent ?? []),
		);
		for (const session of doomed) {
			if (!keptParents.has(session.sessionId)) continue;
			doomed.delete(session);
			plan.held.push({ path: session.directory, reason: "fork-parent" });
			changed = true;
		}
	}
	standing = plan.standardBytes - [...doomed].reduce((sum, session) => sum + sessionBytes(session), 0);
	for (const session of sessions) if (session.hold) plan.held.push({ path: session.directory, reason: session.hold });
	for (const session of [...doomed].sort((a, b) => a.lastWriteMs - b.lastWriteMs)) {
		const reason: PruneReason = session.lastWriteMs < cutoff ? "expired" : "over-size";
		const owner = { kind: "session" as const, directory: session.directory };
		for (const file of [...session.segments, ...session.objects.values()]) plan.remove.push({ ...file, reason, owner });
	}

	// Runs: only unreferenced ones, never one a receipt or a kept session journal cites.
	const cited = new Set(sessions.filter((session) => !doomed.has(session)).flatMap((session) => [...session.runs]));
	for (const run of runs.sort((a, b) => a.lastWriteMs - b.lastWriteMs)) {
		const hold = run.hold ?? (cited.has(run.runId) ? "referenced-run" : null);
		if (hold) {
			plan.held.push({ path: run.directory, reason: hold });
			continue;
		}
		if (run.lastWriteMs >= cutoff && standing <= policy.maxBytes) continue;
		standing -= run.bytes;
		const reason: PruneReason = run.lastWriteMs < cutoff ? "expired" : "over-size";
		for (const file of run.segments)
			plan.remove.push({ ...file, reason, owner: { kind: "run", directory: run.directory } });
	}

	// Kept, readable, idle sessions: research content past its window, then objects no record cites.
	const researchCutoff = nowMs - policy.researchDays * DAY_MS;
	const research: Array<{ file: FileInfo; owner: PruneAction["owner"] }> = [];
	for (const session of sessions) {
		if (session.hold !== null || doomed.has(session)) continue;
		if (session.partial) {
			plan.held.push({ path: session.directory, reason: "unreadable" });
			continue;
		}
		const owner = { kind: "session" as const, directory: session.directory };
		for (const [id, file] of session.objects) {
			const subject = session.refs.get(id);
			if (subject === undefined) plan.remove.push({ ...file, reason: "unreferenced-object", owner });
			else if (CONTENT_SUBJECTS.has(subject)) research.push({ file, owner });
		}
	}
	const traceDirectory = join(stateDir, "telemetry", "research");
	for (const name of (await realDirectory(traceDirectory)) ? await names(traceDirectory) : []) {
		const file = await info(join(traceDirectory, name));
		if (file) research.push({ file, owner: { kind: "research" } });
	}
	plan.researchBytes = research.reduce((sum, item) => sum + item.file.bytes, 0);
	let researchStanding = plan.researchBytes;
	for (const item of research.sort((a, b) => a.file.mtimeMs - b.file.mtimeMs)) {
		if (item.file.mtimeMs >= researchCutoff && researchStanding <= policy.researchMaxBytes) break;
		researchStanding -= item.file.bytes;
		plan.remove.push({
			...item.file,
			reason: item.file.mtimeMs < researchCutoff ? "research-expired" : "research-over-size",
			owner: item.owner,
		});
	}
	return plan;
}

export interface PruneResult {
	removed: PruneAction[];
	skipped: Array<{ path: string; reason: string }>;
}

/**
 * Ownership is re-checked per session or run immediately before its files go, and the journal's lock file again
 * before every unlink, so a session that starts between the plan and its turn is skipped whole. Prune never takes
 * the journal lock itself: a writer that found it held would fail its open and lose the session's journal (#434).
 */
export async function applyTelemetryPrune(plan: PrunePlan): Promise<PruneResult> {
	const result: PruneResult = { removed: [], skipped: [] };
	const journalOf = (owner: PruneAction["owner"]): JournalFileName =>
		owner.kind === "run" ? "events.ndjson" : "calls.jsonl";
	const live = async (owner: PruneAction["owner"]): Promise<boolean> => {
		if (owner.kind === "research") return false;
		if (locked(owner.directory, journalOf(owner))) return true;
		if (owner.kind !== "session") return false;
		try {
			const meta = JSON.parse(await readFile(join(owner.directory, "meta.json"), "utf8")) as Parameters<
				typeof liveSessionOwner
			>[0];
			return liveSessionOwner(meta) !== null;
		} catch {
			return true;
		}
	};
	// One owner's files go together, so the liveness check stays fresh for every file it covers.
	const batches = new Map<string, PruneAction[]>();
	for (const action of plan.remove) {
		const key = action.owner.kind === "research" ? "research" : `${action.owner.kind}:${action.owner.directory}`;
		batches.set(key, [...(batches.get(key) ?? []), action]);
	}
	for (const batch of batches.values()) {
		const owner = (batch[0] as PruneAction).owner;
		if (await live(owner)) {
			for (const action of batch) result.skipped.push({ path: action.path, reason: "became live" });
			continue;
		}
		for (const action of batch) {
			const current = await info(action.path);
			if (!current || current.bytes !== action.bytes || current.mtimeMs !== action.mtimeMs) {
				result.skipped.push({ path: action.path, reason: current ? "changed since planning" : "already gone" });
				continue;
			}
			// A writer creates its lock before it opens the journal, so a lock seen here means a session just started.
			if (owner.kind !== "research" && locked(owner.directory, journalOf(owner))) {
				result.skipped.push({ path: action.path, reason: "became live" });
				continue;
			}
			try {
				await rm(action.path);
				result.removed.push(action);
			} catch (error) {
				result.skipped.push({ path: action.path, reason: error instanceof Error ? error.message : String(error) });
			}
		}
	}
	for (const directory of new Set(
		result.removed.flatMap((action) =>
			action.owner.kind === "session" ? [join(action.owner.directory, "objects")] : [],
		),
	)) {
		// Only an emptied objects directory goes; rmdir refuses one that still holds a file.
		await rmdir(directory).catch(() => {});
	}
	return result;
}
