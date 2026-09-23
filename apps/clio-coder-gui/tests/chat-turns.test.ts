import assert from "node:assert/strict";
import { test } from "node:test";
import {
	activityDigest,
	activityGlyph,
	activityKindLabel,
	activityOpen,
	runningItem,
	showElapsed,
	summarizeActivity,
	toolStatusLabel,
	workerLabel,
} from "../client/chat/activity.js";
import { type HealthItemLike, summarizeHealth } from "../client/chat/health.js";
import { isLive, LIVE_GLYPHS, LIVE_TONES, type LiveState, liveStatus } from "../client/chat/live-status.js";
import { routeFacts } from "../client/chat/route.js";
import { activeTurn, type ChatTurn, groupTurns, sameTurnView, turnStatuses } from "../client/chat/turns.js";
import type { HealthItem } from "../contracts/fleet-events.js";
import type { Permission } from "../contracts/permissions.js";
import type { TimelineItem, Turn } from "../contracts/sessions.js";

function item(
	overrides: Partial<TimelineItem> & { id: string; turnId: string; kind: TimelineItem["kind"] },
): TimelineItem {
	return { sequence: 0, text: "", status: "completed", origin: "live", ...overrides };
}
function statuses(entries: Readonly<Record<string, Turn["status"]>>) {
	return new Map(Object.entries(entries));
}
function turnRow(overrides: Partial<Turn> & { id: string; status: Turn["status"] }): Turn {
	return {
		prompt: "",
		origin: "live",
		startedAt: null,
		finishedAt: null,
		stopReason: null,
		usage: null,
		problem: null,
		...overrides,
	};
}
function permission(overrides: Partial<Permission> & { id: string; turnId: string }): Permission {
	return {
		toolCallId: "call",
		title: "Write src/index.ts",
		kind: "edit",
		requestedAt: "2026-09-20T00:00:00.000Z",
		escalateAt: "2026-09-20T00:00:30.000Z",
		expiresAt: "2026-09-20T00:05:00.000Z",
		status: "pending",
		canStopTurn: true,
		...overrides,
	};
}
function only(turns: readonly ChatTurn[]): ChatTurn {
	assert.equal(turns.length, 1);
	const turn = turns[0];
	assert.ok(turn !== undefined);
	return turn;
}

test("groupTurns interleaves prose, reasoning and runs of activity", () => {
	const timeline = [
		item({ id: "a", turnId: "t1", kind: "user", text: "fix the parser" }),
		item({ id: "b", turnId: "t1", kind: "text", text: "Looking at it." }),
		item({ id: "c", turnId: "t1", kind: "tool", title: "Read parser.ts" }),
		item({ id: "d", turnId: "t1", kind: "tool", title: "Grep token" }),
		item({ id: "e", turnId: "t1", kind: "text", text: "Found it." }),
		item({ id: "f", turnId: "t1", kind: "thought", text: "The lexer drops the last token." }),
		item({ id: "g", turnId: "t1", kind: "tool", title: "Edit parser.ts" }),
		item({ id: "h", turnId: "t1", kind: "notice", title: "Approval needed" }),
	];
	const turn = only(groupTurns(timeline, statuses({ t1: "succeeded" })));
	assert.equal(turn.request?.id, "a");
	assert.equal(turn.settled, true);
	assert.deepEqual(
		turn.segments.map((segment) => (segment.kind === "activity" ? ["activity", segment.items.length] : segment.kind)),
		["response", ["activity", 2], "response", ["activity", 3]],
	);
	const work = turn.segments[3];
	assert.ok(work?.kind === "activity");
	assert.deepEqual(
		work.items.map((entry) => entry.id),
		["f", "g", "h"],
		"reasoning between calls stays with the calls, in wire order",
	);
	const activity = turn.segments[1];
	assert.ok(activity?.kind === "activity");
	assert.deepEqual(
		activity.items.map((entry) => entry.id),
		["c", "d"],
	);
});

test("reasoning with no call beside it keeps its own disclosure", () => {
	const timeline = [
		item({ id: "a", turnId: "t1", kind: "user", text: "explain" }),
		item({ id: "b", turnId: "t1", kind: "thought", text: "Consider the question." }),
		item({ id: "c", turnId: "t1", kind: "text", text: "Here is why." }),
		item({ id: "d", turnId: "t1", kind: "thought", text: "Anything else?" }),
	];
	const turn = only(groupTurns(timeline, statuses({ t1: "running" })));
	assert.deepEqual(
		turn.segments.map((segment) => segment.kind),
		["reasoning", "response", "reasoning"],
	);
});

test("groupTurns orders turns by first appearance and settles a replayed turn without a status row", () => {
	const timeline = [
		item({ id: "r1", turnId: "old", kind: "user", origin: "replay" }),
		item({ id: "n1", turnId: "new", kind: "user" }),
		item({ id: "r2", turnId: "old", kind: "text", origin: "replay" }),
	];
	const turns = groupTurns(timeline, statuses({}));
	assert.deepEqual(
		turns.map((turn) => turn.turnId),
		["old", "new"],
	);
	assert.equal(turns[0]?.settled, true);
	assert.equal(turns[0]?.origin, "replay");
	// A live turn whose row has not arrived is still open, and must not flip settled between calls.
	assert.equal(turns[1]?.settled, false);
	assert.equal(groupTurns(timeline, statuses({}), turns), turns);
});

test("groupTurns keeps the identity of every settled turn across 200 streamed deltas", () => {
	const timeline: TimelineItem[] = [];
	const rows = new Map<string, Turn["status"]>();
	const settledOnce = new Map<string, ChatTurn>();
	let previous: readonly ChatTurn[] = [];
	let rebuilds = 0;
	for (let delta = 0; delta < 200; delta += 1) {
		const turnIndex = Math.floor(delta / 20);
		const turnId = `turn-${turnIndex}`;
		const slot = delta % 20;
		if (slot === 0) {
			rows.set(turnId, "running");
			timeline.push(item({ id: `${turnId}:user`, turnId, kind: "user", text: "go" }));
		} else if (slot === 19) {
			rows.set(turnId, turnIndex % 5 === 4 ? "failed" : "succeeded");
		} else {
			const kind = slot % 3 === 1 ? "text" : slot % 3 === 2 ? "tool" : "thought";
			timeline.push(
				item({
					id: `${turnId}:${slot}`,
					turnId,
					kind,
					status: kind === "tool" ? "completed" : "in_progress",
					title: `Step ${slot}`,
				}),
			);
		}
		const next = groupTurns(timeline, rows, previous);
		if (next !== previous) rebuilds += 1;
		for (const turn of next) {
			if (!turn.settled) continue;
			const held = settledOnce.get(turn.turnId);
			if (held === undefined) settledOnce.set(turn.turnId, turn);
			else assert.equal(turn, held, `turn ${turn.turnId} lost its identity at delta ${delta}`);
		}
		// Re-grouping an unchanged timeline is a no-op, array identity included.
		assert.equal(groupTurns(timeline, rows, next), next);
		previous = next;
	}
	assert.equal(previous.length, 10);
	assert.equal(settledOnce.size, 10);
	assert.equal(
		previous.every((turn) => turn.settled),
		true,
	);
	assert.equal(rebuilds, 200);
});

test("replacing the streaming item rebuilds only its own turn", () => {
	const settled = [
		item({ id: "s1", turnId: "t1", kind: "user" }),
		item({ id: "s2", turnId: "t1", kind: "text", text: "done" }),
	];
	const live = item({ id: "l2", turnId: "t2", kind: "text", text: "wor", status: "in_progress" });
	const timeline = [...settled, item({ id: "l1", turnId: "t2", kind: "user" }), live];
	const rows = statuses({ t1: "succeeded", t2: "running" });
	const first = groupTurns(timeline, rows);
	const grown = [...timeline.slice(0, 3), { ...live, text: "working" }];
	const second = groupTurns(grown, rows, first);
	assert.notEqual(second, first);
	assert.equal(second[0], first[0], "the settled turn must keep its identity");
	assert.notEqual(second[1], first[1]);
	assert.equal(activeTurn(second)?.turnId, "t2");
	assert.equal(activeTurn([...second].slice(0, 1)), null);
});

test("sameTurnView shields a settled turn from the clock and from a permission elsewhere", () => {
	const turn = only(groupTurns([item({ id: "x", turnId: "t", kind: "text" })], statuses({ t: "succeeded" })));
	const liveTurn = only(groupTurns([item({ id: "y", turnId: "u", kind: "text" })], statuses({ u: "running" })));
	assert.equal(
		sameTurnView({ turn, pendingPermissionId: null, nowMs: 0 }, { turn, pendingPermissionId: "p", nowMs: 9 }),
		true,
	);
	assert.equal(
		sameTurnView(
			{ turn: liveTurn, pendingPermissionId: null, nowMs: 0 },
			{ turn: liveTurn, pendingPermissionId: null, nowMs: 1 },
		),
		false,
	);
	assert.equal(
		sameTurnView({ turn, pendingPermissionId: null, nowMs: 0 }, { turn: liveTurn, pendingPermissionId: null, nowMs: 0 }),
		false,
	);
});

test("turnStatuses projects the Turn rows the grouping reads", () => {
	const map = turnStatuses([turnRow({ id: "t1", status: "running" }), turnRow({ id: "t2", status: "cancelled" })]);
	assert.deepEqual(
		[...map],
		[
			["t1", "running"],
			["t2", "cancelled"],
		],
	);
});

const tool = (id: string, status: string) => item({ id, turnId: "t", kind: "tool", status, title: `Tool ${id}` });

test("summarizeActivity derives a label and a tone from statuses alone", () => {
	const cases: ReadonlyArray<readonly [readonly TimelineItem[], string, string]> = [
		[[tool("a", "completed"), tool("b", "completed"), tool("c", "completed")], "3 tools completed", "success"],
		[[tool("a", "completed")], "1 tool completed", "success"],
		[[tool("a", "in_progress"), tool("b", "pending"), tool("c", "completed")], "2 tools running · 1 done", "action"],
		[[tool("a", "failed"), tool("b", "completed"), tool("c", "completed")], "1 tool failed · 2 completed", "error"],
		[[tool("a", "cancelled"), tool("b", "rejected")], "2 tools stopped", "neutral"],
		[[tool("a", "completed"), tool("b", "expired")], "1 tool completed · 1 stopped", "success"],
		[[tool("a", "escalated"), tool("b", "in_progress")], "Approval needed", "warning"],
	];
	for (const [items, label, tone] of cases) {
		const summary = summarizeActivity(items);
		assert.equal(summary.label, label);
		assert.equal(summary.tone, tone);
		assert.equal(summary.total, items.length);
	}
	// A notice in the run makes it steps rather than tools.
	assert.equal(
		summarizeActivity([tool("a", "completed"), item({ id: "n", turnId: "t", kind: "notice" })]).label,
		"2 steps completed",
	);
	// An unrecognised status counts as done rather than stranding the group as running.
	assert.equal(summarizeActivity([tool("a", "something_new")]).label, "1 tool completed");
	assert.equal(summarizeActivity([]).label, "0 tools completed");
});

test("summarizeActivity attention and the group glyph", () => {
	assert.equal(summarizeActivity([tool("a", "completed")]).attention, false);
	assert.equal(summarizeActivity([tool("a", "cancelled")]).attention, false);
	assert.equal(summarizeActivity([tool("a", "in_progress")]).attention, true);
	assert.equal(summarizeActivity([tool("a", "failed")]).attention, true);
	assert.equal(summarizeActivity([tool("a", "escalated")]).attention, true);
	assert.equal(activityGlyph(summarizeActivity([tool("a", "escalated"), tool("b", "failed")])), "!");
	assert.equal(activityGlyph(summarizeActivity([tool("a", "in_progress"), tool("b", "failed")])), "◐");
	assert.equal(activityGlyph(summarizeActivity([tool("a", "failed")])), "✕");
	assert.equal(activityGlyph(summarizeActivity([tool("a", "completed")])), "✓");
});

test("the disclosure policy opens the right groups and then defers to the operator forever", () => {
	const running = summarizeActivity([tool("a", "in_progress")]);
	const failed = summarizeActivity([tool("a", "failed")]);
	const waiting = summarizeActivity([tool("a", "escalated")]);
	const clean = summarizeActivity([tool("a", "completed")]);
	assert.equal(activityOpen(null, false, running), true, "a live run opens");
	assert.equal(activityOpen(null, true, running), false, "a settled run is never opened by liveness alone");
	assert.equal(activityOpen(null, true, failed), true, "a failure opens even after the turn settles");
	assert.equal(activityOpen(null, true, waiting), true);
	assert.equal(activityOpen(null, true, clean), false);
	assert.equal(activityOpen(null, false, clean), true, "the group the turn is working in stays open between calls");
	assert.equal(activityOpen(false, false, failed), false, "the operator's collapse wins over every default");
	assert.equal(activityOpen(true, true, clean), true, "the operator's expansion wins over every default");
});

test("row-level helpers: running item, status labels, kind labels, elapsed and worker attribution", () => {
	const items = [tool("a", "completed"), tool("b", "in_progress"), tool("c", "pending")];
	assert.equal(runningItem(items)?.id, "b");
	assert.equal(runningItem([tool("a", "completed")]), null);
	assert.equal(toolStatusLabel("in_progress"), "running");
	assert.equal(toolStatusLabel("escalated"), "waiting");
	assert.equal(toolStatusLabel("something_new"), "something_new");
	assert.equal(activityKindLabel(item({ id: "n", turnId: "t", kind: "notice" })), "approval");
	assert.equal(activityKindLabel(item({ id: "n", turnId: "t", kind: "notice", toolKind: "safety" })), "safety");
	assert.equal(activityKindLabel(item({ id: "t", turnId: "t", kind: "tool", toolKind: "edit" })), "edit");
	assert.equal(activityKindLabel(item({ id: "t", turnId: "t", kind: "tool" })), "tool");
	assert.equal(showElapsed(tool("a", "in_progress"), 1999), false);
	assert.equal(showElapsed(tool("a", "in_progress"), 2000), true);
	assert.equal(showElapsed(tool("a", "completed"), 60000), false);
	assert.equal(workerLabel(undefined), null);
	assert.equal(workerLabel([]), null);
	assert.equal(workerLabel([{ version: 1, role: "orchestrator", agentId: "clio" }]), null);
	assert.equal(
		workerLabel([
			{ version: 1, role: "orchestrator", agentId: "clio" },
			{ version: 1, role: "worker", agentId: "reviewer", node: "dragon" },
		]),
		"reviewer · dragon",
	);
	assert.equal(
		workerLabel([{ version: 1, role: "worker", agentId: "reviewer", node: null }]),
		"reviewer",
		"an unplaced worker is named without a node",
	);
	assert.equal(
		workerLabel([
			{ version: 1, role: "worker", agentId: "reviewer" },
			{ version: 1, role: "orchestrator", agentId: "clio" },
		]),
		null,
		"the last entry wins, so an orchestrator hand-back drops the tag",
	);
});

function chatTurn(items: readonly TimelineItem[], status?: Turn["status"]): ChatTurn {
	return only(groupTurns(items, status === undefined ? statuses({}) : statuses({ t: status })));
}

test("the live status machine reaches all nine states from one realistic sequence", () => {
	const seen = new Set<LiveState>();
	const record = (status: { state: LiveState }) => {
		seen.add(status.state);
		return status.state;
	};
	const user = item({ id: "1", turnId: "t", kind: "user", text: "fix it" });
	const thought = item({ id: "2", turnId: "t", kind: "thought", text: "read the lexer first" });
	const prose = item({ id: "3", turnId: "t", kind: "text", text: "Reading the lexer." });
	const running = item({ id: "4", turnId: "t", kind: "tool", status: "in_progress", title: "Read src/lexer.ts" });
	const finished = item({ id: "4", turnId: "t", kind: "tool", status: "completed", title: "Read src/lexer.ts" });
	const notice = item({ id: "5", turnId: "t", kind: "notice", status: "escalated", title: "Write src/lexer.ts" });

	assert.equal(
		record(liveStatus(chatTurn([user], "running"), turnRow({ id: "t", status: "running" }), null)),
		"starting",
	);
	// A live worker outranks the orchestrator's silent timeline: "Starting" through a five-minute
	// dispatch is a lie.
	const waitingOnWorker = liveStatus(chatTurn([user], "running"), undefined, null, false, 2);
	assert.equal(waitingOnWorker.state, "acting");
	assert.equal(waitingOnWorker.label, "Waiting on 2 workers");
	assert.equal(liveStatus(chatTurn([user], "running"), undefined, null, false, 1).label, "Waiting on 1 worker");
	assert.equal(record(liveStatus(chatTurn([user, thought], "running"), undefined, null)), "thinking");
	assert.equal(record(liveStatus(chatTurn([user, thought, prose], "running"), undefined, null)), "writing");
	const acting = liveStatus(chatTurn([user, thought, prose, running], "running"), undefined, null);
	assert.equal(record(acting), "acting");
	assert.equal(acting.detail, "Read src/lexer.ts", "the chip carries the running tool's own title");
	assert.equal(record(liveStatus(chatTurn([user, finished], "running"), undefined, null)).valueOf(), "acting");
	assert.equal(liveStatus(chatTurn([user, finished], "running"), undefined, null).label, "Working");
	const parked = liveStatus(
		chatTurn([user, finished], "running"),
		undefined,
		permission({ id: "p1", turnId: "t", title: "Write src/lexer.ts" }),
	);
	assert.equal(record(parked), "waiting");
	assert.equal(parked.detail, "Write src/lexer.ts");
	assert.equal(record(liveStatus(chatTurn([user, notice], "running"), undefined, null)), "waiting");
	assert.equal(
		record(liveStatus(chatTurn([user, running], "running"), turnRow({ id: "t", status: "running" }), null, true)),
		"stopping",
	);
	assert.equal(
		record(liveStatus(chatTurn([user, finished], "succeeded"), turnRow({ id: "t", status: "succeeded" }), null)),
		"done",
	);
	const failed = liveStatus(
		chatTurn([user, finished], "failed"),
		turnRow({
			id: "t",
			status: "failed",
			problem: {
				type: "about:blank",
				title: "Upstream failed",
				status: 502,
				detail: "the model refused the tool call",
				code: "upstream_acp",
				instance: "/api/sessions/s",
			},
		}),
		null,
	);
	assert.equal(record(failed), "failed");
	assert.equal(failed.detail, "the model refused the tool call");
	assert.equal(
		record(liveStatus(chatTurn([user], "cancelled"), turnRow({ id: "t", status: "cancelled" }), null)),
		"stopped",
	);
	assert.deepEqual([...seen].sort(), [
		"acting",
		"done",
		"failed",
		"starting",
		"stopped",
		"stopping",
		"thinking",
		"waiting",
		"writing",
	]);
	for (const state of seen) {
		assert.equal(LIVE_GLYPHS[state].length, 1, `${state} must have a single-codepoint glyph`);
		assert.ok(LIVE_TONES[state]);
	}
});

test("a terminal row outranks everything, and a replayed turn is an earlier record", () => {
	const replayed = only(groupTurns([item({ id: "1", turnId: "t", kind: "user", origin: "replay" })], statuses({})));
	const status = liveStatus(replayed, undefined, permission({ id: "p", turnId: "t" }));
	assert.equal(status.state, "done");
	assert.equal(status.label, "Earlier record");
	const settled = liveStatus(
		chatTurn([item({ id: "1", turnId: "t", kind: "user" })], "succeeded"),
		turnRow({ id: "t", status: "succeeded" }),
		permission({ id: "p", turnId: "t" }),
		true,
	);
	assert.equal(settled.state, "done", "a pending permission cannot un-settle a finished turn");
	// A permission parked on another turn leaves this one alone.
	assert.equal(
		liveStatus(
			chatTurn([item({ id: "1", turnId: "t", kind: "user" })], "running"),
			undefined,
			permission({ id: "p", turnId: "other" }),
		).state,
		"starting",
	);
	assert.equal(isLive({ state: "acting", label: "", detail: null }), true);
	assert.equal(isLive({ state: "waiting", label: "", detail: null }), true);
	assert.equal(isLive({ state: "done", label: "", detail: null }), false);
	assert.equal(isLive({ state: "failed", label: "", detail: null }), false);
	assert.equal(isLive({ state: "stopped", label: "", detail: null }), false);
});

let healthSequence = 0;
function health(type: string, payload: unknown): HealthItemLike {
	healthSequence += 1;
	return {
		id: `h${healthSequence}`,
		at: new Date(Date.UTC(2026, 8, 20, 0, 0, healthSequence)).toISOString(),
		sourceSequence: healthSequence,
		fact: { type, payload },
	};
}

test("summarizeHealth reduces an empty strip to nothing to show", () => {
	const summary = summarizeHealth([]);
	assert.deepEqual(summary.rows, []);
	assert.equal(summary.contextWarning, null);
	assert.equal(summary.attention, false);
	assert.equal(summary.worst, "neutral");
});

test("a null context warning is the clearing edge and retires the banner", () => {
	const raised = summarizeHealth([health("health.contextWarning", { warning: "92% of the context window is in use" })]);
	assert.equal(raised.contextWarning?.detail, "92% of the context window is in use");
	assert.equal(raised.contextWarning?.tone, "warn");
	assert.equal(raised.attention, true);
	const cleared = summarizeHealth([
		health("health.contextWarning", { warning: "92% of the context window is in use" }),
		health("health.contextWarning", { warning: null }),
	]);
	assert.equal(cleared.contextWarning, null);
	assert.deepEqual(cleared.rows, [], "the cleared edge must not render as a row");
	assert.equal(cleared.attention, false);
	// Nothing anywhere may print the word "null".
	assert.equal(JSON.stringify(cleared).includes('"null"'), false);
	// Out-of-order arrival still resolves by sourceSequence, so an older clear cannot beat a newer warning.
	const late = summarizeHealth([
		health("health.contextWarning", { warning: null }),
		health("health.contextWarning", { warning: "97% of the context window is in use" }),
	]);
	assert.equal(late.contextWarning?.detail, "97% of the context window is in use");
});

test("compaction, tool budget and provider health reduce to readable rows", () => {
	const items: HealthItem[] = [
		{
			id: "c1",
			at: "2026-09-20T00:00:01.000Z",
			sourceSequence: 1,
			fact: { type: "health.compacted", payload: { trigger: "token-pressure" } },
		},
		{
			id: "b1",
			at: "2026-09-20T00:00:02.000Z",
			sourceSequence: 2,
			fact: {
				type: "health.toolBudget",
				payload: { tool: "Grep", callsThisTurn: 41, softBudget: 30, hardCeiling: 40, interrupted: true },
			},
		},
		{
			id: "p1",
			at: "2026-09-20T00:00:03.000Z",
			sourceSequence: 3,
			fact: {
				type: "health.provider",
				payload: { targetId: "zeta", status: "degraded", available: true, latencyMs: 2100 },
			},
		},
		{
			id: "p2",
			at: "2026-09-20T00:00:04.000Z",
			sourceSequence: 4,
			fact: { type: "health.provider", payload: { targetId: "alpha", status: "down", available: false, latencyMs: null } },
		},
		{
			id: "p3",
			at: "2026-09-20T00:00:05.000Z",
			sourceSequence: 5,
			fact: {
				type: "health.provider",
				payload: { targetId: "alpha", status: "healthy", available: true, latencyMs: 120 },
			},
		},
	];
	const summary = summarizeHealth(items);
	assert.equal(summary.compaction?.label, "Context compacted");
	assert.match(summary.compaction?.detail ?? "", /Triggered by token-pressure\./);
	assert.equal(summary.toolBudget?.label, "Tool budget stopped the turn");
	assert.equal(summary.toolBudget?.tone, "fail");
	assert.equal(
		summary.toolBudget?.detail,
		"Grep was called 41 times this turn against a soft budget of 30 and a hard ceiling of 40. Clio Coder interrupted the turn.",
	);
	assert.deepEqual(
		summary.providers.map((row) => [row.key, row.tone]),
		[
			["alpha", "success"],
			["zeta", "warn"],
		],
		"one row per target, newest state, ordered by target id",
	);
	assert.equal(summary.providers[0]?.detail, "Reachable, reported healthy, 120 ms last check.");
	assert.equal(summary.providers[1]?.attention, true);
	assert.equal(summary.worst, "fail");
	assert.equal(summary.attention, true);
	assert.deepEqual(
		summary.rows.map((row) => row.kind),
		["toolBudget", "provider", "provider", "compaction"],
	);
});

test("an uninterrupted budget breach and a partially reported provider still read as sentences", () => {
	const summary = summarizeHealth([
		health("health.toolBudget", {
			tool: "Bash",
			callsThisTurn: 31,
			softBudget: 30,
			hardCeiling: null,
			interrupted: false,
		}),
		health("health.provider", { targetId: "beta", status: "unknown", available: false, latencyMs: null }),
	]);
	assert.equal(summary.toolBudget?.label, "Tool budget exceeded");
	assert.equal(summary.toolBudget?.tone, "warn");
	assert.equal(
		summary.toolBudget?.detail,
		"Bash was called 31 times this turn against a soft budget of 30 and a hard ceiling of not reported.",
	);
	assert.equal(summary.providers[0]?.tone, "unverified");
	assert.equal(summary.providers[0]?.detail, "Not reachable, reported unknown, latency not reported.");
});

test("an unknown health fact reduces to a readable row rather than being dropped or throwing", () => {
	const summary = summarizeHealth([
		health("health.quotaExhausted", { remaining: 0 }),
		health("health.quotaExhausted", { remaining: 0 }),
		health("health.contextWarning", { warning: "91% of the context window is in use" }),
	]);
	assert.equal(summary.unknown.length, 1, "one row per unrecognised type, not one per event");
	assert.equal(summary.unknown[0]?.label, "Unrecognised health report");
	assert.match(summary.unknown[0]?.detail ?? "", /health\.quotaExhausted/);
	assert.equal(summary.unknown[0]?.tone, "unverified");
	assert.equal(summary.unknown[0]?.attention, false);
	assert.equal(summary.contextWarning?.detail, "91% of the context window is in use", "the known facts still reduce");
	assert.equal(summary.rows.length, 2);
});

test("a malformed payload never throws and never invents a value", () => {
	const summary = summarizeHealth([
		health("health.compacted", null),
		health("health.toolBudget", "not an object"),
		health("health.provider", { targetId: 17, status: 4, available: "yes", latencyMs: "fast" }),
		health("health.contextWarning", { warning: 5 }),
	]);
	assert.match(summary.compaction?.detail ?? "", /an unreported condition/);
	assert.match(summary.toolBudget?.detail ?? "", /^a tool was called not reported times/);
	assert.equal(summary.providers[0]?.key, "unnamed target");
	assert.equal(summary.providers[0]?.tone, "unverified");
	assert.equal(summary.contextWarning, null, "a non-string warning is not a warning");
});

test("a group only says it changed a file when the change landed", () => {
	const change = (id: string, title: string, path: string, status: string, rawOutput?: Record<string, unknown>) =>
		item({ id, turnId: "t", kind: "tool", title, status, rawInput: { path }, ...(rawOutput ? { rawOutput } : {}) });
	const refusal = {
		result: { kind: "error", message: "write blocked: write was not approved" },
		isError: true,
	};
	const broke = { result: { kind: "error", message: "EACCES: permission denied" }, isError: true };
	assert.equal(
		activityDigest([change("a", "edit", "a.py", "completed"), change("b", "write", "b.py", "completed")]),
		"changed 2 files",
		"edits and writes share one phrase",
	);
	assert.equal(activityDigest([change("a", "write", "a.py", "failed", refusal)]), "1 change not approved");
	assert.equal(activityDigest([change("a", "write", "a.py", "failed", broke)]), "1 change failed");
	assert.equal(activityDigest([change("a", "edit", "a.py", "cancelled")]), "1 change stopped");
	assert.equal(
		activityDigest([change("a", "edit", "a.py", "completed"), change("b", "write", "b.py", "failed", refusal)]),
		"changed 1 file, 1 change not approved",
	);
});

test("a group says what it did in words, counting files once and leaving reasoning out", () => {
	const call = (id: string, title: string, path?: string) =>
		item({ id, turnId: "t", kind: "tool", title, status: "completed", ...(path ? { rawInput: { path } } : {}) });
	const items = [
		item({ id: "r", turnId: "t", kind: "thought", status: "in_progress", text: "Look first." }),
		call("a", "read", "a.py"),
		call("b", "read", "a.py"),
		call("c", "read", "data.csv"),
		call("d", "bash"),
		call("e", "edit", "a.py"),
		call("f", "mcp_custom"),
	];
	assert.equal(activityDigest(items), "read 2 files, ran 1 command, changed 1 file, used 1 other tool");
	const summary = summarizeActivity(items);
	assert.equal(summary.label, "6 tools completed", "reasoning is not a step and never reads as running");
	assert.equal(summary.running, 0);
	assert.equal(runningItem(items), null);
});

test("routeFacts names the reported route and never guesses one it was not told", () => {
	const healthy = summarizeHealth([
		health("health.provider", { targetId: "alpha", status: "healthy", available: true, latencyMs: 120 }),
	]);
	const reported = routeFacts({ target: "alpha", model: "m-1", thinking: "low" }, healthy);
	assert.equal(reported.text, "alpha · m-1");
	assert.equal(reported.tone, "success");
	assert.match(reported.title, /Thinking: low\./);
	assert.match(reported.spoken, /Target alpha:/);

	const automatic = routeFacts({ target: null, model: null, thinking: "off" }, summarizeHealth([]));
	assert.equal(automatic.text, "automatic routing · default model");
	assert.equal(automatic.tone, "unverified", "no probe has run, so the glyph is not a healthy one");
	assert.match(automatic.spoken, /No target health reported/);

	const unreported = routeFacts(undefined, summarizeHealth([]));
	assert.equal(unreported.text, "Model not reported");
	assert.equal(unreported.tone, "unverified");
	const onlyHealth = routeFacts(undefined, healthy);
	assert.equal(onlyHealth.text, "alpha", "a health row names its target even without settings");
	assert.match(onlyHealth.spoken, /^Model not reported\./);
});
