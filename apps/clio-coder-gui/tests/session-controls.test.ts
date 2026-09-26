import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("a prompt-turn command runs as a visible turn with its dispatch call inside it", async (t) => {
	const h = await harness({}, { scenario: "markdown" });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path);
	const session = await h.supervisor.open(workspace.id);
	const response = await h.post(`/api/sessions/${session.id}/commands`, {
		command: "council",
		argv: ["--roster", "review", "Compare the samples"],
	});
	assert.equal(response.status, 200);
	const snapshot = h.supervisor.get(session.id);
	assert.equal(snapshot.turns.at(-1)?.prompt, "/council --roster review Compare the samples");
	assert.equal(snapshot.turns.at(-1)?.status, "succeeded");
	assert.ok(
		snapshot.timeline.some((item) => item.kind === "tool" && item.title === "dispatch" && item.status === "completed"),
	);
	assert.doesNotMatch(
		await readFile(join(h.home.path, "acp.jsonl"), "utf8"),
		/"method":"_clio-coder\/commands\/invoke"/,
	);
});

test("the context window is read from the agent, and recovery runs as a visible turn", async (t) => {
	const h = await harness({}, { scenario: "markdown" });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path);
	const session = await h.supervisor.open(workspace.id);
	const base = `/api/sessions/${session.id}`;
	const ledger = await json(await h.request(`${base}/context`), routes.sessionContext.response);
	assert.equal(ledger.usedTokens, 20480);
	assert.equal(ledger.measured, true);
	const recovered = await h.post(`${base}/commands`, { command: "context", argv: ["recover", "h1", "deliver"] });
	assert.equal(recovered.status, 200);
	const turn = h.supervisor.get(session.id).turns.at(-1);
	assert.equal(turn?.prompt, "/context recover h1 deliver");
	assert.equal(turn?.status, "succeeded");
	assert.ok(h.supervisor.get(session.id).timeline.some((item) => item.text.includes("The paused turn continued")));
	const reset = await h.post(`${base}/commands`, { command: "context", argv: ["reset", "--yes"] });
	assert.equal(reset.status, 200);
	assert.equal(h.supervisor.get(session.id).turns.length, 1, "a reset is a control reply, not a turn");
});

test("a decision is superseded once and its correction becomes a visible request; proposals need review", async (t) => {
	const h = await harness({}, { scenario: "markdown" });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path);
	const session = await h.supervisor.open(workspace.id);
	const base = `/api/sessions/${session.id}`;
	const board = await json(await h.request(`${base}/board`), routes.sessionBoard.response);
	assert.equal(board.decisions[0]?.interviewId, "interview-1");
	assert.equal(board.memory?.bank?.length, 2);
	const body = { interviewId: "interview-1", key: "format", correction: "HTML with one table" };
	const superseded = await json(await h.post(`${base}/decisions/supersede`, body), routes.supersedeDecision.response);
	assert.equal(superseded.status, "superseded");
	assert.match(
		superseded.status === "superseded" ? (superseded.correctionTurn ?? "") : "",
		/New direction: HTML with one table/,
	);
	const again = await json(await h.post(`${base}/decisions/supersede`, body), routes.supersedeDecision.response);
	assert.equal(again.status, "already_superseded");
	assert.equal((await readFile(join(h.home.path, "acp.jsonl"), "utf8")).match(/"superseded":"format"/g)?.length, 1);
	const global = { entryId: "k1", scope: "global" as const };
	const unacknowledged = await json(await h.post(`${base}/memory/propose`, global), routes.proposeMemory.response);
	assert.equal(unacknowledged.status, "needs_acknowledgement");
	const proposed = await json(
		await h.post(`${base}/memory/propose`, { ...global, acknowledgeGlobal: true }),
		routes.proposeMemory.response,
	);
	assert.deepEqual(proposed, { status: "proposed", recordId: "memory-k1-global" });
	const existing = await json(
		await h.post(`${base}/memory/propose`, { ...global, acknowledgeGlobal: true }),
		routes.proposeMemory.response,
	);
	assert.equal(existing.status, "existing");
	assert.equal((await h.post(`${base}/turns`, { text: "[stream]" })).status, 202);
	assert.equal(
		(await h.post(`${base}/decisions/supersede`, { interviewId: "interview-1", key: "format" })).status,
		409,
		"a running turn owns the board",
	);
});

test("a conversation lists the extensions it loaded and reloads them only when idle", async (t) => {
	const h = await harness({}, { scenario: "markdown" });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path);
	const session = await h.supervisor.open(workspace.id);
	const base = `/api/sessions/${session.id}/extensions`;
	const listed = await json(await h.request(base), routes.sessionExtensions.response);
	assert.deepEqual(
		listed.extensions.map((row) => [row.id, row.state]),
		[
			["survey-tools", "eligible"],
			["old-plotter", "incompatible"],
		],
	);
	const reloaded = await json(await h.post(`${base}/reload`), routes.reloadSessionExtensions.response);
	assert.equal(reloaded.status, "committed");
	assert.equal((await h.post(`/api/sessions/${session.id}/turns`, { text: "[stream]" })).status, 202);
	assert.equal((await h.post(`${base}/reload`)).status, 409);
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
test("a branch switch replays only the chosen branch and a fork continues under the new session", {
	timeout: 15000,
}, async (t) => {
	const h = await harness({}, { scenario: "markdown" });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path);
	const session = await h.supervisor.open(workspace.id);
	const base = `/api/sessions/${session.id}`;
	const events: Event[] = [];
	t.after(h.hub.connect(undefined, (event) => events.push(event)));
	const tree = await json(await h.request(`${base}/tree`), routes.sessionTree.response);
	assert.equal(tree.leafId, "a3");
	assert.deepEqual(
		tree.nodes.filter((node) => node.active).map((node) => node.id),
		["u1", "a1", "u3", "a3"],
	);
	assert.equal((await h.post(`${base}/turns`, { text: "A live request" })).status, 202);
	assert.equal((await h.post(`${base}/branch`, { turnId: "a2" })).status, 409, "a running turn owns the context");
	await until(() => h.supervisor.get(session.id).turns.at(-1)?.status !== "running");
	assert.equal((await h.post(`${base}/branch`, { turnId: "missing" })).status, 409);
	assert.equal(h.supervisor.get(session.id).turns.length, 1, "a refused switch keeps the transcript");

	const switched = await h.post(`${base}/branch`, { turnId: "a2" }, "switch-a2");
	assert.equal(switched.status, 200);
	assert.deepEqual(await switched.json(), { leafId: "a2", replayedTurns: 2 });
	assert.equal((await h.post(`${base}/branch`, { turnId: "a2" }, "switch-a2")).status, 200);
	const afterSwitch = h.supervisor.get(session.id);
	assert.deepEqual(
		afterSwitch.turns.map((turn) => [turn.id, turn.origin, turn.status]),
		[
			["replay-1", "replay", "succeeded"],
			["replay-2", "replay", "succeeded"],
		],
	);
	const words = afterSwitch.timeline.map((item) => item.text).join(" | ");
	assert.match(words, /Measure the second sample/);
	assert.doesNotMatch(words, /A live request|Try the other instrument/);
	assert.equal(events.filter((event) => event.type === "session.reset").length, 1, "a retried switch is not replayed");

	const forked = await h.post(`${base}/fork`, { turnId: "a1" });
	assert.equal(forked.status, 200);
	const result = await json(forked, routes.forkSession.response);
	assert.notEqual(result.sessionId, session.id);
	assert.deepEqual(
		{ ...result, sessionId: "child" },
		{ sessionId: "child", parentSessionId: session.id, parentTurnId: "a1", replayed: true },
	);
	assert.equal(h.supervisor.get(session.id).state, "closed");
	const child = h.supervisor.get(result.sessionId);
	assert.equal(child.state, "open");
	assert.deepEqual(
		child.timeline.map((item) => item.text),
		["Earlier prompt", "Earlier reply"],
	);
	assert.ok(child.config?.options.some((option) => option.id === "model"));
	const rows = JSON.parse(await readFile(join(h.home.path, "state", "gui", "children.json"), "utf8")) as Array<{
		sessionId: string;
	}>;
	assert.ok(rows.some((row) => row.sessionId === result.sessionId));
	assert.ok(!rows.some((row) => row.sessionId === session.id));
	const mode = await h.request(`/api/sessions/${result.sessionId}/autonomy`);
	assert.equal(mode.status, 200, "the forked conversation keeps its working freedom");
	assert.deepEqual(await mode.json(), { level: "default", source: "settings" });
	assert.equal((await h.post(`/api/sessions/${result.sessionId}/turns`, { text: "Continue here" })).status, 202);
	await until(() => h.supervisor.get(result.sessionId).turns.at(-1)?.status !== "running");
	assert.equal(h.supervisor.get(result.sessionId).turns.at(-1)?.status, "succeeded");
	for (const event of events) assert.ok(Value.Check(Event, event), event.type);
});

test("a handoff is drawn up without writing, commits the reviewed edit once, and moves the conversation", {
	timeout: 15000,
}, async (t) => {
	const h = await harness({}, { scenario: "markdown" });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path);
	const session = await h.supervisor.open(workspace.id);
	const base = `/api/sessions/${session.id}`;
	const refused = await json(await h.post(`${base}/handoff`, { goal: "continue" }), routes.prepareHandoff.response);
	assert.equal(refused.status, "refused");
	const prepare = h.post(`${base}/handoff`, { goal: "Finish the survey report" }, "draft-1");
	// The second prepare on the wire is this one; the refused goal above was the first.
	await until(() => (readFileSync(join(h.home.path, "acp.jsonl"), "utf8").match(/handoff\/prepare/g)?.length ?? 0) >= 2);
	assert.equal(
		(await h.post(`${base}/turns`, { text: "Too soon" })).status,
		409,
		"a request while drafting would leave the document describing a moving conversation",
	);
	const draft = await json(await prepare, routes.prepareHandoff.response);
	assert.equal(draft.status, "ready");
	if (draft.status !== "ready") return;
	assert.match(draft.document, /Finish the survey report/);
	const again = await json(
		await h.post(`${base}/handoff`, { goal: "Finish the survey report" }, "draft-1"),
		routes.prepareHandoff.response,
	);
	assert.deepEqual(again, draft, "a retried draft answers from the ledger");
	const empty = await json(
		await h.post(`${base}/handoff/commit`, { handoffId: draft.handoffId, document: " " }),
		routes.commitHandoff.response,
	);
	assert.equal(empty.status === "refused" && empty.code, "empty");
	assert.equal(h.supervisor.get(session.id).state, "open", "a refused commit leaves the conversation where it was");
	const reviewed = `${draft.document}\nReviewed in the browser.\n`;
	const committed = await json(
		await h.post(`${base}/handoff/commit`, { handoffId: draft.handoffId, document: reviewed }, "commit-1"),
		routes.commitHandoff.response,
	);
	assert.equal(committed.status, "committed");
	if (committed.status !== "committed") return;
	assert.equal(committed.fromSessionId, session.id);
	assert.equal(h.supervisor.get(session.id).state, "closed");
	assert.equal(h.supervisor.get(committed.sessionId).state, "open");
	const log = await readFile(join(h.home.path, "acp.jsonl"), "utf8");
	assert.match(log, /Reviewed in the browser/);
	assert.equal(log.match(/"method":"_clio-coder\/session\/handoff\/commit"/g)?.length, 2);
	assert.equal(
		(await h.post(`${base}/handoff/commit`, { handoffId: draft.handoffId, document: reviewed }, "commit-1")).status,
		200,
		"a retried commit answers from the ledger",
	);
	assert.equal(
		(await readFile(join(h.home.path, "acp.jsonl"), "utf8")).match(/"method":"_clio-coder\/session\/handoff\/commit"/g)
			?.length,
		2,
	);
	assert.equal((await h.request(`/api/sessions/${committed.sessionId}/autonomy`)).status, 200);
	assert.equal((await h.post(`/api/sessions/${committed.sessionId}/turns`, { text: "Carry on" })).status, 202);
	await until(() => h.supervisor.get(committed.sessionId).turns.at(-1)?.status !== "running");
});

test("a discarded or overtaken handoff draft cannot be committed", async (t) => {
	const h = await harness({}, { scenario: "markdown" });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path);
	const session = await h.supervisor.open(workspace.id);
	const base = `/api/sessions/${session.id}`;
	const first = await json(
		await h.post(`${base}/handoff`, { goal: "Finish the survey report" }),
		routes.prepareHandoff.response,
	);
	assert.equal(first.status, "ready");
	if (first.status !== "ready") return;
	assert.deepEqual(await (await h.post(`${base}/handoff/cancel`, { handoffId: first.handoffId })).json(), {
		cancelled: true,
	});
	const discarded = await json(
		await h.post(`${base}/handoff/commit`, { handoffId: first.handoffId, document: first.document }),
		routes.commitHandoff.response,
	);
	assert.equal(discarded.status === "refused" && discarded.code, "stale");
	const second = await json(
		await h.post(`${base}/handoff`, { goal: "Finish the survey report" }),
		routes.prepareHandoff.response,
	);
	if (second.status !== "ready") throw new Error("expected a draft");
	assert.equal((await h.post(`${base}/turns`, { text: "One more thing" })).status, 202);
	await until(() => h.supervisor.get(session.id).turns.at(-1)?.status !== "running");
	const overtaken = await json(
		await h.post(`${base}/handoff/commit`, { handoffId: second.handoffId, document: second.document }),
		routes.commitHandoff.response,
	);
	assert.equal(overtaken.status === "refused" && overtaken.code, "stale");
	assert.equal(h.supervisor.get(session.id).state, "open");
});

test("a dispatch ask carries the admitted plan to the permission, and an unknown plan field costs nothing", async (t) => {
	const h = await harness({}, { scenario: "markdown" });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path);
	const session = await h.supervisor.open(workspace.id);
	assert.equal((await h.post(`/api/sessions/${session.id}/turns`, { text: "[plan] Survey and report" })).status, 202);
	await until(() => h.supervisor.get(session.id).permissions.some((permission) => permission.status === "pending"));
	const permission = h.supervisor.get(session.id).permissions.find((row) => row.status === "pending");
	assert.equal(permission?.plan?.planScale, true);
	assert.equal(permission?.plan?.hash.slice(0, 12), "3f2a9c1e04b7");
	assert.deepEqual(
		permission?.plan?.tasks.map((task) => [task.agent, task.worktree ?? false]),
		[
			["scout", false],
			["writer", true],
		],
	);
	assert.equal(
		(await h.post(`/api/sessions/${session.id}/permissions/${permission?.id}`, { decision: "allow-once" })).status,
		200,
	);
	await until(() => h.supervisor.get(session.id).turns.at(-1)?.status !== "running");
	assert.match(await readFile(join(h.home.path, "acp.jsonl"), "utf8"), /"planPermission".*"approved":true/);
});

test("a fleet preview dispatches nothing and a run starts only the approved hash", async (t) => {
	const h = await harness({}, { scenario: "markdown" });
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path);
	const session = await h.supervisor.open(workspace.id);
	const base = `/api/sessions/${session.id}/fleet`;
	const preview = await json(
		await h.post(`${base}/preview`, { name: "survey", vars: { site: "plot-7" } }),
		routes.previewFleetRun.response,
	);
	assert.equal(preview.status, "ready");
	if (preview.status !== "ready") return;
	assert.equal(preview.waves.length, 2);
	assert.doesNotMatch(await readFile(join(h.home.path, "acp.jsonl"), "utf8"), /fleetStarted/);
	const missing = await json(await h.post(`${base}/preview`, { name: "nope" }), routes.previewFleetRun.response);
	assert.equal(missing.status, "refused");
	assert.equal((await h.post(`${base}/preview`, { name: "../x" })).status, 422);
	const changed = await json(
		await h.post(`${base}/run`, { name: "survey", vars: { site: "plot-8" }, planHash: preview.planHash }),
		routes.startFleetRun.response,
	);
	assert.equal(changed.status, "changed");
	assert.doesNotMatch(await readFile(join(h.home.path, "acp.jsonl"), "utf8"), /fleetStarted/);
	const run = { name: "survey", vars: { site: "plot-7" }, planHash: preview.planHash };
	const started = await json(await h.post(`${base}/run`, run, "fleet-1"), routes.startFleetRun.response);
	assert.equal(started.status, "started");
	assert.equal((await h.post(`${base}/run`, run, "fleet-1")).status, 200);
	assert.equal((await readFile(join(h.home.path, "acp.jsonl"), "utf8")).match(/fleetStarted/g)?.length, 1);
	const blockedPreview = await json(
		await h.post(`${base}/preview`, { name: "survey", vars: { site: "blocked" } }),
		routes.previewFleetRun.response,
	);
	if (blockedPreview.status !== "ready") throw new Error("expected a plan");
	const failed = await json(
		await h.post(`${base}/run`, { name: "survey", vars: { site: "blocked" }, planHash: blockedPreview.planHash }),
		routes.startFleetRun.response,
	);
	assert.equal(failed.status === "failed" && failed.reason, "dispatch: agent 'writer' is not admitted for this task");
	assert.equal((await h.post(`/api/sessions/${session.id}/turns`, { text: "[stream]" })).status, 202);
	assert.equal((await h.post(`${base}/run`, run)).status, 409, "a running turn owns the workspace");
});

test("an older ACP peer has no branches and refuses tree, switch and fork before sending", async (t) => {
	const h = await harness();
	t.after(h.close);
	const workspace = await h.workspaces.open(h.home.path);
	const session = await h.supervisor.open(workspace.id);
	const base = `/api/sessions/${session.id}`;
	assert.equal((await h.request(`${base}/tree`)).status, 409);
	assert.equal((await h.post(`${base}/branch`, { turnId: "a1" })).status, 409);
	assert.equal((await h.post(`${base}/fork`, { turnId: "a1" })).status, 409);
	assert.equal((await h.post(`${base}/handoff`, { goal: "Finish the survey report" })).status, 409);
	assert.equal((await h.post(`${base}/fleet/preview`, { name: "survey" })).status, 409);
	assert.equal((await h.request(`${base}/context`)).status, 409);
	assert.equal((await h.request(`${base}/extensions`)).status, 409);
	assert.doesNotMatch(
		await readFile(join(h.home.path, "acp.jsonl"), "utf8"),
		/session\/(tree|switch_turn|fork|handoff)|fleet\//,
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
