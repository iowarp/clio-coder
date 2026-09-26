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
test("session config retains open/load options, publishes updates, and never saves conversation choices", {
	timeout: 15000,
}, async (t) => {
	const h = await harness({}, { scenario: "markdown", env: { CLIO_CODER_WEB_FIXTURE_ROUTE: "1" } });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path);
	const session = await h.supervisor.open(workspace.id);
	const base = `/api/sessions/${session.id}`;
	const configOf = (snapshot: unknown) =>
		(snapshot as { config?: { options: Array<{ id: string; currentValue: string }> } }).config;
	assert.equal(configOf(session)?.options.find((option) => option.id === "model")?.currentValue, "fixture-model");
	const events: Event[] = [];
	t.after(h.hub.connect(undefined, (event) => events.push(event)));
	const before = await readFile(join(h.home.path, "acp.jsonl"), "utf8");
	assert.equal((await h.post(`${base}/config`, { configId: "target", value: "other" })).status, 422);
	assert.equal((await h.post(`${base}/config`, { configId: "model", value: "not-listed" })).status, 422);
	assert.equal(await readFile(join(h.home.path, "acp.jsonl"), "utf8"), before);
	const choice = { configId: "model", value: "fixture-small" };
	const changed = await h.post(`${base}/config`, choice, "model-choice");
	assert.equal(changed.status, 200);
	assert.equal((await h.post(`${base}/config`, choice, "model-choice")).status, 200);
	assert.equal((await h.post(`${base}/config`, { configId: "thinkingLevel", value: "high" })).status, 200);
	const snapshot = h.supervisor.get(session.id);
	assert.equal(configOf(snapshot)?.options.find((option) => option.id === "model")?.currentValue, "fixture-small");
	assert.equal(configOf(snapshot)?.options.find((option) => option.id === "thinkingLevel")?.currentValue, "high");
	assert.ok(events.some((event) => event.type === ("session.configured" as Event["type"])));
	for (const event of events) assert.ok(Value.Check(Event, event));
	const log = await readFile(join(h.home.path, "acp.jsonl"), "utf8");
	assert.equal(log.match(/"method":"session\/set_config_option"/g)?.length, 2);
	assert.doesNotMatch(log, /settings\/patch_safe/);
	h.supervisor.startTurn(session.id, "[stream]");
	assert.equal((await h.post(`${base}/config`, { configId: "thinkingLevel", value: "low" })).status, 409);
	await h.supervisor.close(session.id);
	const loaded = await h.supervisor.open(workspace.id, session.id);
	assert.equal(configOf(loaded)?.options.find((option) => option.id === "model")?.currentValue, "fixture-model");
	assert.ok(loaded.timeline.some((item) => item.origin === "replay"));
});

test("an older ACP peer has no conversation config and refuses the write locally", async (t) => {
	const h = await harness();
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path);
	const session = await h.supervisor.open(workspace.id);
	const before = await readFile(join(h.home.path, "acp.jsonl"), "utf8");
	assert.equal(
		(await h.post(`/api/sessions/${session.id}/config`, { configId: "model", value: "fixture-model" })).status,
		409,
	);
	assert.equal(await readFile(join(h.home.path, "acp.jsonl"), "utf8"), before);
});

test("a task hand command owns a visible turn, waits for output, and admits the next request", async (t) => {
	const h = await harness({}, { scenario: "markdown" });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path);
	const session = await h.supervisor.open(workspace.id);
	const base = `/api/sessions/${session.id}`;
	assert.equal((await h.post(`${base}/commands`, { command: "tasks", argv: ["add", "Proof task"] })).status, 200);
	const command = h.post(`${base}/commands`, { command: "tasks", argv: ["hand", "u1"] }, "hand-task");
	await until(() => h.supervisor.get(session.id).turns.at(-1)?.status === "running");
	assert.equal((await h.post(`${base}/turns`, { text: "Too soon" })).status, 409);
	assert.equal((await command).status, 200);
	assert.equal((await h.post(`${base}/commands`, { command: "tasks", argv: ["hand", "u1"] }, "hand-task")).status, 200);
	const snapshot = h.supervisor.get(session.id);
	assert.equal(snapshot.turns.length, 1);
	assert.equal(snapshot.turns[0]?.prompt, "/tasks hand u1");
	assert.equal(snapshot.turns[0]?.status, "succeeded");
	assert.ok(snapshot.timeline.some((item) => item.kind === "text" && item.text.includes("Working on the handed task")));
	assert.equal((await h.supervisor.board(session.id)).operatorTasks[0]?.status, "handed");
	assert.equal(
		(await readFile(join(h.home.path, "acp.jsonl"), "utf8")).match(/"method":"_clio-coder\/commands\/invoke"/g)?.length,
		1,
	);
	assert.equal((await h.post(`${base}/turns`, { text: "Next" })).status, 202);
	await until(() => h.supervisor.get(session.id).turns.at(-1)?.status !== "running");
	assert.equal(h.supervisor.get(session.id).turns.at(-1)?.status, "succeeded");
});

test("an older command peer refuses injected turns without submitting unrecognised slash text", async (t) => {
	const h = await harness({}, { scenario: "markdown", env: { CLIO_CODER_WEB_FIXTURE_PROMPT_TURNS: "0" } });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path);
	const session = await h.supervisor.open(workspace.id);
	assert.equal(
		(await h.post(`/api/sessions/${session.id}/commands`, { command: "skill", argv: ["survey"] })).status,
		409,
	);
	assert.equal(h.supervisor.get(session.id).turns.length, 0);
	assert.doesNotMatch(
		await readFile(join(h.home.path, "acp.jsonl"), "utf8"),
		/"method":"session\/prompt"|"method":"_clio-coder\/commands\/invoke"/,
	);
});
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
	assert.equal(h.supervisor.capabilities(session.id).session?.autonomy, true);
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
		await h.post(`${base}/autonomy`, { level: "default" }),
		routes.setSessionAutonomy.response,
	);
	assert.equal(autonomy.level, "default");
	assert.equal((await h.request(`${base}/autonomy`)).status, 200);
});
test("all eleven opted-in ACP event kinds reach valid bounded global envelopes, an unknown kind is dropped, and both strips retain", {
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
	const forwarded = events.filter(
		(event) => event.type.startsWith("fleet.") || event.type.startsWith("health.") || event.type === "evidence.ready",
	);
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
	assert.equal(state.health.length, 4);
	assert.doesNotMatch(JSON.stringify(state.fleet), /private|excludedProviderBody/);
	assert.doesNotMatch(JSON.stringify(state.health), /private|excludedProviderBody/);
	// The fixture also sends a kind this build has never heard of. It must be
	// dropped rather than fail the turn and retire the child.
	assert.equal(state.turns.at(-1)?.status, "succeeded");
	assert.equal(state.state, "open");
});
