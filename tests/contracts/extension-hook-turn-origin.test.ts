import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { TURN_CONTINUATION_CAP } from "../../src/core/job-types.js";
import { parseExtensionManifest } from "../../src/domains/extensions/discovery.js";
import type { ExtensionHookEvent } from "../../src/domains/extensions/public-api-v2.js";
import { createExtensionRuntimeHookBridge } from "../../src/domains/extensions/runtime-hook-bridge.js";
import { installExtension, listInstalledExtensions } from "../../src/domains/extensions/state.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import { createMiddlewareToolChoiceControl } from "../../src/domains/middleware/tool-choice-control.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { SessionContract, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import {
	buildExtensionPromptGate,
	buildExtensionRuntimeHookRegistrations,
} from "../../src/entry/extension-runtime-hooks.js";
import type { CreateChatLoopDeps } from "../../src/session-control/chat-loop.js";
import { createChatLoop } from "../../src/session-control/chat-loop.js";
import { createTurnMiddleware } from "../../src/session-control/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/session-control/turn-state.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("chat-loop turn hooks are told who started the turn and name it by the user row its turn_start and turn_end share", async (t) => {
	// bt-4: turn_start carried turnId "" and turn_end the final assistant entry, so no hook could tell turns apart.
	const env = await isolateClioEnv("clio-coder-turn-origin-");
	t.after(() => env.restore());
	const source = path.join(env.dir, "source");
	const workspace = path.join(env.dir, "workspace");
	mkdirSync(source);
	mkdirSync(workspace);
	writeFileSync(
		path.join(source, "clio-coder-extension.json"),
		JSON.stringify({
			id: "desk",
			name: "Desk",
			version: "1.0.0",
			description: "Keeps run state across a template's turns",
			runtime: {
				api: 2,
				entrypoint: "extension.mjs",
				hooks: [
					{ on: "prompt_submit", timeoutMs: 1000, onTimeout: "pass", onError: "pass" },
					{ on: "turn_start", timeoutMs: 1000, onTimeout: "pass", onError: "pass" },
					{ on: "turn_end", timeoutMs: 1000, onTimeout: "pass", onError: "pass" },
				],
			},
		}),
	);
	writeFileSync(path.join(source, "extension.mjs"), "export default () => {};\n");
	ok(installExtension(source, { cwd: workspace, scope: "user" }).extension?.loadable);
	const events: ExtensionHookEvent[] = [];
	const bridge = createExtensionRuntimeHookBridge();
	bridge.bind({
		hook: async (_id, event) => {
			events.push(event);
			return { kind: "ok", effects: [] };
		},
		notify: () => {},
	});
	const packages = listInstalledExtensions(workspace, { all: true });
	const options = { generation: 1, recordReceipt: () => {} };
	const gate = buildExtensionPromptGate(packages, bridge, options);
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	const context = dispatchStubContext({ settings });
	const target = settings.targets[0];
	ok(target);
	settings.chat.target = target.id;
	settings.chat.model = target.defaultModel ?? "gpt-4o";
	const entries: SessionEntry[] = [];
	let leaf: string | null = null;
	const session = {
		current: () => ({ id: "origin-session", cwd: env.dir, cwdHash: "origin-repo" }),
		tree: () => ({ leafId: leaf }),
		leafId: () => leaf,
		append(turn: TurnInput) {
			const id = turn.id ?? `turn-${entries.length + 1}`;
			leaf = id;
			entries.push({
				kind: "message",
				turnId: id,
				parentTurnId: turn.parentId,
				timestamp: new Date().toISOString(),
				role: turn.kind,
				payload: turn.payload,
			} as SessionEntry);
			return { id };
		},
		appendEntry(entry: Parameters<SessionContract["appendEntry"]>[0]) {
			const row = { ...entry, turnId: `entry-${entries.length + 1}`, timestamp: new Date().toISOString() } as SessionEntry;
			entries.push(row);
			return row;
		},
	} as unknown as SessionContract;
	let prompts = 0;
	const loop = createChatLoop({
		getSettings: () => settings,
		getAutonomy: () => "yolo",
		providers: context.getContract("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		session,
		bus: context.bus,
		readSessionEntries: () => entries,
		middleware: createMiddlewareBundle({
			registrations: buildExtensionRuntimeHookRegistrations(packages, bridge, options),
		}).contract,
		promptSubmit: async ({ typed, text, origin }) => {
			const verdict = await gate.run(typed, typed === text, origin);
			return verdict.kind === "block" ? verdict : { kind: "pass", text };
		},
		createAgent: ((agentOptions: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => {
			let listener: (event: AgentEvent) => unknown = () => {};
			const state = { ...agentOptions?.initialState, messages: [] as AgentMessage[] };
			return {
				requestCorrelationId: () => undefined,
				agent: {
					state,
					subscribe: (next: typeof listener) => {
						listener = next;
						return () => {};
					},
					abort() {},
					clearAllQueues() {},
					async continue() {
						throw new Error("the fixture never retries");
					},
					async prompt() {
						prompts++;
						await listener({ type: "agent_start" });
						await listener({ type: "turn_start" });
						// The operator turn runs out of tool budget, so yolo files a continuation turn.
						if (prompts === 1)
							context.bus.emit("safety.tool_budget_exceeded", {
								tool: "bash",
								callsThisTurn: 60,
								softBudget: 60,
								hardCeiling: 75,
								interrupted: false,
								at: Date.now(),
							});
						const message = {
							role: "assistant",
							content: [{ type: "text", text: "fixture reply" }],
							stopReason: "stop",
							timestamp: Date.now(),
						} as AgentMessage;
						state.messages.push(message);
						await listener({ type: "message_end", message } as AgentEvent);
						await listener({ type: "agent_end", messages: [message] });
					},
				},
			};
		}) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
	});
	try {
		await loop.submit("advance the desk");
		await loop.whenSettled();
	} finally {
		loop.dispose();
		await loop.whenSettled();
	}
	const userRows = entries.filter((entry) => entry.kind === "message" && entry.role === "user").map((e) => e.turnId);
	strictEqual(userRows.length, 2);
	const [operatorTurn, continuationTurn] = userRows;
	ok(operatorTurn && continuationTurn && operatorTurn !== continuationTurn);
	const operator = { origin: "operator" as const };
	// A tool-budget stop does not count against the cap, so its continuation is index 0.
	const continuation = { origin: "continuation" as const, continuation: { index: 0, cap: TURN_CONTINUATION_CAP } };
	deepStrictEqual(
		events.map(({ model: _model, ...event }: ExtensionHookEvent & { model?: unknown }) => event),
		[
			{ point: "prompt_submit", ...operator },
			{ point: "turn_start", turnId: operatorTurn, ...operator },
			{ point: "turn_end", turnId: operatorTurn, outcome: "completed", ...operator },
			{ point: "prompt_submit", ...continuation },
			{ point: "turn_start", turnId: continuationTurn, ...continuation },
			{ point: "turn_end", turnId: continuationTurn, outcome: "completed", ...continuation },
		],
	);
});

test("a turn_start hook that fails under a block policy refuses the turn, and turn_end cannot declare block", async (t) => {
	// Astra r6-1: the block policy was not enforced at turn points, so the turn proceeded.
	const env = await isolateClioEnv("clio-coder-turn-block-");
	t.after(() => env.restore());
	const source = path.join(env.dir, "source");
	const workspace = path.join(env.dir, "workspace");
	mkdirSync(source);
	mkdirSync(workspace);
	const manifest = {
		id: "desk",
		name: "Desk",
		version: "1.0.0",
		description: "Checks every turn",
		runtime: {
			api: 2,
			entrypoint: "extension.mjs",
			hooks: [
				{ on: "turn_start", timeoutMs: 1000, onError: "block" },
				{ on: "turn_end", timeoutMs: 1000 },
			],
		},
	};
	deepStrictEqual(parseExtensionManifest(manifest, "/pkg/clio-coder-extension.json").diagnostics, []);
	const turnEndBlock = structuredClone(manifest);
	(turnEndBlock.runtime.hooks as unknown[])[1] = { on: "turn_end", timeoutMs: 1000, onTimeout: "block" };
	ok(
		parseExtensionManifest(turnEndBlock, "/pkg/clio-coder-extension.json").diagnostics.some(
			(diag) =>
				diag.type === "error" &&
				diag.message.includes("runtime.hooks[1].onTimeout cannot be block at turn_end, which runs after the turn"),
		),
	);
	writeFileSync(path.join(source, "clio-coder-extension.json"), JSON.stringify(manifest));
	writeFileSync(path.join(source, "extension.mjs"), "export default () => {};\n");
	ok(installExtension(source, { cwd: workspace, scope: "user" }).extension?.loadable);
	const notices: string[] = [];
	const outcomes: string[] = [];
	const bridge = createExtensionRuntimeHookBridge();
	bridge.bind({ hook: async () => ({ kind: "error", message: "boom" }), notify: (text) => notices.push(text) });
	const registrations = buildExtensionRuntimeHookRegistrations(
		listInstalledExtensions(workspace, { all: true }),
		bridge,
		{
			generation: 1,
			recordReceipt: (receipt) =>
				outcomes.push(`${receipt.extension?.id}:${receipt.hook}:${receipt.outcome}:${receipt.effectKinds ?? []}`),
		},
	);
	const middleware = createMiddlewareBundle({ registrations }).contract;
	const turns = createTurnMiddleware({
		state: createTurnState("off"),
		middleware,
		middlewareToolChoice: createMiddlewareToolChoiceControl(),
		emitNotice: () => {},
		emitFooterNotice: () => {},
	});
	const runtime = {
		wireModelId: "faux",
		runtimeResolution: {},
		agent: { state: { tools: [], messages: [] } },
	} as unknown as AgentRuntime;
	const reason = "extension desk turn_start hook failed: boom; the gate fails closed";
	deepStrictEqual((await turns.awaitTurnStart(runtime, "write the intro")).refusal, reason);
	deepStrictEqual(notices, ["extension desk: turn_start hook failed: boom; it fails closed"]);
	deepStrictEqual(outcomes, ["desk:turn_start:runtime-failed:block_turn"]);
	// The runtime gone is the same failure under onError.
	bridge.bind(null);
	deepStrictEqual(
		(await turns.awaitTurnStart(runtime, "write the intro")).refusal,
		reason.replace("failed: boom", "has no running runtime"),
	);
});
