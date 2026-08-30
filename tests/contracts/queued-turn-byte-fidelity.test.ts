/**
 * The model-facing turn lost the payload's edge whitespace after a correct
 * `$ARGUMENTS` expansion.
 *
 * #240 fixed the expander, and the expansion row was already exact. What was
 * not exact was the second row the submit pipeline wrote on the queued and
 * echo paths: `appendQueuedUserTurn` trimmed the engine's user text, which
 * both failed the persisted-echo match (so a second row was written at all)
 * and shortened that row's payload. One `/raw   bar` submit produced a 5-byte
 * `"  bar"` turn and a 3-byte `"bar"` turn, and the assistant was parented to
 * the 3-byte one, so the model's parent turn disagreed with the documented
 * contract that every byte after the delimiter belongs to the payload
 * (issue #244, `docs/prompt-envelope-and-tools.md:24`).
 *
 * These assert on the turn the assistant is actually parented to, which is the
 * one the ticket says matters, not merely on a correct row existing somewhere.
 */
import { ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { collectSessionEntries } from "../../src/domains/session/compaction/session-entries.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { openSession, sessionPaths } from "../../src/engine/session.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { createTurnPersistence } from "../../src/interactive/turn-persistence.js";
import { createTurnQueues } from "../../src/interactive/turn-queues.js";
import { type ChatTurnState, createTurnState } from "../../src/interactive/turn-state.js";
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

function stubContext(): DomainContext {
	return {
		bus: { emit: () => {}, on: () => () => {} } as unknown as DomainContext["bus"],
		getContract: () => undefined,
	};
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } as unknown as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

interface Harness {
	session: SessionContract;
	state: ChatTurnState;
	persistence: ReturnType<typeof createTurnPersistence>;
	/** Texts the loop already persisted itself, matched byte-for-byte like the real queue. */
	echoes: string[];
	/** The payload text of the turn `turnId` is parented to. */
	parentText: (turnId: string) => string;
	userTexts: () => string[];
}

function harness(): Harness {
	const session = createSessionBundle(stubContext()).contract;
	session.create({ cwd: process.cwd() });
	const state = createTurnState("off");
	const echoes: string[] = [];
	const persistence = createTurnPersistence({
		state,
		session,
		getSettings: () => DEFAULT_SETTINGS as ClioSettings,
		middlewareToolChoice: { reset: () => {} } as never,
		consumePersistedEcho: (text: string) => {
			const index = echoes.indexOf(text);
			if (index < 0) return false;
			echoes.splice(index, 1);
			return true;
		},
		removeQueuedMirrorEntry: () => {},
		promptCachePayloadForAssistant: () => ({}),
		promptSideTokens: () => 0,
	});
	// Read the ledger rather than the tree snapshot: a tree node carries a
	// truncated `preview` for the overlay, and this is a test about exact bytes.
	const ledger = (): Array<{ turnId: string; role?: string; payload?: { text?: string } }> => {
		const meta = session.current();
		if (!meta) return [];
		return collectSessionEntries(openSession(meta.id).turns(), sessionPaths(meta).current) as never;
	};
	const payloadText = (turnId: string): string => {
		const entry = ledger().find((item) => item.turnId === turnId);
		return typeof entry?.payload?.text === "string" ? entry.payload.text : "";
	};
	return {
		session,
		state,
		persistence,
		echoes,
		parentText: (turnId) => {
			const parentId = session.tree().nodesById[turnId]?.parentId ?? null;
			ok(parentId !== null, "the assistant turn has a parent");
			return payloadText(parentId);
		},
		userTexts: () =>
			ledger()
				.filter((entry) => entry.role === "user")
				.map((entry) => (typeof entry.payload?.text === "string" ? entry.payload.text : "")),
	};
}

const PAYLOADS: ReadonlyArray<{ name: string; text: string }> = [
	{ name: "leading whitespace", text: "  bar" },
	{ name: "trailing whitespace", text: "bar    " },
	{ name: "both edges", text: "   bar   " },
	{ name: "interior runs", text: "  first  line\n\n   second   line  " },
	{ name: "a tab payload", text: "\tbar\t" },
];

describe("contracts/queued turn byte fidelity", () => {
	let scratch: string;

	beforeEach(async () => {
		scratch = await newScratchClioHome("clio-queued-bytes-");
	});

	afterEach(() => {
		clearScratchClioHome(scratch);
	});

	/**
	 * The `/raw   bar` case from the ticket, at the seam that broke it. The
	 * submitted turn carries the expansion; the engine then echoes the same user
	 * message back, and that echo must be recognized as the turn already in the
	 * ledger rather than written again with fewer bytes.
	 */
	it("recognizes the engine's echo of an expansion that has edge whitespace", () => {
		const test = harness();
		const expanded = "  bar";
		const submitted = test.persistence.appendSubmittedUserTurn(
			{ targetId: "test-target", wireModelId: "model", agent: { sessionId: undefined } } as never,
			expanded,
			undefined,
			false,
			"/raw   bar",
		);
		ok(submitted);
		test.echoes.push(expanded);

		test.persistence.appendQueuedUserTurn(userMessage(expanded));
		test.persistence.appendAssistantTurn(assistantMessage("ok"));
		const assistantId = test.state.lastTurnId;
		ok(assistantId);

		strictEqual(test.userTexts().length, 1, `one user turn, not two: ${JSON.stringify(test.userTexts())}`);
		strictEqual(test.parentText(assistantId), expanded, "and the assistant is parented to the exact expansion");
	});

	for (const payload of PAYLOADS) {
		it(`carries ${payload.name} into the turn the assistant is parented to`, () => {
			const test = harness();
			test.persistence.appendQueuedUserTurn(userMessage(payload.text));
			test.persistence.appendAssistantTurn(assistantMessage("ok"));
			const assistantId = test.state.lastTurnId;
			ok(assistantId);

			strictEqual(
				test.parentText(assistantId),
				payload.text,
				`the parented turn is byte-exact: ${JSON.stringify(test.parentText(assistantId))}`,
			);
		});
	}

	it("still refuses a message that is only whitespace", () => {
		const test = harness();
		const before = test.state.lastTurnId;
		test.persistence.appendQueuedUserTurn(userMessage("   \n  "));
		strictEqual(test.state.lastTurnId, before, "an empty payload writes no turn");
		strictEqual(test.userTexts().length, 0);
	});

	/**
	 * The queue is the other half of "queued or echo". A steer is a model-facing
	 * turn, so the bytes that reach the engine and the bytes mirrored for the
	 * queue panel are the submitted ones.
	 */
	it("hands the engine the submitted bytes for a steer and a follow-up", () => {
		const state = createTurnState("off");
		state.streaming = true;
		const steered: string[] = [];
		const followed: string[] = [];
		state.runtime = {
			agent: {
				steer: (message: { content?: unknown }) => steered.push(String(message.content)),
				followUp: (message: { content?: unknown }) => followed.push(String(message.content)),
			},
		} as never;
		const queues = createTurnQueues({
			state,
			emitQueueUpdateEvent: () => {},
			emitQueuedUserTurn: () => {},
			emitNotice: () => {},
			submit: async () => {},
		});

		strictEqual(queues.steer("  bar  "), true);
		strictEqual(queues.queueFollowUp("\tbaz\t"), true);
		strictEqual(queues.steer("   "), false, "a whitespace-only queue entry is still refused");

		strictEqual(steered[0], "  bar  ", "the engine gets the submitted bytes");
		strictEqual(followed[0], "\tbaz\t");
		strictEqual(queues.queuedMessages().steer[0], "  bar  ", "and so does the queue mirror");
		strictEqual(queues.queuedMessages().followUp[0], "\tbaz\t");
	});

	it("matches the persisted echo on the same bytes the engine was given", async () => {
		const state = createTurnState("off");
		const queues = createTurnQueues({
			state,
			emitQueueUpdateEvent: () => {},
			emitQueuedUserTurn: () => {},
			emitNotice: () => {},
			submit: async () => {},
		});
		let insideMatched: boolean | null = null;
		await queues.markPersistedUserEcho("  bar  ", async () => {
			insideMatched = queues.consumePersistedEcho("  bar  ");
		});
		strictEqual(insideMatched, true, "the untrimmed text is the key the echo is registered under");
		strictEqual(queues.consumePersistedEcho("bar"), false, "and a trimmed lookup is not that turn");
	});
});
