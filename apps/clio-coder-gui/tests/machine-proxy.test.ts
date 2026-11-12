import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
		auth(() => `http://127.0.0.1:${REMOTE_LISTENER_PORT}`, nodeClients),
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
		auth(() => ORIGIN, localClients),
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
				"Content-Type": "application/json",
				"Idempotency-Key": crypto.randomUUID(),
			},
			body: JSON.stringify({ label, ticket: localClients.launchTicket().ticket }),
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
	// Matched as the node routes it: decoded, so an encoded name or a trailing slash forwards nothing.
	assert.equal((await command("/m/blade/api/auth/%72otate", browser)).status, 404);
	assert.equal((await command("/m/blade/api/auth/rotate/", browser)).status, 404);
	assert.equal((await command("/m/blade/api/auth/%E0", browser)).status, 400);
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

test("an attach whose SSH forward exits never turns ready over another listener on its port", {
	timeout: 60_000,
}, async (t) => {
	const bin = await mkdtemp(join(tmpdir(), "clio-fake-ssh-"));
	t.after(() => rm(bin, { recursive: true, force: true }));
	// The node's own GUI, with the real auth, for the token the command channel hands it on stdin.
	const nodeClients = new ClientRegistry(),
		nodeHub = new EventHub();
	const node = new Hono();
	node.onError(problemResponse);
	const server = createAdaptorServer({ fetch: node.fetch, hostname: "127.0.0.1" });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	const nodePort = (server.address() as AddressInfo).port;
	node.use(
		"*",
		auth(() => `http://127.0.0.1:${nodePort}`, nodeClients),
	);
	authRoutes(node, nodeHub, nodeClients, new SessionControls(nodeClients, nodeHub), {
		get token() {
			return readFileSync(join(bin, "token"), "utf8").trim();
		},
		origin: () => `http://127.0.0.1:${nodePort}`,
	});
	node.get("/api/meta", (context) => context.json({ apiVersion: 1, clio: "test", build: "test", host: "node" }));
	// A relay to the node's GUI on the forward's local port: another account's listener in the squatted
	// mode, the forward's own in the honest one. The squatted forward then exits as ExitOnForwardFailure makes
	// it; the honest one prints what its LocalCommand prints once ssh holds the port.
	const relay = `const net=require("node:net");net.createServer((s)=>{const u=net.connect(${nodePort},"127.0.0.1");s.pipe(u);u.pipe(s);s.on("error",()=>u.destroy());u.on("error",()=>s.destroy())}).listen(Number(process.argv[1]),"127.0.0.1",()=>process.send?.("up"))`;
	await writeFile(
		join(bin, "ssh"),
		`#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const bin = ${JSON.stringify(bin)};
const forward = process.argv.indexOf("-L");
if (forward === -1) {
	process.stdin.once("data", (chunk) => {
		writeFileSync(bin + "/token", String(chunk).split("\\n")[0]);
		process.stdout.write("[clio-coder:gui] http://127.0.0.1:${nodePort}/\\n");
	});
	process.stdin.on("end", () => process.exit(0));
} else {
	const local = process.argv[forward + 1].split(":")[1];
	const squatted = readFileSync(bin + "/mode", "utf8") === "squatted";
	const child = spawn(process.execPath, ["-e", ${JSON.stringify(relay)}, local], { detached: squatted, stdio: ["ignore", "ignore", "ignore", "ipc"] });
	appendFileSync(bin + "/pids", child.pid + "\\n");
	child.once("message", () => {
		// ssh exits on the taken port only after it authenticates; until then the squatter answers alone.
		if (squatted) { child.disconnect(); child.unref(); setTimeout(() => process.exit(255), 300); }
		else process.stdout.write("clio-coder-forward-held\\n");
	});
	process.on("SIGTERM", () => { child.kill(); process.exit(0); });
}
`,
		{ mode: 0o700 },
	);
	t.after(async () => {
		for (const pid of (await readFile(join(bin, "pids"), "utf8").catch(() => "")).split("\n").filter(Boolean))
			try {
				process.kill(Number(pid), "SIGKILL");
			} catch {}
	});
	const endpoint: MachineEndpoint = {
		id: "node",
		host: "node.example",
		user: null,
		port: null,
		identityFile: null,
		connectTimeoutSec: null,
		clioCoderEntry: null,
	};
	const hub = new EventHub();
	const attachments = new MachineAttachments({
		endpoints: async () => [endpoint],
		local: () => ({ clio: "test", build: "test" }),
		hub,
		env: { ...process.env, PATH: bin },
		metaTimeoutMs: 5_000,
	});
	t.after(() => attachments.stopAll());
	const settled = async () => {
		for (let i = 0; i < 200; i++) {
			const [state] = (await attachments.list()).map((attachment) => attachment.state);
			if (state !== "connecting") return state;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		return "connecting";
	};
	await writeFile(join(bin, "mode"), "squatted");
	await attachments.attach("node");
	assert.equal(await settled(), "failed", "a forward that exited never carries the attach to ready");
	assert.equal(attachments.route("node")?.kind, "pending");
	attachments.forget("node");
	// The honest forward: the same node attaches as before.
	await writeFile(join(bin, "mode"), "honest");
	await attachments.attach("node");
	assert.equal(await settled(), "ready");
	assert.equal(attachments.route("node")?.kind, "ready");
});
