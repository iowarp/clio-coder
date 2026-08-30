import { deepEqual, equal, match, ok } from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { groupTurns, liveStatus, summarizeActivity } from "../src/chat.ts";
import { ChatTranscript } from "../src/Chat.tsx";
import type { WirePendingPermission, WireTimelineItem } from "../src/protocol.ts";
import { applyTurnEvent, emptyTurnProjection } from "../src/timeline.ts";

function item(overrides: Partial<WireTimelineItem> & Pick<WireTimelineItem, "id" | "kind">): WireTimelineItem {
	return {
		title: overrides.kind,
		summary: "",
		status: "complete",
		turnId: "turn-1",
		origin: "live",
		startedAt: "2026-08-18T12:00:00.000Z",
		source: "observed-on-acp",
		...overrides,
	};
}

Deno.test("turns group request, reasoning, response, activity, and outcome in wire order", () => {
	const timeline = [
		item({ id: "turn-1:request", kind: "request", summary: "Audit the study" }),
		item({ id: "turn-1:thought:2", kind: "thought", summary: "Plan first." }),
		item({ id: "turn-1:tool:a", kind: "tool", summary: "Read notes.md", detail: "read · notes.md" }),
		item({ id: "turn-1:tool:b", kind: "tool", summary: "bash: ls", detail: "execute", status: "failed" }),
		item({ id: "turn-1:text:5", kind: "narrative", summary: "# Findings\n\nAll good." }),
		item({ id: "turn-1:permission:p1", kind: "approval", title: "Write notes.md", summary: "Allowed once." }),
		item({ id: "turn-1:text:7", kind: "narrative", summary: "Done." }),
		item({ id: "turn-1:terminal", kind: "outcome", title: "Turn complete", summary: "Clio Coder finished." }),
		item({ id: "turn-2:request", kind: "request", turnId: "turn-2", summary: "Next", status: "active" }),
	];
	const turns = groupTurns(timeline);
	equal(turns.length, 2);
	const first = turns[0]!;
	equal(first.request?.summary, "Audit the study");
	equal(first.outcome?.title, "Turn complete");
	equal(first.settled, true);
	deepEqual(first.segments.map((segment) => segment.kind), [
		"reasoning",
		"activity",
		"response",
		"activity",
		"response",
	]);
	const activity = first.segments[1];
	ok(activity?.kind === "activity");
	equal(activity.items.length, 2);
	const second = turns[1]!;
	equal(second.settled, false);
	equal(second.segments.length, 0);
	equal(second.outcome, null);
});

Deno.test("settled turns keep their identity while a later turn streams", () => {
	const base = [
		item({ id: "turn-1:request", kind: "request", summary: "One" }),
		item({ id: "turn-1:terminal", kind: "outcome", title: "Turn complete" }),
		item({ id: "turn-2:request", kind: "request", turnId: "turn-2", summary: "Two", status: "active" }),
	];
	const first = groupTurns(base);
	const grown = [...base, item({ id: "turn-2:text:4", kind: "narrative", turnId: "turn-2", summary: "Streaming" })];
	const second = groupTurns(grown, first);
	ok(second !== first, "a changed timeline yields a new array");
	ok(second[0] === first[0], "the settled turn keeps its object identity");
	ok(second[1] !== first[1], "the streaming turn is rebuilt");
	const unchanged = groupTurns(grown, second);
	ok(unchanged === second, "an unchanged timeline returns the same array");
});

Deno.test("a replayed turn is settled even though Clio Coder replays no outcome card", () => {
	const turns = groupTurns([
		item({ id: "turn-1:request", kind: "request", origin: "replay", status: "replayed", startedAt: null }),
		item({ id: "turn-1:text:2", kind: "narrative", origin: "replay", status: "replayed", startedAt: null }),
	]);
	equal(turns[0]?.settled, true);
	equal(liveStatus(turns[0]!, "idle", null).label, "Earlier record");
});

Deno.test("activity summaries count only what item statuses say", () => {
	const done = summarizeActivity([
		item({ id: "a", kind: "tool" }),
		item({ id: "b", kind: "tool" }),
		item({ id: "c", kind: "tool" }),
		item({ id: "d", kind: "tool" }),
	]);
	equal(done.label, "4 tools completed");
	equal(done.tone, "success");
	equal(done.attention, false);

	const running = summarizeActivity([
		item({ id: "a", kind: "tool" }),
		item({ id: "b", kind: "tool", status: "active" }),
	]);
	equal(running.label, "1 tool running · 1 done");
	equal(running.tone, "action");
	equal(running.attention, true);

	const failed = summarizeActivity([
		item({ id: "a", kind: "tool", status: "failed" }),
		item({ id: "b", kind: "tool" }),
	]);
	equal(failed.label, "1 tool failed · 1 completed");
	equal(failed.tone, "error");

	const waiting = summarizeActivity([
		item({ id: "a", kind: "tool", status: "active" }),
		item({ id: "p", kind: "approval", status: "waiting" }),
	]);
	equal(waiting.label, "Approval needed");
	equal(waiting.tone, "warning");

	const mixed = summarizeActivity([item({ id: "a", kind: "tool" }), item({ id: "l", kind: "loop" })]);
	equal(mixed.label, "2 steps completed");

	const stopped = summarizeActivity([item({ id: "a", kind: "tool", status: "canceled" })]);
	equal(stopped.label, "1 tool stopped");
	equal(stopped.tone, "neutral");
});

Deno.test("live status is derived from phase and the newest item, never invented", () => {
	const permission: WirePendingPermission = {
		permissionId: "p1",
		toolCallId: "t1",
		title: "Write notes.md",
		kind: "edit",
		locations: [],
		requestedAt: "2026-08-18T12:00:00.000Z",
		escalateAt: "2026-08-18T12:00:45.000Z",
		expiresAt: "2026-08-18T12:10:00.000Z",
		source: "observed-on-acp",
	};
	const started = groupTurns([item({ id: "turn-1:request", kind: "request", status: "active" })])[0]!;
	equal(liveStatus(started, "running", null).state, "starting");
	const thinking = groupTurns([
		item({ id: "turn-1:request", kind: "request", status: "active" }),
		item({ id: "turn-1:thought:2", kind: "thought" }),
	])[0]!;
	equal(liveStatus(thinking, "running", null).label, "Thinking");
	const acting = groupTurns([
		item({ id: "turn-1:request", kind: "request", status: "active" }),
		item({ id: "turn-1:tool:a", kind: "tool", summary: "bash: make test", status: "active" }),
	])[0]!;
	deepEqual(liveStatus(acting, "running", null), { state: "acting", label: "Running", detail: "bash: make test" });
	const writing = groupTurns([
		item({ id: "turn-1:request", kind: "request", status: "active" }),
		item({ id: "turn-1:text:3", kind: "narrative" }),
	])[0]!;
	equal(liveStatus(writing, "running", null).state, "writing");
	equal(liveStatus(writing, "awaiting-approval", permission).detail, "Write notes.md");
	equal(liveStatus(writing, "cancelling", null).label, "Stopping");
	const failed = groupTurns([
		item({ id: "turn-1:request", kind: "request" }),
		item({ id: "turn-1:terminal", kind: "failure", status: "failed", summary: "Provider timed out." }),
	])[0]!;
	deepEqual(liveStatus(failed, "idle", null), { state: "failed", label: "Failed", detail: "Provider timed out." });
	const stopped = groupTurns([
		item({ id: "turn-1:request", kind: "request" }),
		item({ id: "turn-1:terminal", kind: "outcome", status: "canceled", title: "Turn stopped" }),
	])[0]!;
	equal(liveStatus(stopped, "idle", null).label, "Stopped");
});

Deno.test("the transcript renders Markdown responses, compact activity, and the outcome line", () => {
	let projection = emptyTurnProjection;
	const now = "2026-08-18T12:00:00.000Z";
	projection = applyTurnEvent(projection, {
		kind: "turn.started",
		turnId: "turn-1",
		payload: { promptSummary: "Audit the study", origin: "live", startedAt: now, source: "observed-by-workbench" },
	}, now);
	projection = applyTurnEvent(projection, {
		kind: "turn.thought",
		turnId: "turn-1",
		payload: { text: "Plan first.", source: "observed-on-acp" },
	}, now);
	for (const [id, status] of [["a", "completed"], ["b", "completed"], ["c", "failed"]] as const) {
		projection = applyTurnEvent(projection, {
			kind: "turn.tool",
			turnId: "turn-1",
			payload: {
				toolCallId: id,
				title: "Read project content",
				kind: "read",
				status,
				summary: `Read ${id}.md`,
				locations: [{ segments: [`${id}.md`] }],
				source: "observed-on-acp",
			},
		}, now);
	}
	projection = applyTurnEvent(projection, {
		kind: "turn.text",
		turnId: "turn-1",
		payload: {
			text: "## Findings\n\nThe **coarse** case stalls.\n\n```ts\nconst x = 1;\n```\n",
			source: "observed-on-acp",
		},
	}, now);
	projection = applyTurnEvent(projection, {
		kind: "turn.terminal",
		turnId: "turn-1",
		payload: {
			outcome: "completed",
			code: "end_turn",
			summary: "Clio Coder finished this turn.",
			stopReason: "end_turn",
			usage: { input: 5, output: 8, cacheRead: 1, cacheWrite: 0, reasoning: 2 },
			source: "reported-by-clio",
		},
	}, now);
	const turns = groupTurns(projection.timeline);
	const html = renderToStaticMarkup(
		<ChatTranscript turns={turns} phase="idle" pendingPermission={null} nowMs={0} truncated={false} />,
	);
	match(html, /aria-label="Conversation with Clio Coder"/u);
	match(html, /class="chat-request__prompt">Audit the study</u);
	match(html, /<details class="reasoning">/u);
	match(html, /Plan first\./u);
	match(html, /1 tool failed · 2 completed/u);
	match(
		html,
		/class="details activity activity--error is-open"|<details class="activity activity--error is-open" open=""/u,
	);
	match(html, /activity-row activity-row--tool is-failed/u);
	match(html, /<h3 class="md-heading md-heading--2">Findings<\/h3>/u);
	match(html, /<strong>coarse<\/strong>/u);
	match(html, /class="code-block is-settled" data-language="typescript"/u);
	match(html, /class="turn-outcome"/u);
	match(html, /tokens 5 in · 8 out/u);
	match(html, /3 tool calls/u);
	match(html, /live-chip live-chip--done/u);
	ok(!html.includes("aria-live"), "the transcript itself is not a live region");
	ok(!html.includes("undefined"));
});

Deno.test("an active turn shows the current tool and a pending approval with its actions inline", () => {
	const permission: WirePendingPermission = {
		permissionId: "permission-internal-0001",
		toolCallId: "tool-internal-0001",
		title: "Write notes.md",
		kind: "edit",
		locations: [{ segments: ["notes.md"] }],
		requestedAt: "2026-08-18T12:00:00.000Z",
		escalateAt: "2026-08-18T12:00:45.000Z",
		expiresAt: "2026-08-18T12:10:00.000Z",
		source: "observed-on-acp",
	};
	const turns = groupTurns([
		item({ id: "turn-1:request", kind: "request", summary: "Write it", status: "active" }),
		item({ id: "turn-1:tool:a", kind: "tool", summary: "bash: make", detail: "execute", status: "active" }),
		item({
			id: "turn-1:permission:permission-internal-0001",
			kind: "approval",
			title: "Write notes.md",
			summary: "edit permission requested for notes.md.",
			status: "waiting",
		}),
	]);
	const html = renderToStaticMarkup(
		<ChatTranscript
			turns={turns}
			phase="awaiting-approval"
			pendingPermission={permission}
			nowMs={Date.parse("2026-08-18T12:00:10.000Z")}
			onResolve={() => undefined}
			truncated={false}
		/>,
	);
	match(html, /live-chip live-chip--waiting/u);
	match(html, /Waiting for your approval/u);
	match(html, /Approval needed/u);
	match(html, /id="permission-title"/u);
	match(html, /edit access to notes\.md/u);
	match(html, />Allow once</u);
	match(html, />Reject</u);
	match(html, /activity-row activity-row--tool is-active/u);
	match(html, /· 10s/u);
	ok(!html.includes("permission-internal-0001"), "wire identifiers never render");
	ok(!html.includes("tool-internal-0001"));
});
