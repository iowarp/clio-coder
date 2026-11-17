import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { storeToolDetail } from "../../src/domains/session/tool-details.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { createChatLoop } from "../../src/session-control/chat-loop.js";
import { createGatewayTool } from "../../src/tools/gateway/index.js";
import { createRegistry } from "../../src/tools/registry.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

let env: IsolatedClioEnv;
let previousCwd: string;
beforeEach(async () => {
	env = await isolateClioEnv("detail-ledger-resume-");
	previousCwd = process.cwd();
	const project = path.join(env.dir, "project");
	mkdirSync(project);
	process.chdir(project);
});
afterEach(() => {
	process.chdir(previousCwd);
	env.restore();
});

it("resuming a session whose detail store holds entries makes ledger detail reachable behind the gateway (WTF-P 0.8.3 C3)", async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	const context = dispatchStubContext({ settings });
	const session = createSessionBundle(context).contract;
	const safety = context.getContract("safety");
	ok(safety);
	// A session with no extensions now: no dispatch ledger, no runtime tool, so nothing registered the detail ledger.
	const registry = createRegistry({ safety, autonomy: () => "default" });
	registry.register(createGatewayTool({ registry }));
	const loop = createChatLoop({
		getSettings: () => settings,
		providers: context.getContract("providers") as ProvidersContract,
		knownTargets: () => new Set(),
		session,
		toolRegistry: registry,
		bus: context.bus,
		createAgent: createEngineAgent,
	});
	try {
		// The earlier run stored an extension result's full output, and its transcript carries the ref.
		const withDetails = session.create({ cwd: process.cwd() }).id;
		const detail = "the whole outline, as the extension returned it before it was removed";
		const ref = storeToolDetail(withDetails, detail);
		const plain = session.create({ cwd: process.cwd() }).id;

		// A session whose store holds nothing gains no capability.
		loop.resetForSession(null, []);
		strictEqual(session.current()?.id, plain);
		strictEqual(registry.get(ToolNames.Ledger), undefined, "a session with no stored detail registers nothing");

		session.resume(withDetails);
		loop.resetForSession(null, []);
		const ledger = registry.get(ToolNames.Ledger);
		strictEqual(ledger?.placement, "gateway", "behind the gateway, so the session's tool schema set is unchanged");
		strictEqual(ledger?.metadata?.startupPrompt, false, "and no startup prompt entry");
		const verdict = await registry.invoke(
			{ tool: ToolNames.Gateway, args: { op: "call", capability: ToolNames.Ledger, args: { action: "detail", ref } } },
			{ sessionId: withDetails },
		);
		ok(verdict.kind === "ok" && verdict.result.kind === "ok", JSON.stringify(verdict));
		ok(verdict.result.output.endsWith(detail), verdict.result.output);

		// Switching back keeps the one registration; a later switch never replaces it.
		session.resume(plain);
		loop.resetForSession(null, []);
		strictEqual(registry.get(ToolNames.Ledger), ledger);
	} finally {
		loop.dispose();
		await loop.whenSettled();
		await session.close();
	}
});
