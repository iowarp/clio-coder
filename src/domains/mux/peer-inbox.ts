/**
 * The channel one Clio uses to hand a prompt to another Clio it opened.
 *
 * It exists because typing into a peer's terminal cannot be made safe. Text and
 * Enter written to a PTY are consumed by whatever has the keyboard when they
 * arrive, and that may be an approval dialog that opened a moment earlier; no
 * check made before the write can rule that out. So a prompt for a Clio peer
 * never touches its terminal. It is written as a file into an inbox only that
 * peer reads, and the peer puts it on its own turn queue, which the key handler
 * and every dialog are deaf to. The worst a badly timed prompt can do is wait.
 *
 * Layout, under the state directory both Clios share:
 *
 *   peer-inbox/<id>/owner.json        who is listening, written by the receiver
 *   peer-inbox/<id>/requests/<rid>    one prompt, written whole by the sender
 *   peer-inbox/<id>/claimed/<rid>     the same file once the receiver took it
 *   peer-inbox/<id>/receipts/<rid>    what the receiver did with it
 *
 * `<id>` is 128 random bits chosen per listening session and advertised in the
 * pane host's metadata for the receiver's own pane. A sender reads that token
 * only from the host's record of a pane it opened itself, accepts nothing but
 * 32 hex digits, and joins it under its own state directory, so a token can
 * neither name an arbitrary path nor be guessed by another process. One file
 * per request, renamed into place, means a reader never sees half a record
 * and two writers never interleave.
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	rmSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { processAlive, processBirthToken } from "../../core/process-identity.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";

/** The metadata token a listening Clio publishes on its own pane. */
export const PEER_INBOX_TOKEN = "clio_coder_inbox";
/** A prompt's size limit, the same one a handoff brief has. */
export const PEER_PROMPT_MAX_BYTES = 8_192;
/** A request file larger than this is not read at all. */
const REQUEST_FILE_MAX_BYTES = 4 * PEER_PROMPT_MAX_BYTES;
const INBOX_ID = /^[0-9a-f]{32}$/u;
const REQUEST_ID = /^[0-9a-f-]{36}$/u;
const RECEIPT_POLL_MS = 100;

export interface PeerInboxOwner {
	version: 1;
	paneId: string;
	/** The pane host socket the receiver is bound to; a sender on another server is not its peer. */
	socketPath: string;
	pid: number;
	/** Distinguishes this process from a later one that reused the pid. */
	birthToken: string | null;
}

export interface PeerPromptRequest {
	version: 1;
	id: string;
	text: string;
	/** Who sent it, for the receiver's transcript; display only. */
	fromPaneId: string;
	createdAt: string;
}

/** Why a receiver did not take a prompt. Each is a refusal the sender must report, never retry around. */
export type PeerRefusal =
	| "blocked"
	| "unknown-state"
	| "busy"
	| "stale-session"
	| "invalid"
	| "shutting-down"
	/** The receiver's own admission declined the turn; nothing was added to the conversation. */
	| "not-admitted";

export type PeerReceipt =
	| { version: 1; id: string; status: "accepted"; via: "turn" | "queue"; sessionId: string | null }
	| { version: 1; id: string; status: "refused"; reason: PeerRefusal; detail: string };

function newPeerInboxId(): string {
	return randomBytes(16).toString("hex");
}

/** The inbox directory for an advertised id, or null when the token is not one Clio wrote. */
function peerInboxDir(stateDir: string, token: string | undefined): string | null {
	if (typeof token !== "string" || !INBOX_ID.test(token)) return null;
	return join(stateDir, "peer-inbox", token);
}

/**
 * Parse one small JSON file, or null. Every way this can go wrong is an
 * answer of null, never a throw: it runs inside a filesystem watcher, where
 * an escaped error would take the whole session down. The file is opened
 * without following a link and the bound is applied to what is actually read
 * from the open descriptor, so a symlink, a FIFO, a directory or a file that
 * grew after it was inspected can neither stall the read nor feed it more than
 * `maxBytes`.
 */
function readJson(path: string, maxBytes: number): unknown {
	let fd: number | null = null;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > maxBytes) return null;
		const buffer = Buffer.alloc(maxBytes + 1);
		let length = 0;
		for (;;) {
			const read = readSync(fd, buffer, length, buffer.length - length, null);
			if (read === 0) break;
			length += read;
			if (length > maxBytes) return null;
		}
		return JSON.parse(buffer.subarray(0, length).toString("utf8"));
	} catch {
		// Absent, a link, unreadable, oversized or not JSON: not a record.
		return null;
	} finally {
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {
				// Nothing to do about a descriptor that will not close.
			}
		}
	}
}

function readPeerInboxOwner(dir: string): PeerInboxOwner | null {
	const value = readJson(join(dir, "owner.json"), 4_096);
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (
		record.version !== 1 ||
		typeof record.paneId !== "string" ||
		typeof record.socketPath !== "string" ||
		typeof record.pid !== "number" ||
		!Number.isSafeInteger(record.pid) ||
		record.pid <= 0 ||
		!(record.birthToken === null || (typeof record.birthToken === "string" && record.birthToken.length > 0))
	) {
		return null;
	}
	return {
		version: 1,
		paneId: record.paneId,
		socketPath: record.socketPath,
		pid: record.pid,
		birthToken: typeof record.birthToken === "string" ? record.birthToken : null,
	};
}

/** An unreadable birth token cannot prove that a live owner is dead. */
function peerInboxOwnerState(owner: PeerInboxOwner): "alive" | "dead" | "unknown" {
	if (!processAlive(owner.pid)) return "dead";
	const birthToken = processBirthToken(owner.pid);
	if (birthToken === null || owner.birthToken === null) return "unknown";
	return birthToken === owner.birthToken ? "alive" : "dead";
}

/** A request file's content, or null when it is not a well-formed bounded prompt. */
export function parsePeerPromptRequest(path: string): PeerPromptRequest | null {
	const value = readJson(path, REQUEST_FILE_MAX_BYTES);
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || typeof record.id !== "string" || !REQUEST_ID.test(record.id)) return null;
	if (typeof record.text !== "string" || !validPeerPromptText(record.text)) return null;
	return {
		version: 1,
		id: record.id,
		text: record.text,
		fromPaneId: typeof record.fromPaneId === "string" ? record.fromPaneId.slice(0, 64) : "",
		createdAt: typeof record.createdAt === "string" ? record.createdAt.slice(0, 40) : "",
	};
}

/** Non-empty, bounded, and free of control characters other than newline and tab. */
function validPeerPromptText(text: string): boolean {
	if (text.trim().length === 0 || Buffer.byteLength(text, "utf8") > PEER_PROMPT_MAX_BYTES) return false;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if ((code < 0x20 && code !== 0x0a && code !== 0x09) || code === 0x7f) return false;
	}
	return true;
}

export function writePeerReceipt(dir: string, receipt: PeerReceipt): void {
	if (!REQUEST_ID.test(receipt.id)) throw new Error("invalid peer request id");
	safeResourceWrite(join(dir, "receipts", receipt.id), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
}

function readPeerReceipt(dir: string, id: string): PeerReceipt | null {
	const value = readJson(join(dir, "receipts", id), 4_096);
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || record.id !== id) return null;
	if (
		record.status === "accepted" &&
		(record.via === "queue" || record.via === "turn") &&
		(record.sessionId === null || typeof record.sessionId === "string")
	) {
		return {
			version: 1,
			id,
			status: "accepted",
			via: record.via === "queue" ? "queue" : "turn",
			sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
		};
	}
	if (
		record.status === "refused" &&
		["blocked", "unknown-state", "busy", "stale-session", "invalid", "shutting-down", "not-admitted"].includes(
			record.reason as string,
		) &&
		typeof record.detail === "string"
	) {
		return {
			version: 1,
			id,
			status: "refused",
			reason: record.reason as PeerRefusal,
			detail: typeof record.detail === "string" ? record.detail : "",
		};
	}
	return null;
}

export type PeerDelivery =
	/** The peer confirmed the prompt is on its turn path. */
	| { status: "accepted"; via: "turn" | "queue"; requestId: string }
	/** The peer answered no. */
	| { status: "refused"; reason: PeerRefusal; detail: string; requestId: string }
	/** Nothing was delivered: there is no live inbox to write to, or the request was taken back unread. */
	| { status: "not-delivered"; reason: string; requestId: string | null }
	/**
	 * The peer took the request and has not confirmed. It may be on its turn
	 * path already, so this is never reported as a failure to deliver. Sending
	 * again with the same `requestId` cannot deliver it twice.
	 */
	| { status: "unconfirmed"; reason: string; requestId: string };

export interface PeerDeliveryRequest {
	stateDir: string;
	/** The token the pane host recorded for the target pane. */
	token: string | undefined;
	/** The target pane, which the caller has already established it opened. */
	paneId: string;
	/** The pane host socket the sender is bound to. */
	socketPath: string;
	fromPaneId: string;
	text: string;
	/** Reuse the id of an earlier unconfirmed attempt, so the receiver sees one request. */
	requestId?: string;
	timeoutMs: number;
	signal?: AbortSignal;
}

/**
 * Hand one prompt to a peer and wait for its answer.
 *
 * The request is withdrawn when the wait ends without one. Taking the file
 * back is the test of whether the peer has it: if the unlink succeeds the peer
 * never saw the prompt and "not delivered" is a fact; if the file is already
 * gone the peer claimed it, and the only honest answer is "unconfirmed".
 */
export async function deliverPeerPrompt(request: PeerDeliveryRequest): Promise<PeerDelivery> {
	if (request.requestId !== undefined && !REQUEST_ID.test(request.requestId)) {
		return { status: "not-delivered", reason: "invalid peer request id", requestId: null };
	}
	// A retry carries history that may have disappeared with the inbox. Failure
	// to publish this copy cannot prove that the earlier copy was not admitted.
	const unavailable = (reason: string): PeerDelivery =>
		request.requestId !== undefined
			? { status: "unconfirmed", reason, requestId: request.requestId }
			: { status: "not-delivered", reason, requestId: null };
	if (!Number.isFinite(request.timeoutMs) || request.timeoutMs < 0) {
		return unavailable("invalid peer delivery timeout");
	}
	const deadline = performance.now() + request.timeoutMs;
	const dir = peerInboxDir(request.stateDir, request.token);
	if (dir === null) {
		return unavailable("the peer advertises no prompt inbox");
	}
	const owner = readPeerInboxOwner(dir);
	if (owner === null) {
		return unavailable("the peer's inbox is gone; it has quit or restarted");
	}
	// The token came from the host's record of this pane, but a record outlives
	// the process that wrote it. These three checks are what bind the inbox to
	// the pane, the server and the process the sender means.
	if (owner.paneId !== request.paneId || owner.socketPath !== request.socketPath) {
		return unavailable("the advertised inbox belongs to a different pane");
	}
	const id = request.requestId ?? randomUUID();
	const earlier = readPeerReceipt(dir, id);
	if (earlier !== null) return fromReceipt(earlier);
	if (peerInboxOwnerState(owner) !== "alive") {
		return unavailable("the peer that advertised this inbox is no longer running or its identity cannot be verified");
	}
	if (!validPeerPromptText(request.text)) {
		return unavailable("the prompt is empty, too long, or contains control characters");
	}
	if (request.signal?.aborted || performance.now() >= deadline) {
		return unavailable(request.signal?.aborted ? "the send was cancelled" : "the peer delivery deadline elapsed");
	}
	const requestPath = join(dir, "requests", id);
	const body: PeerPromptRequest = {
		version: 1,
		id,
		text: request.text,
		fromPaneId: request.fromPaneId,
		createdAt: new Date().toISOString(),
	};
	try {
		// Atomic: the receiver sees the whole request or none of it.
		safeResourceWrite(requestPath, `${JSON.stringify(body)}\n`, { mode: 0o600 });
	} catch (error) {
		if (request.requestId !== undefined) {
			const late = readPeerReceipt(dir, id);
			if (late !== null) return fromReceipt(late);
			return unavailable(`could not retry the peer request: ${error instanceof Error ? error.message : String(error)}`);
		}
		return {
			status: "not-delivered",
			reason: `could not write to the peer's inbox: ${error instanceof Error ? error.message : String(error)}`,
			requestId: id,
		};
	}

	for (;;) {
		const receipt = readPeerReceipt(dir, id);
		if (receipt !== null) return fromReceipt(receipt);
		const left = deadline - performance.now();
		if (left <= 0 || request.signal?.aborted) break;
		try {
			await sleep(Math.min(RECEIPT_POLL_MS, left), undefined, request.signal ? { signal: request.signal } : {});
		} catch {
			// Only the abort rejects this sleep; the withdrawal below decides what to report.
			break;
		}
	}

	const why = request.signal?.aborted ? "the send was cancelled" : "the peer did not answer in time";
	try {
		unlinkSync(requestPath);
		// Taken back. That proves the peer never saw this copy, unless the id was
		// already claimed by an earlier attempt, in which case the earlier one may
		// be on its queue and "not delivered" would be false.
		const late = readPeerReceipt(dir, id);
		if (late !== null) return fromReceipt(late);
		if (request.requestId === undefined && !peerRequestClaimExists(dir, id)) {
			return { status: "not-delivered", reason: `${why}, and the request was taken back unread`, requestId: id };
		}
		return { status: "unconfirmed", reason: `${why}, and an earlier claim cannot be ruled out`, requestId: id };
	} catch {
		// Already gone: the receiver claimed it between the last poll and now.
		const late = readPeerReceipt(dir, id);
		if (late !== null) return fromReceipt(late);
		return { status: "unconfirmed", reason: `${why}, but it had already taken the request`, requestId: id };
	}
}

/** Any claim entry is a tombstone, including a symlink whose target disappeared. */
function peerRequestClaimExists(dir: string, id: string): boolean {
	try {
		lstatSync(join(dir, "claimed", id));
		return true;
	} catch (error) {
		// An unreadable claim is uncertain; only absence proves no claim exists.
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

function fromReceipt(receipt: PeerReceipt): PeerDelivery {
	return receipt.status === "accepted"
		? { status: "accepted", via: receipt.via, requestId: receipt.id }
		: { status: "refused", reason: receipt.reason, detail: receipt.detail, requestId: receipt.id };
}

/**
 * Create a new listening inbox. It is built under a staging name and renamed
 * into place, so the final directory never exists without its owner record
 * and a sweep by another Clio cannot mistake a half-built inbox for a dead one.
 */
export function openPeerInbox(
	stateDir: string,
	owner: Omit<PeerInboxOwner, "version" | "birthToken">,
): { id: string; dir: string } {
	const id = newPeerInboxId();
	const root = join(stateDir, "peer-inbox");
	const staging = join(root, `.staging-${id}`);
	const dir = join(root, id);
	for (const part of ["requests", "claimed", "receipts"]) {
		mkdirSync(join(staging, part), { recursive: true, mode: 0o700 });
	}
	const record: PeerInboxOwner = { version: 1, ...owner, birthToken: processBirthToken(owner.pid) };
	safeResourceWrite(join(staging, "owner.json"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
	renameSync(staging, dir);
	return { id, dir };
}

/**
 * Take one request out of the sender's reach, at most once per id for the life
 * of the inbox.
 *
 * The claim is a hard link into `claimed/`, which fails when the name is
 * already there. That file is the durable record that the id was taken: it is
 * never overwritten and never expires, so a resend of an id from any point in
 * the session's past is recognized as a resend however many requests came in
 * between. `gone` means the sender withdrew the request first.
 */
export function claimPeerRequest(dir: string, id: string): "claimed" | "duplicate" | "gone" {
	if (!REQUEST_ID.test(id)) return "gone";
	const from = join(dir, "requests", id);
	let outcome: "claimed" | "duplicate" | "gone" = "claimed";
	try {
		linkSync(from, join(dir, "claimed", id));
	} catch (error) {
		outcome = (error as NodeJS.ErrnoException).code === "EEXIST" ? "duplicate" : "gone";
	}
	if (outcome !== "gone") {
		try {
			unlinkSync(from);
		} catch {
			// The sender withdrew it in the same instant; the claim above still stands.
		}
	}
	return outcome;
}

export function closePeerInbox(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

/**
 * Remove inboxes whose owner is provably no longer running. A Clio that
 * crashed cannot clean up after itself, and a sender already refuses a dead
 * owner, so this is housekeeping. A directory with no readable owner record is
 * left alone: it proves nothing about anybody being dead.
 */
export function sweepDeadPeerInboxes(stateDir: string, entries: ReadonlyArray<string>): void {
	for (const name of entries) {
		const dir = peerInboxDir(stateDir, name);
		if (dir === null) continue;
		const owner = readPeerInboxOwner(dir);
		if (owner !== null && peerInboxOwnerState(owner) === "dead") closePeerInbox(dir);
	}
}
