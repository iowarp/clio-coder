import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { getEventListeners } from "node:events";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { CompiledSessionPrompt } from "../../src/domains/prompts/compiler.js";
import type { PromptsContract } from "../../src/domains/prompts/contract.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import { ContextOverflowError } from "../../src/domains/providers/errors.js";
import type { CompactResult } from "../../src/domains/session/compaction/compact.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import type { RecoveryFailureInput, RecoveryFailureKind } from "../../src/domains/session/retry.js";
import {
	classifyRecoveryFailure,
	DEFAULT_RETRY_SETTINGS,
	isRetryableRecoveryFailure,
	recoveryRetryDelayMs,
} from "../../src/domains/session/retry.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { createChatLoop } from "../../src/session-control/chat-loop.js";
import type { TurnRecoveryDeps } from "../../src/session-control/turn-recovery.js";
import { createTurnRecovery, recoveryAttemptHasOutput } from "../../src/session-control/turn-recovery.js";
import type { AgentRuntime } from "../../src/session-control/turn-state.js";
import { createTurnState } from "../../src/session-control/turn-state.js";
import { syntheticCompactionSummary } from "../harness/compaction-summary.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

test("recovery matrix preserves route, output, cancellation and loading policy", async (t) => {
	const cases: Array<{
		name: string;
		input: RecoveryFailureInput;
		kind: RecoveryFailureKind;
		delay?: number;
		maxDelayMs?: number;
		output?: AgentMessage[];
		stopDuringWait?: boolean;
	}> = [
		{
			name: "cancelled loading request",
			input: { runtimeId: "openai", message: "Model is unloaded.", cancelled: true },
			kind: "cancelled",
		},
		{
			name: "LiteLLM pre-output connection",
			input: { runtimeId: "litellm", message: "Connection error." },
			kind: "connection",
			delay: 2000,
		},
		{
			name: "Stop during connection wait",
			input: { runtimeId: "litellm", message: "Connection error." },
			kind: "connection",
			delay: 2000,
			stopDuringWait: true,
		},
		{
			name: "LiteLLM HTTP 503",
			input: { runtimeId: "litellm", message: "503 Service Unavailable", status: 503 },
			kind: "terminal-provider",
		},
		{
			name: "LiteLLM HTTP 429",
			input: { runtimeId: "litellm", message: "429 rate limit", status: 429 },
			kind: "terminal-provider",
		},
		...[
			{ type: "text", text: "partial response" },
			{ type: "thinking", thinking: "partial reasoning" },
			{ type: "toolCall", id: "call", name: "read", arguments: {} },
		].map((block) => ({
			name: `LiteLLM connection after ${block.type}`,
			input: { runtimeId: "litellm", message: "Connection error." },
			kind: "terminal-provider" as const,
			output: [{ role: "assistant", content: [block] }] as AgentMessage[],
		})),
		{
			name: "LiteLLM connection after tool result",
			input: { runtimeId: "litellm", message: "Connection error." },
			kind: "terminal-provider",
			output: [{ role: "toolResult", content: [] }] as unknown as AgentMessage[],
		},
		{
			name: "local loading floor",
			input: { runtimeId: "lmstudio", message: "Model is unloaded." },
			kind: "model-loading",
			delay: 15000,
		},
		{
			name: "loading honors operator cap",
			input: { runtimeId: "ollama", message: "model is loading" },
			kind: "model-loading",
			delay: 5000,
			maxDelayMs: 5000,
		},
		{
			name: "overflow uses compact recovery",
			input: { runtimeId: "litellm", message: "maximum context length exceeded" },
			kind: "context-overflow",
		},
	];
	for (const row of cases)
		await t.test(row.name, async (c) => {
			let now = 0;
			c.mock.timers.enable({ apis: ["setTimeout"] });
			c.mock.method(performance, "now", () => now);
			const signal = new AbortController();
			if (row.input.cancelled) signal.abort();
			const cause = new Error(row.input.message);
			const failure = classifyRecoveryFailure({
				...row.input,
				cause,
				hasAttemptOutput: recoveryAttemptHasOutput(row.output ?? []),
			});
			strictEqual(failure.kind, row.kind);
			strictEqual(failure.cause, cause);
			strictEqual(failure.status, row.input.status);
			strictEqual(isRetryableRecoveryFailure(failure), row.delay !== undefined);
			const settings = { ...DEFAULT_RETRY_SETTINGS, maxRetries: 1, maxDelayMs: row.maxDelayMs ?? 60000 };
			if (row.delay !== undefined) strictEqual(recoveryRetryDelayMs(1, settings, failure), row.delay);
			let continues = 0,
				prompts = 0,
				compactions = 0;
			const statuses: string[] = [];
			const runtime = {
				runtimeId: row.input.runtimeId,
				runtimeResolution: { contextWindowDetails: { effectiveContextWindow: 131072 } },
				agent: {
					state: { messages: [] },
					async continue() {
						continues++;
					},
					async prompt() {
						prompts++;
					},
				},
			} as unknown as AgentRuntime;
			const recovery = createTurnRecovery({
				state: createTurnState(),
				turnSignal: () => signal.signal,
				turnIdentity: () => signal,
				persistence: { appendRetryStatus() {}, wasPersisted: () => true } as unknown as TurnRecoveryDeps["persistence"],
				context: {
					async runAutoCompact() {
						compactions++;
						return true;
					},
				} as unknown as TurnRecoveryDeps["context"],
				retrySettings: () => settings,
				markPersistedUserEcho: async (_text, prompt) => prompt(),
				emitRetryStatus: (status) => {
					statuses.push(status.phase);
				},
				emitFailureMessage() {},
				emitNotice() {},
			});
			try {
				const pending = recovery.runTransientRetryChain(
					runtime,
					"request",
					{ stopReason: "error", errorMessage: row.input.message },
					row.output,
				);
				if (row.stopDuringWait) signal.abort();
				if (row.delay !== undefined) {
					now = row.delay;
					c.mock.timers.tick(row.delay);
				}
				await pending;
				strictEqual(continues, row.delay !== undefined && !row.stopDuringWait ? 1 : 0);
				if (row.stopDuringWait) strictEqual(statuses.filter((phase) => phase === "cancelled").length, 1);
				if (row.kind === "context-overflow") {
					await recovery.runCompactAndRetry(runtime, "request", new ContextOverflowError(row.input.message, cause));
					deepStrictEqual([compactions, prompts], [1, 1]);
				} else deepStrictEqual([compactions, prompts], [0, 0]);
				strictEqual(getEventListeners(signal.signal, "abort").length, 0);
			} finally {
				recovery.cancelRetryCountdown();
			}
		});
});

test("an OAuth rejection refreshes the sent token once, then retries or ends with the login remedy (#427)", async (t) => {
	const rejection = "Your authentication token has expired. Please try refreshing it.";
	// Either a recorded 401 or the body text alone reads as auth, and auth never joins the transient chain.
	for (const status of [401, undefined]) {
		const failure = classifyRecoveryFailure({ runtimeId: "openai-codex", message: rejection, status });
		strictEqual(failure.kind, "auth");
		strictEqual(isRetryableRecoveryFailure(failure), false);
	}
	for (const refreshed of [true, false])
		await t.test(refreshed ? "refresh succeeds" : "refresh fails", async () => {
			const errorMessage = (message: unknown): string | undefined =>
				(message as { errorMessage?: string } | undefined)?.errorMessage;
			const model = { api: "openai-codex-responses", provider: "openai-codex", id: "gpt-6-luna" };
			const failed = {
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: rejection,
			} as unknown as AgentMessage;
			const state = { messages: [failed] as AgentMessage[], model };
			const rejectedKeys: Array<string | undefined> = [];
			const statuses: Array<{ phase: string; errorMessage?: string }> = [];
			let continues = 0;
			const runtime = {
				runtimeId: "openai-codex",
				lastProviderStatus: 401,
				lastAuthResolution: { providerId: "openai-codex", source: "stored-oauth", apiKey: "stale" },
				runtimeResolution: { target: { id: "codex" }, runtime: { id: "openai-codex" } },
				agent: {
					state,
					async continue() {
						continues++;
						state.messages.push({
							role: "assistant",
							content: [{ type: "text", text: "ok" }],
							stopReason: "stop",
						} as AgentMessage);
					},
				},
			} as unknown as AgentRuntime;
			const recovery = createTurnRecovery({
				auth: {
					resolveForTarget: async (_target: unknown, _runtime: unknown, options?: { rejectedApiKey?: string }) => {
						rejectedKeys.push(options?.rejectedApiKey);
						return refreshed
							? { providerId: "openai-codex", available: true, source: "stored-oauth", apiKey: "fresh" }
							: { providerId: "openai-codex", available: false, source: "stored-oauth", detail: "refresh rejected" };
					},
				} as unknown as NonNullable<TurnRecoveryDeps["auth"]>,
				state: createTurnState(),
				persistence: { appendRetryStatus() {}, wasPersisted: () => true } as unknown as TurnRecoveryDeps["persistence"],
				context: {} as TurnRecoveryDeps["context"],
				retrySettings: () => ({ ...DEFAULT_RETRY_SETTINGS, enabled: false }),
				markPersistedUserEcho: async (_text, prompt) => prompt(),
				emitRetryStatus: (status) =>
					statuses.push({ phase: status.phase, ...(status.errorMessage ? { errorMessage: status.errorMessage } : {}) }),
				emitFailureMessage() {},
				emitNotice() {},
			});
			const handled = await recovery.runTransientRetryChain(
				runtime,
				"request",
				{ stopReason: "error", errorMessage: rejection, message: failed },
				[failed],
			);
			strictEqual(handled, true);
			deepStrictEqual(rejectedKeys, ["stale"], "exactly one forced refresh of the token that was sent");
			strictEqual(continues, refreshed ? 1 : 0);
			deepStrictEqual(
				statuses.map((status) => status.phase),
				["retrying", refreshed ? "recovered" : "exhausted"],
			);
			ok(statuses[0]?.errorMessage?.includes("target 'codex'"), statuses[0]?.errorMessage);
			const tail = state.messages.at(-1);
			if (refreshed) {
				strictEqual(errorMessage(tail), undefined, "the rejected round was pruned before the retry");
				strictEqual(state.messages.length, 1);
			} else {
				const remedy = errorMessage(tail);
				ok(remedy?.includes("target 'codex'") && remedy.includes("clio-coder auth login openai-codex"), remedy);
				strictEqual(statuses[1]?.errorMessage, remedy);
				ok(!remedy?.includes("refresh rejected"), "provider refresh diagnostics stay out of the remedy");
			}
		});
});

test("Stop fences deferred preparation and compaction before model calls or late publication", async (t) => {
	for (const phase of ["prepare", "compaction"] as const)
		for (const navigate of [false, true]) {
			await t.test(`${phase}: Stop${navigate ? " then new session" : " alone"}`, async () => {
				const scratch = await isolateClioEnv("clio-coder-recovery-lifecycle-");
				const settings = structuredClone(DEFAULT_SETTINGS);
				settings.chat.prewarm = false;
				settings.chat.thinkingLevel = "off";
				settings.context.workingSet.enabled = false;
				const context = dispatchStubContext({ settings });
				const target = settings.targets[0];
				ok(target);
				settings.chat.target = target.id;
				settings.chat.model = target.defaultModel ?? "gpt-4o";
				process.env.CLIO_CODER_FORCE_COMPACT = phase === "compaction" ? "1" : "0";
				const session = createSessionBundle(context).contract;
				session.create({ cwd: scratch.dir, target: target.id, model: settings.chat.model });
				const entered = deferred<void>();
				const prepared = deferred<CompiledSessionPrompt>();
				const compacted = deferred<CompactResult>();
				let compactionSignal: AbortSignal | undefined;
				let modelCalls = 0;
				let publishedReductions = 0;
				context.bus.on(BusChannels.ContextPruned, () => {
					publishedReductions++;
				});
				const loop = createChatLoop({
					getSettings: () => settings,
					providers: context.getContract<ProvidersContract>("providers") as ProvidersContract,
					knownTargets: () => new Set([target.id]),
					session,
					bus: context.bus,
					readSessionEntries: () => session.readEntries(),
					createAgent: (options) =>
						createEngineAgent({
							...options,
							streamFn: () => {
								modelCalls++;
								throw new Error("unexpected model call");
							},
						}),
					...(phase === "prepare"
						? {
								prompts: {
									inputEpoch: () => "fixture",
									compileSessionPrompt: () => {
										entered.resolve();
										return prepared.promise;
									},
								} as unknown as PromptsContract,
							}
						: {
								autoCompact: async (_instructions, _trigger, budget) => {
									compactionSignal = budget?.signal;
									entered.resolve();
									return compacted.promise;
								},
							}),
				});
				try {
					const submitting = loop.submit("deferred synthetic request");
					await entered.promise;
					strictEqual(modelCalls, 0);
					loop.cancel();
					if (phase === "compaction") strictEqual(compactionSignal?.aborted, true);
					if (navigate) {
						session.create({ cwd: scratch.dir, target: target.id, model: settings.chat.model });
						loop.resetForSession(null);
					}
					const currentId = session.current()?.id;
					const before = JSON.stringify(session.readEntries());
					prepared.resolve({
						systemPrompt: "late prepared prompt",
						systemPromptHash: "late-hash",
						tokenEstimate: 3,
						sections: [],
						fragmentManifest: [],
					});
					compacted.resolve({
						summary: syntheticCompactionSummary("late checkpoint"),
						tokensBefore: 10000,
						firstKeptEntryIndex: 0,
						firstKeptTurnId: null,
						messagesSummarized: 1,
						isSplitTurn: false,
					});
					await submitting;
					strictEqual(modelCalls, 0);
					strictEqual(session.current()?.id, currentId);
					strictEqual(publishedReductions, 0);
					ok(!JSON.stringify(session.readEntries()).includes("late-hash"));
					strictEqual(
						session.readEntries().some((entry) => entry.kind === "compactionSummary"),
						false,
					);
					if (navigate) strictEqual(JSON.stringify(session.readEntries()), before);
				} finally {
					loop.dispose();
					await session.close();
					context.bus.clear();
					scratch.restore();
				}
			});
		}
});
