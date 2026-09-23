import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { routes } from "../contracts/routes.js";
import { applySessionDelta, emptySession, encodeMeter, SessionBuffer } from "../contracts/session-projection.js";
import { type SessionDelta, SessionDeltas, type SessionSnapshot, type TimelineItem } from "../contracts/sessions.js";
import { harness, json } from "./harness/app.js";

const CHUNK = "0123456789 ";
function streamed(count: number, text = CHUNK) {
	let revision = 0;
	let snapshot = applySessionDelta(emptySession("session", "workspace"), {
		type: "turn.started",
		payload: {
			resource: "session",
			revision: ++revision,
			turn: {
				id: "turn",
				prompt: "",
				origin: "live",
				status: "running",
				startedAt: null,
				finishedAt: null,
				stopReason: null,
				usage: null,
				problem: null,
			},
		},
	});
	const before = encodeMeter.bytes;
	for (let index = 0; index < count; index++)
		snapshot = applySessionDelta(snapshot, {
			type: "turn.text",
			payload: { resource: "session", revision: ++revision, turnId: "turn", text, origin: "live" },
		});
	return { snapshot, encoded: encodeMeter.bytes - before };
}
function toolDelta(snapshot: SessionSnapshot, revision: number, index: number): SessionDelta {
	const item: TimelineItem = {
		id: `turn:tool:${index}`,
		turnId: "turn",
		sequence: 0,
		kind: "tool",
		text: `Tool ${index}`,
		status: "completed",
		origin: "live",
		title: `Tool ${index}`,
		toolCallId: `${index}`,
	};
	return { type: "turn.tool", payload: { resource: snapshot.id, revision, item } };
}

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

test("retention accounting stays linear: quadrupling the deltas must not quadruple the encoded bytes per delta", () => {
	const small = streamed(500),
		large = streamed(2000);
	assert.equal(large.snapshot.timeline.length, 1);
	assert.equal(large.snapshot.timeline[0]?.text, CHUNK.repeat(2000));
	assert.equal(large.snapshot.timelineTruncated, false);
	// Recompute-from-scratch accounting encoded the whole timeline per delta, so 4x the deltas cost ~16x the bytes.
	assert.ok(
		large.encoded < small.encoded * 6,
		`Encoded ${small.encoded} bytes for 500 deltas and ${large.encoded} for 2000.`,
	);
	assert.ok(
		large.encoded < 2000 * CHUNK.length * 8,
		`Encoded ${large.encoded} bytes to project ${2000 * CHUNK.length} bytes of text.`,
	);
});

test("a run past its byte limit keeps the marker, drops later appends, and flags the snapshot", () => {
	const { snapshot } = streamed(1200, "x".repeat(64));
	const run = snapshot.timeline[0];
	assert.equal(snapshot.timelineTruncated, true);
	assert.ok(run?.text.endsWith("\n[… stream truncated …]"));
	assert.equal(new TextEncoder().encode(run?.text).byteLength, 65536);
	assert.equal(streamed(2400, "x".repeat(64)).snapshot.timeline[0]?.text, run?.text);
});

test("the oldest timeline entries are dropped once the entry bound is passed", () => {
	let snapshot = emptySession("session", "workspace"),
		revision = 0;
	for (let index = 0; index < 2100; index++)
		snapshot = applySessionDelta(snapshot, toolDelta(snapshot, ++revision, index));
	assert.equal(snapshot.timeline.length, 2048);
	assert.equal(snapshot.timelineTruncated, true);
	assert.equal(snapshot.timeline[0]?.id, "turn:tool:52");
	assert.equal(snapshot.timeline.at(-1)?.id, "turn:tool:2099");
});

test("narrative written after a tool call becomes a new passage below it, in wire order", () => {
	let revision = 0;
	const worker = [{ version: 1 as const, role: "worker" as const, agentId: "scout", runId: "r1" }];
	let snapshot = streamed(0).snapshot;
	revision = snapshot.revision;
	const narrate = (type: "turn.text" | "turn.thought", text: string, provenance?: typeof worker) => {
		snapshot = applySessionDelta(snapshot, {
			type,
			payload: {
				resource: "session",
				revision: ++revision,
				turnId: "turn",
				text,
				origin: "live",
				...(provenance ? { provenance } : {}),
			},
		});
	};
	narrate("turn.thought", "Plan. ");
	narrate("turn.text", "Looking. ");
	narrate("turn.text", "Still looking. ");
	snapshot = applySessionDelta(snapshot, toolDelta(snapshot, ++revision, 1));
	narrate("turn.text", "Found it. ", worker);
	narrate("turn.text", "Confirmed. ");
	narrate("turn.text", "Worker detail.", worker);
	narrate("turn.thought", "Next. ");
	narrate("turn.text", "Done.");
	assert.deepEqual(
		snapshot.timeline.map((item) => [item.kind, item.text]),
		[
			["thought", "Plan. "],
			["text", "Looking. Still looking. "],
			["tool", "Tool 1"],
			["text", "Found it. Worker detail."],
			["text", "Confirmed. "],
			["thought", "Next. "],
			["text", "Done."],
		],
	);
	assert.equal(new Set(snapshot.timeline.map((item) => item.id)).size, snapshot.timeline.length);
	assert.equal(snapshot.timeline[1]?.id, "turn:text");
	// A browser that applies the same deltas to an earlier snapshot must agree on every id.
	assert.deepEqual(
		snapshot.timeline.map((item) => item.sequence),
		snapshot.timeline.map((_item, index) => index + 1),
	);
});
