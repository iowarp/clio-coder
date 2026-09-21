/**
 * Binding `ContinuityPersistencePorts` to the real session writer.
 *
 * The 02A protocol is injected on purpose, and this is the only place it meets
 * Clio's actual append, flush and checkpoint. Four properties of the existing
 * seams shape it:
 *
 *   - `SessionContract` forwards every write to whichever session is *current*.
 *     A checkpoint is awaited, and a `/tree` switch or `/resume` during that
 *     await installs a different session. So the origin is captured once, at
 *     admission, and rechecked before every write and after every barrier. The
 *     ports never ask "which session is open", only "is the one I was bound to
 *     still open".
 *   - `sessionPaths()` mkdirs and `sessionCurrentPath()` resolves through
 *     `clioStateDir()`, which initializes the state root. Neither may be used
 *     from a readback: an inspection that rebuilds the directory it is
 *     inspecting is how an uninstalled state root came back. The readback
 *     composes its path from `clioStatePath()` and the captured metadata and
 *     never creates anything.
 *   - `readSessionFileEntries()` is not read-only either. It promotes a
 *     leftover `current.jsonl.tmp` over a missing target and fsyncs the
 *     directory. That recovery is right for opening a session and wrong for
 *     proving whether one record exists, so the readback here does its own
 *     plain read and reports the ambiguity instead of resolving it.
 *   - The existing summary lookup returns at its first `kind` + id match. That
 *     is precedent, not proof: it cannot see a later conflicting copy and it
 *     compares no payload. The readback below scans the whole ledger, compares
 *     every copy by value, and treats one malformed line anywhere as enough to
 *     make the answer unresolved.
 *
 * Nothing here executes a recovery, and nothing widens `SessionContract`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { clioStatePath, stateRootRemoved } from "../../../core/xdg.js";
import { CURRENT_SESSION_FORMAT_VERSION } from "../../../engine/session.js";
import type { SessionContract, SessionEntryInput } from "../contract.js";
import { isSessionEntry, isSessionHeader } from "../entries.js";
import { OLDEST_READABLE_SESSION_FORMAT_VERSION } from "../migrations/index.js";
import type { ContinuityAppendable, ContinuityPersistencePorts, ContinuityReadback } from "./contract.js";
import { canonicalJson } from "./validate.js";

/**
 * The session a transaction was admitted in, captured before any write.
 *
 * `cwdHash` travels with the id because the ledger path needs both and reading
 * it back from the live meta would follow a navigation instead of pinning it.
 */
export interface ContinuityPortOrigin {
	sessionId: string;
	cwdHash: string;
	/**
	 * Extra liveness the caller pins beyond the session id: the selected message
	 * leaf, the initiating turn, a cancellation generation. Packet 03 supplies
	 * this from its runtime authority; when absent, only the session id is
	 * pinned, which is the minimum that keeps a write off another session.
	 */
	stillCurrent?: () => boolean;
}

export interface ContinuityPortsInput {
	session: SessionContract;
	origin: ContinuityPortOrigin;
}

/** The pinned ledger path, composed without creating anything. */
function pinnedLedgerPath(origin: ContinuityPortOrigin): string {
	return join(clioStatePath(), "sessions", origin.cwdHash, origin.sessionId, "current.jsonl");
}

/**
 * Prove what the ledger holds for exactly this record.
 *
 * Every outcome other than `matching` and `absent` is a refusal to conclude.
 * A missing ledger with a leftover temp beside it is the ambiguous case the
 * binding notes call out: the record may be in the temp, the temp may be stale,
 * and promoting it would be a write during an inspection. It answers
 * `unresolved` and leaves the files alone.
 */
export function readContinuityRecordExact(
	origin: ContinuityPortOrigin,
	expected: ContinuityAppendable,
): ContinuityReadback {
	const path = pinnedLedgerPath(origin);
	if (!existsSync(path)) {
		const temp = `${path}.tmp`;
		if (existsSync(temp)) {
			return { status: "unresolved", detail: "session ledger is missing and a temporary candidate exists beside it" };
		}
		return { status: "unresolved", detail: "session ledger does not exist" };
	}
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		return {
			status: "unresolved",
			detail: `session ledger could not be read: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const wanted = canonicalJson(expected);
	let found = 0;
	let conflicting: string | null = null;
	let headers = 0;
	for (const line of raw.split("\n")) {
		if (line.trim().length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch {
			// One unreadable line anywhere can be the record being looked for, so
			// nothing after it can prove absence. §6: malformed data never proves
			// absence, and a torn tail is not permission to write the id again.
			return { status: "unresolved", detail: "session ledger contains a line that could not be parsed" };
		}
		if (isSessionHeader(parsed)) {
			// The header is what makes this file the pinned session's ledger. A
			// file holding someone else's header is not evidence about this
			// session at all, and answering `absent` from it would license a
			// re-append into a session whose ledger was never actually read. A
			// version this build does not read is the same refusal: a future
			// format can hold records this scan cannot see.
			headers += 1;
			if (headers > 1) return { status: "unresolved", detail: "session ledger carries more than one session header" };
			if (parsed.id !== origin.sessionId) {
				return {
					status: "unresolved",
					detail: `session ledger carries session header ${parsed.id}, not ${origin.sessionId}`,
				};
			}
			if (parsed.version < OLDEST_READABLE_SESSION_FORMAT_VERSION || parsed.version > CURRENT_SESSION_FORMAT_VERSION) {
				return { status: "unresolved", detail: `session ledger header declares format version ${parsed.version}` };
			}
			continue;
		}
		// Parsing is a weaker test than being a record. A JSON scalar, an array, or
		// an object missing its envelope is data this reader cannot account for,
		// and skipping it would let exactly the kind of damage §6 is about turn
		// into a clean `absent`. The admitted shapes are the v3/v4/v5 session
		// header and the entry union; anything else stops the scan.
		if (!isSessionEntry(parsed)) {
			return { status: "unresolved", detail: "session ledger contains a structured record this build cannot validate" };
		}
		const record = parsed as unknown as Record<string, unknown>;
		if (record.turnId !== expected.turnId) continue;
		// The scan does not stop at the first hit: a second copy under one id with
		// different bytes is a conflict even when an earlier copy matched exactly.
		if (canonicalJson(record) === wanted) {
			found += 1;
			continue;
		}
		conflicting = `stored record ${String(expected.turnId)} has this id and different payload`;
	}
	if (conflicting !== null) return { status: "conflicting", detail: conflicting };
	// Ownership has to be positively established before an answer of `absent`
	// means anything. A ledger with no header at all is a legacy or truncated
	// file this binding cannot attribute to the pinned session, so it is
	// unresolved rather than proof that the record was never written. Nothing is
	// repaired: no header is added and no file is rewritten.
	if (headers === 0) {
		return { status: "unresolved", detail: "session ledger carries no session header to attribute it to this session" };
	}
	return found > 0 ? { status: "matching" } : { status: "absent" };
}

/**
 * Bind the protocol to this session's writer.
 *
 * `flushAppends` is forwarded only when the contract really has it. A
 * `SessionContract` without one is an unsupported persistence port, and the
 * group persister reports that rather than treating a barrier nobody ran as a
 * success. `checkpoint` keeps its own inner removed-state guards; the outer
 * checks here do not replace them.
 */
export function createContinuityPersistencePorts(input: ContinuityPortsInput): ContinuityPersistencePorts {
	const session = input.session;
	// Captured by value, not by reference. Holding the caller's object would let
	// a mutation made while a checkpoint is awaited retarget both the liveness
	// check and the readback path at once, which is precisely the confusion the
	// pinned origin exists to prevent: the ports would then agree that a
	// different session is "current" and read that session's ledger to confirm it.
	const origin: ContinuityPortOrigin = {
		sessionId: input.origin.sessionId,
		cwdHash: input.origin.cwdHash,
		...(input.origin.stillCurrent === undefined ? {} : { stillCurrent: input.origin.stillCurrent }),
	};
	const isOriginCurrent = (): boolean => {
		if (session.current()?.id !== origin.sessionId) return false;
		return origin.stillCurrent?.() ?? true;
	};
	const ports: ContinuityPersistencePorts = {
		append(entry: ContinuityAppendable): void {
			// Defence in depth. `persistContinuityGroup` checks origin immediately
			// before calling this, but the two are separately reviewable and a write
			// to the wrong session is unrecoverable, so the writer refuses too.
			if (!isOriginCurrent()) {
				throw new Error(`continuity append refused: session ${origin.sessionId} is no longer current`);
			}
			// Reserved identity, supplied explicitly. Letting the manager mint a
			// replacement turnId would break the one invariant recovery depends on:
			// that a missing commit is rebuilt under the id its prepare reserved.
			if (typeof entry.turnId !== "string" || entry.turnId.length === 0) {
				throw new Error("continuity append refused: the record carries no reserved turnId");
			}
			if (typeof entry.timestamp !== "string" || entry.timestamp.length === 0) {
				throw new Error("continuity append refused: the record carries no explicit timestamp");
			}
			session.appendEntry(entry as unknown as SessionEntryInput);
		},
		readExact: (expected) => readContinuityRecordExact(origin, expected),
		isStateRemoved: () => stateRootRemoved(),
		isOriginCurrent,
	};
	if (session.flushAppends) {
		ports.flushAppends = () => {
			if (!isOriginCurrent()) {
				throw new Error(`continuity flush refused: session ${origin.sessionId} is no longer current`);
			}
			session.flushAppends?.();
		};
	}
	ports.checkpoint = async (reason: string) => {
		if (!isOriginCurrent()) {
			throw new Error(`continuity checkpoint refused: session ${origin.sessionId} is no longer current`);
		}
		await session.checkpoint(reason);
	};
	return ports;
}
