import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { type TestContext, test } from "node:test";
import { Value } from "typebox/value";
import { tokenRejected } from "../client/api/auth-state.js";
import { createClient } from "../client/api/client.js";
import { createCredentials } from "../client/api/credentials.js";
import { adoptLaunchSecret, dropStoredToken, listenForLaunchLink, refusalReason } from "../client/api/token.js";
import { ClientCredential, LaunchChallenge } from "../contracts/auth.js";
import { Problem } from "../contracts/common.js";
import { routes } from "../contracts/routes.js";
import { launcherProof, serverProof } from "../server/launch-proof.js";
import {
	ClientRegistry,
	CREDENTIAL_TTL_MS,
	PRESENCE_MS,
	ROTATION_GRACE_MS,
	TICKET_TTL_MS,
} from "../server/services/clients.js";
import { harness } from "./harness/app.js";

const launch = { Authorization: "Bearer test-token" };

test("the launch token itself opens nothing; each window gets its own attributed credential", async (t) => {
	const h = await harness();
	t.after(h.close);
	// Sent as a bearer, the launch token is refused everywhere, the exchange included: launchers only prove it.
	const meta = await h.request("/api/meta", { headers: launch });
	assert.equal(meta.status, 401);
	const refusal = (await meta.json()) as Problem;
	assert.ok(Value.Check(Problem, refusal));
	assert.match(refusal.detail, /valid client credential/);
	assert.equal((await h.request("/api/events", { headers: launch })).status, 401);
	assert.equal((await h.request("/api/events?token=test-token", { headers: { Authorization: "" } })).status, 401);
	const a = await h.client("Window A");
	const b = await h.client("Window B");
	const { request: _request, post: _post, ...issued } = a;
	assert.ok(Value.Check(ClientCredential, issued));
	assert.notEqual(a.clientId, b.clientId);
	assert.notEqual(a.credential, b.credential);
	assert.equal(a.expiresIn, CREDENTIAL_TTL_MS / 1000);
	const answered = await a.request("/api/meta");
	assert.equal(answered.status, 200);
	assert.equal(answered.headers.get("X-Clio-Client"), a.clientId);
	assert.equal((await b.request("/api/meta")).headers.get("X-Clio-Client"), b.clientId);
	// The launch token as a bearer buys nothing at the exchange either.
	const wrong = await h.app.request("http://127.0.0.1:4317/api/auth/clients", {
		method: "POST",
		headers: { Authorization: "Bearer nope", "Content-Type": "application/json", "Idempotency-Key": "k" },
		body: "{}",
	});
	assert.equal(wrong.status, 401);
});

test("a launcher's proof opens one client, once, and only over a challenge this app issued", async (t) => {
	type App = Awaited<ReturnType<typeof harness>>;
	const post = (h: App, path: string, body: unknown) =>
		h.app.request(`http://127.0.0.1:4317${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
			body: JSON.stringify(body),
		});
	const challenge = async (h: App) => {
		const issued = await post(h, "/api/auth/challenge", {});
		assert.equal(issued.status, 200);
		const value = (await issued.json()) as LaunchChallenge;
		assert.ok(Value.Check(LaunchChallenge, value));
		return value.challenge;
	};
	const open = (h: App, proved: { challenge: string; proof: string }) =>
		post(h, "/api/auth/clients", { label: "Launcher", ...proved });
	const h = await harness();
	t.after(h.close);
	// A squatter on this port can only hand the launcher a challenge of its own; the proof it keeps opens nothing.
	const forged = randomBytes(32).toString("base64url");
	assert.equal((await open(h, { challenge: forged, proof: launcherProof("test-token", forged, 4317) })).status, 401);
	const issued = await challenge(h);
	const proved = { challenge: issued, proof: launcherProof("test-token", issued, 4317) };
	const opened = await open(h, proved);
	assert.equal(opened.status, 200);
	assert.equal(((await opened.json()) as ClientCredential).serverProof, serverProof("test-token", issued, 4317));
	// Replayed to the same app, or to the app started again on this port, the captured proof opens nothing.
	assert.equal((await open(h, proved)).status, 401);
	const restarted = await harness();
	t.after(restarted.close);
	assert.equal((await open(restarted, proved)).status, 401);
	// Challenges are signed, not stored: a flood of them pushes out none, and a wrong proof spends nothing (N5).
	const other = await challenge(h);
	for (let index = 0; index < 300; index += 1) await challenge(h);
	assert.equal((await open(h, { challenge: other, proof: launcherProof("test-token", other, 4318) })).status, 401);
	assert.equal((await open(h, { challenge: other, proof: launcherProof("test-token", other, 4317) })).status, 200);
	let clock = 0;
	const registry = new ClientRegistry(() => clock);
	const issued2 = registry.launchChallenge().challenge;
	assert.equal(
		new ClientRegistry(() => 0).redeemChallenge(issued2, () => true),
		false,
		"another process's challenge",
	);
	const tampered = `${issued2.slice(0, 5)}${issued2[5] === "A" ? "B" : "A"}${issued2.slice(6)}`;
	assert.equal(
		registry.redeemChallenge(tampered, () => true),
		false,
		"a challenge whose nonce was changed",
	);
	clock = 61_000;
	assert.equal(
		registry.redeemChallenge(issued2, () => true),
		false,
		"an expired challenge",
	);
});

test("the event stream opens on a single-use ticket, never on a bearer in its URL", async (t) => {
	const h = await harness();
	t.after(h.close);
	const a = await h.client("Window A");
	const minted = await a.post("/api/events/ticket");
	assert.equal(minted.status, 200);
	const { ticket } = (await minted.json()) as { ticket: string };
	const stream = await h.app.request(`http://127.0.0.1:4317/api/events?ticket=${ticket}`);
	assert.equal(stream.status, 200);
	assert.equal(stream.headers.get("X-Clio-Client"), a.clientId);
	await stream.body?.cancel();
	// Spent, so a ticket copied from a log or a history entry opens nothing.
	assert.equal((await h.app.request(`http://127.0.0.1:4317/api/events?ticket=${ticket}`)).status, 401);
	// A credential in the query is not a ticket.
	assert.equal((await h.app.request(`http://127.0.0.1:4317/api/events?ticket=${a.credential}`)).status, 401);
	// Tickets open only the stream.
	const another = ((await (await a.post("/api/events/ticket")).json()) as { ticket: string }).ticket;
	assert.equal((await h.app.request(`http://127.0.0.1:4317/api/meta?ticket=${another}`)).status, 401);
});

test("a launch hears whether an app window is live, so a relaunch after a restart opens a fresh one", async (t) => {
	const h = await harness();
	t.after(h.close);
	const launcher = await h.client("Launcher");
	const shown = async (body: object) => {
		const answer = await launcher.post("/api/launch", body);
		assert.equal(answer.status, 200);
		return ((await answer.json()) as { shown: boolean }).shown;
	};
	// A restarted server knows no window: the old one cannot reconnect, so the launcher must not focus it.
	assert.equal(await shown({}), false);
	assert.equal(await shown({ path: "/sessions" }), false);
	// The stream leaves the hub in the same step that releases its window, so the test waits for that, not a clock.
	const connect = h.hub.connect.bind(h.hub);
	let ended: () => void = () => {};
	const end = new Promise<void>((resolve) => {
		ended = resolve;
	});
	h.hub.connect = (cursor, receive) => {
		const unsubscribe = connect(cursor, receive);
		return () => {
			unsubscribe();
			ended();
		};
	};
	const a = await h.client("Window A");
	const { ticket } = (await (await a.post("/api/events/ticket")).json()) as { ticket: string };
	const stream = await h.app.request(`http://127.0.0.1:4317/api/events?ticket=${ticket}`);
	assert.equal(stream.status, 200);
	assert.equal(await shown({}), true);
	assert.equal(await shown({ path: "/sessions" }), true);
	await stream.body?.cancel();
	await end;
	assert.equal(await shown({}), false);
});

test("credentials rotate with a grace, expire, and resume the same id only when no live credential holds it", () => {
	let now = 1_000_000;
	const clients = new ClientRegistry(() => now);
	const first = clients.open("Window A");
	assert.equal(clients.authenticate(first.credential)?.clientId, first.clientId);
	// A second process asking for a live id gets its own.
	assert.notEqual(clients.open("Copy", first.clientId).clientId, first.clientId);
	const record = clients.authenticate(first.credential);
	assert.ok(record);
	const rotated = clients.rotate(record);
	assert.equal(rotated.clientId, first.clientId);
	assert.notEqual(rotated.credential, first.credential);
	// The old credential lands requests already in flight, then stops.
	assert.ok(clients.authenticate(first.credential));
	now += ROTATION_GRACE_MS;
	assert.equal(clients.authenticate(first.credential), null);
	assert.ok(clients.authenticate(rotated.credential));
	// Presence follows requests and open streams.
	now += PRESENCE_MS;
	assert.equal(clients.present(first.clientId), false);
	const release = clients.stream(record);
	assert.equal(clients.present(first.clientId), true);
	release();
	release();
	assert.equal(record.streams, 0);
	// Expired: refused, and a window that slept through it resumes its id.
	now += CREDENTIAL_TTL_MS;
	assert.equal(clients.authenticate(rotated.credential), null);
	const resumed = clients.open("Window A", first.clientId);
	assert.equal(resumed.clientId, first.clientId);
	assert.equal(resumed.label, "Window A");
	// Two live windows that call themselves the same are told apart.
	assert.equal(clients.open("Window A").label, "Window A 2");
	assert.equal(clients.open("Window A").label, "Window A 3");
	// Tickets are single-use and short-lived.
	const live = clients.authenticate(resumed.credential);
	assert.ok(live);
	const { ticket } = clients.ticket(live);
	assert.equal(clients.redeem(ticket)?.clientId, first.clientId);
	assert.equal(clients.redeem(ticket), null);
	const stale = clients.ticket(live).ticket;
	now += TICKET_TTL_MS;
	assert.equal(clients.redeem(stale), null);
});

test("a restart revokes every credential: a fresh registry knows none of them", () => {
	const before = new ClientRegistry();
	const issued = before.open("Window A");
	const after = new ClientRegistry();
	assert.equal(after.authenticate(issued.credential), null);
	// The window then exchanges the launch token again and keeps its id.
	assert.equal(after.open("Window A", issued.clientId).clientId, issued.clientId);
});

test("a launch ticket opens the window's client without an Authorization header, and a restarted server needs a fresh link", async (t) => {
	const server = { clients: new ClientRegistry() };
	const exchanges: { authorization: string | null; resume: string | undefined }[] = [];
	const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = String(input);
		const headers = new Headers(init.headers);
		const bearer = headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
		if (url === routes.authClients.path) {
			const body = JSON.parse(String(init.body)) as { label?: string; resume?: string };
			exchanges.push({ authorization: headers.get("Authorization"), resume: body.resume });
			return Response.json(server.clients.open(body.label, body.resume));
		}
		const client = server.clients.authenticate(bearer);
		if (!client) return Response.json({ status: 401 }, { status: 401 });
		return Response.json({ apiVersion: 1, client: client.clientId });
	}) as typeof fetch;
	const client = createClient({ ticket: "launch-ticket" }, fetcher);
	t.after(() => client.credentials.dispose());
	await client.call(routes.meta, { params: {}, query: {}, body: {} });
	assert.ok(client.credentials.clientId());
	server.clients = new ClientRegistry();
	// The ticket was spent on the first exchange, so nothing in this window can open a client again.
	await assert.rejects(client.call(routes.meta, { params: {}, query: {}, body: {} }), /fresh launch link/);
	assert.deepEqual(exchanges, [{ authorization: null, resume: undefined }]);
	assert.equal(tokenRejected(), false);
});

/** A browser page: session storage and the pagehide that hands the credential to the next document. */
function browserPage(t: TestContext) {
	const stored = new Map<string, string>();
	const listeners = new Map<string, Set<() => void>>();
	const page = globalThis as unknown as Record<string, unknown>;
	const saved = ["sessionStorage", "addEventListener", "removeEventListener"].map((key) => [key, page[key]] as const);
	page.sessionStorage = {
		getItem: (key: string) => stored.get(key) ?? null,
		setItem: (key: string, value: string) => stored.set(key, value),
		removeItem: (key: string) => stored.delete(key),
	};
	page.addEventListener = (type: string, listener: () => void) =>
		listeners.set(type, (listeners.get(type) ?? new Set()).add(listener));
	page.removeEventListener = (type: string, listener: () => void) => listeners.get(type)?.delete(listener);
	t.after(() => {
		for (const [key, value] of saved) page[key] = value;
	});
	return { stored, listeners };
}

test("a launch link pasted into an open window's address bar reloads it, so the fresh ticket is read", (t) => {
	const { listeners } = browserPage(t);
	const page = globalThis as unknown as Record<string, unknown>;
	const savedLocation = page.location;
	const location = { hash: "" };
	page.location = location;
	t.after(() => {
		page.location = savedLocation;
	});
	let reloads = 0;
	listenForLaunchLink(() => {
		reloads += 1;
	});
	const hashChange = (hash: string) => {
		location.hash = hash;
		for (const listener of listeners.get("hashchange") ?? []) listener();
	};
	hashChange("#section");
	assert.equal(reloads, 0);
	hashChange(`#ticket=${"a".repeat(43)}`);
	assert.equal(reloads, 1);
	// A ticket pasted into the page's own field reloads once, through adoptLaunchSecret, not twice.
	Object.assign(location, { origin: "http://app", reload: () => {} });
	adoptLaunchSecret({ ticket: "b".repeat(43) }, "http://app");
	for (const listener of listeners.get("hashchange") ?? []) listener();
	assert.equal(reloads, 1);
});

test("a reload keeps the window's credential, but a document opened from another launch link exchanges that link", async (t) => {
	const { listeners } = browserPage(t);
	const clients = new ClientRegistry();
	const exchanges: { authorization: string | null; resume: string | undefined }[] = [];
	const fetcher = (async (_input: string | URL | Request, init: RequestInit = {}) => {
		const body = JSON.parse(String(init.body)) as { label?: string; resume?: string };
		exchanges.push({ authorization: new Headers(init.headers).get("Authorization"), resume: body.resume });
		return Response.json(clients.open(body.label, body.resume));
	}) as typeof fetch;
	const open = async (ticket: string | undefined, previous?: ReturnType<typeof createCredentials>) => {
		for (const listener of listeners.get("pagehide") ?? []) listener();
		previous?.dispose();
		const credentials = createCredentials(ticket === undefined ? {} : { ticket }, fetcher);
		t.after(() => credentials.dispose());
		return { credentials, bearer: await credentials.bearer() };
	};
	const first = await open("ticket-a");
	const bought = first.bearer;
	const id = first.credentials.clientId();
	// The address bar no longer holds the spent ticket, so a reload opens with nothing but the handoff.
	const same = await open(undefined, first.credentials);
	assert.equal(same.bearer, bought, "a plain reload exchanged again instead of keeping its credential");
	// The page carried a different launch ticket in its address: the old credential must not cover for it.
	const relinked = await open("ticket-b", same.credentials);
	assert.notEqual(relinked.bearer, bought);
	assert.deepEqual(exchanges, [
		{ authorization: null, resume: undefined },
		{ authorization: null, resume: id },
	]);
});

test("a window that signs out is refused by the server and hands nothing to the next page", async (t) => {
	const { stored, listeners } = browserPage(t);
	const clients = new ClientRegistry();
	const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
		const bearer = new Headers(init.headers).get("Authorization")?.slice(7) ?? "";
		if (String(input) === routes.authRevoke.path) {
			const record = clients.authenticate(bearer);
			if (!record) return Response.json({}, { status: 401 });
			clients.revoke(record);
			return Response.json({});
		}
		const body = JSON.parse(String(init.body)) as { label?: string; resume?: string };
		return Response.json(clients.open(body.label, body.resume));
	}) as typeof fetch;
	const credentials = createCredentials({ ticket: "ticket-a" }, fetcher);
	t.after(() => credentials.dispose());
	const bearer = await credentials.bearer();
	assert.ok(clients.authenticate(bearer));
	await credentials.revoke();
	assert.equal(clients.authenticate(bearer), null);
	await assert.rejects(credentials.bearer(), /launch link/);
	// The reload that follows a sign-out must not carry the credential, or the id, into the next document.
	for (const listener of listeners.get("pagehide") ?? []) listener();
	assert.deepEqual([...stored.keys()], []);
});

test("two concurrent refreshes spend the launch ticket in exactly one exchange", async (t) => {
	browserPage(t);
	const clients = new ClientRegistry();
	const tickets: (string | undefined)[] = [];
	const fetcher = (async (_input: string | URL | Request, init: RequestInit = {}) => {
		const body = JSON.parse(String(init.body)) as { label?: string; ticket?: string };
		tickets.push(body.ticket);
		return Response.json(clients.open(body.label));
	}) as typeof fetch;
	const credentials = createCredentials({ ticket: "ticket-once" }, fetcher);
	t.after(() => credentials.dispose());
	const [first, second] = await Promise.all([credentials.bearer(), credentials.bearer()]);
	assert.equal(first, second);
	assert.deepEqual(tickets, ["ticket-once"]);
});

test("a refused credential and a refused launch ticket are told apart", async (t) => {
	const { stored } = browserPage(t);
	// Builds before the reason was recorded stored "1": that reads as this browser's credential.
	stored.set("clio-coder-token-refused", "1");
	assert.equal(refusalReason(), "credential");
	dropStoredToken();
	assert.equal(refusalReason(), "credential");
	stored.clear();
	// Runs last: a refusal marks this module's token rejected for the rest of the file.
	const credentials = createCredentials({ ticket: "spent-ticket" }, (async () =>
		Response.json({ status: 401 }, { status: 401 })) as typeof fetch);
	t.after(() => credentials.dispose());
	await assert.rejects(credentials.bearer(), /launch link/);
	assert.equal(refusalReason(), "ticket");
	assert.equal(stored.get("clio-coder-token-refused"), "ticket");
});
