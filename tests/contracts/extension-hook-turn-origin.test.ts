import { deepStrictEqual, ok } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { turnOriginMetadata } from "../../src/core/turn-origin.js";
import { parseExtensionManifest } from "../../src/domains/extensions/discovery.js";
import type { ExtensionHookEvent } from "../../src/domains/extensions/public-api-v2.js";
import { createExtensionRuntimeHookBridge } from "../../src/domains/extensions/runtime-hook-bridge.js";
import { installExtension, listInstalledExtensions } from "../../src/domains/extensions/state.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import {
	buildExtensionPromptGate,
	buildExtensionRuntimeHookRegistrations,
} from "../../src/entry/extension-runtime-hooks.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("prompt_submit and turn_start hooks are told who started the turn", async (t) => {
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
	const origin = { origin: "continuation" as const, continuation: { index: 1, cap: 3 }, template: "desk:advance" };
	await buildExtensionPromptGate(packages, bridge, options).run("[Clio Coder] continue", true, origin);
	const middleware = createMiddlewareBundle({
		registrations: buildExtensionRuntimeHookRegistrations(packages, bridge, options),
	}).contract;
	await middleware.runAwaitedHook?.({ hook: "turn_start", turnId: "t1", metadata: turnOriginMetadata(origin) });
	deepStrictEqual(events, [
		{ point: "prompt_submit", ...origin },
		{ point: "turn_start", turnId: "t1", ...origin },
	]);
});

test("a turn hook that fails under a block policy says the turn proceeds, and discovery warns of the policy", async (t) => {
	// Astra r6-1: the notice said the gate failed closed while a turn point has nothing to refuse.
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
				{ on: "before_tool", timeoutMs: 1000, onError: "block" },
			],
		},
	};
	writeFileSync(path.join(source, "clio-coder-extension.json"), JSON.stringify(manifest));
	writeFileSync(path.join(source, "extension.mjs"), "export default () => {};\n");
	deepStrictEqual(
		parseExtensionManifest(manifest, "/pkg/clio-coder-extension.json").diagnostics.map((diag) => [
			diag.type,
			diag.message,
		]),
		[
			[
				"warning",
				"extension desk runtime.hooks[0] declares onError: block at turn_start, which a failed hook cannot stop; the host reports the failure and the turn proceeds",
			],
		],
	);
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
			recordReceipt: (receipt) => outcomes.push(`${receipt.hook}:${receipt.outcome}:${receipt.effectKinds ?? []}`),
		},
	);
	const middleware = createMiddlewareBundle({ registrations }).contract;
	deepStrictEqual((await middleware.runAwaitedHook?.({ hook: "turn_start", turnId: "t1" }))?.effects, []);
	deepStrictEqual(notices, [
		"extension desk: turn_start hook failed: boom; its block policy is not enforced at turn_start, so the turn proceeds",
	]);
	deepStrictEqual(outcomes, ["turn_start:runtime-failed:"]);
});
