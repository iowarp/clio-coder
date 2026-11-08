import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { agentSkillToolPolicy } from "../../src/core/skill-activation.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import claudeSdkRuntime from "../../src/domains/providers/runtimes/claude/claude-sdk.js";
import { createClioToolBridge } from "../../src/engine/claude/clio-tool-bridge.js";
import { emitClaudeToolPermissionDecision, mapClaudeToolCall } from "../../src/engine/claude/tool-safety.js";
import { attestedToolSignature, createWorkerSafety } from "../../src/engine/worker-tools.js";
import { toolSignatureOf } from "../../src/worker/protocol.js";
import type { WorkerSpec } from "../../src/worker/spec-contract.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

/**
 * Q11: a claude-sdk worker carries Clio's context, artifact and verify tools
 * through an in-process SDK MCP server, so the recipes that require them are
 * admitted on that route, and a shadow refusal names `coder --read-only` only
 * where that stand-in would itself be admitted.
 */
function claudeSdkSettings() {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [{ id: "sdk-worker", runtime: "claude-sdk", defaultModel: "claude-sonnet-4-6" }];
	settings.fleet.default.target = "sdk-worker";
	settings.fleet.default.model = "claude-sonnet-4-6";
	return settings;
}

function spawnOnClaudeSdk(
	settings = claudeSdkSettings(),
	extra: Partial<Parameters<typeof makeDispatchBundle>[1]> = {},
) {
	const specs: WorkerSpec[] = [];
	const bundle = makeDispatchBundle(dispatchStubContext({ settings, runtime: claudeSdkRuntime }), {
		...extra,
		spawnWorker: (spec): SpawnedWorker => {
			specs.push(spec);
			return {
				pid: null,
				promise: Promise.resolve({ exitCode: 0, signal: null }),
				heartbeatAt: { current: Date.now(), monotonic: 0 },
				events: (async function* () {
					yield { type: "message_end", message: { role: "assistant", stopReason: "stop", content: "done" } };
				})(),
				abort() {},
			};
		},
	});
	return { bundle, specs };
}

describe("claude-sdk: Clio context, artifact and verify tools", () => {
	beforeEach(async () => {
		await isolateDispatchState();
	});
	afterEach(() => {
		restoreDispatchState();
	});

	const cases = [
		{ agentId: "architect", readOnly: false, carries: [ToolNames.Artifact, ToolNames.Context] },
		{ agentId: "coder", readOnly: true, carries: [ToolNames.Context] },
		{ agentId: "debugger", readOnly: false, carries: [ToolNames.Verify] },
		{ agentId: "verifier", readOnly: false, carries: [ToolNames.Verify] },
	] as const;

	for (const { agentId, readOnly, carries } of cases) {
		it(`admits ${agentId}${readOnly ? " --read-only" : ""} and attests the same surface the worker signs`, async () => {
			const { bundle, specs } = spawnOnClaudeSdk();
			await bundle.extension.start();
			try {
				const handle = await bundle.contract.dispatch({
					agentId,
					task: "Inspect src/parser.ts and report on the tokenizer.",
					executionRole: "builder",
					requestOrigin: "user",
					...(readOnly ? { readOnly: true } : {}),
				});
				await handle.finalPromise.catch(() => undefined);
				const spec = specs[0];
				ok(spec, `${agentId} must reach worker creation on claude-sdk`);
				strictEqual(spec.runtimeId, "claude-sdk");
				for (const tool of carries) ok(spec.allowedTools.includes(tool), `${agentId} must carry ${tool}`);
				// Read-only is enforced per call at the permission gate, not by trimming the surface.
				strictEqual(spec.readOnly === true, readOnly);
				// #449: the worker's own projection must sign exactly what admission approved.
				strictEqual(
					attestedToolSignature({
						allowedTools: spec.allowedTools,
						toolsSupported: true,
						...(spec.toolProfile !== undefined ? { toolProfile: spec.toolProfile } : {}),
						agentId: spec.agentId,
						task: spec.task,
						runtime: spec.runtime,
					}),
					toolSignatureOf(spec.allowedTools),
				);
			} finally {
				await bundle.extension.stop?.();
			}
		});
	}

	it("names coder --read-only in a shadow refusal only when the route admits it", async () => {
		const { bundle, specs } = spawnOnClaudeSdk();
		await bundle.extension.start();
		try {
			const scout = {
				agentId: "scout",
				task: "Map the parser module.",
				executionRole: "builder",
				requestOrigin: "user",
			} as const;
			await rejects(bundle.contract.dispatch(scout), (error: Error) => {
				match(error.message, /reserved for Clio internal orchestration; .*'coder' with --read-only$/);
				return true;
			});
			// Denying context leaves coder short of a required tool on this route.
			await rejects(bundle.contract.dispatch({ ...scout, denyTools: [ToolNames.Context] }), (error: Error) => {
				match(error.message, /reserved for Clio internal orchestration$/);
				return true;
			});
			strictEqual(specs.length, 0);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	const refusedRoutes: Array<[string, () => ReturnType<typeof spawnOnClaudeSdk>]> = [
		[
			"the route's permission mode",
			() => {
				const settings = claudeSdkSettings();
				settings.fleet.permissions.mode = "escalate";
				return spawnOnClaudeSdk(settings);
			},
		],
		[
			"a blocking hook the runtime cannot carry",
			() =>
				spawnOnClaudeSdk(claudeSdkSettings(), {
					workerHooks: {
						declarations: () => [
							{
								id: "extension:desk_guard:before_tool:0",
								point: "before_tool",
								tools: [ToolNames.Read],
								timeoutMs: 1000,
								onTimeout: "pass",
								onError: "block",
							},
						],
						evaluate: async () => [],
					},
				}),
		],
	];
	for (const [why, setup] of refusedRoutes) {
		it(`names no stand-in when ${why} refuses it`, async () => {
			const { bundle, specs } = setup();
			await bundle.extension.start();
			try {
				await rejects(
					bundle.contract.dispatch({
						agentId: "scout",
						task: "Map the parser module.",
						executionRole: "builder",
						requestOrigin: "user",
					}),
					(error: Error) => {
						match(error.message, /reserved for Clio internal orchestration$/);
						return true;
					},
				);
				strictEqual(specs.length, 0);
			} finally {
				await bundle.extension.stop?.();
			}
		});
	}
});

describe("claude-sdk: the clio tool bridge", () => {
	beforeEach(async () => {
		await isolateDispatchState();
	});
	afterEach(() => {
		restoreDispatchState();
	});

	it("maps a bridged MCP call onto the Clio tool and gates it read-only", () => {
		deepStrictEqual(mapClaudeToolCall("mcp__clio__verify", { check: "unit" }, process.cwd()), {
			known: true,
			bridged: true,
			claudeToolName: "mcp__clio__verify",
			clioToolName: ToolNames.Verify,
			args: { check: "unit" },
		});
		strictEqual(mapClaudeToolCall("mcp__other__verify", {}, process.cwd()).known, false);
		const cwd = mkdtempSync(join(tmpdir(), "clio-q11-gate-"));
		try {
			const safety = createWorkerSafety({ cwd });
			const allowedTools = new Set<string>([ToolNames.Context, ToolNames.Artifact, ToolNames.Verify]);
			const events: Array<{ type: string; payload?: { outcome?: string } }> = [];
			const record = (event: unknown) => {
				events.push(event as { type: string; payload?: { outcome?: string } });
			};
			const decide = (toolName: string, readOnly: boolean, surface = allowedTools) =>
				emitClaudeToolPermissionDecision({
					toolName,
					input: {},
					safety,
					cwd,
					readOnly,
					allowedTools: surface,
					emit: record,
				}).kind;
			strictEqual(decide("mcp__clio__context", true), "allow");
			// The bridge reports an allowed call's start and real outcome; the gate stays silent.
			strictEqual(events.length, 0);
			strictEqual(decide("mcp__clio__artifact", true), "deny");
			strictEqual(decide("mcp__clio__verify", true), "deny");
			strictEqual(decide("mcp__clio__artifact", false, new Set<string>([ToolNames.Context])), "deny");
			deepStrictEqual(
				events.filter((event) => event.type === "clio_coder_tool_finish").map((event) => event.payload?.outcome),
				["blocked", "blocked", "blocked"],
			);
			strictEqual(decide("mcp__clio__artifact", false), "allow");
			strictEqual(decide("Write", true, new Set<string>([ToolNames.Write])), "deny");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("runs Clio's own tool behind the SDK server and reports its real outcome under the SDK tool-use id", async () => {
		const events: Array<Record<string, unknown>> = [];
		const safety = createWorkerSafety();
		const emit = (event: unknown) => {
			events.push(event as Record<string, unknown>);
		};
		const skillPolicy = agentSkillToolPolicy(["fix-issue"]);
		ok(skillPolicy);
		strictEqual(createClioToolBridge(createSdkMcpServer, { allowedTools: new Set(["read"]), safety, emit }), null);
		const server = createClioToolBridge(createSdkMcpServer, {
			allowedTools: new Set([ToolNames.Read, ToolNames.Context, ToolNames.Verify]),
			safety,
			emit,
			agentId: "coder",
			// The recipe's bound skill path, which dispatch hands a worker in skillPaths.
			skillLoaderOptions: { skillPaths: [join(process.cwd(), "library/skills/git/fix-issue/SKILL.md")] },
			...(skillPolicy !== undefined ? { pendingSkillPolicy: skillPolicy } : {}),
		});
		ok(server);
		strictEqual(server.name, "clio");
		const handlers = (
			server.instance as unknown as {
				server: { _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>> };
			}
		).server._requestHandlers;
		const call = async (name: string, args: Record<string, unknown>, toolUseId: string) =>
			(await handlers.get("tools/call")?.(
				{ method: "tools/call", params: { name, arguments: args, _meta: { "claudecode/toolUseId": toolUseId } } },
				{
					signal: new AbortController().signal,
					requestId: 1,
					sendNotification: async () => {},
					_meta: { "claudecode/toolUseId": toolUseId },
				},
			)) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
		const listed = (await handlers.get("tools/list")?.(
			{ method: "tools/list", params: {} },
			{ signal: new AbortController().signal, requestId: 0, sendNotification: async () => {} },
		)) as { tools: Array<{ name: string; inputSchema: { type?: string; properties?: Record<string, unknown> } }> };
		deepStrictEqual(
			listed.tools.map((tool) => tool.name),
			["context", "verify"],
		);
		ok(listed.tools[0]?.inputSchema.properties?.scope, "the tool's own schema is advertised");

		// A gateway-placed capability is carried under its own name: the SDK has no Clio gateway.
		const architect = createClioToolBridge(createSdkMcpServer, {
			allowedTools: new Set([ToolNames.Artifact, ToolNames.Context, ToolNames.Gateway]),
			safety,
			emit,
		});
		const architectTools = (
			architect?.instance as unknown as {
				server: { _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>> };
			}
		).server._requestHandlers;
		const architectListed = (await architectTools.get("tools/list")?.(
			{ method: "tools/list", params: {} },
			{ signal: new AbortController().signal, requestId: 0, sendNotification: async () => {} },
		)) as { tools: Array<{ name: string }> };
		deepStrictEqual(
			architectListed.tools.map((tool) => tool.name),
			["artifact", "context"],
		);

		// A loaded skill's surface narrows preset tools at the gate, not only bridged ones.
		const gate = (toolName: string) =>
			emitClaudeToolPermissionDecision({
				toolName,
				input: {},
				safety,
				cwd: process.cwd(),
				readOnly: true,
				allowedTools: new Set<string>([ToolNames.Tasks, ToolNames.WebFetch]),
				pendingSkillPolicy: skillPolicy,
				emit: () => {},
			});
		strictEqual(gate("TodoWrite").kind, "allow");
		const beforeLoad = gate("WebFetch");
		ok(beforeLoad.kind !== "deny" || beforeLoad.reasonCode !== "admission:skill_surface");

		// A bound skill loads through the bridged context, as on a native worker.
		const skill = await call("context", { scope: "skills", name: "fix-issue" }, "toolu_skill");
		ok(skill.isError !== true, JSON.stringify(skill.content));
		strictEqual(gate("TodoWrite").kind, "allow");
		const afterLoad = gate("WebFetch");
		strictEqual(afterLoad.kind, "deny");
		strictEqual(afterLoad.kind === "deny" ? afterLoad.reasonCode : undefined, "admission:skill_surface");

		const failed = await call("verify", { check: "q11-no-such-check" }, "toolu_verify");
		strictEqual(failed.isError, true);
		const forCall = (id: string) =>
			events.filter(
				(event) => event.toolCallId === id || (event.payload as { toolCallId?: string } | undefined)?.toolCallId === id,
			);
		deepStrictEqual(
			forCall("toolu_verify").map((event) => event.type),
			["tool_execution_start", "clio_coder_tool_start", "clio_coder_tool_finish", "tool_execution_end"],
		);
		const finish = forCall("toolu_verify").find((event) => event.type === "clio_coder_tool_finish");
		strictEqual((finish?.payload as { tool?: string }).tool, ToolNames.Verify);
		ok((finish?.payload as { outcome?: string }).outcome !== "ok", "a failed check must not finish ok");
		deepStrictEqual(forCall("toolu_verify")[0]?.args, { check: "q11-no-such-check" });
	});
});
