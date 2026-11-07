import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { tokenRejected } from "../client/api/auth-state.js";
import { createClient } from "../client/api/client.js";
import { ClientCredential } from "../contracts/auth.js";
import { Problem } from "../contracts/common.js";
import { routes } from "../contracts/routes.js";
import {
	ClientRegistry,
	CREDENTIAL_TTL_MS,
	PRESENCE_MS,
	ROTATION_GRACE_MS,
	TICKET_TTL_MS,
} from "../server/services/clients.js";
import { harness } from "./harness/app.js";

const launch = { Authorization: "Bearer test-token" };

test("the launch token opens only the exchange; each window gets its own attributed credential", async (t) => {
	const h = await harness();
	t.after(h.close);
	// The launch token is refused everywhere else, with a reason that names the exchange.
	const meta = await h.request("/api/meta", { headers: launch });
	assert.equal(meta.status, 401);
	const refusal = (await meta.json()) as Problem;
	assert.ok(Value.Check(Problem, refusal));
	assert.match(refusal.detail, /only opens a client at POST \/api\/auth\/clients/);
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
	// A wrong launch token buys nothing.
	const wrong = await h.app.request("http://127.0.0.1:4317/api/auth/clients", {
		method: "POST",
		headers: { Authorization: "Bearer nope", "Content-Type": "application/json", "Idempotency-Key": "k" },
		body: "{}",
	});
	assert.equal(wrong.status, 401);
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
	const resumed = clients.open(undefined, first.clientId);
	assert.equal(resumed.clientId, first.clientId);
	assert.equal(resumed.label, "Window A");
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

test("a window whose credential a restarted server no longer knows exchanges again under the same id", async (t) => {
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
	const client = createClient("launch-token", fetcher);
	t.after(() => client.credentials.dispose());
	await client.call(routes.meta, { params: {}, query: {}, body: {} });
	const id = client.credentials.clientId();
	assert.ok(id);
	server.clients = new ClientRegistry();
	await client.call(routes.meta, { params: {}, query: {}, body: {} });
	assert.equal(client.credentials.clientId(), id);
	assert.deepEqual(exchanges, [
		{ authorization: "Bearer launch-token", resume: undefined },
		{ authorization: "Bearer launch-token", resume: id },
	]);
	assert.equal(tokenRejected(), false);
});
