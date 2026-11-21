import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { Problem } from "../contracts/common.js";
import type { Event } from "../contracts/events.js";
import { routes } from "../contracts/routes.js";
import { acpProblem } from "../server/acp/client.js";
import { AcpProtocolError } from "../server/clio/http-shims.js";
import { harness, json } from "./harness/app.js";
import { seedHistory } from "./harness/history-fixture.js";

const { QueryClient } = await import("@tanstack/react-query");
const { ApiProblem } = await import("../client/api/client.js");
const { sessionQuery } = await import("../client/api/session-query.js");

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

test("an engine rename becomes the task's label once, and a new command list bumps the session's counter", {
	timeout: 20000,
}, async (t) => {
	const h = await harness({}, { lanes: false });
	t.after(h.close);
	const events: Event[] = [];
	t.after(h.hub.connect(undefined, (event) => events.push(event)));
	const workspace = await h.workspaces.open(h.home.path);
	const session = await h.supervisor.open(workspace.id);
	const before = h.supervisor.get(session.id).telemetry?.commandsRevision ?? 0;
	h.supervisor.startTurn(session.id, "[rename] Hello");
	await waitUntil(() => h.supervisor.get(session.id).turns.at(-1)?.status === "succeeded");
	const labelled = events.filter((event) => event.type === "session.labelled" && event.payload.resource === session.id);
	assert.deepEqual(
		labelled.map((event) => (event.type === "session.labelled" ? event.payload.label : null)),
		["Renamed"],
		"a repeated title is not a second rename",
	);
	const overview = await json(await h.request("/api/sessions/overview"), routes.sessionOverview.response);
	assert.equal(overview.sessions.find((item) => item.id === session.id)?.title, "Renamed");
	const counted = events.filter(
		(event) =>
			event.type === "session.telemetry" &&
			event.payload.resource === session.id &&
			event.payload.telemetry.commandsRevision !== undefined,
	);
	assert.equal(counted.length, 1);
	assert.equal(h.supervisor.get(session.id).telemetry?.commandsRevision, before + 1);
});

test("the session overview names the live workers the engine holds, past the feed's bound", {
	timeout: 20000,
}, async (t) => {
	const h = await harness({}, { scenario: "steer", lanes: false });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path);
	const session = await h.supervisor.open(workspace.id);
	const turn = h.supervisor.startTurn(session.id, "[fleet] Survey");
	const listed = async () =>
		(await json(await h.request("/api/sessions/overview"), routes.sessionOverview.response)).sessions.find(
			(item) => item.id === session.id,
		);
	await waitUntil(async () => ((await listed())?.runs.length ?? 0) > 0);
	const item = await listed();
	assert.deepEqual(item?.runs, [{ runId: "run-live-1", agentId: "scout", state: "active", node: null }]);
	assert.equal(item?.activeWorkers, 1);
	await h.supervisor.cancel(session.id, turn.turnId);
	await waitUntil(async () => (await listed())?.runs.length === 0);
});

test("saved tasks come from the ledger with no engine started, and a resume starts only its own", {
	timeout: 30000,
}, async (t) => {
	// The default fixture runtime does not announce session/list; the ledger answers anyway.
	const h = await harness({});
	t.after(h.close);
	await mkdir(join(h.home.path, "field-notes"));
	await mkdir(join(h.home.path, "elsewhere"));
	const project = await realpath(join(h.home.path, "field-notes")),
		elsewhere = await realpath(join(h.home.path, "elsewhere"));
	await seedHistory(h.home.path, project);
	const ledger = join(h.home.path, "state", "sessions"),
		[bucket = ""] = await readdir(ledger),
		seeded = join(ledger, bucket, "seeded-1");
	const meta = JSON.parse(await readFile(join(seeded, "meta.json"), "utf8")) as Record<string, unknown>,
		transcript = (await readFile(join(seeded, "current.jsonl"), "utf8")).trim().split("\n");
	// Two records in the project's own ledger directory that the engine's session/list would not return.
	const extra = async (id: string, fields: Record<string, unknown>, lines: string[]) => {
		await mkdir(join(ledger, bucket, id));
		await writeFile(join(ledger, bucket, id, "meta.json"), JSON.stringify({ ...meta, id, ...fields }));
		await writeFile(join(ledger, bucket, id, "current.jsonl"), `${lines.join("\n").replaceAll("seeded-1", id)}\n`);
	};
	await extra("elsewhere-1", { cwd: elsewhere, name: "Another project's task" }, transcript);
	await extra("unanswered-1", { name: "A task the model never answered" }, transcript.slice(0, 2));
	const controls = t.mock.method(h.supervisor, "workspaceControl");
	const workspace = await json(await h.post("/api/workspaces", { path: project }), routes.openWorkspace.response);
	const history = await json(
		await h.request(`/api/workspaces/${workspace.id}/sessions`),
		routes.sessionHistory.response,
	);
	assert.deepEqual(
		history.map((row) => [row.id, row.name ?? row.firstMessagePreview]),
		[
			["seeded-1", "Survey the sensor calibration notes"],
			["seeded-2", "Why does the reduction step drop the last sample of every run? Look at reduce.py and the tests."],
			["seeded-3", "Draft the methods section figures"],
		],
	);
	assert.ok(history.every((row) => row.workspaceId === workspace.id));
	assert.equal(history[2]?.endedAt, null);
	assert.equal(controls.mock.callCount(), 0);
	assert.deepEqual(await h.files.read("children"), []);
	const loaded = await h.post("/api/sessions/seeded-1/load", { workspaceId: workspace.id });
	assert.equal(loaded.status, 200, await loaded.clone().text());
	const session = await json(loaded, routes.loadSession.response);
	assert.equal(controls.mock.callCount(), 0);
	assert.equal(((await h.files.read("children")) as unknown[]).length, 1);
	await h.post(`/api/sessions/${session.id}/close`);
	// An id the ledger does not hold asks the engine once before it is refused.
	const missing = await h.post("/api/sessions/perf-history/load", { workspaceId: workspace.id });
	assert.equal(missing.status, 404);
	assert.equal(controls.mock.callCount(), 1);
});

test("a saved task only the engine's session/list knows still loads", { timeout: 30000 }, async (t) => {
	const h = await harness({}, { env: { CLIO_CODER_WEB_FIXTURE_REPLAY_TURNS: "1" } });
	t.after(h.close);
	const workspace = await json(await h.post("/api/workspaces", { path: h.home.path }), routes.openWorkspace.response);
	const history = await json(
		await h.request(`/api/workspaces/${workspace.id}/sessions`),
		routes.sessionHistory.response,
	);
	assert.deepEqual(history, []);
	const loaded = await h.post("/api/sessions/perf-history/load", { workspaceId: workspace.id });
	assert.equal(loaded.status, 200, await loaded.clone().text());
	const session = await json(loaded, routes.loadSession.response);
	assert.equal(session.id, "perf-history");
	// The saved name is the title, never the first replayed prompt (inspection F15).
	assert.equal(session.label, "A long saved conversation");
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

test("a saved task another process holds names its holder, keeps its history readable and is never loaded here (#439)", {
	timeout: 30000,
}, async (t) => {
	const h = await harness({});
	t.after(h.close);
	await mkdir(join(h.home.path, "field-notes"));
	const project = await realpath(join(h.home.path, "field-notes"));
	await seedHistory(h.home.path, project);
	const ledger = join(h.home.path, "state", "sessions"),
		[bucket = ""] = await readdir(ledger),
		metaPath = join(ledger, bucket, "seeded-3", "meta.json");
	const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
	// A holder on another node: its pid cannot be probed from here, so the stamped owner alone names it.
	await writeFile(metaPath, JSON.stringify({ ...meta, owner: { host: "far-node", pid: 4242, birth: null } }));
	const workspace = await json(await h.post("/api/workspaces", { path: project }), routes.openWorkspace.response);
	const held = async () =>
		(await json(await h.request(`/api/workspaces/${workspace.id}/sessions`), routes.sessionHistory.response)).find(
			(row) => row.id === "seeded-3",
		)?.liveElsewhere;
	const unregistered = await held();
	assert.equal(unregistered?.host, "far-node");
	assert.equal(unregistered?.pid, 4242);
	assert.equal(unregistered?.surface, "process");
	// No live record means no heartbeat to ask through, so Take over is refused rather than guessed.
	assert.equal(unregistered?.canTakeOver, false);
	// Opening it asks whether this server holds it, and that answer is never a 404 in the browser console.
	const presence = await h.request("/api/sessions/seeded-3/presence");
	assert.equal(presence.status, 200, await presence.clone().text());
	assert.deepEqual(await json(presence, routes.sessionPresence.response), { open: false });
	const asked: string[] = [];
	const client = {
		call: async (route: { path: string }, input: { params: Record<string, string> }) => {
			const path = route.path.replace(/:(\w+)/gu, (_, name: string) => input.params[name] ?? "");
			asked.push(path);
			const response = await h.request(path);
			if (!response.ok) throw new ApiProblem(await response.json());
			return response.json();
		},
	} as unknown as Parameters<typeof sessionQuery>[0];
	const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	t.after(() => queries.clear());
	const opened = await queries.fetchQuery(sessionQuery(client, "seeded-3")).then(
		() => null,
		(error: unknown) => error,
	);
	assert.ok(opened instanceof ApiProblem, String(opened));
	assert.equal(opened.problem.code, "not_found");
	assert.deepEqual(asked, ["/api/sessions/seeded-3/presence"]);
	const loaded = await h.post("/api/sessions/seeded-3/load", { workspaceId: workspace.id });
	assert.equal(loaded.status, 409, await loaded.clone().text());
	assert.deepEqual(await h.files.read("children"), []);
	const refused = await h.post(`/api/workspaces/${workspace.id}/sessions/seeded-3/take-over`, {});
	assert.equal(refused.status, 409, await refused.clone().text());
	const transcript = await json(
		await h.request(`/api/workspaces/${workspace.id}/sessions/seeded-3/transcript`),
		routes.storedTranscript.response,
	);
	assert.match(transcript.markdown, /Draft the methods section figures/);
	assert.equal(transcript.truncated, false);
	// A fresh heartbeat from the holder's terminal makes it a terminal holder that Take over can ask to end.
	const startedAt = new Date(Date.now() - 600_000).toISOString();
	await mkdir(join(h.home.path, "state", "live"), { recursive: true });
	await writeFile(
		join(h.home.path, "state", "live", "seeded-3.json"),
		JSON.stringify({
			schema: 1,
			id: "seeded-3",
			cwd: project,
			cwdHash: bucket,
			host: "far-node",
			pid: 4242,
			birth: null,
			startedAt,
			at: new Date().toISOString(),
			surface: "tui",
			version: "0",
			user: "field",
		}),
	);
	const registered = await held();
	assert.equal(registered?.surface, "terminal");
	assert.equal(registered?.since, startedAt);
	assert.equal(registered?.stale, false);
	assert.equal(registered?.canTakeOver, true);
});
