import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { lostControlNotice } from "../client/chat/control-model.js";
import { Problem } from "../contracts/common.js";
import { SessionControl } from "../contracts/control.js";
import type { Event } from "../contracts/events.js";
import { SessionSnapshot } from "../contracts/sessions.js";
import { Supervisor } from "../server/acp/supervisor.js";
import { ClientRegistry, PRESENCE_MS } from "../server/services/clients.js";
import { EventHub } from "../server/services/event-hub.js";
import { SessionControls } from "../server/services/session-control.js";
import { AppFiles } from "../server/state/files.js";
import { harness, json } from "./harness/app.js";

test("one window drives a session; another views it until it takes control, and the first is told", async (t) => {
	const h = await harness();
	t.after(h.close);
	const seen: Event[] = [];
	t.after(h.hub.connect(undefined, (event) => seen.push(event)));
	const workspace = await h.workspaces.open(h.home.path);
	const a = await h.client("Window A");
	const b = await h.client("Window B");
	const session = await json(await a.post(`/api/workspaces/${workspace.id}/sessions`), SessionSnapshot);
	const control = `/api/sessions/${session.id}/control`;
	const autonomy = `/api/sessions/${session.id}/autonomy`;

	// The creator holds it; the second window sees who does.
	const asA = await json(await a.request(control), SessionControl);
	assert.deepEqual(asA.controller, { clientId: a.clientId, label: "Window A" });
	const asB = await json(await b.request(control), SessionControl);
	assert.deepEqual(asB, {
		sessionId: session.id,
		controller: asA.controller,
		you: { clientId: b.clientId, label: "Window B" },
	});

	// A viewer's change is refused, naming the holder; its reads and sightings still work.
	const refused = await b.post(autonomy, { level: "yolo" });
	assert.equal(refused.status, 409);
	const problem = (await refused.json()) as Problem;
	assert.ok(Value.Check(Problem, problem));
	assert.deepEqual(problem.control, { sessionId: session.id, controller: asA.controller });
	assert.match(problem.detail, /Window A controls this session/);
	assert.equal((await b.post(`/api/sessions/${session.id}/close`)).status, 409);
	assert.equal((await b.request(autonomy)).status, 200);
	assert.equal((await b.post(`/api/sessions/${session.id}/view`)).status, 200);
	assert.equal((await a.post(autonomy, { level: "default" })).status, 200);

	// The explicit take-over moves control, and the event names who lost it.
	const taken = await json(await b.post(control), SessionControl);
	assert.equal(taken.controller?.clientId, b.clientId);
	const moved = seen.filter((event) => event.type === "session.control").at(-1);
	assert.ok(moved?.type === "session.control");
	assert.deepEqual(moved.payload, {
		resource: session.id,
		controller: { clientId: b.clientId, label: "Window B" },
		previous: { clientId: a.clientId, label: "Window A" },
	});
	assert.ok(lostControlNotice(moved.payload, a.clientId));
	assert.equal(lostControlNotice(moved.payload, b.clientId), null);
	assert.equal((await a.post(autonomy, { level: "yolo" })).status, 409);
	assert.equal((await b.post(autonomy, { level: "default" })).status, 200);

	// Closing releases it.
	assert.equal((await b.post(`/api/sessions/${session.id}/close`)).status, 200);
	const released = seen.filter((event) => event.type === "session.control").at(-1);
	assert.ok(released?.type === "session.control");
	assert.equal(released.payload.controller, null);

	// A session this server does not hold has no control to read or take.
	assert.equal((await a.request("/api/sessions/no-such-session/control")).status, 404);
	assert.equal((await a.post("/api/sessions/no-such-session/control")).status, 404);
});

test("a window that signs out stops working at once and hands its tasks on", async (t) => {
	const h = await harness();
	t.after(h.close);
	const seen: Event[] = [];
	t.after(h.hub.connect(undefined, (event) => seen.push(event)));
	const workspace = await h.workspaces.open(h.home.path);
	const a = await h.client("Window A");
	const b = await h.client("Window B");
	const session = await json(await a.post(`/api/workspaces/${workspace.id}/sessions`), SessionSnapshot);
	const autonomy = `/api/sessions/${session.id}/autonomy`;
	assert.equal((await b.post(autonomy, { level: "yolo" })).status, 409);
	const ticket = async () => ((await (await a.post("/api/events/ticket")).json()) as { ticket: string }).ticket;
	const stream = await h.app.request(`http://127.0.0.1:4317/api/events?ticket=${await ticket()}`);
	assert.equal(stream.status, 200);
	const unspent = await ticket();

	assert.equal((await a.post("/api/auth/revoke")).status, 200);
	// The open stream ends from the server's side rather than carrying events to a signed-out window.
	const reader = stream.body?.getReader();
	assert.ok(reader);
	t.after(() => reader.cancel());
	const ended = (async () => {
		for (;;) if ((await reader.read()).done) return true;
	})();
	assert.equal(await Promise.race([ended, setTimeout(5_000, false)]), true, "the revoked client's stream stayed open");
	assert.equal((await a.request("/api/meta")).status, 401);
	for (const path of ["/api/auth/rotate", "/api/auth/revoke", "/api/events/ticket"])
		assert.equal((await a.post(path)).status, 401, path);
	assert.equal((await h.app.request(`http://127.0.0.1:4317/api/events?ticket=${unspent}`)).status, 401);
	// Its task is free at once, and the viewer is told so instead of waiting out the holder's presence.
	const released = seen.filter((event) => event.type === "session.control").at(-1);
	assert.ok(released?.type === "session.control");
	assert.deepEqual(released.payload, {
		resource: session.id,
		controller: null,
		previous: { clientId: a.clientId, label: "Window A" },
	});
	assert.equal((await b.post(autonomy, { level: "yolo" })).status, 200);
	assert.equal((await b.request("/api/meta")).status, 200);
});

test("a holder that went away is claimed by the next window to act, never by one that only opened it", () => {
	let now = 1_000_000;
	const clients = new ClientRegistry(() => now);
	const events: Event[] = [];
	const hub = new EventHub();
	hub.connect(undefined, (event) => events.push(event));
	const controls = new SessionControls(clients, hub);
	const a = clients.open("Window A");
	const b = clients.open("Window B");
	controls.admit("s1", a.clientId);
	assert.throws(() => controls.admit("s1", b.clientId), /Window A controls this session/);
	controls.claimIfFree("s1", b.clientId);
	assert.equal(controls.controller("s1")?.clientId, a.clientId);
	// A's tab keeps its stream open, so it stays present however long it is idle.
	const record = clients.authenticate(a.credential);
	assert.ok(record);
	const release = clients.stream(record);
	now += PRESENCE_MS * 4;
	clients.authenticate(b.credential);
	assert.throws(() => controls.admit("s1", b.clientId));
	// The tab closes: once its presence lapses, the next request claims the session.
	release();
	now += PRESENCE_MS;
	clients.authenticate(b.credential);
	assert.equal(controls.controller("s1"), null);
	controls.admit("s1", b.clientId);
	assert.equal(controls.controller("s1")?.clientId, b.clientId);
	const claimed = events.filter((event) => event.type === "session.control").at(-1);
	assert.ok(claimed?.type === "session.control");
	// A holder that went away is not told it lost anything.
	assert.deepEqual(claimed.payload, {
		resource: "s1",
		controller: { clientId: b.clientId, label: "Window B" },
		previous: null,
	});
	// Acting again as the holder publishes nothing new.
	const count = events.length;
	controls.admit("s1", b.clientId);
	assert.equal(events.length, count);
});

test("an unconfirmed stop keeps the session, and a second stop forces the turn and parks the task", {
	timeout: 20000,
}, async (t) => {
	const h = await harness({}, { lanes: false });
	// The agent never answers `session/cancel`; a short injected wait stands in for the ten-second one.
	const supervisor = new Supervisor(
		h.workspaces,
		new AppFiles(join(h.home.path, "stop-state")),
		h.hub,
		{
			...h.home.env,
			CLIO_CODER_WEB_CLI: fileURLToPath(new URL("./fixtures/acp-fixture-child.mjs", import.meta.url)),
			CLIO_CODER_WEB_FIXTURE_SCENARIO: "cancel-unanswered",
			CLIO_CODER_WEB_FIXTURE_LOG: join(h.home.path, "stop.jsonl"),
			// The fixture looks for its own row in the children file of this supervisor's state directory.
			CLIO_CODER_STATE_DIR: join(h.home.path, "stop-state"),
		},
		4,
		undefined,
		undefined,
		undefined,
		50,
	);
	t.after(async () => {
		await supervisor.shutdown();
		await h.close();
	});
	const workspace = await h.workspaces.open(h.home.path),
		session = await supervisor.open(workspace.id);
	const { turnId } = supervisor.startTurn(session.id, "Work until stopped");
	await assert.rejects(supervisor.cancel(session.id, turnId), (error: unknown) => {
		const problem = (error as { problem?: Problem }).problem;
		return (
			problem?.code === "upstream_acp" &&
			problem.detail ===
				"CLIO Coder has not confirmed the stop yet. The turn may still end on its own; ask again to force it."
		);
	});
	assert.equal(supervisor.get(session.id).state, "open");
	assert.equal(supervisor.get(session.id).turns.at(-1)?.status, "running");
	await supervisor.cancel(session.id, turnId);
	const snapshot = supervisor.get(session.id),
		turn = snapshot.turns.at(-1);
	assert.equal(turn?.status, "failed");
	assert.equal(turn?.problem?.detail, "The turn was stopped by force because CLIO Coder did not confirm the stop.");
	assert.equal(snapshot.state, "parked");
});
