import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { validateSettings } from "../../src/core/config.js";
import { HEADLESS_PERMISSION_DENIED_REASON } from "../../src/core/headless-permission.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { dispatchCouncilThroughRegistry } from "../../src/interactive/council-dispatch.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { createRegistry } from "../../src/tools/registry.js";

/**
 * `/council` invokes dispatch with no turn. The turn's denial memory must not
 * hold a declined council in a bucket that never resets, or every later
 * council in the session is refused without being asked.
 */
test("a council declined once is asked again the next time", async () => {
	const registry = createRegistry({ safety: createWorkerSafety({ cwd: process.cwd() }), autonomy: () => "default" });
	registry.register({
		name: ToolNames.Dispatch,
		description: "stub dispatch",
		parameters: Type.Object({}, { additionalProperties: true }),
		baseActionClass: "dispatch",
		async run() {
			return { kind: "ok", output: "council dispatched" };
		},
	});
	let asks = 0;
	registry.onPermissionRequired((_call, _decision, meta) => {
		asks += 1;
		registry.cancelParkedCall(meta.requestId, HEADLESS_PERMISSION_DENIED_REASON);
	});
	const args = {
		tasks: [
			{ agent: "reviewer", task: "review" },
			{ agent: "reviewer", task: "review again" },
		],
	};
	const first = await dispatchCouncilThroughRegistry(registry, args);
	const second = await dispatchCouncilThroughRegistry(registry, args);
	deepStrictEqual([first.status, second.status, asks], ["blocked", "blocked", 2]);
});

/**
 * A roster member may name its own agent, and a member that names none sits
 * as the council's agent. Each keeps its own route and thinking level.
 */
test("council members run as their roster agent, else the council agent", async () => {
	const settings = validateSettings({
		targets: [{ id: "mini", runtime: "openai-compat", url: "http://127.0.0.1:1", defaultModel: "m" }],
		fleet: {
			rosters: {
				design: {
					members: [
						{ label: "arch", target: "mini", model: "a", agent: "architect" },
						{ label: "plain", target: "mini", model: "b", thinkingLevel: "low" },
					],
				},
			},
		},
	});
	deepStrictEqual(settings.issues, []);
	const seated: DispatchRequest[] = [];
	const tool = createDispatchTool({
		dispatch: {
			dispatch: async (request: DispatchRequest) => {
				seated.push(request);
				throw new Error("stub workers");
			},
		} as unknown as DispatchContract,
		getAgentSpecs: () => [{ id: "architect" }, { id: "researcher" }, { id: "scout" }] as never,
		getWorkerRosters: () => settings.settings.fleet.rosters,
		getAutonomy: () => "yolo",
	});
	await tool.run({ mode: "council", roster: "design", agent: "researcher", task: "Who owns the clock?" }, {} as never);
	deepStrictEqual(
		seated.map((request) => [request.council?.label, request.agentId, request.model, request.thinkingLevel ?? null]),
		[
			["arch", "architect", "a", null],
			["plain", "researcher", "b", "low"],
		],
	);
	const refused = await tool.run(
		{
			mode: "council",
			members: [
				{ label: "x", target: "mini", agent: "nope" },
				{ label: "y", target: "mini" },
			],
			task: "t",
		},
		{} as never,
	);
	strictEqual(refused.kind, "error");
	match(refused.kind === "error" ? refused.message : "", /council_member_agent_unknown: x: 'nope'/u);
});
