import { deepStrictEqual, ok } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseExtensionManifest } from "../../src/domains/extensions/discovery.js";
import type { ExtensionHookEvent } from "../../src/domains/extensions/public-api-v2.js";
import { createExtensionRuntimeHookBridge } from "../../src/domains/extensions/runtime-hook-bridge.js";
import { installExtension, listInstalledExtensions } from "../../src/domains/extensions/state.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import { createMiddlewareToolChoiceControl } from "../../src/domains/middleware/tool-choice-control.js";
import type { AgentMessage } from "../../src/engine/types.js";
import {
	buildExtensionPromptGate,
	buildExtensionRuntimeHookRegistrations,
} from "../../src/entry/extension-runtime-hooks.js";
import { createTurnMiddleware } from "../../src/session-control/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/session-control/turn-state.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("turn hooks are told who started the turn and name it by the id its turn_start and turn_end share", async (t) => {
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
	const operator = { origin: "operator" as const, template: "desk:advance" };
	const origin = { origin: "continuation" as const, continuation: { index: 1, cap: 3 }, template: "desk:advance" };
	await buildExtensionPromptGate(packages, bridge, options).run("[Clio Coder] continue", true, origin);
	const state = createTurnState("off");
	const turns = createTurnMiddleware({
		state,
		middleware: createMiddlewareBundle({
			registrations: buildExtensionRuntimeHookRegistrations(packages, bridge, options),
		}).contract,
		middlewareToolChoice: createMiddlewareToolChoiceControl(),
		emitNotice: () => {},
		emitFooterNotice: () => {},
	});
	const runtime = {
		wireModelId: "faux",
		runtimeResolution: {},
		agent: { state: { tools: [], messages: [] } },
	} as unknown as AgentRuntime;
	const reply = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } as AgentMessage;
	// Each turn as the chat loop runs it: turn_start before its user row is filed under the reserved id, turn_end after.
	for (const [turnOrigin, userTurnId] of [
		[operator, "user-1"],
		[origin, "user-2"],
	] as const) {
		state.currentTurnOrigin = turnOrigin;
		state.activeUserTurnId = null;
		ok((await turns.awaitTurnStart(runtime, "advance", 0, userTurnId)) === null);
		state.activeUserTurnId = userTurnId;
		state.lastTurnId = `assistant-of-${userTurnId}`;
		await turns.fireTurnEnd(runtime, [reply]);
	}
	deepStrictEqual(events, [
		{ point: "prompt_submit", ...origin },
		{ point: "turn_start", turnId: "user-1", ...operator },
		{ point: "turn_end", turnId: "user-1", outcome: "completed", ...operator },
		{ point: "turn_start", turnId: "user-2", ...origin },
		{ point: "turn_end", turnId: "user-2", outcome: "completed", ...origin },
	]);
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
	deepStrictEqual(await turns.awaitTurnStart(runtime, "write the intro"), reason);
	deepStrictEqual(notices, ["extension desk: turn_start hook failed: boom; it fails closed"]);
	deepStrictEqual(outcomes, ["desk:turn_start:runtime-failed:block_turn"]);
	// The runtime gone is the same failure under onError.
	bridge.bind(null);
	deepStrictEqual(
		await turns.awaitTurnStart(runtime, "write the intro"),
		reason.replace("failed: boom", "has no running runtime"),
	);
});
