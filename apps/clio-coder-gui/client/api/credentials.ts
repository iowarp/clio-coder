import type { ClientCredential, EventTicket } from "../../contracts/auth.js";
import type { Problem } from "../../contracts/common.js";
import { routes } from "../../contracts/runtime-routes.js";
import { markTokenRejected, tokenRejected } from "./auth-state.js";
import { dropStoredToken, type LaunchSecret, rememberedCredentialKey } from "./token.js";

/** Where a window keeps its client id across a reload, and its live credential only across the reload itself. */
export const clientIdKey = "clio-coder-client";
const handoffKey = "clio-coder-client-handoff";

export class CredentialProblem extends Error {
	constructor(readonly problem: Problem) {
		super(problem.detail);
	}
}
const problem = (status: number, code: Problem["code"], title: string, detail: string): Problem => ({
	type: `urn:clio-coder:problem:${code}`,
	title,
	status,
	code,
	detail,
	instance: "browser",
});
export const unauthorizedProblem = () =>
	problem(401, "unauthorized", "unauthorized", "A fresh launch link is required.");
const unavailableProblem = () =>
	problem(503, "unavailable", "Server unavailable", "Cannot reach CLIO Coder. Check that the server is running.");

interface Held {
	clientId: string;
	credential: string;
	/** Local monotonic times; the server states durations, so the two clocks never meet. */
	rotateAt: number;
	expiresAt: number;
}

export interface Credentials {
	/** Whether this window holds anything that can open a client: a launch ticket, a credential or a remembered one. */
	available(): boolean;
	/** This window's credential, opening a client or rotating first when needed. */
	bearer(): Promise<string>;
	/** The server refused `credential`: forget it so the next bearer() opens a client again. */
	refused(credential: string): void;
	/** A single-use ticket that opens one event stream for this client. */
	ticket(): Promise<string>;
	clientId(): string | null;
	/**
	 * Sign this window out: the server stops honouring its credential now, and this holder keeps nothing,
	 * so neither a rotation nor the next page brings it back.
	 */
	revoke(): Promise<void>;
	dispose(): void;
}

function read(storage: () => Storage, key: string) {
	try {
		return storage().getItem(key);
	} catch {
		return null;
	}
}
function write(storage: () => Storage, key: string, value: string | null) {
	try {
		if (value === null) storage().removeItem(key);
		else storage().setItem(key, value);
	} catch {
		/* Without storage a reload needs a fresh launch link. */
	}
}
const session = () => sessionStorage;
const local = () => localStorage;
/** Another window's (or this browser's last) credential while it lives; it opens this window's own client. */
function remembered() {
	try {
		const value = JSON.parse(read(local, rememberedCredentialKey) ?? "null") as {
			credential?: unknown;
			expiresAt?: unknown;
		};
		return typeof value?.credential === "string" &&
			typeof value.expiresAt === "number" &&
			value.expiresAt - Date.now() > 5_000
			? value.credential
			: null;
	} catch {
		return null;
	}
}

/**
 * One per document, shared by every client in it. A launch ticket goes to POST /api/auth/clients and
 * nowhere else; the credential it buys lives in memory, rotates at half-life and is handed to the next
 * page only across a reload, so a duplicated tab never inherits it and gets its own client id. The
 * latest credential is also remembered in this browser, so a window reopened while it lives opens its
 * own client with it.
 */
export function createCredentials(
	launch: LaunchSecret = {},
	fetcher: typeof fetch = fetch,
	label = "Browser window",
): Credentials {
	let ticket = launch.ticket;
	let held: Held | null = null;
	let pending: Promise<Held> | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let disposed = false;
	let revoked = false;
	const now = () => performance.now();

	const handoff = read(session, handoffKey);
	write(session, handoffKey, null);
	if (handoff) {
		try {
			const value = JSON.parse(handoff) as {
				clientId: string;
				credential: string;
				expiresAt: number;
			};
			const left = value.expiresAt - Date.now();
			// A document opened from a fresh launch link exchanges that link, so a link that fails says so at once.
			if (left > 30_000 && !ticket)
				held = {
					clientId: value.clientId,
					credential: value.credential,
					rotateAt: now() + Math.min(left - 30_000, left / 2),
					expiresAt: now() + left,
				};
		} catch {
			// A damaged handoff only costs one exchange.
		}
	}
	const onPageHide = () => {
		if (held && held.expiresAt > now())
			write(
				session,
				handoffKey,
				JSON.stringify({
					clientId: held.clientId,
					credential: held.credential,
					expiresAt: Date.now() + (held.expiresAt - now()),
				}),
			);
	};
	// A page restored from the back-forward cache still holds its credential in memory.
	const onPageShow = () => write(session, handoffKey, null);
	if (typeof addEventListener === "function") {
		addEventListener("pagehide", onPageHide);
		addEventListener("pageshow", onPageShow);
	}

	const post = async (path: string, bearer: string | null, body: unknown) => {
		try {
			return await fetcher(path, {
				method: "POST",
				headers: {
					...(bearer === null ? {} : { Authorization: `Bearer ${bearer}` }),
					"Content-Type": "application/json",
					"Idempotency-Key": crypto.randomUUID(),
				},
				body: JSON.stringify(body),
			});
		} catch {
			throw new CredentialProblem(unavailableProblem());
		}
	};
	const adopt = (value: ClientCredential): Held => {
		// An exchange that was in flight when the window signed out is signed out with it.
		if (revoked) {
			void post(routes.authRevoke.path, value.credential, {}).catch(() => {});
			throw new CredentialProblem(unauthorizedProblem());
		}
		write(session, clientIdKey, value.clientId);
		write(
			local,
			rememberedCredentialKey,
			JSON.stringify({ credential: value.credential, expiresAt: Date.now() + value.expiresIn * 1000 }),
		);
		held = {
			clientId: value.clientId,
			credential: value.credential,
			rotateAt: now() + value.rotateIn * 1000,
			expiresAt: now() + value.expiresIn * 1000,
		};
		schedule();
		return held;
	};
	// Background tabs throttle timers to about a minute, well inside the half-life.
	const schedule = () => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
		if (disposed || !held) return;
		timer = setTimeout(
			() => {
				timer = null;
				void refresh().catch(() => {});
			},
			Math.max(1_000, held.rotateAt - now()),
		);
	};
	const open = async (): Promise<Held> => {
		// The ticket is single use, so it is spent on the first exchange whatever the answer.
		const spend = ticket;
		ticket = undefined;
		const bearer = spend ? null : remembered();
		if ((!spend && !bearer) || tokenRejected()) throw new CredentialProblem(unauthorizedProblem());
		const resume = held?.clientId ?? read(session, clientIdKey) ?? undefined;
		const response = await post(routes.authClients.path, bearer, {
			label,
			...(resume && /^[A-Za-z0-9_-]{8,64}$/.test(resume) ? { resume } : {}),
			...(spend ? { ticket: spend } : {}),
		});
		if (response.status === 401) {
			// Only what opens a client was refused here, so a reload would fail the same way.
			dropStoredToken();
			markTokenRejected();
			throw new CredentialProblem(unauthorizedProblem());
		}
		if (!response.ok) throw new CredentialProblem((await response.json().catch(unavailableProblem)) as Problem);
		return adopt((await response.json()) as ClientCredential);
	};
	const rotate = async (current: Held): Promise<Held> => {
		const response = await post(routes.authRotate.path, current.credential, {});
		if (response.ok) return adopt((await response.json()) as ClientCredential);
		if (response.status === 401) return open();
		throw new CredentialProblem((await response.json().catch(unavailableProblem)) as Problem);
	};
	const refresh = () => {
		pending ??= (held && held.expiresAt - now() > 5_000 ? rotate(held) : open()).finally(() => {
			pending = null;
		});
		return pending;
	};

	return {
		available: () => !tokenRejected() && !revoked && !!(ticket || held || remembered()),
		async bearer() {
			if (tokenRejected() || revoked) throw new CredentialProblem(unauthorizedProblem());
			if (pending) return (await pending).credential;
			if (held && now() < held.rotateAt) return held.credential;
			try {
				return (await refresh()).credential;
			} catch (error) {
				// A rotation that could not reach the server leaves a credential that still works.
				if (held && now() < held.expiresAt && !tokenRejected()) return held.credential;
				throw error;
			}
		},
		refused(credential) {
			if (held?.credential !== credential) return;
			// Keep the id: the exchange asks to resume it, which a restarted server grants.
			held = { ...held, rotateAt: 0, expiresAt: 0 };
		},
		async ticket() {
			for (let attempt = 0; ; attempt += 1) {
				const credential = await this.bearer();
				const response = await post(routes.eventTicket.path, credential, {});
				if (response.ok) return ((await response.json()) as EventTicket).ticket;
				if (response.status === 401 && attempt === 0) {
					this.refused(credential);
					continue;
				}
				throw new CredentialProblem((await response.json().catch(unavailableProblem)) as Problem);
			}
		},
		clientId: () => held?.clientId ?? null,
		async revoke() {
			revoked = true;
			const current = held;
			held = null;
			if (timer !== null) clearTimeout(timer);
			timer = null;
			write(session, clientIdKey, null);
			write(session, handoffKey, null);
			if (current && remembered() === current.credential) write(local, rememberedCredentialKey, null);
			if (!current || current.expiresAt <= now()) return;
			const response = await post(routes.authRevoke.path, current.credential, {});
			// A 401 means the server already holds no such credential, which is the outcome asked for.
			if (!response.ok && response.status !== 401)
				throw new CredentialProblem((await response.json().catch(unavailableProblem)) as Problem);
		},
		dispose() {
			disposed = true;
			if (timer !== null) clearTimeout(timer);
			if (typeof removeEventListener === "function") {
				removeEventListener("pagehide", onPageHide);
				removeEventListener("pageshow", onPageShow);
			}
		},
	};
}
