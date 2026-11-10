import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { Problem } from "../contracts/common.js";
import type { Event } from "../contracts/events.js";
import { routes } from "../contracts/routes.js";
import { acpProblem } from "../server/acp/client.js";
import { AcpProtocolError } from "../server/clio/http-shims.js";
import { harness, json } from "./harness/app.js";

test("ACP problems explain missing credentials and failed turns without forwarding upstream prose", () => {
	const failure = (code: unknown, reason?: unknown) =>
		acpProblem(
			new AcpProtocolError("private-provider-secret", {
				message: "private-provider-secret",
				data: { _meta: { "clio-coder/error": { code, reason } } },
			}),
		).problem;
	const missing = failure("prompt_not_admitted", "authentication-required");
	assert.equal(missing.code, "upstream_acp");
	assert.match(missing.detail, /credentials.*selected target/);
	assert.match(missing.detail, /clio-coder auth login/);
	assert.match(missing.detail, /close and reopen/);
	assert.match(failure("turn_failed").detail, /session's trace/);
	// A screened `/name` line is explained in the app's own words; the agent's sentence is not forwarded.
	assert.match(failure("unknown_command").detail, /not a command or a loaded prompt template.*nothing was sent/);
	assert.match(failure("command_unavailable").detail, /command list/);
	for (const problem of [
		failure("unknown_command"),
		failure("command_unavailable"),
		missing,
		failure("turn_failed"),
		failure("prompt_not_admitted", "private-provider-secret"),
		failure("private-provider-secret"),
	])
		assert.doesNotMatch(JSON.stringify(problem), /private-provider-secret/);
});

/**
 * Waits for a state the test drives toward. The bound is past every test's own timeout, so a slow host fails on the
 * test's budget and a stuck one never leaves this loop running after its test.
 */
async function waitUntil(check: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 30_000;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for a turn.");
		await setTimeout(25);
	}
}

for (const scenario of ["steer", "queue-push"]) {
	test(`idle parking preserves held operator messages with ${scenario} updates`, { timeout: 20000 }, async (t) => {
		const h = await harness({}, { scenario, parkAfterMs: 100, lanes: false });
		t.after(h.close);
		const workspace = await h.workspaces.open(h.home.path);
		const held = await h.supervisor.open(workspace.id);
		const turn = h.supervisor.startTurn(held.id, "[hold] Wait for the operator");
		await h.supervisor.steer(held.id, { text: "unsent operator work", mode: "end-of-turn" });
		await h.supervisor.cancel(held.id, turn.turnId);
		await waitUntil(() => h.supervisor.get(held.id).turns.at(-1)?.status === "cancelled");
		const empty = await h.supervisor.open(workspace.id);
		h.supervisor.startTurn(empty.id, "Nothing waits after this");
		await waitUntil(() => h.supervisor.get(empty.id).state === "parked");
		assert.equal(h.supervisor.get(held.id).state, "open");
		assert.deepEqual((await h.supervisor.queue(held.id)).followUp, ["unsent operator work"]);
		await h.supervisor.clearQueue(held.id);
		await waitUntil(() => h.supervisor.get(held.id).state === "parked");
	});
}

test("idle parking keeps a child whose queue ownership cannot be read", { timeout: 20000 }, async (t) => {
	const h = await harness({}, { scenario: "steer", parkAfterMs: 100, lanes: false });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path);
	const held = await h.supervisor.open(workspace.id);
	h.supervisor.startTurn(held.id, "[unreadable-queue]");
	await waitUntil(() => h.supervisor.get(held.id).turns.at(-1)?.status === "succeeded");
	const empty = await h.supervisor.open(workspace.id);
	h.supervisor.startTurn(empty.id, "No waiting messages");
	await waitUntil(() => h.supervisor.get(empty.id).state === "parked");
	assert.equal(h.supervisor.get(held.id).state, "open");
	await assert.rejects(h.supervisor.queue(held.id));
});

test("workspace and session routes stream one complete turn with recorded usage and cost and command idempotency", {
	timeout: 20000,
}, async (t) => {
	const h = await harness({}, { lanes: false });
	t.after(h.close);
	const events: Event[] = [],
		disconnect = h.hub.connect(undefined, (event) => events.push(event));
	t.after(disconnect);
	const workspace = await json(await h.post("/api/workspaces", { path: h.home.path }), routes.openWorkspace.response);
	const legacyHistory = await h.request(`/api/workspaces/${workspace.id}/sessions`);
	assert.equal(legacyHistory.status, 409);
	assert.equal((await json(legacyHistory, Problem)).code, "unsupported");
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
	const usage = snapshot.turns.at(-1)?.usage;
	assert.equal(usage?.quantities?.total.display, "50");
	assert.equal(usage?.quantities?.usd.display, "not measured");
	const turnEvents = events.filter((event) => event.type.startsWith("turn."));
	assert.equal(turnEvents[0]?.type, "turn.started");
	assert.equal(turnEvents.at(-1)?.type, "turn.finished");
	assert.deepEqual(
		turnEvents.filter((event) => event.type === "turn.text").map((event) => event.payload.text),
		["Hello ", "from ", "Clio."],
	);
	assert.equal(turnEvents.filter((event) => event.type === "turn.finished").length, 1);
	const finished = events.find((event) => event.type === "turn.finished");
	// Session spend is the read model's; neither the snapshot nor the turn event folds one (#434).
	assert.equal(finished && "costDisplay" in finished.payload, false);
	assert.equal("costDisplay" in snapshot, false);
	await h.post(`/api/sessions/${session.id}/close`);
	assert.deepEqual(await h.files.read("children"), []);
});

test("permission rejection never executes and remote session admission codes remain upstream_acp problems", {
	timeout: 20000,
}, async (t) => {
	const h = await harness({}, { scenario: "permission", lanes: false });
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
		const other = await harness({}, { scenario: code, lanes: false });
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

test("open sessions are not limited: a fifth and a sixth ACP child start beside the first four", {
	timeout: 15000,
}, async (t) => {
	const h = await harness({}, { lanes: false });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path);
	const replies = await Promise.all(Array.from({ length: 6 }, () => h.post(`/api/workspaces/${workspace.id}/sessions`)));
	assert.equal(replies.filter((response) => response.status === 200).length, 6);
	assert.equal((await h.supervisor.children.rows()).length, 6);
	await h.supervisor.shutdown();
	assert.deepEqual(await h.files.read("children"), []);
});

test("a request carries text files to the agent as ACP embedded resources, only when it accepts them", {
	timeout: 20000,
}, async (t) => {
	const h = await harness({}, { scenario: "markdown", lanes: false });
	t.after(h.close);
	const workspace = await json(await h.post("/api/workspaces", { path: h.home.path }), routes.openWorkspace.response);
	const session = await json(
		await h.post(`/api/workspaces/${workspace.id}/sessions`, {}, "files-session"),
		routes.newSession.response,
	);
	const capabilities = await json(
		await h.request(`/api/sessions/${session.id}/capabilities`),
		routes.sessionCapabilities.response,
	);
	assert.equal(capabilities.embeddedContext, true);
	const turn = await h.post(
		`/api/sessions/${session.id}/turns`,
		{ text: "Summarize these.", files: [{ name: "field notes.md", text: "sample A: 4.2\n" }] },
		"files-turn",
	);
	assert.equal(turn.status, 202);
	let log = "";
	await waitUntil(async () => {
		log = await readFile(join(h.home.path, "acp.jsonl"), "utf8").catch(() => "");
		return log.includes('"session/prompt"');
	});
	const prompt = log
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { method?: string; params?: { prompt?: Array<Record<string, unknown>> } })
		.find((frame) => frame.method === "session/prompt");
	assert.deepEqual(prompt?.params?.prompt?.[1], {
		type: "resource",
		resource: { uri: "attachment:field%20notes.md", mimeType: "text/plain", text: "sample A: 4.2\n" },
	});
	const snapshot = await json(await h.request(`/api/sessions/${session.id}`), routes.session.response);
	assert.equal(snapshot.turns.at(-1)?.files, 1);
	// Too many, or a control character in a name, is refused before anything reaches the agent.
	const tooMany = await h.post(
		`/api/sessions/${session.id}/turns`,
		{ text: "Too many.", files: Array.from({ length: 5 }, (_, index) => ({ name: `${index}.md`, text: "x" })) },
		"files-too-many",
	);
	assert.equal(tooMany.status, 422);
	const badName = await h.post(
		`/api/sessions/${session.id}/turns`,
		{ text: "Bad.", files: [{ name: "a\u001b.md", text: "x" }] },
		"files-bad-name",
	);
	assert.equal(badName.status, 422);
});

test("an agent that did not announce embedded context is never sent a file", { timeout: 20000 }, async (t) => {
	const h = await harness({}, { lanes: false });
	t.after(h.close);
	const workspace = await json(await h.post("/api/workspaces", { path: h.home.path }), routes.openWorkspace.response);
	const session = await json(
		await h.post(`/api/workspaces/${workspace.id}/sessions`, {}, "plain-session"),
		routes.newSession.response,
	);
	const refused = await h.post(
		`/api/sessions/${session.id}/turns`,
		{ text: "Read this.", files: [{ name: "a.md", text: "x" }] },
		"plain-files",
	);
	assert.equal(refused.status, 409);
});

test("a request carries images to the agent as ACP image blocks, within the one-line bound", {
	timeout: 20000,
}, async (t) => {
	const h = await harness({}, { scenario: "markdown", lanes: false });
	t.after(h.close);
	const workspace = await json(await h.post("/api/workspaces", { path: h.home.path }), routes.openWorkspace.response);
	const session = await json(
		await h.post(`/api/workspaces/${workspace.id}/sessions`, {}, "images-session"),
		routes.newSession.response,
	);
	const capabilities = await json(
		await h.request(`/api/sessions/${session.id}/capabilities`),
		routes.sessionCapabilities.response,
	);
	assert.equal(capabilities.images, true);
	// Past the 64 KiB every other route allows, and inside the agent's line.
	const data = Buffer.alloc(150_000, 7).toString("base64");
	const turn = await h.post(
		`/api/sessions/${session.id}/turns`,
		{ text: "Describe these.", images: [{ mimeType: "image/png", data }] },
		"images-turn",
	);
	assert.equal(turn.status, 202);
	let log = "";
	await waitUntil(async () => {
		log = await readFile(join(h.home.path, "acp.jsonl"), "utf8").catch(() => "");
		return log.includes('"session/prompt"');
	});
	const prompt = log
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { method?: string; params?: { prompt?: Array<{ type: string }> } })
		.find((frame) => frame.method === "session/prompt");
	assert.deepEqual(
		prompt?.params?.prompt?.map((block) => block.type),
		["text", "image"],
	);
	const tooMany = await h.post(
		`/api/sessions/${session.id}/turns`,
		{ text: "Too many.", images: Array.from({ length: 5 }, () => ({ mimeType: "image/png", data: "AAAA" })) },
		"images-too-many",
	);
	assert.equal(tooMany.status, 422);
	const other = await h.post(`/api/sessions/${session.id}/steer`, { text: "x".repeat(70 * 1024) }, "big-steer");
	assert.equal(other.status, 422, "every other route keeps its 64 KiB body limit");
});
