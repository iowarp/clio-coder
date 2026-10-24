import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { readClioVersion } from "../../core/package-root.js";
import { processBirthToken } from "../../core/process-identity.js";
import { assertSafeId } from "../../core/safe-id.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { clioStateDir, stateRootRemoved } from "../../core/xdg.js";
import type { ClioSessionMeta, ClioSessionOwner, ClioSessionWriter } from "../../engine/session.js";

/**
 * Session heartbeat on a shared state dir (#439). Every open session keeps
 * `live/<id>.json` fresh so another node can list it, tell a dead owner from a
 * live one by age instead of by a pid it cannot probe, and ask it to end.
 *
 * Stale after 180 s: NFS attribute caching (acregmax/acdirmax, 60 s default)
 * can hide a rename that long, login node clocks drift, and a SIGSTOPped or
 * swapped owner must survive a hiccup. 60 s cache + one 15 s beat + 105 s for
 * skew and pauses. A forced release requires that age; nothing here removes a
 * record on a guess.
 */
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_STALE_MS = 180_000;
/** `at` and the file mtime further apart than this point at writer and reader clocks that disagree. */
export const HEARTBEAT_SKEW_MS = 5_000;

export type SessionSurface = "tui" | "run" | "acp";

export interface LiveSessionRecord {
	schema: 1;
	id: string;
	cwd: string;
	cwdHash: string;
	host: string;
	pid: number;
	birth: string | null;
	startedAt: string;
	at: string;
	surface: SessionSurface;
	version: string;
	user: string;
	model?: string;
	target?: string;
}

export interface SessionRequester {
	host: string;
	pid: number;
	user: string;
}

export interface TerminateRequest {
	schema: 1;
	requestedAt: string;
	by: SessionRequester;
	reason?: string;
	force: boolean;
}

export interface ReleasedFence {
	schema: 1;
	at: string;
	by: SessionRequester;
	reason: string;
}

let surface: SessionSurface = "tui";
let terminate: ((notice: string) => void) | null = null;

/**
 * The orchestrator names its surface once at boot and hands over the one
 * shutdown path (`TerminationCoordinator.shutdown(143)`), so a terminate
 * request ends a TUI, a headless run and an ACP connection the way SIGTERM
 * does. Injected rather than imported: the coordinator's render helpers sit in
 * the Stage 0 closure and must not ride into every seam that opens a session.
 */
export function configureSessionHeartbeat(input: {
	surface: SessionSurface;
	terminate: (notice: string) => void;
}): void {
	surface = input.surface;
	terminate = input.terminate;
}

export function liveSessionsDir(): string {
	return join(clioStateDir(), "live");
}

export function liveRecordPath(id: string): string {
	return join(liveSessionsDir(), `${id}.json`);
}

export function terminateRequestPath(id: string): string {
	return join(liveSessionsDir(), `${id}.terminate.json`);
}

export function releasedFencePath(id: string): string {
	return join(liveSessionsDir(), `${id}.released.json`);
}

export function currentRequester(): SessionRequester {
	return { host: hostname(), pid: process.pid, user: currentUser() };
}

function currentUser(): string {
	try {
		return userInfo().username;
	} catch {
		return process.env.USER ?? process.env.USERNAME ?? "unknown";
	}
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/**
 * Records come from other nodes and other versions, so every field a reader
 * prints or compares is checked; a file that fails reads as absent rather than
 * throwing from a timer or a listing.
 */
function isLiveRecord(value: unknown): value is LiveSessionRecord {
	const record = value as Partial<LiveSessionRecord> | null;
	return (
		record !== null &&
		typeof record === "object" &&
		record.schema === 1 &&
		typeof record.id === "string" &&
		typeof record.cwd === "string" &&
		typeof record.cwdHash === "string" &&
		typeof record.host === "string" &&
		Number.isSafeInteger(record.pid) &&
		(record.birth === null || typeof record.birth === "string") &&
		typeof record.startedAt === "string" &&
		typeof record.at === "string" &&
		(record.surface === "tui" || record.surface === "run" || record.surface === "acp") &&
		typeof record.version === "string" &&
		typeof record.user === "string" &&
		(record.model === undefined || typeof record.model === "string") &&
		(record.target === undefined || typeof record.target === "string")
	);
}

function isRequester(value: unknown): value is SessionRequester {
	const by = value as Partial<SessionRequester> | null;
	return (
		by !== null &&
		typeof by === "object" &&
		typeof by.host === "string" &&
		Number.isSafeInteger(by.pid) &&
		typeof by.user === "string"
	);
}

/** A record copied under another session's name must not stand in for it. */
function namesItself(record: LiveSessionRecord, id: string): boolean {
	if (record.id !== id) return false;
	try {
		assertSafeId(record.id, "session");
		return true;
	} catch {
		return false;
	}
}

function readLiveRecord(id: string): LiveSessionRecord | null {
	const value = readJson(liveRecordPath(id));
	return isLiveRecord(value) && namesItself(value, id) ? value : null;
}

function readTerminateRequest(id: string): TerminateRequest | null {
	const value = readJson(terminateRequestPath(id)) as Partial<TerminateRequest> | null;
	if (value === null || typeof value !== "object" || value.schema !== 1 || !isRequester(value.by)) return null;
	if (value.reason !== undefined && typeof value.reason !== "string") return null;
	return value as TerminateRequest;
}

/** Any fence file fences, well-formed or not: it exists only because a release ran. */
function readReleasedFence(id: string): ReleasedFence | null {
	const value = readJson(releasedFencePath(id)) as Partial<ReleasedFence> | null;
	if (value === null || typeof value !== "object" || value.schema !== 1 || !isRequester(value.by)) return null;
	return typeof value.reason === "string" ? (value as ReleasedFence) : null;
}

/** Control characters from a file another node wrote never reach the operator's terminal raw. */
export function printable(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
	return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

export interface LiveSessionView {
	record: LiveSessionRecord;
	/** now − max(at, mtime): an NFS mtime is the server clock every reader shares. */
	ageMs: number;
	skewMs: number;
	stale: boolean;
	terminateRequested: boolean;
}

function viewLiveRecord(record: LiveSessionRecord, mtimeMs: number, nowMs = Date.now()): LiveSessionView {
	const atMs = Date.parse(record.at);
	const beatMs = Number.isFinite(atMs) ? Math.max(atMs, mtimeMs) : mtimeMs;
	const ageMs = Math.max(0, nowMs - beatMs);
	return {
		record,
		ageMs,
		skewMs: Number.isFinite(atMs) ? Math.abs(atMs - mtimeMs) : 0,
		stale: ageMs > HEARTBEAT_STALE_MS,
		terminateRequested: existsSync(terminateRequestPath(record.id)),
	};
}

/**
 * One readdir plus one small read per open session; no walk of the session
 * tree. `malformed` names record files that failed validation, so a listing
 * shows them instead of failing on them.
 */
export function listLiveSessions(nowMs = Date.now()): { sessions: LiveSessionView[]; malformed: string[] } {
	const dir = liveSessionsDir();
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return { sessions: [], malformed: [] };
	}
	const sessions: LiveSessionView[] = [];
	const malformed: string[] = [];
	for (const name of names) {
		if (!name.endsWith(".json") || name.startsWith(".") || name.split(".").length !== 2) continue;
		const path = join(dir, name);
		const record = readJson(path);
		if (!isLiveRecord(record) || !namesItself(record, name.slice(0, -".json".length))) {
			if (existsSync(path)) malformed.push(name);
			continue;
		}
		let mtimeMs: number;
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			continue;
		}
		sessions.push(viewLiveRecord(record, mtimeMs, nowMs));
	}
	sessions.sort((a, b) => a.record.startedAt.localeCompare(b.record.startedAt));
	return { sessions, malformed };
}

/**
 * How far this host's clock is from the clock that stamps mtimes in `live/`,
 * measured by writing a probe file there. On NFS the mtime is the server's
 * clock, so a forcer whose own clock runs ahead would read fresh beats as
 * stale; this catches that. On Lustre and GPFS the mtime is the writing
 * client's clock, so the probe reads 0 there and the guard is NFS-only.
 */
export function stateDirClockOffsetMs(): number | null {
	const probe = join(liveSessionsDir(), `.clock-probe-${process.pid}-${Date.now()}`);
	try {
		const before = Date.now();
		safeResourceWrite(probe, "");
		const after = Date.now();
		const mtimeMs = statSync(probe).mtimeMs;
		if (mtimeMs < before - 1_000) return mtimeMs - before;
		if (mtimeMs > after + 1_000) return mtimeMs - after;
		return 0;
	} catch {
		return null;
	} finally {
		rmSync(probe, { force: true });
	}
}

/** True while the live record still names exactly this owner triple. */
export function liveRecordNames(id: string, owner: ClioSessionOwner): boolean {
	const current = readLiveRecord(id);
	return current !== null && sameOwner(current, owner);
}

export function liveSessionView(id: string, nowMs = Date.now()): LiveSessionView | null {
	const record = readLiveRecord(id);
	if (record === null) return null;
	try {
		return viewLiveRecord(record, statSync(liveRecordPath(id)).mtimeMs, nowMs);
	} catch {
		return null;
	}
}

export function formatAge(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function sameOwner(record: Pick<LiveSessionRecord, "host" | "pid" | "birth">, owner: ClioSessionOwner): boolean {
	return record.host === owner.host && record.pid === owner.pid && record.birth === owner.birth;
}

function removeQuietly(path: string): void {
	try {
		rmSync(path, { force: true });
	} catch {
		// A shared filesystem that refuses the unlink leaves a record the next reader ages out.
	}
}

/**
 * Publish this session's live record and keep it fresh until `stop`. A
 * failed write is swallowed: a full parallel filesystem must never end a turn.
 * Each beat also checks for a terminate request and for a fence left by a
 * forced release, and ends the process through the one shutdown path when
 * either is present.
 */
export function startSessionHeartbeat(input: { meta: ClioSessionMeta; writer: ClioSessionWriter }): () => void {
	const { meta, writer } = input;
	const owner: ClioSessionOwner = meta.owner ?? { pid: process.pid, host: hostname(), birth: processBirthToken() };
	const startedAt = new Date().toISOString();
	const base = {
		schema: 1 as const,
		id: meta.id,
		cwd: meta.cwd,
		cwdHash: meta.cwdHash,
		host: owner.host,
		pid: owner.pid,
		birth: owner.birth,
		startedAt,
		surface,
		version: readClioVersion(),
		user: currentUser(),
	};
	let stopped = false;
	let ending = false;

	const publish = (): void => {
		if (stateRootRemoved()) return;
		const record: LiveSessionRecord = {
			...base,
			at: new Date().toISOString(),
			...(meta.model ? { model: meta.model } : {}),
			...(meta.target ? { target: meta.target } : {}),
		};
		try {
			safeResourceWrite(liveRecordPath(meta.id), `${JSON.stringify(record)}\n`);
		} catch {
			// See the doc comment: a beat that cannot land is retried on the next one.
		}
	};

	const end = (notice: string): void => {
		if (ending) return;
		ending = true;
		stop();
		if (terminate) terminate(notice);
		// A process that opened a session outside bootOrchestrator has no shutdown
		// path to call; it says so instead of carrying on silently.
		else process.stderr.write(`${notice} (no shutdown path in this process; it must end on its own)\n`);
	};

	const beat = (): void => {
		if (stopped || ending || stateRootRemoved()) return;
		const fenced = writer.fenced || existsSync(releasedFencePath(meta.id));
		const fence = fenced ? readReleasedFence(meta.id) : null;
		const current = readLiveRecord(meta.id);
		// A missing record without a fence is not a release: every release writes
		// the fence first. An operator who removed live/ gets it back on this beat.
		if (fenced || (current !== null && !sameOwner(current, owner))) {
			// Another node released this session while this process was stopped
			// or partitioned, and may already have resumed it. Fence the writer
			// before shutdown runs any persist hook against the ledger.
			writer.fence();
			if (fenced && (current === null || sameOwner(current, owner))) removeQuietly(releasedFencePath(meta.id));
			const by = fence ? printable(`${fence.by.user}@${fence.by.host}`) : "another process";
			end(
				`Clio Coder: session ${meta.id} was released by ${by}${fence ? ` (${printable(fence.reason)})` : ""}; this process no longer owns it and wrote nothing more.`,
			);
			return;
		}
		const request = readTerminateRequest(meta.id);
		if (request !== null) {
			end(
				printable(
					`Clio Coder: terminated by ${request.by.user}@${request.by.host}${request.reason ? `: ${request.reason}` : ""}`,
				),
			);
			return;
		}
		publish();
	};

	// A request or fence left by an earlier owner of this id does not apply to this open.
	removeQuietly(terminateRequestPath(meta.id));
	removeQuietly(releasedFencePath(meta.id));
	// Checked again at every ledger write, not only on the beat: after SIGCONT
	// queued I/O or a compaction can run before the next timer tick (#439).
	const fencePath = releasedFencePath(meta.id);
	// A resumer on another node clears the fence on open, so a record that no
	// longer names this owner fences too.
	writer.fenceWhen(() => {
		if (existsSync(fencePath)) return true;
		const current = readLiveRecord(meta.id);
		return current !== null && !sameOwner(current, owner);
	});
	publish();
	const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
	timer.unref();

	function stop(): void {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
	}

	return () => {
		stop();
		if (writer.fenced || stateRootRemoved()) return;
		// Remove only a record that still names this process; a successor's is not ours.
		const current = readLiveRecord(meta.id);
		if (current !== null && sameOwner(current, owner)) removeQuietly(liveRecordPath(meta.id));
		removeQuietly(terminateRequestPath(meta.id));
	};
}
