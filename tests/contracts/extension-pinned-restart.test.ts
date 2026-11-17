import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { clioStateDir } from "../../src/core/xdg.js";
import {
	pinnedContextDelta,
	pinnedContextFile,
	renderPinnedContext,
} from "../../src/domains/extensions/pinned-context.js";
import { createExtensionRuntimeHookBridge } from "../../src/domains/extensions/runtime-hook-bridge.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { SessionContract, SessionMeta } from "../../src/domains/session/contract.js";
import { type CreateChatLoopDeps, createChatLoop } from "../../src/session-control/chat-loop.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const MILESTONE = "Milestone 2: methods. Next: plan-section";

/** One process's bridge: a restart is a new bridge over the same state directory. */
function processFor(session: { id: string | null }) {
	return createExtensionRuntimeHookBridge({ sessionId: () => session.id });
}

/** The first request a resumed session sends, through a chat loop whose session is already open. */
async function firstRequestAfterResume(bridge: ReturnType<typeof processFor>, sessionId: string): Promise<string> {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	const context = dispatchStubContext({ settings });
	const target = settings.targets[0];
	assert.ok(target);
	settings.chat.target = target.id;
	settings.chat.model = target.defaultModel ?? "gpt-4o";
	const meta = {
		id: sessionId,
		cwd: process.cwd(),
		cwdHash: "hash",
		createdAt: "2026-11-16T00:00:00.000Z",
		endedAt: null,
		model: null,
		target: null,
	} as SessionMeta;
	let turns = 0;
	const session = {
		current: () => meta,
		create: () => meta,
		append: (turn: Record<string, unknown>) => ({ ...turn, id: `turn-${++turns}`, at: "2026-11-16T00:00:00.000Z" }),
		appendEntry: (entry: Record<string, unknown>) => entry,
		checkpoint: async () => {},
		flushAppends: () => {},
		replaceEntries: () => {},
		tree: () => ({ leafId: null, nodes: [] }),
		leafId: () => null,
	} as unknown as SessionContract;
	const sent: string[] = [];
	const loop = createChatLoop({
		getSettings: () => settings,
		providers: context.getContract("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		session,
		pinnedContext: () => bridge.pinned(),
		createAgent: ((options: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => {
			const agent = {
				state: options?.initialState,
				subscribe: () => () => {},
				abort() {},
				async prompt(text: string) {
					sent.push(text);
				},
			};
			return { agent };
		}) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
	});
	try {
		await loop.submit("carry on with the paper");
	} finally {
		loop.dispose();
		await loop.whenSettled();
	}
	const first = sent[0];
	assert.ok(first !== undefined);
	return first;
}

test("a pinned block persists with its session and is on the first request after a restart", async (t) => {
	const env = await isolateClioEnv("clio-coder-pinned-restart-");
	t.after(() => env.restore());
	const session = { id: "paper-1" as string | null };
	const before = processFor(session);
	before.pin("desk", MILESTONE);
	assert.ok(existsSync(pinnedContextFile(clioStateDir(), "paper-1")));

	// No hook has run in the new process: the block comes back from the session's state.
	const after = processFor({ id: "paper-1" });
	const first = await firstRequestAfterResume(after, "paper-1");
	assert.ok(first.includes(renderPinnedContext({ extensionId: "desk", text: MILESTONE })), first);
	assert.ok(first.indexOf("<pinned-context") < first.indexOf("carry on with the paper"));
	// The delivery rule is unchanged: a resumed context that still carries the block is not sent it again.
	assert.deepEqual(
		pinnedContextDelta(after.pinned(), [renderPinnedContext({ extensionId: "desk", text: MILESTONE })]),
		[],
	);

	// Another session has its own blocks, none of this one's.
	assert.deepEqual(processFor({ id: "paper-2" }).pinned(), []);
});

test("a cleared or removed block stays cleared across a restart, and a session-less pin joins the next session", async (t) => {
	const env = await isolateClioEnv("clio-coder-pinned-restart-");
	t.after(() => env.restore());
	const session = { id: null as string | null };
	const live = processFor(session);
	// Pinned before the session existed: the session that opens adopts it.
	live.pin("desk", MILESTONE);
	live.pin("notes", "Open question: tail latency");
	session.id = "paper-1";
	assert.deepEqual(processFor({ id: "paper-1" }).pinned(), []);
	assert.equal(live.pinned().length, 2);
	assert.deepEqual(processFor({ id: "paper-1" }).pinned(), [
		{ extensionId: "desk", text: MILESTONE },
		{ extensionId: "notes", text: "Open question: tail latency" },
	]);

	// desk clears its block; a reload removes notes.
	live.pin("desk", "");
	live.retainPinned(new Set(["desk"]));
	const restarted = processFor({ id: "paper-1" });
	assert.deepEqual(restarted.pinned(), [
		{ extensionId: "desk", text: "" },
		{ extensionId: "notes", text: "" },
	]);
	// Nothing is sent to a context that never saw the blocks; one that still shows the old value hears it cleared.
	assert.deepEqual(pinnedContextDelta(restarted.pinned(), []), []);
	const old = renderPinnedContext({ extensionId: "desk", text: MILESTONE });
	assert.deepEqual(pinnedContextDelta(restarted.pinned(), [old]), [
		renderPinnedContext({ extensionId: "desk", text: "" }),
	]);
	const firstAfterClear = await firstRequestAfterResume(restarted, "paper-1");
	assert.ok(!firstAfterClear.includes("<pinned-context"), firstAfterClear);
});
