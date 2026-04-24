/**
 * Fork-replay integration. /fork picks a parent assistant turn, forks the
 * session contract to a new branch, and the interactive layer rehydrates
 * the chat panel from the parent's transcript truncated at the fork point
 * so the user sees the pre-fork turns while the new branch awaits its
 * first user submit.
 *
 * Row 52 regression reproducer: before this wiring existed, /fork cleared
 * the chat panel after forking but never replayed the parent transcript,
 * and chat-loop's in-memory lastTurnId + agent.state.messages still carried
 * pre-fork context so the next submit behaved like nothing had changed.
 */
import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import type { SessionContract } from "../../src/domains/session/index.js";
import { openSession } from "../../src/engine/session.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { buildReplayAgentMessagesFromTurns, rehydrateChatPanelFromTurns } from "../../src/interactive/chat-renderer.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
function strip(s: string): string {
	return s.replace(ANSI, "");
}

function stubContext(): DomainContext {
	return {
		bus: { emit: () => {}, on: () => () => {} } as unknown as DomainContext["bus"],
		getContract: () => undefined,
	};
}

const ORIGINAL_ENV = { ...process.env };

describe("fork navigator switches to new branch and replays pre-fork turns", () => {
	let scratch: string;
	let bundle: ReturnType<typeof createSessionBundle>;
	let contract: SessionContract;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-fork-replay-"));
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
		resetXdgCache();
		bundle = createSessionBundle(stubContext());
		contract = bundle.contract;
	});

	afterEach(async () => {
		try {
			await contract.close();
		} catch {
			// already closed by the test
		}
		for (const k of Object.keys(process.env)) {
			if (!(k in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
			if (v !== undefined) process.env[k] = v;
		}
		rmSync(scratch, { recursive: true, force: true });
		resetXdgCache();
	});

	it("fork swaps the active session and the parent transcript replays up to the fork point", () => {
		const parent = contract.create({ cwd: scratch });
		const u1 = contract.append({ parentId: null, kind: "user", payload: { text: "first" } });
		const a1 = contract.append({ parentId: u1.id, kind: "assistant", payload: { text: "reply1" } });
		const u2 = contract.append({ parentId: a1.id, kind: "user", payload: { text: "second" } });
		const a2 = contract.append({ parentId: u2.id, kind: "assistant", payload: { text: "reply2" } });
		const u3 = contract.append({ parentId: a2.id, kind: "user", payload: { text: "third" } });
		contract.append({ parentId: u3.id, kind: "assistant", payload: { text: "reply3" } });

		// Capture the parent session id BEFORE fork: the contract's current
		// swaps to the new branch during fork(), so index.ts captures the
		// parent id on the onFork entry and uses it for replay.
		const parentSessionId = contract.current()?.id;
		strictEqual(parentSessionId, parent.id);

		// Fork at the second assistant turn. The new branch should cover
		// u1/a1/u2/a2 on replay and drop u3/reply3.
		const forked = contract.fork(a2.id);

		strictEqual(contract.current()?.id, forked.id, "current session is the fork");
		ok(forked.id !== parent.id, "fork has a distinct session id");
		strictEqual(forked.parentSessionId, parent.id, "fork points back to the parent session");
		strictEqual(forked.parentTurnId, a2.id, "fork points at the parent turn");

		// Rehydrate a fresh chat panel from the parent's on-disk transcript
		// up to the fork point. This mirrors the post-/fork wiring in
		// src/interactive/index.ts openMessagePickerOverlayState.
		const panel = createChatPanel();
		const parentTurns = openSession(parent.id).turns();
		rehydrateChatPanelFromTurns(panel, parentTurns, { uptoTurnId: a2.id });
		const text = strip(panel.render(80).join("\n"));

		ok(text.includes("you: first"), `first user missing:\n${text}`);
		ok(text.includes("clio: reply1"), `first assistant missing:\n${text}`);
		ok(text.includes("you: second"), `fork-point user missing:\n${text}`);
		ok(text.includes("clio: reply2"), `fork-point assistant missing:\n${text}`);
		ok(!text.includes("third"), `post-fork user turn leaked:\n${text}`);
		ok(!text.includes("reply3"), `post-fork assistant turn leaked:\n${text}`);
	});

	it("fork replay preserves branch summaries and seeds parent-prefix context", () => {
		const parent = contract.create({ cwd: scratch });
		const u1 = contract.append({ parentId: null, kind: "user", payload: { text: "first" } });
		const a1 = contract.append({ parentId: u1.id, kind: "assistant", payload: { text: "reply1" } });
		contract.appendEntry({
			kind: "branchSummary",
			parentTurnId: a1.id,
			fromTurnId: "abandoned-turn",
			summary: "The abandoned branch edited src/app.ts.",
		});
		const u2 = contract.append({ parentId: a1.id, kind: "user", payload: { text: "second" } });
		const t1 = contract.append({
			parentId: u2.id,
			kind: "tool_call",
			payload: { toolCallId: "fork-call", name: "bash", args: { command: "npm test" } },
		});
		const tr1 = contract.append({
			parentId: t1.id,
			kind: "tool_result",
			payload: { toolCallId: "fork-call", toolName: "bash", out: "tests passed" },
		});
		const a2 = contract.append({ parentId: tr1.id, kind: "assistant", payload: { text: "reply2" } });

		const forked = contract.fork(a2.id);
		strictEqual(forked.parentSessionId, parent.id);

		const parentTurns = openSession(parent.id).turns();
		const panel = createChatPanel();
		rehydrateChatPanelFromTurns(panel, parentTurns, { uptoTurnId: a2.id });
		const text = strip(panel.render(96).join("\n"));
		ok(text.includes("[branch summary]"), text);
		ok(text.includes("The abandoned branch edited src/app.ts."), text);
		ok(text.includes("you: second"), text);
		ok(text.includes("tool: bash"), text);
		ok(text.includes("tests passed"), text);

		const replayMessages = buildReplayAgentMessagesFromTurns(parentTurns, { uptoTurnId: a2.id });
		const serialized = JSON.stringify(replayMessages);
		ok(serialized.includes("abandoned branch edited src/app.ts"), serialized);
		ok(serialized.includes("second"), serialized);
		ok(serialized.includes("Tool call: bash"), serialized);
		ok(serialized.includes("Tool result: tests passed"), serialized);
	});
});
