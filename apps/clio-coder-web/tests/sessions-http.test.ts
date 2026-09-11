import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { Problem } from "../contracts/common.js";
import type { Event } from "../contracts/events.js";
import { routes } from "../contracts/routes.js";
import { harness, json } from "./harness/app.js";

async function waitUntil(check: () => boolean) {
	for (let i = 0; i < 200; i++) {
		if (check()) return;
		await setTimeout(25);
	}
	throw new Error("Timed out waiting for a turn.");
}

test("workspace and session routes stream one complete turn with five usage fields and command idempotency", {
	timeout: 20000,
}, async (t) => {
	const h = await harness();
	t.after(h.close);
	const events: Event[] = [],
		disconnect = h.hub.connect(undefined, (event) => events.push(event));
	t.after(disconnect);
	const workspace = await json(await h.post("/api/workspaces", { path: h.home.path }), routes.openWorkspace.response);
	assert.equal((await h.request(`/api/workspaces/${workspace.id}/sessions`)).status, 200);
	const response = await h.post(`/api/workspaces/${workspace.id}/sessions`, {}, "new-session");
	assert.equal(response.status, 200);
	const session = await json(response, routes.newSession.response);
	const same = await json(
		await h.post(`/api/workspaces/${workspace.id}/sessions`, {}, "new-session"),
		routes.newSession.response,
	);
	assert.equal(session.id, same.id);
	const accepted = await json(
		await h.post(`/api/sessions/${session.id}/turns`, { text: "Hello" }, "prompt"),
		routes.turn.response,
	);
	const repeated = await json(
		await h.post(`/api/sessions/${session.id}/turns`, { text: "Hello" }, "prompt"),
		routes.turn.response,
	);
	assert.equal(accepted.turnId, repeated.turnId);
	assert.equal((await h.post(`/api/sessions/${session.id}/turns`, { text: "Different" }, "prompt")).status, 409);
	assert.equal((await h.post(`/api/sessions/${session.id}/turns`, { text: " " })).status, 422);
	await waitUntil(() => h.supervisor.get(session.id).turns.at(-1)?.status === "succeeded");
	const snapshotResponse = await h.request(`/api/sessions/${session.id}`),
		snapshot = await json(snapshotResponse, routes.session.response);
	assert.equal(Number(snapshotResponse.headers.get("X-Clio-Revision")), snapshot.revision);
	assert.equal(
		snapshot.timeline
			.filter((item) => item.kind === "text")
			.map((item) => item.text)
			.join(""),
		"Hello from Clio.",
	);
	assert.deepEqual(snapshot.turns.at(-1)?.usage, {
		input: 11,
		output: 12,
		cacheRead: 13,
		cacheWrite: 14,
		reasoning: 15,
	});
	const turnEvents = events.filter((event) => event.type.startsWith("turn."));
	assert.equal(turnEvents[0]?.type, "turn.started");
	assert.equal(turnEvents.at(-1)?.type, "turn.finished");
	assert.deepEqual(
		turnEvents.filter((event) => event.type === "turn.text").map((event) => event.payload.text),
		["Hello ", "from ", "Clio."],
	);
	assert.equal(turnEvents.filter((event) => event.type === "turn.finished").length, 1);
	await h.post(`/api/sessions/${session.id}/close`);
	assert.deepEqual(await h.files.read("children"), []);
});

test("permission rejection never executes and remote session admission codes remain upstream_acp problems", {
	timeout: 20000,
}, async (t) => {
	const h = await harness({}, { scenario: "permission" });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path),
		session = await h.supervisor.open(workspace.id);
	h.supervisor.startTurn(session.id, "Write a file");
	await waitUntil(() => h.supervisor.get(session.id).permissions.length > 0);
	const permission = h.supervisor.get(session.id).permissions[0];
	assert.ok(permission);
	assert.equal(
		(await h.post(`/api/sessions/${session.id}/permissions/${permission.id}`, { decision: "reject" })).status,
		200,
	);
	await waitUntil(() => h.supervisor.get(session.id).turns.at(-1)?.status === "succeeded");
	const state = h.supervisor.get(session.id);
	assert.ok(state.timeline.some((item) => item.kind === "notice" && item.text.includes("Permission rejected")));
	const log = await readFile(join(h.home.path, "acp.jsonl"), "utf8");
	assert.match(log, /"toolExecuted":false/);
	for (const code of ["session_limit", "session_cwd_mismatch"]) {
		const other = await harness({}, { scenario: code });
		try {
			const workspace = await other.workspaces.open(other.home.path);
			const response = await other.post(`/api/workspaces/${workspace.id}/sessions`);
			assert.equal(response.status, 409);
			const problem = await json(response, Problem);
			assert.equal(problem.code, "upstream_acp");
			assert.match(problem.detail, new RegExp(code));
		} finally {
			await other.close();
		}
	}
});

test("concurrent admission allows four ACP children and refuses the fifth without starting it", {
	timeout: 15000,
}, async (t) => {
	const h = await harness();
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path);
	const replies = await Promise.all(Array.from({ length: 5 }, () => h.post(`/api/workspaces/${workspace.id}/sessions`)));
	assert.equal(replies.filter((response) => response.status === 200).length, 4);
	assert.equal(replies.filter((response) => response.status === 409).length, 1);
	assert.equal((await h.supervisor.children.rows()).length, 4);
	await h.supervisor.shutdown();
	assert.deepEqual(await h.files.read("children"), []);
});
