import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import type { Event } from "../contracts/events.js";
import { routes } from "../contracts/routes.js";
import { applySessionDelta, emptySession } from "../contracts/session-projection.js";
import type { TimelineItem } from "../contracts/sessions.js";
import { harness, json } from "./harness/app.js";

// The `readouts` fixture's frames (tests/fixtures/acp-fixture-child.mjs).
const SKILLS = { names: ["review"], display: "skill review" };
const YOLO = {
	level: "yolo",
	confinement: "contained",
	osSandbox: true,
	label: "YOLO · contained",
	tone: "warning",
	window: { display: "3/600 calls", tone: "neutral", halted: false },
};
const TURN_END = { autonomy: YOLO, throughput: null, skills: SKILLS, retry: null };

async function readoutsTurn(scenario: string, env: NodeJS.ProcessEnv = {}) {
	const h = await harness({}, { scenario, env, lanes: false });
	const events: Event[] = [];
	const disconnect = h.hub.connect(undefined, (event) => events.push(event));
	const workspace = await json(await h.post("/api/workspaces", { path: h.home.path }), routes.openWorkspace.response);
	const session = await json(
		await h.post(`/api/workspaces/${workspace.id}/sessions`, {}, "new-session"),
		routes.newSession.response,
	);
	const capabilities = await json(
		await h.request(`/api/sessions/${session.id}/capabilities`),
		routes.sessionCapabilities.response,
	);
	await h.post(`/api/sessions/${session.id}/turns`, { text: "Write the notes" }, "prompt");
	const settled = () => h.supervisor.get(session.id).turns.at(-1)?.status;
	for (let i = 0; i < 400 && (settled() ?? "running") === "running"; i++) await setTimeout(10);
	const snapshot = await json(await h.request(`/api/sessions/${session.id}`), routes.session.response);
	return {
		h,
		events,
		capabilities,
		snapshot,
		close: async () => {
			disconnect();
			await h.close();
		},
	};
}

const readoutDeltas = (events: readonly Event[]) =>
	events.flatMap((event) =>
		event.type === "session.telemetry" && event.payload.telemetry.readouts ? [event.payload.telemetry.readouts] : [],
	);

test("the GUI asks for readouts, and the session carries the engine's frames as sent", {
	timeout: 20_000,
}, async (t) => {
	const run = await readoutsTurn("readouts");
	t.after(run.close);
	const initialize = (await readFile(join(run.h.home.path, "acp.jsonl"), "utf8"))
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.find((entry) => entry.method === "initialize");
	assert.deepEqual(initialize?.params?.clientCapabilities?._meta?.["clio-coder/readouts"], { version: 1 });
	assert.deepEqual(run.capabilities.readouts, {
		version: 1,
		notification: "_clio-coder/session/readouts",
		minIntervalMs: 250,
		admission: "clio-coder/admission",
	});
	assert.equal(run.snapshot.turns.at(-1)?.status, "succeeded");
	assert.deepEqual(run.snapshot.telemetry?.readouts, TURN_END);
	const deltas = readoutDeltas(run.events);
	assert.deepEqual(deltas[0], { autonomy: null, throughput: null, skills: SKILLS, retry: null }, "the open frame lands");
	assert.ok(
		deltas.some((readouts) => readouts.throughput?.display === "42 tok/s"),
		"the turn's rate reached the stream",
	);
});

test("a frame of another shape, version or older sequence changes nothing, and the turn completes", {
	timeout: 20_000,
}, async (t) => {
	const run = await readoutsTurn("readouts", { CLIO_CODER_WEB_FIXTURE_READOUTS_BAD: "1" });
	t.after(run.close);
	assert.equal(run.snapshot.turns.at(-1)?.status, "succeeded");
	assert.deepEqual(run.snapshot.telemetry?.readouts, TURN_END);
	assert.ok(
		readoutDeltas(run.events).every((readouts) => readouts.skills?.display !== "skill stray"),
		"no dropped frame was published",
	);
});

test("a call shows the judge's hold while it is judged and loses it once admitted", { timeout: 20_000 }, async (t) => {
	const run = await readoutsTurn("readouts");
	t.after(run.close);
	const states = run.events.flatMap((event) =>
		event.type === "turn.tool" && event.payload.item.toolCallId === "write-1"
			? [[event.payload.item.status, event.payload.item.admission] as const]
			: [],
	);
	assert.deepEqual(states, [
		["in_progress", undefined],
		["in_progress", "waiting for the safety judge"],
		["in_progress", undefined],
		["completed", undefined],
	]);
	const settled = run.snapshot.timeline.find((item) => item.toolCallId === "write-1");
	assert.equal(settled?.status, "completed");
	assert.equal(settled && "admission" in settled, false);
});

test("the window's projection takes the judge's hold off a call once it is admitted", () => {
	const call: TimelineItem = {
		id: "turn:tool:write-1",
		turnId: "turn",
		sequence: 0,
		kind: "tool",
		text: "Write notes.md",
		status: "in_progress",
		origin: "live",
		title: "Write notes.md",
		toolCallId: "write-1",
		partialOutput: "half",
	};
	let snapshot = emptySession("session", "workspace");
	const tool = (item: TimelineItem) =>
		(snapshot = applySessionDelta(snapshot, {
			type: "turn.tool",
			payload: { resource: "session", revision: snapshot.revision + 1, item },
		}));
	const row = () => {
		const found = snapshot.timeline.find((item) => item.id === call.id);
		assert.ok(found);
		return found;
	};
	tool({ ...call, admission: "waiting for the safety judge" });
	assert.equal(row().admission, "waiting for the safety judge");
	const { partialOutput: _partial, ...admitted } = call;
	tool(admitted);
	assert.equal("admission" in row(), false, "admitted, the call is running and no longer held");
	assert.equal(row().partialOutput, "half", "an omitted partial output is still kept");
	tool({ ...admitted, status: "completed" });
	assert.equal("admission" in row(), false);
});

test("an engine without readouts leaves no readouts key on the session", { timeout: 20_000 }, async (t) => {
	const run = await readoutsTurn("text");
	t.after(run.close);
	assert.equal(run.snapshot.turns.at(-1)?.status, "succeeded");
	assert.equal("readouts" in run.capabilities, false);
	assert.equal(run.snapshot.telemetry !== undefined && "readouts" in run.snapshot.telemetry, false);
	assert.deepEqual(readoutDeltas(run.events), []);
});
