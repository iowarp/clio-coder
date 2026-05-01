import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import type { Query as ClaudeQuery, Options as ClaudeQueryOptions, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ToolName } from "../../../src/core/tool-names.js";
import { EMPTY_CAPABILITIES } from "../../../src/domains/providers/types/capability-flags.js";
import type { EndpointDescriptor } from "../../../src/domains/providers/types/endpoint-descriptor.js";
import type { RuntimeDescriptor } from "../../../src/domains/providers/types/runtime-descriptor.js";
import {
	createClaudeCodeSdkRuntime,
	mapClioModeToClaudePermission,
} from "../../../src/engine/claude-code-sdk-runtime.js";
import type { AgentEvent } from "../../../src/engine/types.js";

const endpoint: EndpointDescriptor = {
	id: "claude-sdk-test",
	runtime: "claude-code-sdk",
};

const runtime: RuntimeDescriptor = {
	id: "claude-code-sdk",
	displayName: "Claude Code SDK",
	kind: "sdk",
	tier: "sdk",
	apiFamily: "claude-agent-sdk",
	auth: "cli",
	defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true },
	defaultBinaryPath: "/tmp/fake-claude",
	synthesizeModel: () => ({ id: "claude-sonnet-4-6", provider: "anthropic", baseUrl: "" }) as never,
};

interface FakeQueryControls {
	setModelCalls: Array<string | undefined>;
	setPermissionModeCalls: string[];
	interruptCalls: number;
	closed: boolean;
}

function makeFakeQuery(
	prompt: AsyncIterable<unknown>,
	messages: ReadonlyArray<SDKMessage>,
	controls: FakeQueryControls,
): ClaudeQuery {
	async function* iterate(): AsyncGenerator<SDKMessage, void> {
		for await (const _message of prompt) {
			for (const message of messages) yield message;
			return;
		}
	}
	const generator = iterate();
	return Object.assign(generator, {
		async interrupt() {
			controls.interruptCalls += 1;
		},
		async setPermissionMode(mode: string) {
			controls.setPermissionModeCalls.push(mode);
		},
		async setModel(model?: string) {
			controls.setModelCalls.push(model);
		},
		async setMaxThinkingTokens(_maxThinkingTokens: number | null) {},
		close() {
			controls.closed = true;
		},
	}) as ClaudeQuery;
}

function resultMessage(text: string): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		duration_ms: 1,
		duration_api_ms: 1,
		is_error: false,
		num_turns: 1,
		result: text,
		stop_reason: "stop",
		total_cost_usd: 0.02,
		usage: { input_tokens: 2, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 1 },
		modelUsage: {},
		permission_denials: [],
		uuid: "result-1",
		session_id: "claude-session-1",
	} as never;
}

describe("Claude Code SDK runtime", () => {
	it("maps Clio modes and allowed tools to Claude permission options", () => {
		const advise = mapClioModeToClaudePermission("advise", ["read", "grep", "bash"] as ToolName[]);
		strictEqual(advise.permissionMode, "plan");
		strictEqual(advise.allowDangerouslySkipPermissions, false);
		ok(Array.isArray(advise.tools));
		ok((advise.tools as string[]).includes("Read"));
		ok(!(advise.tools as string[]).includes("Bash"));

		const full = mapClioModeToClaudePermission("super", undefined);
		strictEqual(full.permissionMode, "bypassPermissions");
		strictEqual(full.allowDangerouslySkipPermissions, true);
	});

	it("runs one SDK turn with streaming deltas and final usage", async () => {
		const controls: FakeQueryControls = {
			setModelCalls: [],
			setPermissionModeCalls: [],
			interruptCalls: 0,
			closed: false,
		};
		let capturedOptions: ClaudeQueryOptions | undefined;
		const sdk = createClaudeCodeSdkRuntime({
			createQuery: ({ prompt, options }) => {
				capturedOptions = options;
				return makeFakeQuery(
					prompt,
					[
						{
							type: "stream_event",
							event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } },
							parent_tool_use_id: null,
							uuid: "stream-1",
							session_id: "claude-session-1",
						} as never,
						resultMessage("hello"),
					],
					controls,
				);
			},
		});
		const events: AgentEvent[] = [];
		const session = await sdk.startSession(
			{
				systemPrompt: "system",
				endpoint,
				runtime,
				wireModelId: "claude-sonnet-4-6",
				mode: "default",
			},
			(event) => events.push(event),
		);
		const turn = await sdk.sendTurn({ threadId: session.threadId, task: "hi" });
		const result = await turn.done;
		await sdk.stopSession(session.threadId);

		strictEqual(result.exitCode, 0);
		strictEqual(capturedOptions?.model, "claude-sonnet-4-6");
		strictEqual(capturedOptions?.permissionMode, "default");
		strictEqual(capturedOptions?.includePartialMessages, true);
		strictEqual(capturedOptions?.persistSession, true);
		ok(
			events.some((event) => event.type === "message_update"),
			"expected stream update event",
		);
		const final = result.messages[0];
		ok(final && "role" in final && final.role === "assistant");
		strictEqual(final.content[0]?.type, "text");
		strictEqual(final.content[0]?.type === "text" ? final.content[0].text : "", "hello");
		strictEqual(final.usage.input, 2);
		strictEqual(final.usage.output, 3);
		strictEqual(final.usage.cacheRead, 1);
		strictEqual(final.usage.cost.total, 0.02);
		strictEqual(controls.closed, true);
	});

	it("uses in-session model and permission steering before a turn", async () => {
		const controls: FakeQueryControls = {
			setModelCalls: [],
			setPermissionModeCalls: [],
			interruptCalls: 0,
			closed: false,
		};
		const sdk = createClaudeCodeSdkRuntime({
			createQuery: ({ prompt }) => makeFakeQuery(prompt, [resultMessage("done")], controls),
		});
		const session = await sdk.startSession(
			{
				systemPrompt: "",
				endpoint,
				runtime,
				wireModelId: "claude-sonnet-4-6",
				mode: "default",
			},
			() => undefined,
		);
		const turn = await sdk.sendTurn({
			threadId: session.threadId,
			task: "plan",
			wireModelId: "claude-opus-4-7",
			mode: "advise",
		});
		await turn.done;
		await sdk.stopSession(session.threadId);

		strictEqual(controls.setModelCalls[0], "claude-opus-4-7");
		strictEqual(controls.setPermissionModeCalls[0], "plan");
	});

	it("runs lifecycle hooks in start and stop order", async () => {
		const controls: FakeQueryControls = {
			setModelCalls: [],
			setPermissionModeCalls: [],
			interruptCalls: 0,
			closed: false,
		};
		const seen: string[] = [];
		const sdk = createClaudeCodeSdkRuntime({
			createQuery: ({ prompt }) => makeFakeQuery(prompt, [], controls),
		});
		sdk.onSessionStart(async () => {
			seen.push("start-hook");
		});
		sdk.onSessionEnd(async () => {
			seen.push("end-hook");
		});
		const session = await sdk.startSession(
			{
				systemPrompt: "",
				endpoint,
				runtime,
				wireModelId: "claude-sonnet-4-6",
			},
			(event) => seen.push(event.type),
		);
		await sdk.stopSession(session.threadId);
		strictEqual(seen.join("|"), "start-hook|agent_start|end-hook");
	});

	it("propagates lifecycle hook failures", async () => {
		const controls: FakeQueryControls = {
			setModelCalls: [],
			setPermissionModeCalls: [],
			interruptCalls: 0,
			closed: false,
		};
		const sdk = createClaudeCodeSdkRuntime({
			createQuery: ({ prompt }) => makeFakeQuery(prompt, [], controls),
		});
		sdk.onSessionStart(async () => {
			throw new Error("hook failed");
		});
		const outcome = await sdk
			.startSession(
				{
					systemPrompt: "",
					endpoint,
					runtime,
					wireModelId: "claude-sonnet-4-6",
				},
				() => undefined,
			)
			.then(
				() => "resolved",
				(err: unknown) => (err instanceof Error ? err.message : String(err)),
			);
		strictEqual(outcome, "hook failed");
	});

	it("denies unsupported native user-input hooks through canUseTool", async () => {
		let capturedOptions: ClaudeQueryOptions | undefined;
		const controls: FakeQueryControls = {
			setModelCalls: [],
			setPermissionModeCalls: [],
			interruptCalls: 0,
			closed: false,
		};
		const sdk = createClaudeCodeSdkRuntime({
			createQuery: ({ prompt, options }) => {
				capturedOptions = options;
				return makeFakeQuery(prompt, [], controls);
			},
		});
		const session = await sdk.startSession(
			{
				systemPrompt: "",
				endpoint,
				runtime,
				wireModelId: "claude-sonnet-4-6",
			},
			() => undefined,
		);
		const ask = await capturedOptions?.canUseTool?.("AskUserQuestion", { question: "continue?" }, fakeToolOptions());
		const exitPlan = await capturedOptions?.canUseTool?.("ExitPlanMode", { plan: "do it" }, fakeToolOptions());
		await sdk.stopSession(session.threadId);

		strictEqual(ask?.behavior, "deny");
		strictEqual(exitPlan?.behavior, "deny");
	});
});

function fakeToolOptions() {
	return {
		signal: new AbortController().signal,
		toolUseID: "tool-1",
	};
}
