import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ExtensionHookEvent } from "../../src/domains/extensions/public-api-v2.js";
import { createExtensionRuntimeHookBridge } from "../../src/domains/extensions/runtime-hook-bridge.js";
import { installExtension, listInstalledExtensions } from "../../src/domains/extensions/state.js";
import { createMiddlewareToolChoiceControl } from "../../src/domains/middleware/tool-choice-control.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { SessionContract, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/entries.js";
import type { AgentEvent, AgentMessage } from "../../src/engine/types.js";
import { buildExtensionPromptGate } from "../../src/entry/extension-runtime-hooks.js";
import type { CreateChatLoopDeps, PromptSubmitInput } from "../../src/session-control/chat-loop.js";
import { createChatLoop } from "../../src/session-control/chat-loop.js";
import type { SealedCompletion } from "../../src/tools/finish.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const SECRET = "sk-ant-api03-continuationfixture0123456789abcdefghijklmnop";

/**
 * A yolo turn the tool budget stopped after a failed bash call, through the real chat loop and turn runtime. With
 * `declared`, the same turn also calls `finish` alone while a required tool is still pending, and the fixture records
 * the turn runtime's finishTurn decision. With `handover`, an operator message is queued when that declared turn
 * finishes and carries the run into a second, undeclared turn that ends with a required tool still pending. With `bare`,
 * the yolo continuation that follows offers the turn runtime's beforeToolCall finish calls with no reply text, before
 * and after an operator message is handed into it, and the last one runs and declares.
 */
async function stoppedTurn(dir: string, mode: "undeclared" | "declared" | "handover" | "bare") {
	const declared = mode === "declared" || mode === "handover";
	let queued = false;
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
		current: () => ({ id: "continuation-session", cwd: dir, cwdHash: "continuation-repo" }),
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
	const decisions: unknown[] = [];
	const gates: string[] = [];
	const toolChoice = createMiddlewareToolChoiceControl();
	let prompts = 0;
	const loop = createChatLoop({
		middlewareToolChoice: toolChoice,
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
			// Pi's per-call gate as the turn runtime wired it: the refusal reason, or "ran".
			const gate = async (call: { type: "toolCall"; id: string; name: string; arguments: unknown }) => {
				const beforeToolCall = (
					agentOptions as unknown as {
						beforeToolCall?: (context: {
							assistantMessage: unknown;
							toolCall: unknown;
						}) => Promise<{ reason?: string } | undefined>;
					}
				).beforeToolCall;
				const assistantMessage = { role: "assistant", content: [{ type: "thinking", thinking: "done" }, call] };
				gates.push((await beforeToolCall?.({ assistantMessage, toolCall: call }))?.reason ?? "ran");
			};
			const push = async (message: AgentMessage) => {
				state.messages.push(message);
				await listener({ type: "message_end", message } as AgentEvent);
			};
			const agent = {
				state,
				subscribe: (next: typeof listener) => {
					listener = next;
					return () => {};
				},
				abort() {},
				clearAllQueues() {},
				hasQueuedMessages: () => queued,
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
					if (prompts === 1 && declared) {
						// A middleware required verify; the provider fell back to auto and the model called finish alone.
						toolChoice.apply([{ kind: "require_tool", toolName: "verify" }]);
						const message = {
							role: "assistant",
							content: [{ type: "toolCall", id: "call-f", name: "finish", arguments: { state: "partly_done" } }],
							stopReason: "toolUse",
							toolRounds: [{ kind: "required", toolName: "verify", choice: "auto" }],
							timestamp: Date.now(),
						} as unknown as AgentMessage;
						await push(message);
						const completion = { state: "partly_done", limitations: [], unverified: [] };
						const result = { content: [{ type: "text", text: "declared" }], details: { completion }, terminate: true };
						await listener({ type: "tool_execution_start", toolCallId: "call-f", toolName: "finish", args: completion });
						await listener({
							type: "tool_execution_end",
							toolCallId: "call-f",
							toolName: "finish",
							result,
							isError: false,
						} as unknown as AgentEvent);
						queued = mode === "handover";
						decisions.push(await agent.finishTurn?.({ message, toolResults: [] }));
						if (mode === "handover") {
							// The engine carries the run on with the queued message: a new turn that declares nothing.
							queued = false;
							await listener({ type: "turn_start" });
							await push({
								role: "user",
								content: [{ type: "text", text: "also update the notes" }],
								timestamp: Date.now(),
							} as AgentMessage);
							toolChoice.apply([{ kind: "require_tool", toolName: "verify" }]);
							const next = {
								role: "assistant",
								content: [{ type: "text", text: "Updated." }],
								stopReason: "stop",
								toolRounds: [{ kind: "required", toolName: "verify", choice: "auto" }],
								timestamp: Date.now(),
							} as unknown as AgentMessage;
							await push(next);
							decisions.push(await agent.finishTurn?.({ message: next, toolResults: [] }));
							await listener({ type: "agent_end", messages: [next] });
							return;
						}
						await listener({ type: "agent_end", messages: [message] });
						return;
					}
					if (prompts === 2 && mode === "bare") {
						const finish = { type: "toolCall" as const, id: "call-b", name: "finish", arguments: { state: "done" } };
						// Nobody watches the continuation, so its bare finish runs.
						await gate(finish);
						// An operator message handed into the run makes the turn attended.
						await push({
							role: "user",
							content: [{ type: "text", text: "what changed?" }],
							timestamp: Date.now(),
						} as AgentMessage);
						await gate({
							type: "toolCall",
							id: "call-g",
							name: "gateway",
							arguments: { op: "call", capability: "finish", args: { state: "done" } },
						});
						// Refused once in this user turn: the next bare finish runs and declares.
						await gate(finish);
						const message = {
							role: "assistant",
							content: [finish],
							stopReason: "toolUse",
							timestamp: Date.now(),
						} as unknown as AgentMessage;
						await push(message);
						const completion = { state: "done", limitations: [], unverified: [] };
						const result = { content: [{ type: "text", text: "declared" }], details: { completion }, terminate: true };
						await listener({ type: "tool_execution_start", toolCallId: "call-b", toolName: "finish", args: completion });
						await listener({
							type: "tool_execution_end",
							toolCallId: "call-b",
							toolName: "finish",
							result,
							isError: false,
						} as unknown as AgentEvent);
						decisions.push(await agent.finishTurn?.({ message, toolResults: [] }));
						await listener({ type: "agent_end", messages: [message] });
						return;
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
			} as {
				state: typeof state;
				finishTurn?: (turn: { message: AgentMessage; toolResults: AgentMessage[] }) => Promise<unknown>;
			} & Record<string, unknown>;
			return { requestCorrelationId: () => undefined, agent };
		}) as unknown as NonNullable<CreateChatLoopDeps["createAgent"]>,
	});
	let sealed: SealedCompletion | null = null;
	try {
		await loop.submit("poll CI until green");
		await loop.whenSettled();
		sealed = loop.lastTurnCompletion?.() ?? null;
	} finally {
		loop.dispose();
		await loop.whenSettled();
	}
	return { submitted, decisions, entries, gates, sealed };
}

test("a continuation's prompt_submit names the last tool call; an operator prompt does not", async (t) => {
	const scratch = await isolateClioEnv("clio-coder-continuation-call-");
	t.after(() => scratch.restore());
	const { submitted } = await stoppedTurn(scratch.dir, "undeclared");

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

test("a turn declared through finish is never continued: no required-tool round, no yolo continuation (FX-38)", async (t) => {
	const scratch = await isolateClioEnv("clio-coder-continuation-declared-");
	t.after(() => scratch.restore());
	const { submitted, decisions } = await stoppedTurn(scratch.dir, "declared");
	// The pending require_tool asked for no further request, and the tool budget it crossed resubmitted nothing.
	deepStrictEqual(decisions, [undefined]);
	strictEqual(submitted.length, 1);
	strictEqual(submitted[0]?.origin.origin, "operator");

	// A queued operator message carries the run past the declared turn: that turn still settles (its terminal row is
	// written before the handed-over message), and the declaration does not outlive it, so the undeclared next turn
	// still takes its required-tool round.
	const handover = await stoppedTurn(scratch.dir, "handover");
	deepStrictEqual(handover.decisions, [undefined, { action: "continue" }]);
	const rowOf = (match: (payload: Record<string, unknown>) => boolean) =>
		handover.entries.findIndex(
			(entry) => entry.kind === "message" && match((entry as { payload: Record<string, unknown> }).payload ?? {}),
		);
	const terminal = rowOf((payload) => payload.terminalToolResult === true && payload.toolCallId === "call-f");
	const followUp = rowOf((payload) => payload.text === "also update the notes");
	ok(terminal >= 0 && followUp > terminal, `terminal row ${terminal}, follow-up row ${followUp}`);
});

test("an attended finish with no reply text is refused once per user turn; a handed-over message is attended (FX-40)", async (t) => {
	const scratch = await isolateClioEnv("clio-coder-continuation-bare-");
	t.after(() => scratch.restore());
	const { submitted, gates, sealed } = await stoppedTurn(scratch.dir, "bare");
	strictEqual(submitted[1]?.origin.origin, "continuation");
	deepStrictEqual(gates, [
		"ran",
		"finish did not run: this response has no reply text. Write your reply to the operator, then call finish.",
		"ran",
	]);
	// The bare finish that ran still declares, and the seal records that its response carried no reply.
	strictEqual(sealed?.claimed, "done");
	deepStrictEqual(sealed?.limitations, [
		{ what: "the response that declared completion carried no reply text for the operator", why: "other" },
	]);
});
