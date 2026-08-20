/**
 * The `!command` then prompt sequence (final review finding 1). A local bash
 * command captured the session leaf when it started and restored that leaf to
 * the chat loop when it finished. If a prompt landed in between, the restored
 * leaf was stale, and session.append refused every later turn on it: the
 * operator saw "chat failed" on each Enter until /resume. Two guards now cover
 * it: the bash path restores the leaf the session has at completion, and the
 * chat loop's append re-syncs its leaf copy to the session's when the session
 * refuses a parent, so a stale copy from any producer costs one retry, never
 * the session.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { createTurnPersistence } from "../../src/interactive/turn-persistence.js";
import { createTurnState } from "../../src/interactive/turn-state.js";
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

describe("contracts/turn-persistence leaf resync", () => {
	let scratch: string;

	beforeEach(async () => {
		scratch = await newScratchClioHome("clio-leaf-resync-");
	});

	afterEach(() => {
		clearScratchClioHome(scratch);
	});

	it("a stale chat leaf costs one retry onto the session's real leaf, not the session", () => {
		const session = createSessionBundle(stubContext()).contract;
		session.create({ cwd: process.cwd() });
		const state = createTurnState("off");
		const persistence = createTurnPersistence({
			state,
			session,
			getSettings: () => DEFAULT_SETTINGS as ClioSettings,
			middlewareToolChoice: { reset: () => {} } as never,
			consumePersistedEcho: () => false,
			removeQueuedMirrorEntry: () => {},
			promptCachePayloadForAssistant: () => ({}),
			promptSideTokens: () => 0,
		});

		// The operator starts `!npm test`, which captures the leaf (null: empty
		// session), then submits a prompt while it runs: u1 -> a1 land.
		persistence.appendQueuedUserTurn(userMessage("u1"));
		const u1 = state.lastTurnId;
		ok(u1);
		persistence.appendAssistantTurn(assistantMessage("a1"));
		const a1 = state.lastTurnId;
		ok(a1 && a1 !== u1);
		strictEqual(session.tree().leafId, a1);

		// The bash child finishes and a caller restores the leaf it captured
		// before those turns landed. This is the stale-copy state the old bash
		// path produced (leaf u1 while the session is at a1).
		state.lastTurnId = u1;

		// Next Enter. Before the fix: session.append threw and lastTurnId stayed
		// u1, so every later submit failed the same way.
		persistence.appendQueuedUserTurn(userMessage("u2"));

		const u2 = state.lastTurnId;
		ok(u2 && u2 !== u1 && u2 !== a1, "the new user turn was appended");
		strictEqual(session.tree().leafId, u2, "and it is the session leaf");
		const nodes = session.tree().nodesById;
		strictEqual(nodes[u2]?.parentId ?? null, a1, "parented onto the session's real leaf, not the stale copy");
		deepStrictEqual(Object.keys(nodes).sort(), [a1, u1, u2].sort(), "one branch, no orphan sibling");
		deepStrictEqual(nodes[a1]?.children, [u2], "a1 has exactly one child, the retried user turn");

		// The loop keeps working afterwards: the copy is back in lockstep.
		persistence.appendAssistantTurn(assistantMessage("a2"));
		strictEqual(session.tree().leafId, state.lastTurnId);
	});
});
