/**
 * The shared turn projection.
 *
 * The host folds every turn event through `applyTurnEvent` before broadcasting
 * it and the renderer folds the same events on receipt, so a browser that
 * reloads mid-turn must land on the identical timeline. These tests fold the
 * same event stream twice and compare.
 */

import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { MAX_WIRE_TIMELINE_ENTRIES, type WireTimelineItem } from "../src/protocol.ts";
import {
	applyTurnEvent,
	emptyTurnProjection,
	MAX_TIMELINE_STREAM_BYTES,
	resolutionSummary,
	restoreTurnProjection,
	TIMELINE_STREAM_TRUNCATION_MARKER,
	type TurnEventInput,
	type TurnProjection,
} from "../src/timeline.ts";

interface Stamped {
	readonly event: TurnEventInput;
	readonly now: string;
}

function at(second: number): string {
	return new Date(Date.UTC(2026, 7, 18, 12, 0, second)).toISOString();
}

function fold(stream: readonly Stamped[], initial: TurnProjection = emptyTurnProjection): TurnProjection {
	return stream.reduce((state, entry) => applyTurnEvent(state, entry.event, entry.now), initial);
}

function started(turnId: string, origin: "live" | "replay", startedAt: string | null): TurnEventInput {
	return {
		kind: "turn.started",
		turnId,
		payload: {
			promptSummary: `Prompt for ${turnId}`,
			origin,
			startedAt,
			source: origin === "replay" ? "replayed-from-clio" : "observed-by-workbench",
		},
	};
}

function text(
	turnId: string,
	value: string,
	source: "observed-on-acp" | "replayed-from-clio" = "observed-on-acp",
): TurnEventInput {
	return { kind: "turn.text", turnId, payload: { text: value, source } };
}

function tool(
	turnId: string,
	toolCallId: string,
	status: "in_progress" | "completed" | "failed" | "canceled",
	title = "Read fixture note",
	source: "observed-on-acp" | "replayed-from-clio" = "observed-on-acp",
): TurnEventInput {
	return {
		kind: "turn.tool",
		turnId,
		payload: {
			toolCallId,
			title,
			kind: "read",
			status,
			summary: `${toolCallId} ${status}`,
			locations: [{ segments: ["notes.txt"] }],
			source,
		},
	};
}

function terminal(turnId: string, outcome: "completed" | "canceled" | "failed"): TurnEventInput {
	return {
		kind: "turn.terminal",
		turnId,
		payload: { outcome, code: `clio-${outcome}`, summary: `Turn ${outcome}.`, source: "reported-by-clio" },
	};
}

function permissionRequested(turnId: string, permissionId: string): TurnEventInput {
	return {
		kind: "turn.permission.requested",
		turnId,
		payload: {
			permissionId,
			toolCallId: "tool-1",
			title: "Write fixture note",
			kind: "edit",
			locations: [{ segments: ["notes.txt"] }],
			requestedAt: at(10),
			escalateAt: at(55),
			expiresAt: at(60),
			source: "observed-on-acp",
		},
	};
}

const conversation: readonly Stamped[] = [
	{ event: started("turn-1", "live", at(1)), now: at(1) },
	{ event: text("turn-1", "Reading "), now: at(2) },
	{ event: text("turn-1", "the note."), now: at(3) },
	{ event: tool("turn-1", "tool-1", "in_progress"), now: at(4) },
	{ event: tool("turn-1", "tool-1", "completed"), now: at(5) },
	{
		event: {
			kind: "turn.thought",
			turnId: "turn-1",
			payload: { text: "Considering.", source: "observed-on-acp" },
		},
		now: at(6),
	},
	{ event: terminal("turn-1", "completed"), now: at(7) },
];

Deno.test("a live turn projects one card per entity with stable identifiers", () => {
	const state = fold(conversation);
	deepStrictEqual(state.timeline.map((item) => item.id), [
		"turn-1:request",
		"turn-1:text:2",
		"turn-1:tool:tool-1",
		"turn-1:thought:4",
		"turn-1:terminal",
	]);
	deepStrictEqual(state.timeline.map((item) => item.sequence), [1, 2, 3, 4, 5]);
	equal(state.timeline.find((item) => item.id === "turn-1:text:2")?.summary, "Reading the note.");
	equal(state.timeline.find((item) => item.id === "turn-1:tool:tool-1")?.status, "complete");
	equal(state.timeline.find((item) => item.id === "turn-1:tool:tool-1")?.detail, "read · notes.txt");
	equal(state.activeTurn, null);
	equal(state.ordinal, 5);
	ok(state.timeline.every((item) => item.origin === "live"));
});

Deno.test("host and renderer projections of the same stream agree card for card", () => {
	const host = fold(conversation);
	const renderer = fold(conversation);
	deepStrictEqual(renderer.timeline, host.timeline);
	deepStrictEqual(
		renderer.timeline.map((item) => ({ id: item.id, summary: item.summary, status: item.status })),
		host.timeline.map((item) => ({ id: item.id, summary: item.summary, status: item.status })),
	);
	equal(renderer.ordinal, host.ordinal);
});

Deno.test("a renderer that reloads mid-turn continues the host's numbering", () => {
	const midTurn = fold(conversation.slice(0, 4));
	const restored = restoreTurnProjection({
		timeline: midTurn.timeline,
		timelineTruncated: midTurn.timelineTruncated,
		activeTurn: midTurn.activeTurn,
		pendingPermission: midTurn.pendingPermission,
	});
	equal(restored.ordinal, midTurn.ordinal);
	deepStrictEqual(restored.currentTurn, midTurn.currentTurn);
	const rest = conversation.slice(4);
	deepStrictEqual(
		fold(rest, restored).timeline.map((item) => item.id),
		fold(conversation).timeline.map((item) => item.id),
	);
});

Deno.test("replayed turns stay clockless and neutral except for terminal tool statuses supplied by replay", () => {
	const state = fold([
		{ event: started("turn-1", "replay", null), now: at(30) },
		{ event: text("turn-1", "Earlier answer.", "replayed-from-clio"), now: at(30) },
		{ event: tool("turn-1", "tool-open", "in_progress", "Open earlier tool", "replayed-from-clio"), now: at(30) },
		{
			event: tool("turn-1", "tool-complete", "in_progress", "Completed earlier tool", "replayed-from-clio"),
			now: at(30),
		},
		{
			event: tool("turn-1", "tool-complete", "completed", "Completed earlier tool", "replayed-from-clio"),
			now: at(30),
		},
		{ event: tool("turn-1", "tool-failed", "failed", "Failed earlier tool", "replayed-from-clio"), now: at(30) },
		{ event: tool("turn-1", "tool-canceled", "canceled", "Canceled earlier tool", "replayed-from-clio"), now: at(30) },
		{ event: started("turn-2", "live", at(31)), now: at(31) },
	]);
	const replayed = state.timeline.filter((item) => item.turnId === "turn-1");
	const request = state.timeline.find((item) => item.id === "turn-1:request");
	equal(request?.title, "Earlier request");
	equal(request?.status, "replayed");
	equal(request?.origin, "replay");
	equal(state.timeline.find((item) => item.id === "turn-1:text:2")?.status, "replayed");
	equal(state.timeline.find((item) => item.id === "turn-1:tool:tool-open")?.status, "replayed");
	equal(state.timeline.find((item) => item.id === "turn-1:tool:tool-complete")?.status, "complete");
	equal(state.timeline.find((item) => item.id === "turn-1:tool:tool-failed")?.status, "failed");
	equal(state.timeline.find((item) => item.id === "turn-1:tool:tool-canceled")?.status, "canceled");
	ok(replayed.every((item) => item.startedAt === null));
	ok(replayed.every((item) => item.endedAt === undefined));
	ok(replayed.every((item) => item.source === "replayed-from-clio"));
	ok(replayed.every((item) => item.kind !== "outcome" && item.kind !== "failure"));
	equal(state.activeTurn?.turnId, "turn-2");
	equal(state.timeline.find((item) => item.id === "turn-2:request")?.origin, "live");
});

Deno.test("the active turn counts tools once and remembers the last title", () => {
	const state = fold([
		{ event: started("turn-1", "live", at(1)), now: at(1) },
		{ event: tool("turn-1", "tool-1", "in_progress", "Read one"), now: at(2) },
		{ event: tool("turn-1", "tool-1", "completed", "Read one"), now: at(3) },
		{ event: tool("turn-1", "tool-2", "in_progress", "Read two"), now: at(4) },
		{
			event: {
				kind: "turn.loop",
				turnId: "turn-1",
				payload: {
					toolCallId: null,
					tool: "bash",
					repeatCount: 3,
					blocksThisTurn: 1,
					budget: 5,
					disposition: "block",
					interrupted: false,
					shape: null,
					source: "reported-by-clio",
				},
			},
			now: at(5),
		},
	]);
	equal(state.activeTurn?.toolCalls, 2);
	// Clio's own title for the call, not the generic kind label, because during a
	// silent run this is the only place the operator learns what is running.
	equal(state.activeTurn?.lastToolTitle, "tool-2 in_progress");
	equal(state.activeTurn?.repeatedShapes, 1);
	const loop = state.timeline.find((item) => item.kind === "loop");
	equal(loop?.title, "Clio blocked a repeated bash call");
	ok(loop?.summary.includes("Repeated 3 times"));
	equal(loop?.detail, undefined);
});

Deno.test("a pending approval clears on resolution and never claims Clio said no", () => {
	const base: readonly Stamped[] = [
		{ event: started("turn-1", "live", at(1)), now: at(1) },
		{ event: permissionRequested("turn-1", "permission-1"), now: at(10) },
	];
	const waiting = fold(base);
	equal(waiting.pendingPermission?.permissionId, "permission-1");
	equal(waiting.timeline.find((item) => item.kind === "approval")?.status, "waiting");

	for (
		const [decision, status] of [
			["allow-once", "complete"],
			["reject", "canceled"],
			["unanswered", "canceled"],
			["disconnect", "canceled"],
			["cancelled", "canceled"],
		] as const
	) {
		const state = fold([{
			event: {
				kind: "turn.permission.resolved",
				turnId: "turn-1",
				payload: { permissionId: "permission-1", decision, source: "observed-by-workbench" },
			},
			now: at(20),
		}], waiting);
		const card = state.timeline.find((item) => item.kind === "approval");
		equal(state.pendingPermission, null);
		equal(card?.status, status);
		equal(card?.summary, resolutionSummary(decision));
		equal(card?.title, "Write fixture note");
		equal(card?.endedAt, at(20));
		if (decision !== "allow-once" && decision !== "reject") ok(card?.summary.includes("Clio was not told no"));
	}
});

Deno.test("a terminal event settles every unfinished card in its turn", () => {
	const state = fold([
		{ event: started("turn-1", "live", at(1)), now: at(1) },
		{ event: tool("turn-1", "tool-1", "in_progress"), now: at(2) },
		{ event: permissionRequested("turn-1", "permission-1"), now: at(3) },
		{ event: terminal("turn-1", "canceled"), now: at(9) },
	]);
	deepStrictEqual(
		state.timeline.map((item) => ({ id: item.id, status: item.status, endedAt: item.endedAt })),
		[
			{ id: "turn-1:request", status: "canceled", endedAt: at(9) },
			{ id: "turn-1:tool:tool-1", status: "canceled", endedAt: at(9) },
			{ id: "turn-1:permission:permission-1", status: "canceled", endedAt: at(9) },
			{ id: "turn-1:terminal", status: "canceled", endedAt: at(9) },
		],
	);
	equal(state.activeTurn, null);
	equal(state.pendingPermission, null);
	equal(state.timeline.find((item) => item.id === "turn-1:terminal")?.kind, "outcome");
});

Deno.test("a failed turn projects a failure card carrying its code", () => {
	const state = fold([
		{ event: started("turn-1", "live", at(1)), now: at(1) },
		{ event: terminal("turn-1", "failed"), now: at(2) },
	]);
	const card = state.timeline.find((item) => item.id === "turn-1:terminal");
	equal(card?.kind, "failure");
	equal(card?.title, "Turn failed");
	equal(card?.detail, "clio-failed");
});

Deno.test("a streamed card is bounded and says so once", () => {
	const chunk = "x".repeat(8 * 1024);
	const stream: Stamped[] = [{ event: started("turn-1", "live", at(1)), now: at(1) }];
	for (let index = 0; index < 12; index += 1) stream.push({ event: text("turn-1", chunk), now: at(2) });
	const state = fold(stream);
	const card = state.timeline.find((item) => item.kind === "narrative");
	ok(card !== undefined);
	equal(new TextEncoder().encode(card.summary).byteLength <= MAX_TIMELINE_STREAM_BYTES, true);
	ok(card.summary.endsWith(TIMELINE_STREAM_TRUNCATION_MARKER));
	equal(card.summary.split(TIMELINE_STREAM_TRUNCATION_MARKER).length, 2);
});

Deno.test("the timeline is bounded and reports the truncation", () => {
	let state = fold([{ event: started("turn-1", "live", at(1)), now: at(1) }]);
	for (let index = 0; index < MAX_WIRE_TIMELINE_ENTRIES + 8; index += 1) {
		state = applyTurnEvent(state, tool("turn-1", `tool-${index}`, "completed"), at(2));
	}
	equal(state.timeline.length, MAX_WIRE_TIMELINE_ENTRIES);
	equal(state.timelineTruncated, true);
	// Bounding drops the oldest cards, so identifiers keep climbing rather than reusing.
	const sequences = state.timeline.map((item) => item.sequence ?? 0);
	ok(sequences.every((value, index) => index === 0 || value > (sequences[index - 1] ?? 0)));
	equal(state.ordinal, MAX_WIRE_TIMELINE_ENTRIES + 9);
});

Deno.test("interleaved text and reasoning become separate cards in arrival order", () => {
	const state = fold([
		{ event: started("turn-1", "live", at(1)), now: at(1) },
		{ event: text("turn-1", "First. "), now: at(2) },
		{
			event: { kind: "turn.thought", turnId: "turn-1", payload: { text: "Thinking.", source: "observed-on-acp" } },
			now: at(3),
		},
		{ event: text("turn-1", "Second."), now: at(4) },
	]);
	deepStrictEqual(
		state.timeline.map((item: WireTimelineItem) => [item.kind, item.summary]),
		[
			["request", "Prompt for turn-1"],
			["narrative", "First. "],
			["thought", "Thinking."],
			["narrative", "Second."],
		],
	);
});

Deno.test("the last tool title falls back to the kind label when Clio names nothing", () => {
	const blank: TurnEventInput = {
		kind: "turn.tool",
		turnId: "turn-1",
		payload: {
			toolCallId: "tool-1",
			title: "Run a project command",
			kind: "execute",
			status: "in_progress",
			summary: "   ",
			locations: [],
			source: "observed-on-acp",
		},
	};
	const state = fold([
		{ event: started("turn-1", "live", at(1)), now: at(1) },
		{ event: blank, now: at(2) },
	]);
	equal(state.activeTurn?.lastToolTitle, "Run a project command");
});
