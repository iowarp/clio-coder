import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { lostControlNotice } from "../client/chat/control-model.js";
import { Problem } from "../contracts/common.js";
import { SessionControl } from "../contracts/control.js";
import type { Event } from "../contracts/events.js";
import { SessionSnapshot } from "../contracts/sessions.js";
import { ClientRegistry, PRESENCE_MS } from "../server/services/clients.js";
import { EventHub } from "../server/services/event-hub.js";
import { SessionControls } from "../server/services/session-control.js";
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
