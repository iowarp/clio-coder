import { deepStrictEqual, doesNotMatch, match, ok, rejects, strictEqual } from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { runHeadlessMainAgent } from "../../src/cli/modes/print.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import {
	HEADLESS_PERMISSION_DENIED_MARKER,
	HEADLESS_PERMISSION_DENIED_REASON,
} from "../../src/core/headless-permission.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { readRunJournal } from "../../src/domains/eval/metrics/invariants.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { type ChatLoopEvent, type CreateChatLoopDeps, createChatLoop } from "../../src/interactive/chat-loop.js";
import { resolveAgentTools } from "../../src/tools/agent-tools.js";
import { bashTool } from "../../src/tools/bash.js";
import { createRegistry } from "../../src/tools/registry.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const pivot =
	"Do not retry this action through another tool unless a hint above names one; pivot or report the blocker.";
const inline = `python3 -c "from pathlib import Path; Path('sentinel.txt').write_text('changed')"`;
let env: IsolatedClioEnv;
let previousCwd: string;
beforeEach(async () => {
	env = await isolateClioEnv("d6-");
	previousCwd = process.cwd();
	process.chdir(env.dir);
	writeFileSync("sentinel.txt", "blocked is harmless fixture text\n");
});
afterEach(() => {
	process.chdir(previousCwd);
	env.restore();
});

function tools() {
	const safety = createWorkerSafety({ cwd: env.dir });
	const registry = createRegistry({ safety, autonomy: () => "full-auto" });
	registry.register(bashTool);
	return { safety, registry };
}

test("headless denied asks preserve the actual cause/rule, final denial and bounded no-bypass feedback", async () => {
	const { safety, registry } = tools();
	const original = safety.evaluate({ tool: "bash", args: { command: inline } });
	strictEqual(original.kind, "ask", "full-auto must not relax the hidden-content confirmation rail");
	strictEqual(original.policy?.ruleId, "bash-hidden-content");
	registry.onPermissionRequired(() => registry.cancelParkedCalls(HEADLESS_PERMISSION_DENIED_REASON));
	const bash = resolveAgentTools({ registry })[0];
	ok(bash);
	await rejects(bash.execute("denied-inline", { command: inline }), (error: unknown) => {
		ok(error instanceof Error);
		ok(error.message.startsWith(HEADLESS_PERMISSION_DENIED_MARKER));
		match(error.message, /rule: bash-hidden-content/);
		match(error.message, /shell variables or interpreter source hide paths/);
		match(error.message, /denied|not approved/);
		doesNotMatch(error.message, /hard block|is parked|resumeParked|awaiting approval/);
		ok(error.message.endsWith(pivot));
		ok(error.message.split("\n").length <= 16);
		ok(error.message.split("\n").every((line) => line.length <= 301));
		return true;
	});
	strictEqual(registry.parkedCount(), 0);
	strictEqual(readFileSync("sentinel.txt", "utf8"), "blocked is harmless fixture text\n");
});

test("interactive denials remain terminal, while actual hard blocks retain hard-block guidance", async () => {
	const { safety, registry } = tools();
	registry.onPermissionRequired(() => registry.cancelParkedCalls("Operator denied this action."));
	const bash = resolveAgentTools({ registry })[0];
	ok(bash);
	await rejects(bash.execute("interactive", { command: inline }), (error: unknown) => {
		ok(error instanceof Error);
		strictEqual(error.message, `Operator denied this action.\n${pivot}`);
		return true;
	});
	strictEqual(safety.evaluate({ tool: "bash", args: { command: "rm -f sentinel.txt" } }).kind, "block");
	await rejects(bash.execute("hard", { command: "rm -f sentinel.txt" }), /hard block; confirmation cannot override/);
	strictEqual(readFileSync("sentinel.txt", "utf8"), "blocked is harmless fixture text\n");
});

async function runtimeFixture() {
	const { safety, registry } = tools();
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	settings.chat.target = "fixture";
	settings.chat.model = "fixture-model";
	settings.safety.autonomy = "full-auto";
	const capabilities = {
		chat: true,
		tools: true,
		reasoning: false,
		vision: false,
		audio: false,
		embeddings: false,
		rerank: false,
		fim: false,
		contextWindow: 131072,
		maxTokens: 4096,
	};
	const target = {
		id: "fixture",
		runtime: "fixture",
		url: "https://fixture.invalid",
		defaultModel: "fixture-model",
		capabilities,
	};
	const model = {
		id: "fixture-model",
		name: "Fixture",
		api: "openai-completions",
		provider: "fixture",
		baseUrl: target.url,
		reasoning: false,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 4096,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const runtime = {
		id: "fixture",
		displayName: "Fixture",
		kind: "http",
		tier: "cloud",
		apiFamily: "openai-completions",
		auth: "none",
		defaultCapabilities: capabilities,
		synthesizeModel: () => structuredClone(model),
	};
	const providers = {
		getTarget: () => target,
		getRuntime: () => runtime,
		getDetectedReasoning: () => false,
		list: () => [
			{
				target,
				runtime,
				capabilities,
				available: true,
				discoveredModels: ["fixture-model"],
				discoveredModelsSource: "probe",
				probeCapabilities: null,
			},
		],
	} as unknown as ProvidersContract;
	let pendingRequest: string | undefined;
	registry.onPermissionRequired((_call, _decision, meta) => {
		pendingRequest = meta.requestId;
	});
	const events: ChatLoopEvent[] = [];
	const loop = createChatLoop({
		getSettings: () => settings,
		providers,
		knownTargets: () => new Set(["fixture"]),
		toolRegistry: registry,
		createAgent: ((options: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => {
			const state = options?.initialState;
			ok(state);
			let listener: ((event: AgentEvent) => void) | undefined;
			return {
				agent: {
					state,
					abort() {},
					subscribe: (callback: (event: AgentEvent) => void) => {
						listener = callback;
						return () => {};
					},
					prompt: async () => {
						const bash = state.tools?.find((entry) => entry.name === "bash");
						ok(bash);
						const begin = (id: string, command: string) => {
							listener?.({ type: "tool_execution_start", toolName: "bash", toolCallId: id, args: { command } });
							return bash.execute(id, { command }).then(
								(result) => ({ result, isError: result.details.kind === "error" }),
								(error: unknown) => ({
									result: { content: [{ type: "text", text: String(error instanceof Error ? error.message : error) }] },
									isError: true,
								}),
							);
						};
						const end = async (id: string, pending: ReturnType<typeof begin>) => {
							listener?.({ type: "tool_execution_end", toolName: "bash", toolCallId: id, ...(await pending) });
						};
						// Actual registry/adapter calls of the same tool finish in reverse start order.
						const denied = begin("ask-first", inline);
						await end("error-second", begin("error-second", "cat missing-blocked.txt"));
						ok(pendingRequest);
						registry.cancelParkedCall(pendingRequest, HEADLESS_PERMISSION_DENIED_REASON);
						await end("ask-first", denied);
						await end("success", begin("success", "cat sentinel.txt"));
						await end("hard", begin("hard", "rm -f sentinel.txt"));
						// Legacy producer controls have no admission telemetry. Words never classify them.
						for (const isError of [false, true])
							listener?.({
								type: "tool_execution_end",
								toolName: "legacy",
								toolCallId: `legacy-${isError}`,
								isError,
								result: { content: [{ type: "text", text: "blocked cancelled are ordinary result words" }] },
							});
						const message = {
							role: "assistant",
							content: [{ type: "text", text: "Done; inline mutation remained denied." }],
							stopReason: "stop",
							timestamp: Date.now(),
						} as AgentMessage;
						state.messages?.push(message);
						listener?.({ type: "message_end", message });
					},
				},
			};
		}) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
	});
	loop.onEvent((event) => events.push(event));
	return { loop, events, safety };
}

for (const check of ["correlation", "receipt"] as const)
	test(`headless production ${check} preserves authoritative outcomes rather than classifying text`, async (t) => {
		let output = "";
		const stdoutWrite = process.stdout.write.bind(process.stdout);
		t.mock.method(process.stdout, "write", (chunk: string | Uint8Array, callback?: () => void) => {
			// Preserve node:test IPC frames while capturing the actual JSON stream.
			if (typeof chunk !== "string") return stdoutWrite(chunk, callback);
			output += String(chunk);
			callback?.();
			return true;
		});
		t.mock.method(process.stderr, "write", () => true);
		const { loop, events, safety } = await runtimeFixture();
		try {
			strictEqual(
				await runHeadlessMainAgent(loop, {
					prompt: "Run the controlled denial scenario",
					mode: "json",
					shutdown: { onDrain() {}, getExitCode: () => 0, isShuttingDown: () => false },
				}),
				0,
			);
			const ends = events.filter((event) => event.type === "tool_execution_end") as Array<
				Extract<ChatLoopEvent, { type: "tool_execution_end" }> & {
					outcome?: string;
					ruleId?: string;
					reasonCode?: string;
					policySource?: string;
				}
			>;
			deepStrictEqual(
				ends.slice(0, 2).map((event) => event.toolCallId),
				["error-second", "ask-first"],
			);
			strictEqual(readFileSync("sentinel.txt", "utf8"), "blocked is harmless fixture text\n");
			if (check === "correlation") {
				for (const [id, command, outcome] of [
					["ask-first", inline, "blocked"],
					["error-second", "cat missing-blocked.txt", "error"],
					["success", "cat sentinel.txt", "ok"],
					["hard", "rm -f sentinel.txt", "blocked"],
				] as const) {
					const event = ends.find((entry) => entry.toolCallId === id);
					ok(event);
					const policy = safety.evaluate({ tool: "bash", args: { command } }).policy;
					ok(policy);
					deepStrictEqual(
						{ outcome: event.outcome, ruleId: event.ruleId, reasonCode: event.reasonCode, policySource: event.policySource },
						{ outcome, ruleId: policy.ruleId, reasonCode: policy.reasonCode, policySource: policy.policySource },
						id,
					);
					const wire = output
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line))
						.find((entry) => entry.type === "tool_execution_end" && entry.toolCallId === id);
					strictEqual(wire.ruleId, policy.ruleId);
				}
				for (const legacy of ends.filter((event) => event.toolName === "legacy")) {
					strictEqual(legacy.outcome, undefined);
					strictEqual(legacy.ruleId, undefined);
				}
			} else {
				const journal = readRunJournal(join(env.dir, "state"));
				ok(journal);
				strictEqual(journal.receipts.length, 1);
				const receipt = journal.receipts[0];
				ok(receipt);
				const envelope = journal.envelopes.get(receipt.runId);
				ok(envelope);
				strictEqual(verifyReceiptIntegrity(receipt, envelope).ok, true);
				const stats = receipt.toolStats.map(({ tool, count, ok, errors, blocked }) => ({
					tool,
					count,
					ok,
					errors,
					blocked,
				}));
				deepStrictEqual(stats, [
					{ tool: "bash", count: 4, ok: 1, errors: 1, blocked: 2 },
					{ tool: "legacy", count: 2, ok: 1, errors: 1, blocked: 0 },
				]);
				for (const stat of receipt.toolStats) strictEqual(stat.count, stat.ok + stat.errors + stat.blocked);
			}
		} finally {
			loop.dispose();
			t.mock.restoreAll();
		}
	});
