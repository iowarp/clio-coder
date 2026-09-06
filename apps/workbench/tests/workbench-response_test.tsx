import { deepEqual, equal, ok } from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatTranscript } from "../src/Chat.tsx";
import { groupTurns } from "../src/chat.ts";
import { appReducer, type AppState } from "../src/state.ts";
import { responseCompletedWorkspace, responseEvents, responseInitialState } from "./workbench-response-fixture.ts";

function responses(state: AppState) {
	const turns = groupTurns(state.open!.projection.timeline);
	const html = renderToStaticMarkup(
		<ChatTranscript turns={turns} phase="idle" pendingPermission={null} nowMs={0} truncated={false} />,
	);
	return { turns, count: (html.match(/<p>WORKBENCH_LIVE_OK<\/p>/gu) ?? []).length };
}

Deno.test("recorded New and six text chunks settle into one response", () => {
	let state = responseInitialState();
	equal(responses(state).count, 1);
	const initialSession = state.open!.clioCoder.session!.id;
	state = appReducer(state, { type: "host.events", events: responseEvents });
	ok(state.open!.clioCoder.session!.id !== initialSession);
	equal(responses(state).count, 1);
	equal(responses(state).turns.length, 1);
	deepEqual(state.open!.projection.timeline.map((item) => item.kind), ["request", "narrative", "outcome"]);
	const replayed = appReducer(state, { type: "host.events", events: responseEvents });
	equal(responses(replayed).count, 1);
	deepEqual(replayed.open!.projection, state.open!.projection);
});

Deno.test("a refreshed completed snapshot and repeated events preserve one response", () => {
	const state = appReducer(responseInitialState(), { type: "host.events", events: responseEvents });
	deepEqual(
		state.open!.projection.timeline.map((item) => [item.id, item.summary]),
		responseCompletedWorkspace().timeline.map((item) => [item.id, item.summary]),
	);
	const initial = responseInitialState();
	// project.opened replaces the browser projection on reconnect; retain host item identities.
	const refreshed = appReducer(initial, {
		type: "host.event",
		event: {
			...responseEvents.at(-1)!,
			kind: "project.opened",
			payload: { workspace: responseCompletedWorkspace() },
		},
	});
	equal(responses(refreshed).count, 1);
	equal(responses(appReducer(refreshed, { type: "host.events", events: responseEvents })).count, 1);
});

Deno.test("two distinct turn identities preserve identical replies in the same session", () => {
	let state = appReducer(responseInitialState(), { type: "host.events", events: responseEvents });
	const secondTurn = responseEvents.filter((event) => event.kind.startsWith("turn.")).map((event) => ({
		...event,
		turnId: "turn-2",
		sequence: event.sequence + 20,
		eventId: `${event.eventId}-second-turn`,
	}));
	state = appReducer(state, { type: "host.events", events: secondTurn });
	const result = responses(state);
	deepEqual(result.turns.map((turn) => turn.turnId), ["turn-1", "turn-2"]);
	equal(result.count, 2);
	for (const turn of result.turns) {
		equal(turn.segments.length, 1);
		equal(turn.outcome?.status, "complete");
	}
});

Deno.test("binding a replayed session preserves its history and subsequent state updates", () => {
	let state = responseInitialState();
	state = appReducer(state, { type: "host.event", event: responseEvents[0]! });
	equal(state.open!.projection.timeline.length, 0);
	const replay = responseEvents.filter((event) => event.kind === "turn.started" || event.kind === "turn.text")
		.map((event) =>
			event.kind === "turn.started"
				? {
					...event,
					payload: {
						...event.payload,
						origin: "replay" as const,
						startedAt: null,
						source: "replayed-from-clio" as const,
					},
				}
				: event
		);
	state = appReducer(state, { type: "host.events", events: replay });
	const projection = state.open!.projection;
	state = appReducer(state, { type: "host.event", event: responseEvents.at(-1)! });
	equal(state.open!.projection, projection);
	equal(responses(state).count, 1);
	equal(responses(state).turns[0]!.origin, "replay");
	equal(responses(state).turns[0]!.settled, true);
});
