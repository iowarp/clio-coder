import { match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { appendInterviewRecord, type CommandOutputSink } from "../../src/interactive/command-output.js";
import { createOverlayAskUserLifecycle } from "../../src/interactive/overlay-ask-user-lifecycle.js";

function sink(): { sink: CommandOutputSink; blocks: Array<(width: number) => string[]>; renders: number } {
	const blocks: Array<(width: number) => string[]> = [];
	const state = { renders: 0 };
	return {
		blocks,
		get renders() {
			return state.renders;
		},
		sink: {
			appendReplayBlock: (renderBlock) => blocks.push(renderBlock),
			requestRender: () => {
				state.renders += 1;
			},
		},
	};
}

test("an answered round leaves its questions and answers in the transcript", () => {
	const out = sink();
	appendInterviewRecord(
		[
			{
				label: "Research Exploration; Material Science",
				answer:
					"Provided details; Energy materials; Nb microalloying and sigma-phase onset in CoCrFeNi HEA aged at 700 C; arc melter and SEM available",
			},
			{ label: "Researcher Context", answer: "Skip; use reasonable defaults" },
			{ label: "Ignored", answer: "   " },
		],
		out.sink,
	);
	strictEqual(out.blocks.length, 1);
	const rows = (out.blocks[0] as (width: number) => string[])(60).map(stripTerminalSequences);
	strictEqual(rows[0], "❯ Research Exploration; Material Science");
	ok(rows[1]?.startsWith("  Provided details; Energy materials"));
	ok(rows.some((row) => row === "❯ Researcher Context"));
	ok(rows.some((row) => row === "  Skip; use reasonable defaults"));
	ok(!rows.some((row) => row.includes("Ignored")), "an empty answer is not recorded");
	for (const row of rows) ok(row.length <= 60, row);
	match(rows.join(" "), /SEM available/u, "the answer is wrapped, not cut");
	const empty = sink();
	appendInterviewRecord([], empty.sink);
	strictEqual(empty.blocks.length, 0);
});

test("a round a tool call asked leaves no second record; a round no tool row states keeps one", async () => {
	const recorded: string[] = [];
	let state: "closed" | "ask-user" = "closed";
	const session = {
		ask: async () => ({ cancelled: false, answers: [{ question: "Unit?", answer: "Elapsed milliseconds" }] }),
		cancel() {},
		close() {},
		isWaiting: () => false,
		hide() {},
	};
	const lifecycle = createOverlayAskUserLifecycle({
		tui: {} as never,
		getOverlayState: () => state,
		setOverlayState: (next) => {
			state = next as typeof state;
		},
		getOverlayHandle: () => null,
		setOverlayHandle() {},
		renderContextIsland() {},
		renderTaskIsland() {},
		requestRender() {},
		openAskUserOverlay: (() => session) as never,
		onRoundAnswered: (_questions, answers) => recorded.push(...answers.map((answer) => answer.answer)),
	});
	const questions = [{ question: "Unit?", header: "Retry budget unit", options: [] }] as never;
	// The `? asked Unit? → Elapsed milliseconds` row states this round.
	await lifecycle.handler(questions, { toolCallId: "ask-1" } as never);
	strictEqual(recorded.length, 0);
	// An operator question outside any tool call has no row: the record is its trace.
	await lifecycle.handler(questions, undefined);
	strictEqual(recorded.length, 1);
	lifecycle.dispose();
});
