import assert from "node:assert/strict";
import { test } from "node:test";
import { extractGlobalFlags } from "../../src/cli/argv.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import type { SessionToolLimits } from "../../src/core/tool-limit-flags.js";
import { turnDelegatesTool } from "../../src/core/turn-constraints.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { SessionContract, SessionMeta } from "../../src/domains/session/contract.js";
import {
	createInteractiveSlashRuntime,
	type InteractiveSlashRuntimeDeps,
} from "../../src/interactive/interactive-slash-runtime.js";
import { type CreateChatLoopDeps, createChatLoop } from "../../src/session-control/chat-loop.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

function limitedChatLoop(sessionToolLimits: SessionToolLimits) {
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
	return createChatLoop({
		getSettings: () => settings,
		providers: context.getContract<ProvidersContract>("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		session,
		sessionToolLimits,
		createAgent: ((options: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => ({
			agent: { state: options?.initialState, subscribe: () => () => {}, abort() {}, async prompt() {} },
		})) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
	});
}

test("an interactive or ACP session's tool limits bound every turn, before and after a scoped one", async () => {
	const parsed = extractGlobalFlags(["--allow-tools", "read,write", "--delegate-tools", "none"]).toolLimits;
	assert.deepEqual(parsed?.allowedTools, ["read", "write"]);
	assert.deepEqual(parsed?.delegatedTools, []);
	const loop = limitedChatLoop({ allowedTools: ["read", "write"], delegatedTools: [] });
	try {
		// A prewarmed runtime builds its tool surface from these before any turn.
		assert.deepEqual(loop.currentTurnConstraints?.(), { allowedTools: ["read", "write"], delegatedTools: [] });
		await loop.submit("typed by the operator");
		assert.deepEqual(loop.currentTurnConstraints?.(), { allowedTools: ["read", "write"], delegatedTools: [] });
		// The scoped turn restores session limits when it settles (#423).
		await loop.submit("scoped", { constraints: { allowedTools: ["read", "bash"], delegatedTools: ["bash"] } });
		assert.deepEqual(loop.currentTurnConstraints?.(), { allowedTools: ["read", "write"], delegatedTools: [] });
	} finally {
		loop.dispose();
		await loop.whenSettled();
	}
});

test("a TUI /delegate under --delegate-tools read dispatches a worker limited to read", async () => {
	const toolLimits = extractGlobalFlags(["--delegate-tools", "read"]).toolLimits;
	assert.ok(toolLimits);
	const loop = limitedChatLoop(toolLimits);
	const dispatched: DispatchRequest[] = [];
	const runtime = createInteractiveSlashRuntime({
		io: { stdout() {}, stderr() {} },
		bus: createTelemetryHub(),
		chat: loop,
		chatPanel: { appendReplayBlock() {}, appendUser() {} },
		requestRender() {},
		refreshFooter() {},
		dispatch: {
			dispatch: async (request: DispatchRequest) => {
				dispatched.push(request);
				return {
					runId: "delegate-run",
					events: (async function* () {})(),
					finalPromise: Promise.resolve({ runId: "delegate-run", outcome: "completed", exitCode: 0 }),
				};
			},
		},
	} as unknown as InteractiveSlashRuntimeDeps);
	try {
		runtime.dispatchCommand("/delegate codex rewrite the build script");
		await new Promise((resolve) => setImmediate(resolve));
		const request = dispatched.at(0);
		assert.ok(request, "/delegate dispatched nothing");
		assert.deepEqual(request.turnConstraints, toolLimits);
		assert.equal(turnDelegatesTool(request.turnConstraints, "read"), true);
		assert.equal(turnDelegatesTool(request.turnConstraints, "write"), false);
		assert.equal(turnDelegatesTool(request.turnConstraints, "bash"), false);
	} finally {
		loop.dispose();
		await loop.whenSettled();
	}
});
