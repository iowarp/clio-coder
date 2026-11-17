import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { isSessionJsonlHeader, sessionCurrentPath } from "../../engine/session.js";

/**
 * The per-session store behind a compact tool result (WTF-P 0.8.3 C3). A tool whose output is large returns a short
 * summary to the model and parks the full detail here; the model fetches it with `ledger(action="detail", ref=...)`.
 * Details live in the session's own store directory, so they outlive compaction and resume and go when the session
 * is removed. A ref is content-addressed, so storing the same detail twice yields the same ref.
 */

const DETAILS_DIRECTORY = "details";
const REF = /^xd_[0-9a-f]{16}$/u;
/** A forked session replays its parent's history, so a ref a parent stored resolves through the fork chain. */
const MAX_FORK_DEPTH = 8;

export function isToolDetailRef(value: unknown): value is string {
	return typeof value === "string" && REF.test(value);
}

function detailsDirectory(sessionId: string): string {
	return join(dirname(sessionCurrentPath(sessionId)), DETAILS_DIRECTORY);
}

/** Store a detail for the session and return its ref. Throws when the session has no store directory. */
export function storeToolDetail(sessionId: string, detail: string): string {
	const ref = `xd_${createHash("sha256").update(detail).digest("hex").slice(0, 16)}`;
	const directory = detailsDirectory(sessionId);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	safeResourceWrite(join(directory, `${ref}.txt`), detail, { mode: 0o600 });
	return ref;
}

/** The session ledger's header names the parent of a fork; only the first line is read. */
function parentSession(sessionId: string): string | null {
	let fd: number | null = null;
	try {
		fd = openSync(sessionCurrentPath(sessionId), "r");
		const buffer = Buffer.alloc(4096);
		const read = readSync(fd, buffer, 0, buffer.length, 0);
		const first = buffer.subarray(0, read).toString("utf8").split("\n")[0] ?? "";
		const header: unknown = JSON.parse(first);
		return isSessionJsonlHeader(header) && header.parentSession !== undefined ? header.parentSession : null;
	} catch {
		// No readable ledger header: the session has no parent to fall back to.
		return null;
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

/** The stored detail for `ref`, looked up in the session and then its fork ancestors; null when none holds it. */
export function readToolDetail(sessionId: string, ref: string): string | null {
	if (!isToolDetailRef(ref)) return null;
	let current: string | null = sessionId;
	for (let depth = 0; current !== null && depth <= MAX_FORK_DEPTH; depth += 1) {
		try {
			return readFileSync(join(detailsDirectory(current), `${ref}.txt`), "utf8");
		} catch {
			// Not stored in this session; a fork's parent may hold it.
			current = parentSession(current);
		}
	}
	return null;
}

/** Whether the session, or a fork ancestor its refs resolve through, has stored any detail. */
export function sessionHoldsToolDetails(sessionId: string): boolean {
	let current: string | null = sessionId;
	for (let depth = 0; current !== null && depth <= MAX_FORK_DEPTH; depth += 1) {
		try {
			if (readdirSync(detailsDirectory(current)).some((name) => isToolDetailRef(name.replace(/\.txt$/u, "")))) return true;
		} catch {
			// No store directory in this session; a fork's parent may have one.
		}
		current = parentSession(current);
	}
	return false;
}
