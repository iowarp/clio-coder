import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";
import { Value } from "typebox/value";
import { Problem } from "../contracts/common.js";
import { auth, requestClient } from "../server/http/auth.js";
import { problemResponse } from "../server/http/problem.js";
import { authRoutes } from "../server/http/routes-auth.js";
import { type MachineAttachmentsApi, machinesRoutes } from "../server/http/routes-machines.js";
import { ClientRegistry } from "../server/services/clients.js";
import { EventHub } from "../server/services/event-hub.js";
import { MachineAttachments } from "../server/services/machine-attach.js";
import { SessionControls } from "../server/services/session-control.js";
import type { MachineEndpoint } from "../server/worker/protocol.js";

const LOCAL_TOKEN = "local-launch-token-0123456789abcdefghij";
const REMOTE_TOKEN = "remote-attach-token-0123456789abcdefghij";
const ORIGIN = "http://127.0.0.1:4317";
/** The port the node's own GUI listens on, which its auth expects in Host; the forward's port differs. */
const REMOTE_LISTENER_PORT = 38211;

test("an attachment awaiting the registry cannot start after shutdown", async () => {
	let resolveRegistry: (endpoints: MachineEndpoint[]) => void = () => {};
	const registry = new Promise<MachineEndpoint[]>((resolve) => {
		resolveRegistry = resolve;
	});
	const attachments = new MachineAttachments({
		endpoints: () => registry,
		local: () => ({ clio: "test", build: "test" }),
		hub: new EventHub(),
		env: { ...process.env, PATH: "" },
	});
	const pending = attachments.attach("node");
	const result = assert.rejects(pending, /stopping/);
	try {
		await attachments.stopAll();
		resolveRegistry([
			{
				id: "node",
				host: "127.0.0.1",
				user: null,
				port: null,
				identityFile: null,
				connectTimeoutSec: null,
				clioCoderEntry: null,
			},
		]);
		await result;
		assert.equal(attachments.route("node"), null);
		await assert.rejects(attachments.attach("node"), /stopping/);
	} finally {
		resolveRegistry([]);
		await pending.catch(() => {});
		await attachments.stopAll();
	}
});

test("the node proxy rewrites Host, Origin and bearer, strips browser credentials, and refuses what is not attached", async (t) => {
	// The fake node GUI runs the real auth: it issues its own credentials and tickets for its launch token.
	const seen: { url: string; headers: Record<string, string | string[] | undefined>; body: string; client: string }[] =
		[];
	const nodeHub = new EventHub();
	const upstream = new Hono();
	upstream.onError(problemResponse);
	const nodeClients = new ClientRegistry();
	upstream.use(
		"*",
		auth(REMOTE_TOKEN, () => `http://127.0.0.1:${REMOTE_LISTENER_PORT}`, nodeClients),
	);
	authRoutes(upstream, nodeHub, nodeClients, new SessionControls(nodeClients, nodeHub), {
		token: REMOTE_TOKEN,
		origin: () => `http://127.0.0.1:${REMOTE_LISTENER_PORT}`,
	});
	upstream.all("*", async (context) => {
		const body = context.req.method === "POST" ? await context.req.text() : "";
		const client = requestClient(context).clientId;
		seen.push({ url: context.req.url, headers: Object.fromEntries(context.req.raw.headers), body, client });
		if (context.req.path === "/api/refuse401") return context.json({ refused: 401 }, 401);
		if (context.req.path === "/api/refuse421") return context.json({ refused: 421 }, 421);
		if (context.req.path === "/api/events") {
			context.header("Content-Type", "text/event-stream");
			return context.body("event: hello\ndata: {}\n\n");
		}
		context.header("X-Remote", "yes");
		return context.json({ echo: body, path: context.req.path, client });
	});
	const server = createAdaptorServer({ fetch: upstream.fetch, hostname: "127.0.0.1" });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const port = (server.address() as AddressInfo).port;
	const attachments: MachineAttachmentsApi = {
		list: async () => [],
		attach: async () => {
			throw new Error("not under test");
		},
		route: (id) =>
			id === "blade"
				? { kind: "ready", port, remotePort: REMOTE_LISTENER_PORT, token: REMOTE_TOKEN }
				: id === "mini"
					? { kind: "pending", state: "connecting" }
					: null,
		forget: () => {},
	};
	const app = new Hono();
	const hub = new EventHub();
	app.onError(problemResponse);
	const localClients = new ClientRegistry();
	app.use(
		"*",
		auth(LOCAL_TOKEN, () => ORIGIN, localClients),
	);
	authRoutes(app, hub, localClients, new SessionControls(localClients, hub), {
		token: LOCAL_TOKEN,
		origin: () => ORIGIN,
	});
	machinesRoutes(app, hub, undefined, attachments);
	const request = (path: string, init: RequestInit = {}) => app.request(`${ORIGIN}${path}`, init);
	const command = (path: string, bearer: string) =>
		request(path, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${bearer}`,
				"Content-Type": "application/json",
				"Idempotency-Key": crypto.randomUUID(),
			},
			body: "{}",
		});
	const window = async (label: string) => {
		const response = await request("/api/auth/clients", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${LOCAL_TOKEN}`,
				"Content-Type": "application/json",
				"Idempotency-Key": crypto.randomUUID(),
			},
			body: JSON.stringify({ label }),
		});
		assert.equal(response.status, 200);
		return ((await response.json()) as { credential: string }).credential;
	};
	const problem = async (response: Response) => {
		assert.match(response.headers.get("content-type") ?? "", /application\/problem\+json/);
		const value = (await response.json()) as unknown;
		assert.ok(Value.Check(Problem, value));
		return value;
	};
	const browser = await window("Window A");

	// A GET with the browser's own bearer, cookie, origin and query token: all replaced or removed.
	const meta = await request("/m/blade/api/meta?token=not-for-the-node&after=x", {
		headers: { Authorization: `Bearer ${browser}`, Cookie: "session=browser", Origin: ORIGIN, "X-Keep": "1" },
	});
	assert.equal(meta.status, 200);
	assert.equal(meta.headers.get("content-type"), "application/json");
	assert.equal(meta.headers.get("x-remote"), "yes");
	assert.equal(meta.headers.get("x-frame-options"), "DENY");
	const echoed = (await meta.json()) as { echo: string; path: string; client: string };
	assert.deepEqual({ ...echoed, client: "" }, { echo: "", path: "/api/meta", client: "" });
	const first = seen.at(-1);
	assert.ok(first);
	assert.equal(new URL(first.url).pathname + new URL(first.url).search, "/api/meta?after=x");
	assert.equal(first.headers.host, `127.0.0.1:${REMOTE_LISTENER_PORT}`);
	assert.equal(first.headers.origin, `http://127.0.0.1:${REMOTE_LISTENER_PORT}`);
	// The node sees this app's own credential there: neither its launch token nor the browser's credential.
	const remoteBearer = String(first.headers.authorization);
	assert.match(remoteBearer, /^Bearer [\w-]{43}$/);
	assert.notEqual(remoteBearer, `Bearer ${REMOTE_TOKEN}`);
	assert.notEqual(remoteBearer, `Bearer ${browser}`);
	assert.equal(first.headers.cookie, undefined);
	assert.equal(first.headers["x-keep"], "1");

	// A stream authenticates locally by a single-use ticket and reaches the node on this app's bearer.
	const ticketResponse = await command("/api/events/ticket", browser);
	assert.equal(ticketResponse.status, 200);
	const { ticket } = (await ticketResponse.json()) as { ticket: string };
	const events = await request(`/m/blade/api/events?ticket=${ticket}&after=e-1:3`);
	assert.equal(events.status, 200);
	assert.equal(events.headers.get("content-type"), "text/event-stream");
	assert.equal(await events.text(), "event: hello\ndata: {}\n\n");
	const stream = seen.at(-1);
	assert.ok(stream);
	assert.equal(new URL(stream.url).search, "?after=e-1%3A3");
	assert.equal(stream.headers.authorization, remoteBearer);
	assert.equal(stream.client, echoed.client);
	// Spent: the same ticket opens nothing a second time, here or at the node.
	const before = seen.length;
	assert.equal((await request(`/m/blade/api/events?ticket=${ticket}`)).status, 401);

	// A command body travels with its idempotency key and epoch.
	const posted = await request("/m/blade/api/sessions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${browser}`,
			"Content-Type": "application/json",
			"Idempotency-Key": "k-1",
			"X-Clio-Epoch": "e-1",
		},
		body: JSON.stringify({ cwd: "/work" }),
	});
	assert.equal(posted.status, 200);
	assert.deepEqual(await posted.json(), { echo: '{"cwd":"/work"}', path: "/api/sessions", client: echoed.client });
	const sent = seen.at(-1);
	assert.ok(sent);
	assert.equal(sent.headers["idempotency-key"], "k-1");
	assert.equal(sent.headers["x-clio-epoch"], "e-1");

	// A second window is a second client at the node too, so the node can tell the two apart.
	const other = await window("Window B");
	const second = (await (
		await request("/m/blade/api/meta", { headers: { Authorization: `Bearer ${other}` } })
	).json()) as {
		client: string;
	};
	assert.notEqual(second.client, echoed.client);

	// Local auth still guards the prefix: neither a wrong bearer nor the launch token reaches the node.
	const guarded = seen.length;
	assert.equal((await request("/m/blade/api/meta", { headers: { Authorization: "Bearer wrong" } })).status, 401);
	assert.equal(
		(await request("/m/blade/api/meta", { headers: { Authorization: `Bearer ${LOCAL_TOKEN}` } })).status,
		401,
	);
	assert.equal((await request("/m/blade/api/meta")).status, 401);
	// Credentials are this app's to issue; the prefix never forwards an exchange.
	assert.equal((await command("/m/blade/api/auth/clients", browser)).status, 404);
	assert.equal((await command("/m/blade/api/events/ticket", browser)).status, 404);
	// Nor a sign-out, which would revoke this app's own credential at the node rather than the window's.
	assert.equal((await command("/m/blade/api/auth/revoke", browser)).status, 404);
	assert.equal(seen.length, guarded);

	// A remote refusal is reported as the node being unavailable, never as this app's credential being refused.
	for (const path of ["/m/blade/api/refuse401", "/m/blade/api/refuse421"]) {
		const refused = await request(path, { headers: { Authorization: `Bearer ${browser}` } });
		assert.equal(refused.status, 502, path);
		assert.equal((await problem(refused)).code, "unavailable", path);
	}

	// A node that is not attached, or not known, is refused before any socket opens.
	const unrouted = seen.length;
	const pending = await request("/m/mini/api/meta", { headers: { Authorization: `Bearer ${browser}` } });
	assert.equal(pending.status, 503);
	assert.equal((await problem(pending)).code, "unavailable");
	for (const id of ["dragon", "local"]) {
		const unknown = await request(`/m/${id}/api/meta`, { headers: { Authorization: `Bearer ${browser}` } });
		assert.equal(unknown.status, 404, id);
		assert.equal((await problem(unknown)).code, "not_found", id);
	}
	assert.equal(seen.length, unrouted);
	assert.ok(before > 0);
});
