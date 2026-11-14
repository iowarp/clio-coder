// The conversation view's decisions and the command palette's source of truth. Neither file has a
// DOM here, which is the point: `ChatTurn.tsx`, `ActivityGroup.tsx` and `app.tsx` are declarative
// over these functions, so everything that can be wrong is callable from node:test.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	compactionsByTurn,
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
	turnActivity,
	turnAriaLabel,
	turnStartedAt,
} from "../client/chat/chat-turn.js";
import type { HealthRow } from "../client/chat/health.js";
import { type ChatTurn, groupTurns, turnStatuses } from "../client/chat/turns.js";
import { appCommands, DESTINATIONS, liveStopTarget, NO_SITUATION } from "../client/interaction/commands.js";
import { stopRefusal } from "../client/pages/session-control-model.js";
import type { Problem } from "../contracts/common.js";
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
	assert.deepEqual(responseAuthor(plain), { name: "CLIO Coder", delegated: false });

	const orchestrated = turnOf([
		item({
			id: "b",
			kind: "text",
			text: "hello",
			provenance: [{ version: 1, role: "orchestrator", agentId: "clio" }],
		}),
	]);
	assert.equal(responseAuthor(orchestrated).name, "CLIO Coder");

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

test("turnActivity sums host-timed tool calls and names the slowest; compactions count per turn", () => {
	const activity = turnActivity(
		turnOf([
			item({ id: "a", kind: "tool", toolCallId: "a", title: "Read file", durationMs: 120 }),
			item({ id: "b", kind: "tool", toolCallId: "b", title: "Run tests", durationMs: 3900, sequence: 1 }),
			item({ id: "c", kind: "tool", toolCallId: "c", title: "Replayed", origin: "replay", sequence: 2 }),
			item({ id: "d", kind: "text", text: "done", sequence: 3 }),
		]),
		2,
	);
	assert.deepEqual(activity, {
		tools: 3,
		timed: 2,
		toolMs: 4020,
		slowest: { name: "Run tests", ms: 3900 },
		compactions: 2,
	});
	const counts = compactionsByTurn(
		[healthRow({ id: "h1", at: "2026-09-20T10:01:00.000Z" }), healthRow({ id: "h2", at: "2026-09-20T10:02:00.000Z" })],
		[row({ id: "t1", startedAt: "2026-09-20T10:00:00.000Z" })],
	);
	assert.equal(counts.get("t1"), 2);
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
	assert.ok(paths.length > 0, "expected the navigation table to be readable");
	assert.equal(paths.includes("/docs"), false, "native Docs is no longer a navigation destination");
	const offered = new Set(DESTINATIONS.map((destination) => destination.path));
	assert.equal(offered.has("/docs"), false, "the palette must not retain native Docs navigation");
	for (const path of paths) assert.ok(offered.has(path), `${path} is in the navigation but not in the palette`);
	const { calls, handlers: on } = handlers();
	const help = appCommands(NO_SITUATION, on).find((command) => command.id === "app.help");
	assert.ok(help?.available, "Help remains reachable without an open session");
	help.run();
	assert.deepEqual(calls, ["help"], "Help opens its reference action instead of navigating to a reader");
});

test("the palette builds no request of its own and no row that looks like a typed command", () => {
	// The open task's catalog arrives as data and its rows run through the composer, so this module
	// never calls the command routes itself. Nothing here may look like a slash line.
	const source = readFileSync(fileURLToPath(new URL("../client/interaction/commands.ts", import.meta.url)), "utf8");
	assert.equal(source.includes("sessionCommands"), false);
	assert.equal(source.includes("invokeSessionCommand"), false);
	const { handlers: on } = handlers();
	for (const command of appCommands({ sessionId: "s1", runningTurnId: null, sessionOpen: true, hasNotices: true }, on))
		assert.equal(command.title.startsWith("/"), false, `${command.id} looks like a slash command`);
});

test("the open task's commands are a This task group: one runs, one that needs arguments asks for them", () => {
	const { calls, handlers: on } = handlers();
	const command = (name: string, args: Record<string, unknown>) =>
		({ name, summary: `Run ${name}`, usage: `/${name}`, group: "Work", args }) as never;
	const catalog = {
		version: 1 as const,
		commands: [command("doctor", {}), command("share", { positionals: [{ name: "target", required: true }] })],
	};
	const run = {
		...on,
		runTaskCommand: (name: string) => calls.push(`run ${name}`),
		fillTaskCommand: (name: string) => calls.push(`fill ${name}`),
	};
	const open = { sessionId: "s1", runningTurnId: null, sessionOpen: true, hasNotices: false, catalog };
	const rows = appCommands(open, run).filter((row) => row.group === "This task");
	assert.deepEqual(
		rows.map((row) => row.title),
		["Run doctor", "Run share…"],
	);
	for (const row of rows) row.run();
	assert.deepEqual(calls, ["run doctor", "fill share"]);
	assert.equal(appCommands({ ...open, sessionOpen: false }, run).filter((row) => row.group === "This task").length, 0);
	assert.equal(appCommands(open, on).filter((row) => row.group === "This task").length, 0);
});

test("a stop names the turn running when it is pressed, and nothing once that turn settled", () => {
	const turn = (id: string, status: string) => ({ id, status, prompt: "Seed turn." });
	const snapshot = (turns: unknown[], state = "open") =>
		({ workspaceId: "w1", state, label: null, turns, timeline: [] }) as never;
	assert.deepEqual(liveStopTarget("s1", snapshot([turn("t1", "succeeded"), turn("t2", "running")])), {
		id: "s1",
		workspaceId: "w1",
		title: "Seed turn.",
		currentTurnId: "t2",
	});
	assert.equal(liveStopTarget("s1", snapshot([turn("t1", "running"), turn("t2", "succeeded")])), null);
	assert.equal(liveStopTarget("s1", snapshot([turn("t2", "running")], "closed")), null);
	assert.equal(liveStopTarget("s1", undefined), null);
});

test("a refused stop reads as nothing stopped, never as accepted", () => {
	const problem = (code: Problem["code"], extra: Partial<Problem> = {}): Problem => ({
		type: `urn:clio-coder:problem:${code}`,
		title: "Refused",
		status: 409,
		detail: "That turn already ended, so CLIO Coder stopped nothing.",
		code,
		instance: "/api/sessions/s1/turns/t1/cancel",
		...extra,
	});
	assert.equal(stopRefusal(problem("conflict")), "That turn already ended, so CLIO Coder stopped nothing.");
	// Another window's control and transport failures stay for review: retrying can still stop the turn.
	assert.equal(
		stopRefusal(problem("conflict", { control: { sessionId: "s1", controller: { clientId: "c", label: "Window A" } } })),
		null,
	);
	assert.equal(stopRefusal(problem("upstream_acp")), null);
	assert.equal(stopRefusal(undefined), null);
	const actions = readFileSync(
		fileURLToPath(new URL("../client/pages/session-control-actions.ts", import.meta.url)),
		"utf8",
	);
	assert.match(actions, /stopRefusal\(error\.problem\)/);
});
