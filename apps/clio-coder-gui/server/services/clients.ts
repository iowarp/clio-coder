import { createHash, randomBytes } from "node:crypto";
import type { ClientCredential, ClientIdentity } from "../../contracts/auth.js";

/**
 * Credentials live only in this process, so a restart or a stop revokes every one of them. A window
 * rotates its credential at half-life; one that slept past expiry exchanges the launch token again and
 * asks to resume its old id, which it gets back because no live credential holds it.
 */
export const CREDENTIAL_TTL_MS = 15 * 60_000;
export const ROTATE_AFTER_MS = CREDENTIAL_TTL_MS / 2;
/** A request already in flight with the old credential when the window rotated still lands. */
export const ROTATION_GRACE_MS = 60_000;
export const TICKET_TTL_MS = 30_000;
/** A client with no open event stream still counts as present this long after its last request. */
export const PRESENCE_MS = 30_000;
const MAX_CLIENTS = 256;
const MAX_TICKETS = 1024;

export interface ClientRecord extends ClientIdentity {
	lastSeen: number;
	streams: number;
	credential: { hash: string; expiresAt: number };
	previous: { hash: string; expiresAt: number } | null;
}

const secret = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export class ClientRegistry {
	private readonly clients = new Map<string, ClientRecord>();
	private readonly byCredential = new Map<string, string>();
	private readonly tickets = new Map<string, { clientId: string; expiresAt: number }>();
	constructor(private readonly now: () => number = Date.now) {}

	/** Issue a credential to a client that presented the launch token. */
	open(label: string | undefined, resume?: string): ClientCredential {
		const now = this.now();
		const held = resume === undefined ? undefined : this.clients.get(resume);
		// A live credential still holds the id: a duplicated tab or a second process gets its own.
		const resumable = resume !== undefined && (!held || this.expired(held, now));
		if (held && resumable) {
			// The same record, so an event stream it still holds keeps counting as its presence.
			this.byCredential.delete(held.credential.hash);
			if (held.previous) this.byCredential.delete(held.previous.hash);
			held.previous = null;
			held.lastSeen = now;
			// The same window, so it keeps the name other windows already know it by.
			return this.issue(held, now);
		}
		this.prune(now);
		const record: ClientRecord = {
			clientId: resumable ? resume : randomBytes(9).toString("base64url"),
			label: this.distinct(label?.trim() || "Client", now),
			lastSeen: now,
			streams: 0,
			credential: { hash: "", expiresAt: 0 },
			previous: null,
		};
		this.clients.set(record.clientId, record);
		return this.issue(record, now);
	}

	/** The client a bearer credential belongs to, or null when no live credential matches it. */
	authenticate(credential: string): ClientRecord | null {
		const now = this.now();
		const hash = digest(credential);
		const id = this.byCredential.get(hash);
		const record = id === undefined ? undefined : this.clients.get(id);
		if (!record) return null;
		const valid =
			(record.credential.hash === hash && record.credential.expiresAt > now) ||
			(record.previous?.hash === hash && record.previous.expiresAt > now);
		if (!valid) return null;
		record.lastSeen = now;
		return record;
	}

	rotate(record: ClientRecord): ClientCredential {
		const now = this.now();
		if (record.previous) this.byCredential.delete(record.previous.hash);
		record.previous = {
			hash: record.credential.hash,
			expiresAt: Math.min(record.credential.expiresAt, now + ROTATION_GRACE_MS),
		};
		return this.issue(record, now);
	}

	ticket(record: ClientRecord) {
		const now = this.now();
		for (const [hash, entry] of this.tickets) if (entry.expiresAt <= now) this.tickets.delete(hash);
		// Oldest first: a client that floods tickets loses its own unused ones, not the bound.
		while (this.tickets.size >= MAX_TICKETS) this.tickets.delete(this.tickets.keys().next().value as string);
		const ticket = secret();
		this.tickets.set(digest(ticket), { clientId: record.clientId, expiresAt: now + TICKET_TTL_MS });
		return { ticket, expiresIn: TICKET_TTL_MS / 1000 };
	}

	/** Single use: a ticket read from a log or a history entry opens nothing. */
	redeem(ticket: string): ClientRecord | null {
		const hash = digest(ticket);
		const entry = this.tickets.get(hash);
		this.tickets.delete(hash);
		const now = this.now();
		if (!entry || entry.expiresAt <= now) return null;
		const record = this.clients.get(entry.clientId);
		if (!record) return null;
		record.lastSeen = now;
		return record;
	}

	/** Count an open event stream as presence; the returned function ends it. */
	stream(record: ClientRecord) {
		record.streams += 1;
		let open = true;
		return () => {
			if (!open) return;
			open = false;
			record.streams -= 1;
			record.lastSeen = this.now();
		};
	}

	identity(id: string): ClientIdentity | null {
		const record = this.clients.get(id);
		return record ? { clientId: record.clientId, label: record.label } : null;
	}

	/** Present: an event stream is open, or a request arrived within the presence window. */
	present(id: string) {
		const record = this.clients.get(id);
		return !!record && (record.streams > 0 || this.now() - record.lastSeen < PRESENCE_MS);
	}

	get size() {
		return this.clients.size;
	}

	private issue(record: ClientRecord, now: number): ClientCredential {
		const credential = secret();
		const hash = digest(credential);
		record.credential = { hash, expiresAt: now + CREDENTIAL_TTL_MS };
		this.byCredential.set(hash, record.clientId);
		return {
			clientId: record.clientId,
			label: record.label,
			credential,
			expiresAt: new Date(record.credential.expiresAt).toISOString(),
			expiresIn: CREDENTIAL_TTL_MS / 1000,
			rotateIn: ROTATE_AFTER_MS / 1000,
		};
	}

	/** Two windows of one browser both call themselves "Browser window"; a take-over must say which. */
	private distinct(label: string, now: number) {
		const taken = new Set<string>();
		for (const record of this.clients.values()) if (!this.expired(record, now)) taken.add(record.label);
		if (!taken.has(label)) return label;
		const base = label.slice(0, 74);
		for (let n = 2; ; n += 1) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
	}

	private expired(record: ClientRecord, now: number) {
		return record.credential.expiresAt <= now && (record.previous?.expiresAt ?? 0) <= now;
	}

	private drop(record: ClientRecord) {
		this.byCredential.delete(record.credential.hash);
		if (record.previous) this.byCredential.delete(record.previous.hash);
		this.clients.delete(record.clientId);
	}

	/** Forget expired clients without a stream, then the least recently seen idle ones past the bound. */
	private prune(now: number) {
		for (const record of this.clients.values()) if (record.streams === 0 && this.expired(record, now)) this.drop(record);
		if (this.clients.size < MAX_CLIENTS) return;
		const idle = [...this.clients.values()].filter((record) => record.streams === 0);
		idle.sort((a, b) => a.lastSeen - b.lastSeen);
		for (const record of idle.slice(0, this.clients.size - MAX_CLIENTS + 1)) this.drop(record);
	}
}
