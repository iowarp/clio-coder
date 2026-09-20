import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { Value } from "typebox/value";
import { Event } from "../contracts/events.js";
import { ACP_TO_WEB_EVENT } from "../contracts/fleet-events.js";
import { routes } from "../contracts/routes.js";
import { harness, json } from "./harness/app.js";

async function until(check: () => boolean) {
	for (let i = 0; i < 400; i++) {
		if (check()) return;
		await setTimeout(10);
	}
	throw new Error("Session control did not settle.");
}
test("permission allows once, restores pending snapshot, and rejects stale/duplicate conflicting decisions", {
	timeout: 15000,
}, async (t) => {
	const h = await harness({}, { scenario: "permission" });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path),
		session = await h.supervisor.open(workspace.id);
	const events: Event[] = [];
	t.after(h.hub.connect(undefined, (event) => events.push(event)));
	h.supervisor.startTurn(session.id, "Write the fixture");
	await until(() => h.supervisor.get(session.id).permissions.length === 1);
	const snapshot = await json(await h.request(`/api/sessions/${session.id}`), routes.session.response),
		permission = snapshot.permissions[0];
	assert.ok(permission);
	assert.equal(permission.status, "pending");
	assert.ok(snapshot.timeline.some((item) => item.toolCallId === permission.toolCallId));
	const path = `/api/sessions/${session.id}/permissions/${permission.id}`;
	assert.equal((await h.post(path, { decision: "allow-once" }, "answer")).status, 200);
	assert.equal((await h.post(path, { decision: "allow-once" }, "answer")).status, 200);
	assert.equal((await h.post(path, { decision: "reject" }, "answer")).status, 409);
	assert.equal((await h.post(path, { decision: "allow-once" })).status, 409);
	await until(() => h.supervisor.get(session.id).turns.at(-1)?.status === "succeeded");
	assert.match(await readFile(join(h.home.path, "acp.jsonl"), "utf8"), /"toolExecuted":true/);
	assert.equal(events.filter((event) => event.type === "permission.requested").length, 1);
	assert.equal(events.filter((event) => event.type === "permission.resolved").length, 1);
});
test("unanswered permission escalates then expires, cancels through ACP, and never executes", {
	timeout: 15000,
}, async (t) => {
	const h = await harness({}, { scenario: "permission", permissionTimers: { escalateMs: 80, budgetMs: 400 } });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path),
		session = await h.supervisor.open(workspace.id);
	const events: Event[] = [];
	t.after(h.hub.connect(undefined, (event) => events.push(event)));
	h.supervisor.startTurn(session.id, "Wait for approval");
	await until(() => h.supervisor.get(session.id).permissions[0]?.status === "escalated");
	await until(() => h.supervisor.get(session.id).turns.at(-1)?.status === "cancelled");
	const state = h.supervisor.get(session.id);
	assert.equal(state.turns.at(-1)?.stopReason, "cancelled");
	assert.equal(state.permissions[0]?.status, "expired");
	assert.deepEqual(
		events.filter((event) => event.type.startsWith("permission.")).map((event) => event.type),
		["permission.requested", "permission.escalated", "permission.expired"],
	);
	assert.equal(events.filter((event) => event.type === "turn.finished").length, 1);
	const log = await readFile(join(h.home.path, "acp.jsonl"), "utf8");
	assert.match(log, /"method":"session\/cancel"/);
	assert.match(log, /"toolExecuted":false/);
});
test("mismatched permission tool input fails closed without publishing an approval card", {
	timeout: 15000,
}, async (t) => {
	const h = await harness({}, { scenario: "permission-mismatch" });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path),
		session = await h.supervisor.open(workspace.id);
	h.supervisor.startTurn(session.id, "Write");
	await until(() => h.supervisor.get(session.id).turns.at(-1)?.status === "failed");
	assert.deepEqual(h.supervisor.get(session.id).permissions, []);
	assert.doesNotMatch(await readFile(join(h.home.path, "acp.jsonl"), "utf8"), /"toolExecuted":true/);
});
test("cancel mid-stream has one terminal and an old cancel cannot cancel the next turn", {
	timeout: 15000,
}, async (t) => {
	const h = await harness({}, { scenario: "loop" });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path),
		session = await h.supervisor.open(workspace.id);
	const events: Event[] = [];
	t.after(h.hub.connect(undefined, (event) => events.push(event)));
	const turn = h.supervisor.startTurn(session.id, "Stream");
	await until(() => events.filter((event) => event.type === "turn.text").length >= 20);
	const path = `/api/sessions/${session.id}/turns/${turn.turnId}/cancel`;
	assert.equal((await h.post(path)).status, 200);
	await until(() => h.supervisor.get(session.id).turns.at(-1)?.status === "cancelled");
	assert.equal(events.filter((event) => event.type === "turn.finished").length, 1);
	const next = h.supervisor.startTurn(session.id, "Next");
	assert.equal((await h.post(path)).status, 200);
	assert.equal(h.supervisor.get(session.id).turns.at(-1)?.status, "running");
	assert.equal((await h.post(`/api/sessions/${session.id}/turns/${next.turnId}/cancel`)).status, 200);
});
test("safe settings reject extra keys before ACP, project four keys, and expose bounded targets/probes/autonomy", {
	timeout: 15000,
}, async (t) => {
	const h = await harness();
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path),
		session = await h.supervisor.open(workspace.id),
		base = `/api/sessions/${session.id}`;
	const mutate = (path: string, body: unknown) =>
		h.request(path, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
			body: JSON.stringify(body),
		});
	const before = await readFile(join(h.home.path, "acp.jsonl"), "utf8");
	assert.equal((await mutate(`${base}/settings`, { "chat.apiKey": "must-not-cross" })).status, 422);
	assert.equal((await mutate(`${base}/settings`, { "chat.model": "\ninvalid" })).status, 422);
	assert.equal(await readFile(join(h.home.path, "acp.jsonl"), "utf8"), before);
	const settings = await json(await h.request(`${base}/settings`), routes.sessionSettings.response);
	assert.equal(settings.editable.length, 4);
	assert.doesNotMatch(JSON.stringify(settings), /must-be-stripped/);
	const changed = await json(
		await mutate(`${base}/settings`, { "chat.model": "next-model", "chat.thinkingLevel": "high" }),
		routes.patchSessionSettings.response,
	);
	assert.equal(changed.settings.chat.model, "next-model");
	assert.equal(changed.settings.chat.thinkingLevel, "high");
	const targets = await json(await h.request(`${base}/targets`), routes.sessionTargets.response);
	assert.equal(targets.truncated, true);
	assert.doesNotMatch(JSON.stringify(targets), /apiKey|must-be-stripped/);
	const probe = await json(await h.post(`${base}/targets/fixture/probe`), routes.probeSessionTarget.response);
	assert.equal(probe.healthy, true);
	assert.equal(probe.latencyMs, 5);
	const autonomy = await json(
		await h.post(`${base}/autonomy`, { level: "auto-edit" }),
		routes.setSessionAutonomy.response,
	);
	assert.equal(autonomy.level, "auto-edit");
	assert.equal((await h.request(`${base}/autonomy`)).status, 200);
});
test("all seven opted-in ACP event kinds reach valid bounded global envelopes and the retained strip", {
	timeout: 15000,
}, async (t) => {
	const h = await harness({}, { scenario: "fleet" });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path),
		session = await h.supervisor.open(workspace.id);
	const events: Event[] = [];
	t.after(h.hub.connect(undefined, (event) => events.push(event)));
	h.supervisor.startTurn(session.id, "Dispatch");
	await until(() => h.supervisor.get(session.id).turns.at(-1)?.status !== "running");
	const forwarded = events.filter((event) => event.type.startsWith("fleet.") || event.type === "evidence.ready");
	assert.deepEqual(
		forwarded.map((event) => event.type),
		Object.values(ACP_TO_WEB_EVENT),
	);
	for (const event of forwarded) {
		assert.ok(Value.Check(Event, event));
		assert.ok(Buffer.byteLength(JSON.stringify(event)) < 8192);
	}
	const state = await json(await h.request(`/api/sessions/${session.id}`), routes.session.response);
	assert.equal(state.fleet.length, 7);
	assert.doesNotMatch(JSON.stringify(state.fleet), /private|excludedProviderBody/);
	assert.equal(state.turns.at(-1)?.status, "succeeded");
});
