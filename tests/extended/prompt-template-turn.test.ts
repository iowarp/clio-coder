import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import type { ResourcesContract } from "../../src/domains/resources/contract.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { appendOperatorAside, type CommandOutputSink } from "../../src/interactive/command-output.js";
import { expandInteractiveSubmitAsync } from "../../src/interactive/interactive-application.js";
import type { QueueEvent } from "../../src/session-control/turn-queues.js";

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

const TEMPLATE_BODY = Array.from({ length: 32 }, (_, index) => `line ${index + 1} of the template body`).join("\n");

function fakeResources(): ResourcesContract {
	return {
		parsePendingSkillRequests: (text: string) => ({ text, pendingSkillRequests: [] }),
		expandPromptTemplate: (text: string) =>
			text.startsWith("/interview:daisy")
				? {
						expanded: true,
						text: TEMPLATE_BODY,
						args: [],
						diagnostics: [],
						template: { name: "interview:daisy" },
					}
				: { expanded: false, text, args: [], diagnostics: [] },
	} as unknown as ResourcesContract;
}

test("a prompt template turn paints the typed line and a note, and sends the body", async () => {
	const expansion = await expandInteractiveSubmitAsync("/interview:daisy sigma phase  ", fakeResources(), "/tmp");
	strictEqual(expansion.text, TEMPLATE_BODY, "the model receives the expanded body");
	deepStrictEqual(expansion.display, {
		text: "/interview:daisy sigma phase",
		note: "expanded prompt template interview:daisy (32 lines)",
	});
	const plain = await expandInteractiveSubmitAsync("Inspect src", fakeResources(), "/tmp");
	strictEqual(plain.display, undefined, "ordinary text has nothing to annotate");
	strictEqual(plain.text, "Inspect src");
});

test("the aside under an operator turn is one dim row in the prose gutter", () => {
	const out = sink();
	appendOperatorAside("expanded prompt template interview:daisy (32 lines)", out.sink);
	strictEqual(out.blocks.length, 1);
	const rows = (out.blocks[0] as (width: number) => string[])(80).map(stripTerminalSequences);
	deepStrictEqual(rows, ["  expanded prompt template interview:daisy (32 lines)"]);
	strictEqual(out.renders, 1);
	appendOperatorAside("   ", out.sink);
	strictEqual(out.blocks.length, 1, "an empty note adds nothing");
});

test("streaming prompt injection and stranded resubmission retain presentation, text and monotonic queue age", async (t) => {
	const { createTurnQueues } = await import("../../src/session-control/turn-queues.js");
	let wallClock = Date.parse("2026-10-07T00:00:00Z");
	let elapsed = 0;
	t.mock.method(performance, "now", () => elapsed);
	const expansion = await expandInteractiveSubmitAsync("/interview:daisy", fakeResources(), "/tmp");
	const model: unknown[] = [];
	const injected: Array<{ kind: string; text: string; display?: unknown }> = [];
	const resubmitted: string[] = [];
	const outcomes: QueueEvent[] = [];
	const state = {
		streaming: true,
		pendingRequestContinuation: false,
		runtime: {
			agent: {
				steer: (message: unknown) => model.push(message),
				followUp: (message: unknown) => model.push(message),
				clearAllQueues: () => {},
			},
		},
	};
	const queues = createTurnQueues({
		state: state as unknown as import("../../src/session-control/turn-state.js").ChatTurnState,
		emitQueueUpdateEvent: () => {},
		emitQueuedUserTurn: (entry) => injected.push({ kind: entry.kind, text: entry.text, display: entry.display }),
		emitNotice: () => {},
		now: () => wallClock,
		onEvent: (event) => outcomes.push(event),
		submit: async (text) => {
			resubmitted.push(text);
		},
	});
	for (const kind of ["steer", "follow-up"] as const) {
		const entry =
			kind === "steer"
				? queues.steer(expansion.text, expansion.display)
				: queues.queueFollowUp(expansion.text, expansion.display);
		ok(entry);
		strictEqual(entry.enqueuedAt, wallClock);
		wallClock += kind === "steer" ? 60_000 : -120_000;
		elapsed += 25;
		queues.relabel(entry.id, { producer: "triage" }, kind);
		queues.setEntryKind(entry.id, kind);
		// The engine receives the entry only at a slot; a final turn hands
		// end-of-turn entries over once nothing is left to steer.
		queues.handOverAtFinishTurn(kind === "follow-up");
		const delivered = outcomes.at(-1);
		ok(delivered?.type === "delivered");
		strictEqual(delivered.waitedMs, 25);
		deepStrictEqual(delivered.entry, queues.acknowledgeInjected(expansion.text));
		deepStrictEqual(injected.at(-1), { kind, text: TEMPLATE_BODY, display: expansion.display });
	}
	for (const message of model) strictEqual((message as { content: string }).content, TEMPLATE_BODY);
	queues.steer(expansion.text, expansion.display);
	elapsed += 15;
	strictEqual(await queues.resubmitStranded(), true);
	const resubmittedOutcome = outcomes.at(-1);
	ok(resubmittedOutcome?.type === "removed");
	strictEqual(resubmittedOutcome.waitedMs, 15);
	deepStrictEqual(injected.at(-1), { kind: "steer", text: TEMPLATE_BODY, display: expansion.display });
	deepStrictEqual(resubmitted, [TEMPLATE_BODY]);
	const requeued = queues.steer("requeue after cancellation");
	ok(requeued);
	elapsed += 10;
	queues.handOverAtFinishTurn(false);
	queues.onRunCancelled({ hold: true });
	wallClock -= 60_000;
	elapsed += 20;
	queues.removeEntry(requeued.id);
	const removed = outcomes.at(-1);
	ok(removed?.type === "removed");
	strictEqual(removed.waitedMs, 30);
	queues.queueFollowUp("machine prompt", undefined, { origin: "peer" });
	elapsed += 5;
	queues.reset();
	const reset = outcomes.at(-1);
	ok(reset?.type === "removed");
	strictEqual(reset.waitedMs, 5);
	deepStrictEqual(queues.entries(), []);
});
