import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ExtensionRuntimeDeclarationV2 } from "../../src/domains/extensions/manifest-v2.js";
import { renderPinnedContext } from "../../src/domains/extensions/pinned-context.js";
import type { ExtensionEffect } from "../../src/domains/extensions/public-api-v2.js";
import { createExtensionRuntimeHookBridge } from "../../src/domains/extensions/runtime-hook-bridge.js";
import { parseExtensionHookResult } from "../../src/domains/extensions/runtime-output-v2.js";
import { installExtension, listInstalledExtensions } from "../../src/domains/extensions/state.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { SessionContract, SessionMeta } from "../../src/domains/session/contract.js";
import { buildExtensionRuntimeHooks } from "../../src/entry/extension-runtime-hooks.js";
import { type CreateChatLoopDeps, createChatLoop } from "../../src/session-control/chat-loop.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const declaration = { ui: [], access: [], workspaces: [] } as unknown as ExtensionRuntimeDeclarationV2;

test("pin_context applies where extension state moves and refuses an oversize or doubled block", () => {
	const pin = { effects: [{ kind: "pin_context", text: "milestone 2" }] };
	for (const point of ["prompt_submit", "turn_start", "after_tool"] as const)
		assert.deepEqual(parseExtensionHookResult(pin, declaration, point).effects, [
			{ kind: "pin_context", text: "milestone 2" },
		]);
	for (const point of ["before_tool", "turn_end"] as const)
		assert.throws(() => parseExtensionHookResult(pin, declaration, point), /does not apply at/);
	// The limit is UTF-8 bytes: 4096 two-byte characters fit, one more does not.
	const fits = { effects: [{ kind: "pin_context", text: "é".repeat(4096) }] };
	assert.equal(parseExtensionHookResult(fits, declaration, "turn_start").effects?.length, 1);
	const over = { effects: [{ kind: "pin_context", text: "é".repeat(4097) }] };
	assert.throws(
		() => parseExtensionHookResult(over, declaration, "turn_start"),
		/effects\[0\]\.text exceeds the 8192-byte pinned context limit/,
	);
	const twice = { effects: [pin.effects[0], { kind: "pin_context", text: "" }] };
	assert.throws(() => parseExtensionHookResult(twice, declaration, "turn_start"), /pin_context at most once/);
});

/** A runtime for `desk` whose turn_start and after_tool answers the test sets, behind real hook registrations. */
async function deskHooks(dir: string) {
	const source = path.join(dir, "source");
	const workspace = path.join(dir, "workspace");
	mkdirSync(source);
	mkdirSync(workspace);
	writeFileSync(
		path.join(source, "clio-coder-extension.json"),
		JSON.stringify({
			id: "desk",
			name: "Desk",
			version: "1.0.0",
			description: "Keeps the paper's milestone in view",
			runtime: {
				api: 2,
				entrypoint: "extension.mjs",
				hooks: [
					{ on: "turn_start", timeoutMs: 1000, onTimeout: "pass", onError: "pass" },
					{ on: "after_tool", timeoutMs: 1000, onTimeout: "pass", onError: "pass" },
				],
			},
		}),
	);
	writeFileSync(path.join(source, "extension.mjs"), "export default () => {};\n");
	assert.ok(installExtension(source, { cwd: workspace, scope: "user" }).extension?.loadable);
	const answers: { effects: ExtensionEffect[] } = { effects: [] };
	const bridge = createExtensionRuntimeHookBridge();
	bridge.bind({ hook: async () => ({ kind: "ok", effects: answers.effects }), notify: () => {} });
	const packages = listInstalledExtensions(workspace, { all: true });
	const hooks = buildExtensionRuntimeHooks(packages, bridge, { generation: 1, recordReceipt: () => {} });
	return { answers, bridge, hooks };
}

test("a worker's after_tool pin is not the session's; the session's own replaces the block", async (t) => {
	const env = await isolateClioEnv("clio-coder-pinned-worker-");
	t.after(() => env.restore());
	const { answers, bridge, hooks } = await deskHooks(env.dir);
	const afterTool = hooks.registrations.find((registration) => registration.hooks.includes("after_tool"));
	assert.ok(afterTool?.evaluateAsync);
	answers.effects = [{ kind: "pin_context", text: "draft intro" }];
	await afterTool.evaluateAsync({ hook: "after_tool", toolName: "write", metadata: {} });
	answers.effects = [{ kind: "pin_context", text: "draft methods" }];
	await afterTool.evaluateAsync({ hook: "after_tool", toolName: "write", metadata: {} });
	assert.deepEqual(bridge.pinned(), [{ extensionId: "desk", text: "draft methods" }]);
	answers.effects = [{ kind: "pin_context", text: "from a worktree" }];
	const worker = hooks.workerEvaluators.get(afterTool.id);
	assert.ok(worker);
	await worker({ hook: "after_tool", toolName: "write", metadata: {} });
	assert.deepEqual(bridge.pinned(), [{ extensionId: "desk", text: "draft methods" }]);
});

test("the pinned block rides the message tail once, is replaced, and returns verbatim after a compaction", async (t) => {
	const env = await isolateClioEnv("clio-coder-pinned-context-");
	t.after(() => env.restore());
	const { answers, bridge, hooks } = await deskHooks(env.dir);
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
				id: "pinned-context",
				cwd: input?.cwd ?? process.cwd(),
				cwdHash: "hash",
				createdAt: "2026-11-16T00:00:00.000Z",
				endedAt: null,
				model: null,
				target: null,
			} as SessionMeta;
			return current;
		},
		append: (turn: Record<string, unknown>) => ({ ...turn, id: `turn-${++turns}`, at: "2026-11-16T00:00:00.000Z" }),
		appendEntry: (entry: Record<string, unknown>) => entry,
		checkpoint: async () => {},
		flushAppends: () => {},
		replaceEntries: () => {},
		tree: () => ({ leafId: null, nodes: [] }),
		leafId: () => null,
	} as unknown as SessionContract;
	// Each prompt is one request: the history it extends, then the new message.
	const sent: Array<{ history: string; text: string; tail?: unknown[] | undefined }> = [];
	let midTurnPin: string | null = null;
	let live: { state: { messages: unknown[] } } | undefined;
	const loop = createChatLoop({
		getSettings: () => settings,
		providers: context.getContract("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		session,
		middleware: createMiddlewareBundle({ registrations: hooks.registrations }).contract,
		pinnedContext: () => bridge.pinned(),
		createAgent: ((options: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => {
			const agent = {
				state: options?.initialState,
				subscribe: () => () => {},
				abort() {},
				async prompt(text: string) {
					assert.ok(agent.state);
					const messages = agent.state.messages as Array<{ role: string; content: unknown; timestamp?: number }>;
					const request: (typeof sent)[number] = { history: JSON.stringify(messages), text };
					sent.push(request);
					messages.push({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
					messages.push({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: Date.now() });
					if (midTurnPin !== null) {
						// A tool hook changed the block between two requests of one turn.
						bridge.pin("desk", midTurnPin);
						midTurnPin = null;
						const prepare = (agent as { prepareNextTurnWithContext?: (c: unknown) => Promise<unknown> })
							.prepareNextTurnWithContext;
						const update = (await prepare?.({})) as { context?: { messages: unknown[] } } | undefined;
						// The pushed tail is the context's last message.
						request.tail = update?.context?.messages.slice(-1);
					}
				},
			};
			live = agent as unknown as typeof live;
			return { agent };
		}) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
	});
	const milestoneA = renderPinnedContext({ extensionId: "desk", text: "Milestone 2: methods. Next: plan-section" });
	const milestoneB = renderPinnedContext({ extensionId: "desk", text: "Milestone 3: results. Next: draft" });
	try {
		answers.effects = [{ kind: "pin_context", text: "Milestone 2: methods. Next: plan-section" }];
		await loop.submit("start the methods section");
		const first = sent.at(-1);
		assert.ok(first);
		assert.ok(first.text.startsWith("<system-reminder>\n"), first.text);
		assert.ok(first.text.includes(milestoneA));
		// The block heads the tail: the operator's words follow the host frame it rides in.
		assert.ok(first.text.indexOf(milestoneA) < first.text.indexOf("start the methods section"));

		// Unchanged: nothing is sent again and the history it rode in keeps its bytes.
		await loop.submit("keep going");
		const second = sent.at(-1);
		assert.ok(second && !second.text.includes("<pinned-context"), second?.text);
		assert.ok(second.history.includes(JSON.stringify(milestoneA).slice(1, -1)));
		const historyBefore = second.history;

		// A new value replaces the old one: only the new block is sent, and the store holds one block.
		answers.effects = [{ kind: "pin_context", text: "Milestone 3: results. Next: draft" }];
		await loop.submit("move on");
		const third = sent.at(-1);
		assert.ok(third);
		assert.ok(third.text.includes(milestoneB), third.text);
		assert.ok(!third.text.includes("Milestone 2"));
		assert.ok(third.history.startsWith(historyBefore.slice(0, -1)), "a pin change rewrote earlier history");
		assert.deepEqual(bridge.pinned(), [{ extensionId: "desk", text: "Milestone 3: results. Next: draft" }]);

		// A compaction replaces the history with a summary that lost the block; the next request carries it verbatim.
		assert.ok(live);
		live.state.messages = [
			{ role: "user", content: [{ type: "text", text: "<summary>methods drafted</summary>" }], timestamp: 1 },
		];
		await loop.submit("what next?");
		const fourth = sent.at(-1);
		assert.ok(fourth?.text.includes(milestoneB), fourth?.text);

		// A tool hook moves the block mid-turn: the next request of the same turn carries it as a host-framed tail.
		midTurnPin = "Milestone 3: results. Next: verify";
		await loop.submit("draft it");
		const tail = JSON.stringify(sent.at(-1)?.tail ?? []);
		assert.ok(
			tail.includes(
				JSON.stringify(renderPinnedContext({ extensionId: "desk", text: "Milestone 3: results. Next: verify" })).slice(
					1,
					-1,
				),
			),
			tail,
		);
	} finally {
		loop.dispose();
		await loop.whenSettled();
	}
});
