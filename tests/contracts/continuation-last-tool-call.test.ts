import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ExtensionHookEvent } from "../../src/domains/extensions/public-api-v2.js";
import { createExtensionRuntimeHookBridge } from "../../src/domains/extensions/runtime-hook-bridge.js";
import { installExtension, listInstalledExtensions } from "../../src/domains/extensions/state.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { SessionContract, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { buildExtensionPromptGate } from "../../src/entry/extension-runtime-hooks.js";
import type { CreateChatLoopDeps, PromptSubmitInput } from "../../src/session-control/chat-loop.js";
import { createChatLoop } from "../../src/session-control/chat-loop.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const SECRET = "sk-ant-api03-continuationfixture0123456789abcdefghijklmnop";

test("a continuation's prompt_submit names the last tool call; an operator prompt does not", async (t) => {
	const scratch = await isolateClioEnv("clio-coder-continuation-call-");
	t.after(() => scratch.restore());
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
		current: () => ({ id: "continuation-session", cwd: scratch.dir, cwdHash: "continuation-repo" }),
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
	const submitted: PromptSubmitInput[] = [];
	let prompts = 0;
	const loop = createChatLoop({
		getSettings: () => settings,
		getAutonomy: () => "yolo",
		providers: context.getContract("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		session,
		bus: context.bus,
		readSessionEntries: () => entries,
		promptSubmit: async (input) => {
			submitted.push(input);
			return { kind: "pass", text: input.text };
		},
		createAgent: ((agentOptions: Parameters<NonNullable<CreateChatLoopDeps["createAgent"]>>[0]) => {
			let listener: (event: AgentEvent) => unknown = () => {};
			const state = { ...agentOptions?.initialState, messages: [] as AgentMessage[] };
			const push = async (message: AgentMessage) => {
				state.messages.push(message);
				await listener({ type: "message_end", message } as AgentEvent);
			};
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
						if (prompts === 1) {
							// The stopped turn's last call: a failed bash run whose args carry a secret and a long string.
							await push({
								role: "assistant",
								content: [
									{
										type: "toolCall",
										id: "call-1",
										name: "bash",
										arguments: { command: `curl -H 'x-api-key: ${SECRET}' https://example.invalid`, note: "n".repeat(900) },
									},
								],
								stopReason: "toolUse",
								timestamp: Date.now(),
							} as unknown as AgentMessage);
							await push({
								role: "toolResult",
								toolCallId: "call-1",
								toolName: "bash",
								content: [{ type: "text", text: "exit 22" }],
								isError: true,
								timestamp: Date.now(),
							} as unknown as AgentMessage);
							context.bus.emit("safety.tool_budget_exceeded", {
								tool: "bash",
								callsThisTurn: 60,
								softBudget: 60,
								hardCeiling: 75,
								interrupted: false,
								at: Date.now(),
							});
						}
						const message = {
							role: "assistant",
							content: [{ type: "text", text: "fixture reply" }],
							stopReason: "stop",
							timestamp: Date.now(),
						} as AgentMessage;
						await push(message);
						await listener({ type: "agent_end", messages: [message] });
					},
				},
			};
		}) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
	});
	try {
		await loop.submit("poll CI until green");
		await loop.whenSettled();
	} finally {
		loop.dispose();
		await loop.whenSettled();
	}

	strictEqual(submitted.length, 2);
	const [operator, continuation] = submitted;
	strictEqual(operator?.origin.origin, "operator");
	strictEqual(operator?.origin.lastToolCall, undefined);
	strictEqual(continuation?.origin.origin, "continuation");
	const call = continuation?.origin.lastToolCall;
	ok(call);
	strictEqual(call.tool, "bash");
	strictEqual(call.outcome, "error");
	const command = String(call.args?.command);
	ok(!command.includes(SECRET), command);
	ok(command.startsWith("curl -H"), command);
	strictEqual(call.args?.note, `${"n".repeat(400)}… (900 chars)`);

	// The extension prompt gate passes the call on; its arguments cross only under tool-args.
	const source = path.join(scratch.dir, "source");
	const workspace = path.join(scratch.dir, "workspace");
	mkdirSync(source);
	mkdirSync(workspace);
	const events: ExtensionHookEvent[] = [];
	const bridge = createExtensionRuntimeHookBridge();
	bridge.bind({
		hook: async (_id, event) => {
			events.push(event);
			return { kind: "ok", effects: [] };
		},
		notify: () => {},
	});
	for (const [id, access] of [
		["desk", []],
		["ledger", ["tool-args"]],
	] as const) {
		const dir = path.join(source, id);
		mkdirSync(dir);
		writeFileSync(
			path.join(dir, "clio-coder-extension.json"),
			JSON.stringify({
				id,
				name: id,
				version: "1.0.0",
				description: "Reads why a continuation started",
				runtime: {
					api: 2,
					entrypoint: "extension.mjs",
					access,
					hooks: [{ on: "prompt_submit", timeoutMs: 1000, onTimeout: "pass", onError: "pass" }],
				},
			}),
		);
		writeFileSync(path.join(dir, "extension.mjs"), "export default () => {};\n");
		ok(installExtension(dir, { cwd: workspace, scope: "user" }).extension?.loadable);
	}
	const gate = buildExtensionPromptGate(listInstalledExtensions(workspace, { all: true }), bridge, {
		generation: 1,
		recordReceipt: () => {},
	});
	ok(continuation);
	await gate.run(continuation.typed, true, continuation.origin);
	const { args: _args, ...withoutArgs } = call;
	const byAccess = events.map((event) => (event as { lastToolCall?: { args?: unknown } }).lastToolCall);
	strictEqual(byAccess.length, 2);
	deepStrictEqual(
		byAccess.find((entry) => entry?.args === undefined),
		withoutArgs,
	);
	deepStrictEqual(
		byAccess.find((entry) => entry?.args !== undefined),
		call,
	);
	ok(events.every((event) => event.point === "prompt_submit" && event.origin === "continuation"));
	events.length = 0;
	await gate.run(operator?.typed ?? "", true, operator?.origin);
	ok(events.every((event) => event.point === "prompt_submit" && !("lastToolCall" in event)));
});
