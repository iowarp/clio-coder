// The conversation view's decisions and the command palette's source of truth. Neither file has a
// DOM here, which is the point: `ChatTurn.tsx`, `ActivityGroup.tsx` and `app.tsx` are declarative
// over these functions, so everything that can be wrong is callable from node:test.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	EMPTY_PROMPT,
	observeStart,
	placeHealthRows,
	REPLAY_PROMPT_MISSING,
	reasoningPreview,
	requestView,
	resetObservedStarts,
	responseAuthor,
	responseText,
	segmentSettled,
	toolCount,
	turnAriaLabel,
	turnStartedAt,
} from "../client/chat/chat-turn.js";
import type { HealthRow } from "../client/chat/health.js";
import { type ChatTurn, groupTurns, turnStatuses } from "../client/chat/turns.js";
import { appCommands, DESTINATIONS, NO_SITUATION } from "../client/interaction/commands.js";
import type { TimelineItem, Turn } from "../contracts/sessions.js";

const item = (over: Partial<TimelineItem> & Pick<TimelineItem, "id" | "kind">): TimelineItem => ({
	turnId: "t1",
	sequence: 0,
	text: "",
	status: "completed",
	origin: "live",
	...over,
});

const row = (over: Partial<Turn> & Pick<Turn, "id">): Turn => ({
	prompt: "",
	origin: "live",
	status: "succeeded",
	startedAt: null,
	finishedAt: null,
	stopReason: null,
	usage: null,
	problem: null,
	...over,
});

function turnOf(items: readonly TimelineItem[], rows: readonly Turn[] = []): ChatTurn {
	const turns = groupTurns(items, turnStatuses(rows), []);
	const first = turns[0];
	assert.ok(first !== undefined, "expected at least one turn");
	return first;
}

const healthRow = (over: Partial<HealthRow> & Pick<HealthRow, "id" | "at">): HealthRow => ({
	kind: "compaction",
	key: "compaction",
	sourceSequence: 0,
	label: "Conversation compacted",
	detail: null,
	tone: "warn",
	attention: false,
	...over,
});

test("reasoningPreview keeps the first line and caps it without losing that it was cut", () => {
	assert.equal(reasoningPreview("  first line\nsecond line\nthird"), "first line");
	assert.equal(reasoningPreview(""), "");
	const long = "x".repeat(200);
	const preview = reasoningPreview(long);
	assert.equal(preview.length, 141);
	assert.ok(preview.endsWith("…"));
	// A line exactly at the cap is not marked as truncated, because it was not.
	assert.equal(reasoningPreview("y".repeat(140)), "y".repeat(140));
});

test("requestView states a missing prompt rather than leaving a headless response", () => {
	const live = turnOf([item({ id: "a", kind: "user", text: "Explain the router" })]);
	assert.deepEqual(requestView(live), {
		heading: "You",
		text: "Explain the router",
		missing: false,
		replay: false,
	});

	// The case `applySessionDelta` produces for a replayed turn whose prompt was never written.
	const replayed = turnOf([item({ id: "b", kind: "text", text: "It routes.", origin: "replay" })]);
	const view = requestView(replayed);
	assert.equal(view.heading, "Earlier request");
	assert.equal(view.text, REPLAY_PROMPT_MISSING);
	assert.equal(view.missing, true);
	assert.equal(view.replay, true);

	const blank = turnOf([item({ id: "c", kind: "user", text: "   " })]);
	assert.equal(requestView(blank).text, EMPTY_PROMPT);
	assert.equal(requestView(blank).missing, true);
});

test("turnAriaLabel never repeats a stated absence as though it were the operator's words", () => {
	const named = turnOf([item({ id: "a", kind: "user", text: "Find the leak" })]);
	assert.equal(turnAriaLabel(named), "Request: Find the leak");
	const replayed = turnOf([item({ id: "b", kind: "text", text: "done", origin: "replay" })]);
	assert.equal(turnAriaLabel(replayed), "Earlier turn");
	const blank = turnOf([item({ id: "c", kind: "user", text: "" })]);
	assert.equal(turnAriaLabel(blank), "Turn");
});

test("segmentSettled marks only the last segment of a live turn as still growing", () => {
	assert.equal(segmentSettled(false, 0, 3), true);
	assert.equal(segmentSettled(false, 2, 3), true);
	assert.equal(segmentSettled(true, 0, 3), true);
	assert.equal(segmentSettled(true, 1, 3), true);
	assert.equal(segmentSettled(true, 2, 3), false);
});

test("responseAuthor prefers the delegated worker and never guesses an attribution", () => {
	const plain = turnOf([item({ id: "a", kind: "text", text: "hello" })]);
	assert.deepEqual(responseAuthor(plain), { name: "Clio Coder", delegated: false });

	const orchestrated = turnOf([
		item({
			id: "b",
			kind: "text",
			text: "hello",
			provenance: [{ version: 1, role: "orchestrator", agentId: "clio" }],
		}),
	]);
	assert.equal(responseAuthor(orchestrated).name, "Clio Coder");

	const delegated = turnOf([
		item({
			id: "c",
			kind: "text",
			text: "hello",
			provenance: [
				{ version: 1, role: "orchestrator", agentId: "clio" },
				{ version: 1, role: "worker", agentId: "reviewer", node: "dragon" },
			],
		}),
	]);
	assert.deepEqual(responseAuthor(delegated), { name: "reviewer · dragon", delegated: true });
});

test("responseAuthor reads past an activity group to the narrative the name sits above", () => {
	const turn = turnOf([
		item({
			id: "a",
			kind: "text",
			text: "first",
			provenance: [{ version: 1, role: "worker", agentId: "reviewer" }],
		}),
		item({ id: "b", kind: "tool", title: "grep" }),
	]);
	assert.equal(responseAuthor(turn).name, "reviewer");
});

test("toolCount and responseText report the turn, not the timeline", () => {
	const turn = turnOf([
		item({ id: "a", kind: "user", text: "go" }),
		item({ id: "b", kind: "text", text: "one" }),
		item({ id: "c", kind: "tool", title: "grep" }),
		item({ id: "d", kind: "notice", text: "Permission allowed: grep" }),
		item({ id: "e", kind: "tool", title: "read" }),
		item({ id: "f", kind: "text", text: "two" }),
	]);
	assert.equal(toolCount(turn), 2);
	assert.equal(responseText(turn), "one\n\ntwo");
});

test("turnStartedAt refuses to invent a time for a replayed turn", () => {
	assert.equal(turnStartedAt(undefined), null);
	assert.equal(turnStartedAt(row({ id: "t1", origin: "replay", startedAt: null })), null);
	assert.equal(turnStartedAt(row({ id: "t1", startedAt: "2026-09-20T10:00:00.000Z" })), "2026-09-20T10:00:00.000Z");
});

test("placeHealthRows puts a fact at the turn it happened in", () => {
	const turns = [
		row({ id: "t1", startedAt: "2026-09-20T10:00:00.000Z" }),
		row({ id: "t2", startedAt: "2026-09-20T10:05:00.000Z" }),
	];
	const placed = placeHealthRows(
		[
			healthRow({ id: "h1", at: "2026-09-20T10:02:00.000Z" }),
			healthRow({ id: "h2", at: "2026-09-20T10:06:00.000Z", kind: "toolBudget" }),
			healthRow({ id: "h3", at: "2026-09-20T10:03:00.000Z", kind: "toolBudget" }),
		],
		turns,
	);
	assert.deepEqual(placed.leading, []);
	assert.deepEqual(
		(placed.after.get("t1") ?? []).map((entry) => entry.id),
		["h1", "h3"],
	);
	assert.deepEqual(
		(placed.after.get("t2") ?? []).map((entry) => entry.id),
		["h2"],
	);
});

test("placeHealthRows keeps a fact it cannot place rather than dropping it", () => {
	const turns = [row({ id: "t1", startedAt: "2026-09-20T10:00:00.000Z" })];
	const placed = placeHealthRows(
		[
			healthRow({ id: "early", at: "2026-09-20T09:00:00.000Z" }),
			healthRow({ id: "unparsable", at: "not a time" }),
			healthRow({ id: "unstamped", at: "" }),
		],
		turns,
	);
	assert.deepEqual(
		placed.leading.map((entry) => entry.id),
		["early", "unparsable", "unstamped"],
	);
	assert.equal(placed.after.size, 0);
});

test("placeHealthRows tolerates turns with no start stamp at all", () => {
	const placed = placeHealthRows([healthRow({ id: "h1", at: "2026-09-20T10:02:00.000Z" })], [row({ id: "t1" })]);
	assert.deepEqual(
		placed.leading.map((entry) => entry.id),
		["h1"],
	);
});

test("observeStart records the first sighting and never moves it", () => {
	resetObservedStarts();
	assert.equal(observeStart("call-1", 1_000), 1_000);
	assert.equal(observeStart("call-1", 9_000), 1_000);
	assert.equal(observeStart("call-2", 9_000), 9_000);
	resetObservedStarts();
	assert.equal(observeStart("call-1", 42), 42);
});

const handlers = () => {
	const calls: string[] = [];
	return {
		calls,
		handlers: {
			navigate: (path: string) => calls.push(`navigate ${path}`),
			openHelp: () => calls.push("help"),
			toggleSidebar: () => calls.push("sidebar"),
			dismissNotices: () => calls.push("dismiss"),
			cancelTurn: (turnId: string) => calls.push(`cancel ${turnId}`),
			closeSession: () => calls.push("close"),
		},
	};
};

test("appCommands offers no session rows when the operator is not in a conversation", () => {
	const { handlers: on } = handlers();
	const commands = appCommands(NO_SITUATION, on);
	assert.equal(
		commands.some((command) => command.group === "Session"),
		false,
	);
	assert.equal(commands.filter((command) => command.group === "Go to").length, DESTINATIONS.length);
});

test("appCommands marks a control that cannot run as unavailable rather than offering a refusal", () => {
	const { calls, handlers: on } = handlers();
	const idle = appCommands({ sessionId: "s1", runningTurnId: null, sessionOpen: true, hasNotices: false }, on);
	const cancel = idle.find((command) => command.id === "session.cancel");
	assert.ok(cancel);
	assert.equal(cancel.available, false);
	cancel.run();
	assert.deepEqual(calls, [], "an unavailable row must not act even if something runs it");

	const close = idle.find((command) => command.id === "session.close");
	assert.equal(close?.available, true);

	const dismiss = idle.find((command) => command.id === "app.dismiss-notices");
	assert.equal(dismiss?.available, false);
});

test("appCommands runs the running turn's own id, and does not offer close mid-turn", () => {
	const { calls, handlers: on } = handlers();
	const busy = appCommands({ sessionId: "s1", runningTurnId: "turn-7", sessionOpen: true, hasNotices: true }, on);
	busy.find((command) => command.id === "session.cancel")?.run();
	assert.deepEqual(calls, ["cancel turn-7"]);
	assert.equal(busy.find((command) => command.id === "session.close")?.available, false);
	assert.equal(busy.find((command) => command.id === "app.dismiss-notices")?.available, true);
});

test("every palette destination is a path this app actually routes", () => {
	const main = readFileSync(fileURLToPath(new URL("../client/main.tsx", import.meta.url)), "utf8");
	const routed = new Set<string>();
	for (const match of main.matchAll(/path:\s*"([^"]+)"/g)) {
		const path = match[1];
		if (path !== undefined) routed.add(path.replace(/\/\*$/, ""));
	}
	assert.ok(routed.size > 10, "expected the router table to be readable");
	for (const destination of DESTINATIONS)
		assert.ok(routed.has(destination.path), `${destination.path} is offered by the palette but is not routed`);
});

test("every navigation entry is reachable from the palette", () => {
	const source = readFileSync(fileURLToPath(new URL("../client/design/navigation.tsx", import.meta.url)), "utf8");
	const table = source.slice(source.indexOf("export const navigation"), source.indexOf("] as const"));
	const paths = [...table.matchAll(/path:\s*"([^"]+)"/g)].flatMap((match) => (match[1] ? [match[1]] : []));
	assert.equal(paths.length, 11, "the navigation table changed; the palette destinations must follow");
	const offered = new Set(DESTINATIONS.map((destination) => destination.path));
	for (const path of paths) assert.ok(offered.has(path), `${path} is in the navigation but not in the palette`);
});

test("the palette never sources a row from the session command catalog", () => {
	// GET /api/sessions/:id/commands wires 9 of about 21 optional members, so a row built from it
	// would refuse with "not wired". Nothing here may look like one.
	const source = readFileSync(fileURLToPath(new URL("../client/interaction/commands.ts", import.meta.url)), "utf8");
	assert.equal(source.includes("sessionCommands"), false);
	assert.equal(source.includes("invokeSessionCommand"), false);
	const { handlers: on } = handlers();
	for (const command of appCommands({ sessionId: "s1", runningTurnId: null, sessionOpen: true, hasNotices: true }, on))
		assert.equal(command.title.startsWith("/"), false, `${command.id} looks like a slash command`);
});
