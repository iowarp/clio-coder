import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { ResourcesContract } from "../../src/domains/resources/contract.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { appendOperatorAside, type CommandOutputSink } from "../../src/interactive/command-output.js";
import { expandInteractiveSubmitAsync } from "../../src/interactive/interactive-application.js";

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

test("streaming prompt injection and stranded resubmission retain presentation and full model text", async () => {
	const { createTurnQueues } = await import("../../src/interactive/turn-queues.js");
	const expansion = await expandInteractiveSubmitAsync("/interview:daisy", fakeResources(), "/tmp");
	const model: unknown[] = [];
	const injected: unknown[] = [];
	const resubmitted: string[] = [];
	const state = {
		streaming: true,
		pendingRequestContinuation: false,
		runtime: {
			agent: {
				steer: (message: unknown) => model.push(message),
				followUp: (message: unknown) => model.push(message),
				clearSteeringQueue: () => {},
			},
		},
	};
	const queues = createTurnQueues({
		state: state as unknown as import("../../src/interactive/turn-state.js").ChatTurnState,
		emitQueueUpdateEvent: () => {},
		emitQueuedUserTurn: (entry) => injected.push(entry),
		emitNotice: () => {},
		submit: async (text) => {
			resubmitted.push(text);
		},
	});
	for (const kind of ["steer", "follow-up"] as const) {
		strictEqual(
			kind === "steer"
				? queues.steer(expansion.text, expansion.display)
				: queues.queueFollowUp(expansion.text, expansion.display),
			true,
		);
		queues.removeQueuedMirrorEntry(expansion.text);
		deepStrictEqual(injected.at(-1), { kind, text: TEMPLATE_BODY, display: expansion.display });
	}
	for (const message of model) strictEqual((message as { content: string }).content, TEMPLATE_BODY);
	queues.steer(expansion.text, expansion.display);
	strictEqual(await queues.resubmitStrandedSteers(), true);
	deepStrictEqual(injected.at(-1), { kind: "steer", text: TEMPLATE_BODY, display: expansion.display });
	deepStrictEqual(resubmitted, [TEMPLATE_BODY]);
});
