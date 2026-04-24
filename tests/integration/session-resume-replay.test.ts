/**
 * Resume-replay integration. When the /resume overlay picks a session, the
 * interactive layer must swap the session contract, read the target's
 * persisted turns off disk, and rehydrate the chat panel so the user sees
 * the prior transcript instead of a blank pane.
 *
 * Row 51 regression reproducer: before this wiring existed, /resume flipped
 * the session contract but left chatPanel unchanged, so a fresh TUI rendered
 * nothing at all after selection.
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
import { rehydrateChatPanelFromTurns } from "../../src/interactive/chat-renderer.js";

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

describe("resume rehydrates the chat panel from a persisted session", () => {
	let scratch: string;
	let bundle: ReturnType<typeof createSessionBundle>;
	let contract: SessionContract;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-resume-replay-"));
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

	it("replays persisted user/assistant turns into a fresh chat panel after resume", async () => {
		const meta = contract.create({ cwd: scratch });
		const u1 = contract.append({ parentId: null, kind: "user", payload: { text: "what is 2+2" } });
		const a1 = contract.append({ parentId: u1.id, kind: "assistant", payload: { text: "four" } });
		const u2 = contract.append({ parentId: a1.id, kind: "user", payload: { text: "thanks" } });
		contract.append({ parentId: u2.id, kind: "assistant", payload: { text: "you are welcome" } });
		await contract.checkpoint("test");
		await contract.close();

		// Simulate the post-/resume wiring that lives in
		// src/interactive/index.ts openResumeOverlayState onResume: flip the
		// contract back to the target session, read its turns off disk, and
		// rehydrate a fresh chat panel.
		contract.resume(meta.id);
		strictEqual(contract.current()?.id, meta.id, "resume swaps current session");

		const turns = openSession(meta.id).turns();
		strictEqual(turns.length, 4, "all four turns persisted");

		const panel = createChatPanel();
		rehydrateChatPanelFromTurns(panel, turns);
		const text = strip(panel.render(80).join("\n"));

		ok(text.includes("you: what is 2+2"), `first user turn missing:\n${text}`);
		ok(text.includes("clio: four"), `first assistant turn missing:\n${text}`);
		ok(text.includes("you: thanks"), `second user turn missing:\n${text}`);
		ok(text.includes("clio: you are welcome"), `second assistant turn missing:\n${text}`);
	});
});
