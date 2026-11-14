import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { routes } from "../contracts/routes.js";
import { applySessionDelta, emptySession, encodeMeter, SessionBuffer } from "../contracts/session-projection.js";
import { type SessionDelta, SessionDeltas, type SessionSnapshot, type TimelineItem } from "../contracts/sessions.js";
import { harness, json } from "./harness/app.js";

const CHUNK = "0123456789 ";
function streamed(count: number, text: string | ((index: number) => string) = CHUNK) {
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
			payload: {
				resource: "session",
				revision: ++revision,
				turnId: "turn",
				text: typeof text === "string" ? text : text(index),
				origin: "live",
			},
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

const SLICE = 16 * 1024;
/** One answer of `total` bytes, cut into the 16 KiB chunks an agent streams. */
function answer(total: number) {
	return streamed(Math.ceil(total / SLICE), (index) => "y".repeat(Math.min(SLICE, total - index * SLICE))).snapshot;
}

test("a run past its byte limit keeps the marker, drops later appends, and flags the snapshot", () => {
	const { snapshot } = streamed(70, "x".repeat(SLICE));
	const run = snapshot.timeline[0];
	assert.equal(snapshot.timelineTruncated, true);
	assert.ok(run?.text.endsWith("\n[… stream truncated …]"));
	assert.equal(new TextEncoder().encode(run?.text).byteLength, 1024 * 1024);
	assert.equal(streamed(140, "x".repeat(SLICE)).snapshot.timeline[0]?.text, run?.text);
});

test("a 200 KB answer arrives whole; only an answer past the 1 MiB run limit is cut", () => {
	const whole = answer(200_000);
	assert.equal(whole.timeline.length, 1);
	assert.equal(whole.timeline[0]?.text.length, 200_000);
	assert.ok(!whole.timeline[0]?.text.endsWith("\n[… stream truncated …]"));
	assert.equal(whole.timelineTruncated, false);
	const cut = answer(1_100_000);
	assert.ok(cut.timeline[0]?.text.endsWith("\n[… stream truncated …]"));
	assert.equal(cut.timelineTruncated, true);
});

/**
 * The projection's timeline upsert as it was before the newest-item fast path, with its retention measured from
 * scratch instead of carried forward, and only the deltas the recording below sends. Text bounds at the same
 * 1 MiB run limit so the comparison isolates the upsert.
 */
const REFERENCE_MARKER = "\n[… stream truncated …]";
const utf8 = (value: string) => new TextEncoder().encode(value).byteLength;
function referenceBound(value: string) {
	const limit = 1024 * 1024;
	if (utf8(value) <= limit) return value;
	const budget = limit - utf8(REFERENCE_MARKER);
	let used = 0,
		output = "";
	for (const character of value) {
		const size = utf8(character);
		if (used + size > budget) break;
		output += character;
		used += size;
	}
	return output + REFERENCE_MARKER;
}
const referenceIdentity = (provenance: TimelineItem["provenance"]) =>
	provenance ? `:${provenance.map((agent) => `${agent.agentId}:${agent.runId ?? ""}`).join("|")}` : "";
function referenceNarrativeId(
	timeline: readonly TimelineItem[],
	turnId: string,
	kind: "text" | "thought",
	identity: string,
) {
	const base = `${turnId}:${kind}${identity}`;
	let broken = false;
	for (let index = timeline.length - 1; index >= 0; index -= 1) {
		const item = timeline[index];
		if (item === undefined || item.turnId !== turnId) break;
		if (item.id === base || item.id.startsWith(`${base}#`)) {
			if (!broken) return item.id;
			return `${base}#${(timeline.at(-1)?.sequence ?? 0) + 1}`;
		}
		if (item.kind === "tool" || item.kind === "notice") broken = true;
		else if ((item.kind === "text" || item.kind === "thought") && referenceIdentity(item.provenance) === identity)
			broken = true;
	}
	return base;
}
function referenceApply(current: SessionSnapshot, event: SessionDelta): SessionSnapshot {
	let state: SessionSnapshot = { ...current, revision: event.payload.revision };
	const upsert = (item: Omit<TimelineItem, "sequence">, append = false) => {
		const previous = state.timeline.find((row) => row.id === item.id);
		const sequence = previous?.sequence ?? (state.timeline.at(-1)?.sequence ?? 0) + 1;
		const text =
			append && previous
				? previous.text.endsWith(REFERENCE_MARKER)
					? previous.text
					: referenceBound(previous.text + item.text)
				: referenceBound(item.text);
		const next = { ...previous, ...item, text, sequence };
		let timeline = previous ? state.timeline.map((row) => (row.id === item.id ? next : row)) : [...state.timeline, next];
		let truncated = state.timelineTruncated;
		const cost = (row: TimelineItem) => utf8(JSON.stringify(row)) + 1;
		let bytes = timeline.reduce((sum, row) => sum + cost(row), 0);
		let dropped = 0;
		for (const removed of timeline) {
			const retained = timeline.length - dropped;
			if (retained <= 1 || (retained <= 2048 && bytes <= 2 * 1024 * 1024)) break;
			bytes -= cost(removed);
			dropped++;
			truncated = true;
		}
		if (dropped) timeline = timeline.slice(dropped);
		state = { ...state, timeline, timelineTruncated: truncated || text.endsWith(REFERENCE_MARKER) };
	};
	switch (event.type) {
		case "turn.started": {
			const turn = event.payload.turn;
			state = { ...state, turns: [...state.turns, turn].slice(-128) };
			if (turn.prompt)
				upsert({
					id: `${turn.id}:user`,
					turnId: turn.id,
					kind: "user",
					text: turn.prompt,
					status: "completed",
					origin: turn.origin,
				});
			break;
		}
		case "turn.text":
		case "turn.thought": {
			const { turnId, text, origin, provenance } = event.payload,
				kind = event.type === "turn.text" ? "text" : "thought";
			upsert(
				{
					id: referenceNarrativeId(state.timeline, turnId, kind, referenceIdentity(provenance)),
					turnId,
					kind,
					text,
					origin,
					status: origin === "replay" ? "completed" : "in_progress",
					...(provenance ? { provenance } : {}),
				},
				true,
			);
			break;
		}
		case "turn.tool":
			upsert(event.payload.item);
			break;
		case "turn.finished": {
			const { turnId, stopReason, usage, problem, finishedAt } = event.payload;
			const status = stopReason === "cancelled" ? "cancelled" : problem ? "failed" : "succeeded";
			state = {
				...state,
				turns: state.turns.map((turn) => {
					if (turn.id !== turnId) return turn;
					const { queued: _queued, ...settled } = turn;
					return { ...settled, status, stopReason, usage, problem, finishedAt };
				}),
				timeline: state.timeline.map((item) =>
					item.turnId === turnId && (item.status === "in_progress" || item.status === "pending")
						? { ...item, status: item.kind === "tool" ? "unknown" : status === "succeeded" ? "completed" : status }
						: item,
				),
			};
			break;
		}
		default:
			throw new Error(`The recording sends no ${event.type}.`);
	}
	return state;
}

/**
 * Two turns as an agent streams them: prose and reasoning in chunks, a worker writing between the lead's chunks
 * (so the lead appends to an item that is not the newest), tool calls that update after later text, and a second
 * turn large enough to cut its runs and evict the first turn from the timeline.
 */
function recording(): SessionDelta[] {
	const deltas: SessionDelta[] = [];
	let revision = 0;
	const worker = [{ version: 1 as const, role: "worker" as const, agentId: "scout", runId: "r1" }];
	const started = (id: string, prompt: string) =>
		deltas.push({
			type: "turn.started",
			payload: {
				resource: "session",
				revision: ++revision,
				turn: {
					id,
					prompt,
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
	const narrate = (type: "turn.text" | "turn.thought", turnId: string, text: string, provenance?: typeof worker) =>
		deltas.push({
			type,
			payload: {
				resource: "session",
				revision: ++revision,
				turnId,
				text,
				origin: "live",
				...(provenance ? { provenance } : {}),
			},
		});
	const tool = (turnId: string, call: string, status: TimelineItem["status"]) =>
		deltas.push({
			type: "turn.tool",
			payload: {
				resource: "session",
				revision: ++revision,
				item: {
					id: `${turnId}:tool:${call}`,
					turnId,
					sequence: 0,
					kind: "tool",
					text: `Read ${call}`,
					status,
					origin: "live",
					title: `Read ${call}`,
					toolCallId: call,
				},
			},
		});
	const finished = (turnId: string) =>
		deltas.push({
			type: "turn.finished",
			payload: {
				resource: "session",
				revision: ++revision,
				turnId,
				stopReason: "end_turn",
				usage: null,
				problem: null,
				finishedAt: null,
			},
		});
	started("one", "Explain the café menu.");
	for (let index = 0; index < 6; index++) {
		narrate("turn.thought", "one", `Considering ${index}. `);
		narrate("turn.text", "one", `Lead paragraph ${index} — é. `);
		narrate("turn.text", "one", `Scout note ${index}. `, worker);
	}
	tool("one", "a", "in_progress");
	narrate("turn.text", "one", "After the first call. ");
	tool("one", "b", "in_progress");
	tool("one", "a", "completed");
	narrate("turn.text", "one", "Still after the calls. ", worker);
	narrate("turn.text", "one", "Lead closes. ");
	tool("one", "b", "failed");
	finished("one");
	started("two", "Write everything down.");
	const block = "z".repeat(300 * 1024);
	for (let index = 0; index < 5; index++) {
		narrate("turn.text", "two", block);
		narrate("turn.text", "two", block, worker);
	}
	for (let index = 0; index < 3; index++) {
		tool("two", `c${index}`, "in_progress");
		narrate("turn.text", "two", `Between calls ${index}. `);
		if (index > 0) tool("two", `c${index - 1}`, "completed");
	}
	tool("one", "a", "completed");
	finished("two");
	return deltas;
}

test("projecting a recorded stream yields the same snapshot as the upsert that searched the whole timeline", () => {
	let actual = emptySession("session", "workspace"),
		expected = actual;
	for (const [index, delta] of recording().entries()) {
		actual = applySessionDelta(actual, delta);
		expected = referenceApply(expected, delta);
		assert.deepEqual(actual, expected, `Snapshots diverged at delta ${index} (${delta.type}).`);
	}
	assert.equal(actual.timelineTruncated, true);
	assert.ok(actual.timeline.some((item) => item.text.endsWith(REFERENCE_MARKER)));
	assert.ok(!actual.timeline.some((item) => item.turnId === "one" && item.kind === "text"));
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

test("a session cost ceiling stop stands until model output or a tool call follows it", () => {
	const budget = {
		level: "at" as const,
		currentUsd: 5,
		ceilingUsd: 5,
		contextTokens: 1200,
		raiseToUsd: 5.5,
		setting: "safety.limits.sessionCostUsd",
	};
	let revision = 1;
	let snapshot = streamed(0).snapshot;
	const apply = (type: SessionDelta["type"], payload: Record<string, unknown>) =>
		(snapshot = applySessionDelta(snapshot, {
			type,
			payload: { resource: "session", revision: ++revision, ...payload },
		} as SessionDelta));
	apply("session.telemetry", { telemetry: { budget } });
	assert.deepEqual(snapshot.telemetry?.budget, budget);
	// A notice, the operator's own words and a cancelled wait prove no paid request ran.
	apply("turn.tool", {
		item: {
			id: "turn:notice",
			turnId: "turn",
			sequence: 0,
			kind: "notice",
			text: "paused",
			status: "completed",
			origin: "live",
		},
	});
	apply("turn.user", { turnId: "turn", text: "still there?", origin: "live" });
	apply("turn.finished", { turnId: "turn", stopReason: "cancelled", usage: null, problem: null, finishedAt: null });
	assert.ok(snapshot.telemetry?.budget, "nothing paid ran, so the stop stands");
	apply("turn.text", { turnId: "turn", text: "resumed", origin: "live" });
	assert.equal(snapshot.telemetry?.budget, undefined, "model text ends the stop");
	apply("session.telemetry", { telemetry: { budget } });
	snapshot = applySessionDelta(snapshot, toolDelta(snapshot, ++revision, 1));
	assert.equal(snapshot.telemetry?.budget, undefined, "a tool call ends the stop");
	apply("session.telemetry", { telemetry: { budget } });
	apply("session.reset", {});
	assert.equal(
		snapshot.telemetry?.budget,
		undefined,
		"a branch switch drops it; the replay brings it back if it stands",
	);
});
