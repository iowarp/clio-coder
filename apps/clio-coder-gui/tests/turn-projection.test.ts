import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { routes } from "../contracts/routes.js";
import { SessionBuffer } from "../contracts/session-projection.js";
import { type SessionDelta, SessionDeltas } from "../contracts/sessions.js";
import { harness, json } from "./harness/app.js";

test("held GET snapshot replays newer deltas exactly once; a newer assembled snapshot covers already delivered deltas", {
	timeout: 10000,
}, async (t) => {
	let release = () => {},
		arrived = () => {};
	const held = new Promise<void>((resolve) => {
			release = resolve;
		}),
		holding = new Promise<void>((resolve) => {
			arrived = resolve;
		});
	const h = await harness(
		{},
		{
			snapshotHold: async () => {
				arrived();
				await held;
			},
		},
	);
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path),
		session = await h.supervisor.open(workspace.id),
		buffer = new SessionBuffer();
	const disconnect = h.hub.connect(undefined, (event) => {
		if (Object.hasOwn(SessionDeltas, event.type)) buffer.event(event as SessionDelta);
	});
	t.after(disconnect);
	const response = h.request(`/api/sessions/${session.id}`);
	await holding;
	h.supervisor.startTurn(session.id, "Hello");
	for (let i = 0; i < 100 && h.supervisor.get(session.id).turns.at(-1)?.status !== "succeeded"; i++)
		await setTimeout(20);
	release();
	const base = await json(await response, routes.session.response);
	const current = buffer.snapshot(base);
	assert.deepEqual(current, h.supervisor.get(session.id));
	assert.equal(
		current?.timeline
			.filter((item) => item.kind === "text")
			.map((item) => item.text)
			.join(""),
		"Hello from Clio.",
	);
	const assembledLater = await json(await h.request(`/api/sessions/${session.id}`), routes.session.response);
	assert.deepEqual(buffer.snapshot(assembledLater), current);
});

test("tool updates preserve locations and raw input while coalescing one card with provenance", {
	timeout: 10000,
}, async (t) => {
	const h = await harness({}, { scenario: "tool" });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path),
		session = await h.supervisor.open(workspace.id);
	h.supervisor.startTurn(session.id, "Read");
	for (let i = 0; i < 100 && h.supervisor.get(session.id).turns.at(-1)?.status !== "succeeded"; i++)
		await setTimeout(20);
	const tools = h.supervisor.get(session.id).timeline.filter((item) => item.kind === "tool");
	assert.equal(tools.length, 1);
	assert.equal(tools[0]?.status, "completed");
	assert.equal(tools[0]?.toolKind, "read");
	assert.deepEqual(tools[0]?.locations, [{ path: "README.md", line: 0 }]);
	assert.deepEqual(tools[0]?.rawInput, { path: "README.md" });
	assert.deepEqual(tools[0]?.rawOutput, { result: "Fixture documentation" });
	assert.equal(tools[0]?.provenance?.[0]?.agentId, "orchestrator");
});
