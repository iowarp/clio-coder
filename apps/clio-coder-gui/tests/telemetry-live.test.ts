import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { telemetryInvalidations } from "../client/telemetry/live-model.js";
import type { Event } from "../contracts/events.js";
import { routes } from "../contracts/routes.js";
import { harness, json } from "./harness/app.js";

test("a telemetry_update names the reads to refresh and folds nothing (#434)", () => {
	assert.deepEqual(telemetryInvalidations({ topics: ["session", "cost"] }), ["telemetry", "session-usage"]);
	assert.deepEqual(telemetryInvalidations({ topics: ["cache", "timeline", "runs"] }), ["telemetry"]);
	assert.deepEqual(telemetryInvalidations({ topics: ["quota", "health"] }), []);
	assert.deepEqual(telemetryInvalidations({ topics: [] }), []);
});

test("the agent's telemetry_update reaches the browser as a telemetry.updated event for its session", {
	timeout: 20_000,
}, async (t) => {
	const h = await harness({}, { scenario: "telemetry" });
	t.after(h.close);
	const events: Event[] = [];
	t.after(h.hub.connect(undefined, (event) => events.push(event)));
	const workspace = await json(await h.post("/api/workspaces", { path: h.home.path }), routes.openWorkspace.response);
	const session = await json(
		await h.post(`/api/workspaces/${workspace.id}/sessions`, {}, "new-session"),
		routes.newSession.response,
	);
	const capabilities = await json(
		await h.request(`/api/sessions/${session.id}/capabilities`),
		routes.sessionCapabilities.response,
	);
	assert.equal(capabilities.telemetry?.update, "_clio-coder/telemetry/update");
	await h.post(`/api/sessions/${session.id}/turns`, { text: "Hello" }, "prompt");
	const updated = () => events.find((event) => event.type === "telemetry.updated");
	for (let i = 0; i < 200 && !updated(); i++) await setTimeout(25);
	const event = updated();
	assert.ok(event && event.type === "telemetry.updated", "telemetry.updated arrived");
	assert.equal(event.payload.resource, session.id);
	assert.deepEqual(event.payload.update.topics, ["session", "cost"]);
	assert.equal(event.payload.update.sessionId, session.id);
});
