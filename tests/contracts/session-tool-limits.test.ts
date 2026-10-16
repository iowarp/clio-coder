import assert from "node:assert/strict";
import { test } from "node:test";
import { extractGlobalFlags } from "../../src/cli/argv.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { SessionContract, SessionMeta } from "../../src/domains/session/contract.js";
import { type CreateChatLoopDeps, createChatLoop } from "../../src/session-control/chat-loop.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

test("an interactive or ACP session's tool limits bound every turn, before and after a scoped one", async () => {
	assert.deepEqual(extractGlobalFlags(["--allow-tools", "read,write", "--delegate-tools", "none"]).toolLimits, {
		allowedTools: ["read", "write"],
		delegatedTools: [],
	});
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	const context = dispatchStubContext({ settings });
	const target = settings.targets[0];
	assert.ok(target);
	settings.chat.target = target.id;
	settings.chat.model = target.defaultModel ?? "gpt-4o";
	let current: SessionMeta | null = null;
	let turns = 0;
	const session = {
		current: () => current,
		create: (input?: { cwd?: string }) => {
			current = {
				id: "session-tool-limits",
				cwd: input?.cwd ?? process.cwd(),
				cwdHash: "hash",
				createdAt: "2026-10-16T00:00:00.000Z",
				endedAt: null,
				model: null,
				target: null,
			} as SessionMeta;
			return current;
		},
		append: (turn: Record<string, unknown>) => ({ ...turn, id: `turn-${++turns}`, at: "2026-10-16T00:00:00.000Z" }),
		appendEntry: (entry: Record<string, unknown>) => entry,
		checkpoint: async () => {},
		flushAppends: () => {},
		replaceEntries: () => {},
		tree: () => ({ leafId: null, nodes: [] }),
	} as unknown as SessionContract;
	const loop = createChatLoop({
		getSettings: () => settings,
		providers: context.getContract<ProvidersContract>("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		session,
		sessionToolLimits: { allowedTools: ["read", "write"], delegatedTools: [] },
		createAgent: ((options: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => ({
			agent: { state: options?.initialState, subscribe: () => () => {}, abort() {}, async prompt() {} },
		})) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
	});
	try {
		// A prewarmed runtime builds its tool surface from these before any turn.
		assert.deepEqual(loop.currentTurnConstraints?.(), { allowedTools: ["read", "write"], delegatedTools: [] });
		await loop.submit("typed by the operator");
		assert.deepEqual(loop.currentTurnConstraints?.(), { allowedTools: ["read", "write"], delegatedTools: [] });
		// A host-scoped turn narrows further and never widens past the session limit.
		await loop.submit("scoped", { constraints: { allowedTools: ["read", "bash"], delegatedTools: ["bash"] } });
		assert.deepEqual(loop.currentTurnConstraints?.(), { allowedTools: ["read"], delegatedTools: [] });
	} finally {
		loop.dispose();
		await loop.whenSettled();
	}
});
