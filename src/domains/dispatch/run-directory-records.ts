/**
 * Cross-process run state in the run's own directory (fleet design principle 8, M11).
 *
 * A run's directory, `<stateDir>/runs/<runId>/`, already holds its display feed (run-feed.ts). Two more kinds of record
 * live there so a second Clio process on the same state directory can see a live run and answer its held ask:
 *
 *   owner.json                   who drives the run: owner identity (pid, birth token, pid namespace, boot id, host),
 *                                the owner's cwd and the run's `run.started` identity, written once when it starts
 *   grants/<requestId>.json      one operator-visible ask: the request as the owner's card received it, the binding the
 *                                owner checks an answer against (attempt, argument digest, a per-record nonce), and
 *                                its state, `pending` until the owner writes `resolved` with the resolution
 *   grants/<requestId>.answer.json
 *                                an answer from another process, echoing the binding; the owner applies it through the
 *                                same path its own card uses, then removes it
 *
 * Every write goes through `safeResourceWrite` (temp file, fsync, rename), so a reader never sees a torn record. A
 * reader never trusts a record whose owner died: `ownerState` probes the pid and its birth token the way the capacity
 * lease does, and a `pending` ask whose owner is gone is no ask at all. Everything here is best-effort: a record that
 * cannot be written or read costs the cross-process view, never the run.
 */

import { randomBytes } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type OwnerIdentity, ownerIdentity, type RecordedOwner } from "../../core/process-identity.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import type {
	DispatchStartedPayload,
	PermissionRequestedPayload,
	PermissionResolvedPayload,
} from "../../core/telemetry/live-events.js";

export const RUN_OWNER_FILE = "owner.json";
export const RUN_GRANTS_DIR = "grants";
const RECORD_VERSION = 1;

/** Run and request ids are generated base36 or `grant-<hex>`; anything with a separator is refused before a path is built. */
function isSafeId(id: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && id !== "." && id !== "..";
}

function runDirectory(stateDir: string, runId: string): string {
	return join(stateDir, "runs", runId);
}

/** The run directory and its parent must be real directories, never links, before a record lands in them. */
function directoryIsPlain(path: string): boolean {
	try {
		const stat = lstatSync(path, { throwIfNoEntry: false });
		return stat === undefined || (stat.isDirectory() && !stat.isSymbolicLink());
	} catch {
		return false;
	}
}

function writeRecord(stateDir: string, runId: string, relative: string, value: unknown): boolean {
	const directory = runDirectory(stateDir, runId);
	if (![join(stateDir, "runs"), directory, join(directory, RUN_GRANTS_DIR)].every(directoryIsPlain)) return false;
	try {
		safeResourceWrite(join(directory, relative), `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
		return true;
	} catch {
		return false;
	}
}

function readObject(path: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function recordedOwner(value: unknown): RecordedOwner | null {
	if (typeof value !== "object" || value === null) return null;
	const owner = value as Record<string, unknown>;
	if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0) return null;
	return {
		host: typeof owner.host === "string" ? owner.host : null,
		pid: owner.pid as number,
		birthToken: typeof owner.birthToken === "string" ? owner.birthToken : null,
		...(typeof owner.pidNs === "string" ? { pidNs: owner.pidNs } : {}),
		...(typeof owner.bootId === "string" ? { bootId: owner.bootId } : {}),
	};
}

// ---------------------------------------------------------------------------
// Owner record
// ---------------------------------------------------------------------------

export interface RunOwnerRecord {
	v: typeof RECORD_VERSION;
	runId: string;
	owner: RecordedOwner;
	/** The owning process's working directory. */
	cwd: string;
	/** The project the owner works in; a viewer shows only the runs of its own project, from any of its subdirectories. */
	projectRoot: string;
	startedAt: string;
	started: DispatchStartedPayload;
}

/** Name this process as the run's owner. Written when the run starts; a later attempt of the same run rewrites it. */
export function writeRunOwnerRecord(
	stateDir: string,
	started: DispatchStartedPayload,
	location: { cwd: string; projectRoot: string },
	owner: OwnerIdentity = ownerIdentity(),
): boolean {
	if (!isSafeId(started.runId)) return false;
	const record: RunOwnerRecord = {
		v: RECORD_VERSION,
		runId: started.runId,
		owner,
		cwd: location.cwd,
		projectRoot: location.projectRoot,
		startedAt: new Date().toISOString(),
		started,
	};
	return writeRecord(stateDir, started.runId, RUN_OWNER_FILE, record);
}

export function readRunOwnerRecord(stateDir: string, runId: string): RunOwnerRecord | null {
	if (!isSafeId(runId)) return null;
	const value = readObject(join(runDirectory(stateDir, runId), RUN_OWNER_FILE));
	if (value === null || value.v !== RECORD_VERSION || value.runId !== runId) return null;
	const owner = recordedOwner(value.owner);
	const started = value.started as Partial<DispatchStartedPayload> | undefined;
	if (owner === null || typeof value.cwd !== "string" || typeof value.projectRoot !== "string") return null;
	if (typeof started?.agentId !== "string" || started.runId !== runId) return null;
	return {
		v: RECORD_VERSION,
		runId,
		owner,
		cwd: value.cwd,
		projectRoot: value.projectRoot,
		startedAt: typeof value.startedAt === "string" ? value.startedAt : "",
		started: started as DispatchStartedPayload,
	};
}

// ---------------------------------------------------------------------------
// Grant records
// ---------------------------------------------------------------------------

/** What an answer must echo for the owner to apply it. */
export interface GrantRecordBinding {
	requestId: string;
	runId: string;
	/** The attempt the worker parked the call in; null for an ask the grant broker does not hold. */
	attempt: number | null;
	/** sha256 of the parked call's effect descriptor; null for an ask the grant broker does not hold. */
	argDigest: string | null;
	/** Minted per record, so an answer written for an earlier record with the same ids never applies. */
	nonce: string;
}

export interface GrantRequestRecord extends GrantRecordBinding {
	v: typeof RECORD_VERSION;
	owner: RecordedOwner;
	createdAt: string;
	state: "pending" | "resolved";
	request: PermissionRequestedPayload;
	resolved?: PermissionResolvedPayload;
	/** The owner refused the last answer another process gave; the ask stays pending under a fresh nonce. */
	lastRefusal?: { at: string; reason: string };
}

export interface GrantAnswerRecord extends GrantRecordBinding {
	v: typeof RECORD_VERSION;
	decision: "approve" | "deny";
	answeredBy: RecordedOwner;
	at: string;
}

function grantPath(stateDir: string, runId: string, requestId: string, answer = false): string {
	return join(runDirectory(stateDir, runId), RUN_GRANTS_DIR, `${requestId}${answer ? ".answer" : ""}.json`);
}

/** Record an operator-visible ask this process holds. Null when the ids are unsafe or the write failed. */
export function writeGrantRequestRecord(
	stateDir: string,
	input: { request: PermissionRequestedPayload; runId: string; attempt: number | null; argDigest: string | null },
	owner: OwnerIdentity = ownerIdentity(),
): GrantRequestRecord | null {
	const requestId = input.request.requestId;
	if (requestId === undefined || !isSafeId(requestId) || !isSafeId(input.runId)) return null;
	const record: GrantRequestRecord = {
		v: RECORD_VERSION,
		requestId,
		runId: input.runId,
		attempt: input.attempt,
		argDigest: input.argDigest,
		nonce: randomBytes(16).toString("hex"),
		owner,
		createdAt: new Date().toISOString(),
		state: "pending",
		request: input.request,
	};
	return writeRecord(stateDir, input.runId, `${RUN_GRANTS_DIR}/${requestId}.json`, record) ? record : null;
}

/** Mark a recorded ask settled, with the resolution the owner's own card received. */
export function resolveGrantRequestRecord(
	stateDir: string,
	record: GrantRequestRecord,
	resolved: PermissionResolvedPayload,
): GrantRequestRecord {
	const next: GrantRequestRecord = { ...record, state: "resolved", resolved };
	writeRecord(stateDir, record.runId, `${RUN_GRANTS_DIR}/${record.requestId}.json`, next);
	return next;
}

/**
 * The owner refused an answer another process gave (its session changed, the run is ending): the ask stays pending
 * under a fresh nonce, so the refused answer can never apply, and says why, so a viewer shows its card again.
 */
export function refuseGrantAnswerRecord(
	stateDir: string,
	record: GrantRequestRecord,
	reason: string,
): GrantRequestRecord {
	const next: GrantRequestRecord = {
		...record,
		nonce: randomBytes(16).toString("hex"),
		lastRefusal: { at: new Date().toISOString(), reason: reason.slice(0, 500) },
	};
	writeRecord(stateDir, record.runId, `${RUN_GRANTS_DIR}/${record.requestId}.json`, next);
	return next;
}

function bindingOf(value: Record<string, unknown>): GrantRecordBinding | null {
	const { requestId, runId, attempt, argDigest, nonce } = value;
	if (typeof requestId !== "string" || typeof runId !== "string" || typeof nonce !== "string") return null;
	if (attempt !== null && !Number.isSafeInteger(attempt)) return null;
	if (argDigest !== null && typeof argDigest !== "string") return null;
	return { requestId, runId, attempt: attempt as number | null, argDigest: argDigest as string | null, nonce };
}

/** Every ask recorded for a run, newest state of each; malformed files are skipped. */
export function readGrantRequestRecords(stateDir: string, runId: string): GrantRequestRecord[] {
	if (!isSafeId(runId)) return [];
	let names: string[];
	try {
		names = readdirSync(join(runDirectory(stateDir, runId), RUN_GRANTS_DIR));
	} catch {
		return [];
	}
	const records: GrantRequestRecord[] = [];
	for (const name of names) {
		if (!name.endsWith(".json") || name.endsWith(".answer.json")) continue;
		const requestId = name.slice(0, -".json".length);
		if (!isSafeId(requestId)) continue;
		const value = readObject(grantPath(stateDir, runId, requestId));
		if (value === null || value.v !== RECORD_VERSION) continue;
		const binding = bindingOf(value);
		const owner = recordedOwner(value.owner);
		const request = value.request as PermissionRequestedPayload | undefined;
		if (binding === null || binding.requestId !== requestId || binding.runId !== runId || owner === null) continue;
		if (typeof request !== "object" || request === null || request.requestId !== requestId) continue;
		if (value.state !== "pending" && value.state !== "resolved") continue;
		records.push({
			...binding,
			v: RECORD_VERSION,
			owner,
			createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
			state: value.state,
			request,
			...(typeof value.resolved === "object" && value.resolved !== null
				? { resolved: value.resolved as PermissionResolvedPayload }
				: {}),
			...(lastRefusalOf(value.lastRefusal) ?? {}),
		});
	}
	return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** Answer an ask another process holds. The owner checks the echoed binding before it applies anything. */
export function writeGrantAnswerRecord(
	stateDir: string,
	binding: GrantRecordBinding,
	decision: "approve" | "deny",
	answeredBy: OwnerIdentity = ownerIdentity(),
): boolean {
	if (!isSafeId(binding.requestId) || !isSafeId(binding.runId)) return false;
	const record: GrantAnswerRecord = {
		v: RECORD_VERSION,
		requestId: binding.requestId,
		runId: binding.runId,
		attempt: binding.attempt,
		argDigest: binding.argDigest,
		nonce: binding.nonce,
		decision,
		answeredBy,
		at: new Date().toISOString(),
	};
	return writeRecord(stateDir, binding.runId, `${RUN_GRANTS_DIR}/${binding.requestId}.answer.json`, record);
}

/**
 * Take the answer waiting for one of this process's asks. The answer file is first renamed to a name private to this
 * process, so an answer written while it is read lands as a new file for the next poll instead of being removed unread.
 * The decision and who gave it come back only when the answer echoes the record's binding exactly; a mismatched answer
 * is removed and ignored, so it cannot apply later.
 */
export function takeGrantAnswer(
	stateDir: string,
	record: GrantRecordBinding,
): { decision: "approve" | "deny"; answeredBy: RecordedOwner } | null {
	const path = grantPath(stateDir, record.runId, record.requestId, true);
	const taken = `${path.slice(0, -".json".length)}.${process.pid}.take`;
	try {
		renameSync(path, taken);
	} catch {
		return null;
	}
	const value = readObject(taken);
	try {
		rmSync(taken, { force: true });
	} catch {
		// A private leftover is never read again: the next answer arrives under the public name.
	}
	if (value === null || value.v !== RECORD_VERSION) return null;
	const binding = bindingOf(value);
	const answeredBy = recordedOwner(value.answeredBy);
	if (binding === null || answeredBy === null) return null;
	const matches =
		binding.requestId === record.requestId &&
		binding.runId === record.runId &&
		binding.attempt === record.attempt &&
		binding.argDigest === record.argDigest &&
		binding.nonce === record.nonce;
	if (!matches) return null;
	return value.decision === "approve" || value.decision === "deny" ? { decision: value.decision, answeredBy } : null;
}

/** Remove an answer left for an ask that settled another way, such as the owner's own card answering first. */
export function removeGrantAnswer(stateDir: string, record: GrantRecordBinding): void {
	try {
		rmSync(grantPath(stateDir, record.runId, record.requestId, true), { force: true });
	} catch {
		// Nothing applies it: the record it answers is no longer pending.
	}
}

function lastRefusalOf(value: unknown): { lastRefusal: { at: string; reason: string } } | null {
	if (typeof value !== "object" || value === null) return null;
	const { at, reason } = value as Record<string, unknown>;
	return typeof at === "string" && typeof reason === "string" ? { lastRefusal: { at, reason } } : null;
}
