import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";
import { Value } from "typebox/value";
import { Problem } from "../contracts/common.js";
import { auth } from "../server/http/auth.js";
import { problemResponse } from "../server/http/problem.js";
import { type MachineAttachmentsApi, machinesRoutes } from "../server/http/routes-machines.js";
import { EventHub } from "../server/services/event-hub.js";
import { MachineAttachments } from "../server/services/machine-attach.js";
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
	// The fake node GUI: records what reached it and answers like a private server would.
	const seen: { url: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];
	const upstream = new Hono();
	upstream.all("*", async (context) => {
		const body = context.req.method === "POST" ? await context.req.text() : "";
		seen.push({ url: context.req.url, headers: Object.fromEntries(context.req.raw.headers), body });
		if (context.req.path === "/api/refuse401") return context.json({ refused: 401 }, 401);
		if (context.req.path === "/api/refuse421") return context.json({ refused: 421 }, 421);
		if (context.req.path === "/api/events") {
			context.header("Content-Type", "text/event-stream");
			return context.body("event: hello\ndata: {}\n\n");
		}
		context.header("X-Remote", "yes");
		return context.json({ echo: body, path: context.req.path });
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
	app.onError(problemResponse);
	app.use(
		"*",
		auth(LOCAL_TOKEN, () => ORIGIN),
	);
	machinesRoutes(app, new EventHub(), undefined, attachments);
	const request = (path: string, init: RequestInit = {}) => app.request(`${ORIGIN}${path}`, init);
	const problem = async (response: Response) => {
		assert.match(response.headers.get("content-type") ?? "", /application\/problem\+json/);
		const value = (await response.json()) as unknown;
		assert.ok(Value.Check(Problem, value));
		return value;
	};

	// A GET with the browser's own bearer, cookie, origin and query token: all replaced or removed.
	const meta = await request("/m/blade/api/meta?token=not-for-the-node&after=x", {
		headers: { Authorization: `Bearer ${LOCAL_TOKEN}`, Cookie: "session=browser", Origin: ORIGIN, "X-Keep": "1" },
	});
	assert.equal(meta.status, 200);
	assert.equal(meta.headers.get("content-type"), "application/json");
	assert.equal(meta.headers.get("x-remote"), "yes");
	assert.equal(meta.headers.get("x-frame-options"), "DENY");
	assert.deepEqual(await meta.json(), { echo: "", path: "/api/meta" });
	const first = seen.at(-1);
	assert.ok(first);
	assert.equal(new URL(first.url).pathname + new URL(first.url).search, "/api/meta?after=x");
	assert.equal(first.headers.host, `127.0.0.1:${REMOTE_LISTENER_PORT}`);
	assert.equal(first.headers.origin, `http://127.0.0.1:${REMOTE_LISTENER_PORT}`);
	assert.equal(first.headers.authorization, `Bearer ${REMOTE_TOKEN}`);
	assert.equal(first.headers.cookie, undefined);
	assert.equal(first.headers["x-keep"], "1");

	// A stream authenticates locally by query token and reaches the node with the bearer instead.
	const events = await request(`/m/blade/api/events?token=${LOCAL_TOKEN}`);
	assert.equal(events.status, 200);
	assert.equal(events.headers.get("content-type"), "text/event-stream");
	assert.equal(await events.text(), "event: hello\ndata: {}\n\n");
	const stream = seen.at(-1);
	assert.ok(stream);
	assert.equal(new URL(stream.url).search, "");
	assert.equal(stream.headers.authorization, `Bearer ${REMOTE_TOKEN}`);

	// A command body travels with its idempotency key and epoch.
	const posted = await request("/m/blade/api/sessions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${LOCAL_TOKEN}`,
			"Content-Type": "application/json",
			"Idempotency-Key": "k-1",
			"X-Clio-Epoch": "e-1",
		},
		body: JSON.stringify({ cwd: "/work" }),
	});
	assert.equal(posted.status, 200);
	assert.deepEqual(await posted.json(), { echo: '{"cwd":"/work"}', path: "/api/sessions" });
	const command = seen.at(-1);
	assert.ok(command);
	assert.equal(command.headers["idempotency-key"], "k-1");
	assert.equal(command.headers["x-clio-epoch"], "e-1");

	// Local auth still guards the prefix: a wrong token never reaches the node.
	const before = seen.length;
	assert.equal((await request("/m/blade/api/meta", { headers: { Authorization: "Bearer wrong" } })).status, 401);
	assert.equal((await request("/m/blade/api/meta")).status, 401);
	assert.equal(seen.length, before);

	// A remote refusal is reported as the node being unavailable, never as this app's token being refused.
	for (const path of ["/m/blade/api/refuse401", "/m/blade/api/refuse421"]) {
		const refused = await request(path, { headers: { Authorization: `Bearer ${LOCAL_TOKEN}` } });
		assert.equal(refused.status, 502, path);
		assert.equal((await problem(refused)).code, "unavailable", path);
	}

	// A node that is not attached, or not known, is refused before any socket opens.
	const pending = await request("/m/mini/api/meta", { headers: { Authorization: `Bearer ${LOCAL_TOKEN}` } });
	assert.equal(pending.status, 503);
	assert.equal((await problem(pending)).code, "unavailable");
	for (const id of ["dragon", "local"]) {
		const unknown = await request(`/m/${id}/api/meta`, { headers: { Authorization: `Bearer ${LOCAL_TOKEN}` } });
		assert.equal(unknown.status, 404, id);
		assert.equal((await problem(unknown)).code, "not_found", id);
	}
	assert.equal(seen.length, before + 2);
});
