import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { projectDispatchJsonEvent } from "../../src/cli/modes/json-stream.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { messageUsageForAccounting, rememberMessageCalls } from "../../src/core/message-accounting.js";
import type { CallSettled } from "../../src/core/telemetry/schemas.js";
import type { MiddlewareToolChoiceControl } from "../../src/domains/middleware/index.js";
import { callSettlementFromMessage } from "../../src/domains/observability/call-facts.js";
import { callCoverageForRun, createCostTracker, renderCostAggregate } from "../../src/domains/observability/cost.js";
import { createObservabilityBundle } from "../../src/domains/observability/extension.js";
import type { SessionContract, TurnInput } from "../../src/domains/session/contract.js";
import { ledgerUsageCalls, type SessionEntry } from "../../src/domains/session/index.js";
import { ledgerCallFailureCounts } from "../../src/domains/session/usage.js";
import {
	remainingContextMaxTokens,
	resolveReservedOutputTokens,
	setGlobalDefaultMaxOutputTokens,
} from "../../src/engine/apis/output-budget.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { reseedSessionUsageFromLedger } from "../../src/interactive/session-usage-reseed.js";
import { emptyRunTally, foldMessageIntoRunTally } from "../../src/interactive/status/summary.js";
import {
	assistantSessionPayload,
	estimatedUsageForInterruptedTurn,
	sumRunUsage,
	terminalFailureFromAssistantMessage,
} from "../../src/session-control/chat-loop-messages.js";
import { createTurnPersistence } from "../../src/session-control/turn-persistence.js";
import { createTurnState } from "../../src/session-control/turn-state.js";
import {
	checkCostRendering,
	checkLedgerUsageMutation,
	checkSurfaceTotals,
	runBoundaryCheck,
} from "../boundaries/check-boundaries.js";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
	id: string,
	stopReason: "stop" | "aborted",
	usage: Record<string, unknown>,
	extra: Record<string, unknown> = {},
): SessionEntry {
	return {
		kind: "message",
		role: "assistant",
		turnId: id,
		parentTurnId: null,
		timestamp: "2026-08-31T12:00:00.000Z",
		payload: {
			text: stopReason === "aborted" ? "partial output" : "done",
			stopReason,
			usage,
			...extra,
		},
	} as unknown as SessionEntry;
}

describe("contracts/metering integrity", () => {
	afterEach(() => setGlobalDefaultMaxOutputTokens(0));

	it("folds retry facts once across messages while keeping unknown usage and display estimates separate", () => {
		const usage = Object.freeze({
			...zeroUsage,
			input: 8,
			output: 2,
			totalTokens: 10,
			cost: Object.freeze({ ...zeroUsage.cost, total: 0.25 }),
			clioExternal: { tokenUsage: "provider-reported", cost: "provider-reported" },
		});
		const settled = (attempt: number, message: unknown): CallSettled => ({
			callId: "call-fixture",
			attemptId: `attempt-${attempt}`,
			attempt,
			label: "main",
			roundKind: "normal",
			toolChoice: "auto",
			target: {
				targetId: "test",
				runtimeId: "test",
				api: "test",
				requestedModel: "requested",
				reportedModel: { kind: "measured", value: "served", source: "provider" },
			},
			stages: { settle: 1 },
			...callSettlementFromMessage(message, "known"),
		});
		const first = settled(0, { stopReason: "stop", usage });
		// Thinking the provider counted no reasoning for is estimated at chars/4, never above the measured output.
		const thought = settled(0, { stopReason: "stop", usage, content: [{ type: "thinking", thinking: "x".repeat(40) }] });
		deepStrictEqual(thought.usage?.reasoning, { kind: "estimated", value: 2, method: "chars/4" });
		for (const invoked of [false, true]) {
			const message = {
				role: "assistant",
				content: [],
				stopReason: "aborted",
				callInvoked: invoked,
				usage: zeroUsage,
				estimatedUsage: { input: 20, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 23, estimated: true },
			} as unknown as AgentMessage;
			rememberMessageCalls(message, [first, settled(1, message)]);
			// The journal keeps the display estimate beside the usage, where no fold sums it.
			deepStrictEqual(
				settled(1, message).interruptedEstimate,
				invoked
					? {
							input: { kind: "estimated", value: 20, method: "prompt-side-only" },
							output: { kind: "estimated", value: 3, method: "chars/4" },
						}
					: undefined,
			);
			const summary = sumRunUsage([message, message]);
			strictEqual(summary.tokens, 10);
			strictEqual(summary.costUsd, 0.25);
			strictEqual(summary.apiCalls, invoked ? 2 : 1);
			strictEqual(summary.missingTokenCalls, invoked ? 1 : 0);
			strictEqual(summary.costSummary?.hasUnknown, invoked);
			strictEqual(summary.costSummary?.calls, invoked ? 2 : 1);
			strictEqual(summary.lastResponseModelIdObservation.state, "reported");
			const display = sumRunUsage([message], { includeEstimates: true });
			strictEqual(display.tokens, invoked ? 33 : 10);
			strictEqual(display.costUsd, 0.25);
			const tally = foldMessageIntoRunTally(emptyRunTally(), message);
			strictEqual(tally.inputTokens, display.input);
			strictEqual(tally.outputTokens, display.output);
			strictEqual((message as unknown as { usage: unknown }).usage, zeroUsage);
		}
	});

	it("keeps provider usage immutable while accounting reads separate annotations and legacy rows", () => {
		for (const reported of [zeroUsage, { ...zeroUsage, input: 10, output: 3, totalTokens: 13 }]) {
			const usage = Object.freeze({ ...reported, cost: Object.freeze({ ...reported.cost }) });
			const message = {
				role: "assistant",
				content: [{ type: "text", text: "partial" }],
				stopReason: "aborted",
				usage,
				callId: "call-fixture",
				attemptId: "attempt-fixture",
				callInvoked: true,
				callAccounting: { usageObserved: reported.totalTokens > 0, targetId: "selected-target", costProvenance: "unknown" },
			} as unknown as AgentMessage;
			const payload = assistantSessionPayload(message, terminalFailureFromAssistantMessage(message));
			strictEqual(payload.usage, usage);
			strictEqual(payload.callId, "call-fixture");
			strictEqual(payload.attemptId, "attempt-fixture");
			// The ledger is the conversation record; the journal owns usage, so annotations stay on the live message (#434 §5.3).
			strictEqual(payload.callAccounting, undefined);
			strictEqual(payload.estimatedUsage, undefined);
			strictEqual(sumRunUsage([message]).tokens, reported.totalTokens);
			const projected = messageUsageForAccounting(message);
			ok(projected);
			strictEqual(projected.targetId, "selected-target");
			projected.input = 999;
			strictEqual(usage.input, reported.input);
			// Old ledgers persisted the annotations beside usage, and older ones inside it; both still read alike.
			const accounting = (message as unknown as { callAccounting: Record<string, unknown> }).callAccounting;
			const entry = assistant("immutable", "aborted", usage, { ...payload, callAccounting: accounting });
			const calls = ledgerUsageCalls([entry]);
			strictEqual(calls[0]?.providerId, "selected-target");
			strictEqual(calls[0]?.totalTokens, reported.totalTokens);
			const legacy = assistant(
				"legacy",
				"aborted",
				{ ...usage, ...accounting, callInvoked: true },
				{ responseModelIdObservation: payload.responseModelIdObservation },
			);
			strictEqual(calls[0]?.callId, "call-fixture");
			deepStrictEqual(
				ledgerUsageCalls([legacy]).map((call) => ({ ...call, callId: "call-fixture" })),
				calls,
			);
		}
		for (const source of [
			"message.usage.input = 0;",
			"const { usage } = message; usage.input += 2;",
			"Object.assign(message, { usage: { input: 0 } });",
			"const usage = message.usage; usage.cost = {};",
			"Object.assign(payload.usage, { input: 0 });",
			'payload["usage"] = { input: 0 };',
		])
			strictEqual(checkLedgerUsageMutation("src/session-control/example.ts", source).length, 1);
		deepStrictEqual(
			checkLedgerUsageMutation(
				"src/session-control/example.ts",
				"payload.usage = null; payload.usage = message.usage; const projection = { ...message.usage }; projection.input = 0;",
			),
			[],
		);
		deepStrictEqual(checkLedgerUsageMutation("src/engine/example.ts", "message.usage.input = 0;"), []);
	});

	it("preserves declared call counts and unknown run coverage through usage projections", () => {
		const tracker = createCostTracker();
		for (const [counts, expected] of [
			[{}, { apiCalls: 0, missingTokenCalls: 0, unknownCallCoverageRuns: 1 }],
			[
				{ apiCalls: 0, missingTokenCalls: 0 },
				{ apiCalls: 0, missingTokenCalls: 0, unknownCallCoverageRuns: 0 },
			],
			[
				{ apiCalls: 3, missingTokenCalls: 1 },
				{ apiCalls: 3, missingTokenCalls: 1, unknownCallCoverageRuns: 0 },
			],
			[{ apiCalls: 2 }, { apiCalls: 2, missingTokenCalls: 0, unknownCallCoverageRuns: 1 }],
		] as const) {
			const coverage = callCoverageForRun(counts);
			deepStrictEqual(coverage, expected);
			tracker.accumulate("target", "model", 0, 0, coverage, "known_free", undefined, "worker");
		}
		strictEqual(tracker.sessionCost().calls, 5);
		strictEqual(tracker.sessionCost().unknownCallCoverageRuns, 2);
		strictEqual(renderCostAggregate(tracker.sessionCost()), "$0.00 local");
		tracker.reset();
		strictEqual(tracker.sessionTokens().unknownCallCoverageRuns, undefined);
		strictEqual(renderCostAggregate(tracker.sessionCost()), "not measured");
	});

	it("replaces replayed run snapshots without retaining their previous amounts or missing coverage", () => {
		const tracker = createCostTracker();
		tracker.accumulate("main", "model", 10, 0, { apiCalls: 1 }, "known_free");
		tracker.replace(
			"run:worker",
			"worker",
			"model",
			3,
			0,
			{ apiCalls: 0, unknownCallCoverageRuns: 1, cacheWrite1h: 2 },
			"unknown",
		);
		strictEqual(tracker.sessionTokens().totalTokens, 13);
		strictEqual(tracker.sessionCost().hasUnknown, true);
		tracker.replace(
			"run:worker",
			"worker",
			"model",
			7,
			0,
			{ apiCalls: 2, missingTokenCalls: 0, cacheWrite1h: 4 },
			"known_free",
		);
		strictEqual(tracker.sessionTokens().totalTokens, 17);
		strictEqual(tracker.sessionTokens().cacheWrite1h, 4);
		strictEqual(tracker.sessionCost().calls, 3);
		strictEqual(tracker.sessionCost().hasUnknown, false);
		strictEqual(tracker.sessionCost().unknownCallCoverageRuns, undefined);
		strictEqual(tracker.entries().length, 2);
		tracker.reset();
		strictEqual(tracker.sessionTokens().totalTokens, 0);
		strictEqual(tracker.entries().length, 0);
	});

	it("attributes provider usage to the target and the model that answered", () => {
		const [call] = ledgerUsageCalls(
			[
				assistant(
					"a1",
					"stop",
					{
						input: 120,
						output: 30,
						cacheRead: 80,
						cacheWrite: 5,
						totalTokens: 235,
						cost: { total: 0.25 },
					},
					{ provider: "llamacpp", model: "requested-model", responseModel: "answering-model" },
				),
			],
			{ target: "local-cluster", model: "requested-model" },
		);

		strictEqual(call?.providerId, "local-cluster");
		strictEqual(call?.requestedModelId, "requested-model");
		strictEqual(call?.attributedModelId, "answering-model");
		strictEqual(call?.totalTokens, 235);
		strictEqual(call?.cacheRead, 80);
		strictEqual(call?.costUsd, 0.25);
	});

	it("estimates spent prompt and streamed output when cancellation prevents final usage", () => {
		const message = {
			role: "assistant",
			content: [{ type: "text", text: "streamed result ".repeat(80) }],
			stopReason: "aborted",
			errorMessage: "Request was aborted.",
			timestamp: Date.now(),
			usage: zeroUsage,
		} as unknown as AgentMessage;
		const corrected = estimatedUsageForInterruptedTurn(message, 9_658);

		ok(corrected);
		strictEqual(corrected.input, 9_658);
		ok(typeof corrected.output === "number" && corrected.output > 0);
		strictEqual(corrected.totalTokens, corrected.input + corrected.output);
		strictEqual(corrected.estimated, true);
		strictEqual(estimatedUsageForInterruptedTurn({ ...message, stopReason: "stop" } as AgentMessage, 9_658), null);
	});

	it("counts tool arguments with interleaved text and thinking, and repairs older estimates", () => {
		const message = {
			role: "assistant",
			stopReason: "aborted",
			content: [
				{ type: "text", text: "eight123" },
				{ type: "thinking", thinking: "thoughts" },
				{ type: "toolCall", id: "write-1", name: "write", arguments: "x".repeat(20_000) },
			],
			usage: { ...zeroUsage, input: 50, output: 6, estimated: true },
		} as unknown as AgentMessage;
		const usage = estimatedUsageForInterruptedTurn(message, 100);
		strictEqual(usage?.output, 5004);
		strictEqual(usage?.input, 100);
		strictEqual(usage?.estimated, true);
		const raw = { ...message, clioCoderOutputChars: 24_000 } as unknown as AgentMessage;
		strictEqual(estimatedUsageForInterruptedTurn(raw, 100)?.output, 6000);
		const authoritative = { ...raw, usage: { ...zeroUsage, input: 100, output: 42, totalTokens: 142 } } as AgentMessage;
		strictEqual(estimatedUsageForInterruptedTurn(authoritative, 100), null);
		const summary = projectDispatchJsonEvent({ type: "agent_end", messages: [raw] }) as {
			usage: {
				measured: boolean;
				estimated?: boolean;
			};
		};
		strictEqual(summary.usage.measured, false);
		strictEqual(summary.usage.estimated, true);
	});

	it("never-sent aborts have no prompt estimate or spend and count separately from unknown usage", async () => {
		const usage = { ...zeroUsage, callInvoked: false };
		const message = {
			role: "assistant",
			stopReason: "aborted",
			content: [],
			usage,
		} as unknown as AgentMessage;
		strictEqual(estimatedUsageForInterruptedTurn(message, 326_637), null);
		const frame = projectDispatchJsonEvent({
			type: "agent_end",
			messages: [{ ...message, usage: zeroUsage, callInvoked: false }],
		}) as { usage: { missingTokenCalls?: number } };
		strictEqual(frame.usage.missingTokenCalls ?? 0, 0);
		const unknown = assistant("unknown", "aborted", { ...zeroUsage, callInvoked: true });
		for (const neverSent of [
			assistant("never-sent", "aborted", usage),
			assistant("never-sent-failure", "aborted", zeroUsage, {
				failure: { invoked: false, stage: "admission", errorClass: "aborted", httpStatus: null },
			}),
		]) {
			deepStrictEqual(ledgerUsageCalls([neverSent]), []);
			deepStrictEqual(ledgerUsageCalls([unknown, neverSent]), ledgerUsageCalls([unknown]));
			deepStrictEqual(ledgerCallFailureCounts([unknown, neverSent]), {
				invokedUnknownCalls: 1,
				neverInvokedCalls: 1,
			});
		}
		const { contract: observability, extension } = createObservabilityBundle(
			{ bus: createSafeEventBus() } as DomainContext,
			{ dispatchTrace: false },
		);
		try {
			const entries: SessionEntry[] = [];
			const persistence = createTurnPersistence({
				state: createTurnState(),
				session: {
					append: (turn: TurnInput) => {
						const id = `persisted-${entries.length}`;
						entries.push(assistant(id, "aborted", {}, turn.payload as Record<string, unknown>));
						return { id };
					},
				} as unknown as SessionContract,
				getSettings: () => ({}) as never,
				middlewareToolChoice: {} as MiddlewareToolChoiceControl,
				consumePersistedEcho: () => false,
				removeQueuedMirrorEntry: () => undefined,
				promptCachePayloadForAssistant: () => ({}),
				promptSideTokens: () => 326_637,
				observability,
			});
			persistence.appendAssistantTurn(message);
			persistence.appendAssistantTurn(message);
			// Null usage can carry only the top-level marker; no failure object is required (#434).
			persistence.appendAssistantTurn({ ...message, usage: null, callInvoked: false } as unknown as AgentMessage);
			persistence.appendAssistantTurn({
				...message,
				usage: zeroUsage,
				failure: { invoked: false, stage: "admission", errorClass: "aborted", httpStatus: null },
			} as unknown as AgentMessage);
			strictEqual(entries.length, 3);
			for (const entry of entries) {
				ok("payload" in entry);
				strictEqual((entry.payload as Record<string, unknown>).usage, null);
			}
			strictEqual(observability.snapshot().session.tokens.neverSentCalls, 3);
			strictEqual(observability.snapshot().session.tokens.apiCalls ?? 0, 0);
			strictEqual(observability.snapshot().session.cost.calls, 0);
			deepStrictEqual(observability.costEntries(), []);
			for (let resume = 0; resume < 2; resume += 1) {
				reseedSessionUsageFromLedger(observability, [unknown, ...entries]);
				const snapshot = observability.snapshot();
				strictEqual(snapshot.session.tokens.neverSentCalls, 3);
				strictEqual(snapshot.session.tokens.missingTokenCalls, 1);
				strictEqual(snapshot.session.tokens.apiCalls, 1);
				strictEqual(snapshot.session.tokens.totalTokens, 0);
				strictEqual(snapshot.session.cost.calls, 1);
			}
			reseedSessionUsageFromLedger(observability, []);
			strictEqual(observability.snapshot().session.tokens.neverSentCalls ?? 0, 0);
		} finally {
			await extension.stop?.();
		}
	});

	it("resolves model, fallback, explicit, and served-window output budgets", () => {
		type Model = Parameters<typeof remainingContextMaxTokens>[0];
		type Context = Parameters<typeof remainingContextMaxTokens>[1];
		const model = { contextWindow: 262_144, maxTokens: 131_072 } as Model;
		const unknownCap = { contextWindow: 262_144, maxTokens: 0 } as Model;
		const servedWindowModel = { contextWindow: 131_072, maxTokens: 131_072 } as Model;
		const empty = { systemPrompt: "", messages: [], tools: [] } as unknown as Context;
		const loaded = { systemPrompt: "x".repeat(480_000), messages: [], tools: [] } as unknown as Context;

		setGlobalDefaultMaxOutputTokens(0);
		strictEqual(remainingContextMaxTokens(model, empty, undefined), 131_072);
		strictEqual(remainingContextMaxTokens(unknownCap, empty, undefined), 32_768);
		setGlobalDefaultMaxOutputTokens(8_192);
		strictEqual(remainingContextMaxTokens(model, empty, undefined), 8_192);
		strictEqual(remainingContextMaxTokens(model, empty, { maxTokens: 4_096 }), 4_096);
		setGlobalDefaultMaxOutputTokens(32_768);
		strictEqual(remainingContextMaxTokens(servedWindowModel, loaded, undefined), 6_976);
		// Masking and eviction stamp the last assistant usage stale. The ceiling sizes input from the
		// transcript, so that anchor must not shrink it.
		const masked = {
			systemPrompt: "",
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					stopReason: "stop",
					timestamp: 1,
					usage: { totalTokens: 120_000 },
					contextUsageInvalidated: true,
				},
			],
			tools: [],
		} as unknown as Context;
		strictEqual(remainingContextMaxTokens(servedWindowModel, masked, undefined), 32_768);
	});

	it("reserves the configured response allowance rather than compacting a fitting first request", () => {
		setGlobalDefaultMaxOutputTokens(1_024);
		const model = { contextWindow: 32_768, maxTokens: 32_768 };
		const context = { systemPrompt: "x".repeat(40_736), messages: [], tools: [] };
		const reserved = resolveReservedOutputTokens(model.maxTokens);
		strictEqual(reserved, 1_024);
		strictEqual(remainingContextMaxTokens(model, context, undefined), reserved);
		ok(10_184 + reserved < model.contextWindow);
	});

	it("bounds a full-window output ceiling exactly like the local wire adapters", () => {
		setGlobalDefaultMaxOutputTokens(131_072);
		const context = { systemPrompt: "x".repeat(11_890 * 4), messages: [], tools: [] };
		const model = { contextWindow: 131_072, maxTokens: 131_072 };
		for (const api of ["openai-completions", "ollama-native"]) {
			const reserved = resolveReservedOutputTokens(model.maxTokens, {
				api,
				contextWindow: model.contextWindow,
				inputTokens: 11_890,
			});
			strictEqual(reserved, 115_086);
			strictEqual(reserved, remainingContextMaxTokens(model, context, undefined));
			ok(11_890 + reserved < model.contextWindow);
			strictEqual(
				resolveReservedOutputTokens(4096, { api, contextWindow: model.contextWindow, inputTokens: 11_890 }),
				4096,
			);
			strictEqual(
				resolveReservedOutputTokens(model.maxTokens, {
					api,
					contextWindow: model.contextWindow,
					inputTokens: model.contextWindow + 1,
				}),
				1,
			);
		}
		strictEqual(
			resolveReservedOutputTokens(model.maxTokens, {
				api: "anthropic-messages",
				contextWindow: model.contextWindow,
				inputTokens: 11_890,
			}),
			131_072,
		);
	});

	it("respects configured larger reservations, model caps, and unset fallbacks", () => {
		setGlobalDefaultMaxOutputTokens(65_536);
		strictEqual(resolveReservedOutputTokens(131_072), 65_536);
		strictEqual(resolveReservedOutputTokens(4_096), 4_096);
		strictEqual(resolveReservedOutputTokens(null), 65_536);
		setGlobalDefaultMaxOutputTokens(0);
		strictEqual(resolveReservedOutputTokens(131_072), 32_768);
		strictEqual(resolveReservedOutputTokens(4_096), 4_096);
		strictEqual(resolveReservedOutputTokens(null), 32_768);
	});

	it("reseeds reported spend including aborted calls, with missing-call coverage for placeholders and estimates", () => {
		let resets = 0;
		const recorded: Array<{ provider: string; model: string; tokens: number; missing: number }> = [];
		const completed = {
			input: 100,
			output: 20,
			cacheRead: 30,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { total: 0.1 },
		};
		reseedSessionUsageFromLedger(
			{
				resetSession: () => {
					resets += 1;
				},
				recordTokens: (provider, model, tokens, _cost, breakdown) =>
					recorded.push({ provider, model, tokens, missing: breakdown?.missingTokenCalls ?? 0 }),
			},
			[
				assistant("unobserved", "aborted", {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { total: 0 },
				}),
				assistant("aborted", "aborted", completed, { provider: "llamacpp", responseModel: "model-a" }),
				assistant(
					"estimated",
					"aborted",
					{ ...completed, estimated: true },
					{ provider: "llamacpp", responseModel: "model-a" },
				),
				assistant("complete", "stop", completed, { provider: "llamacpp", responseModel: "model-a" }),
			],
			{ target: "local-cluster", model: "model-a" },
		);

		strictEqual(resets, 1);
		deepStrictEqual(recorded, [
			{ provider: "local-cluster", model: "model-a", tokens: 0, missing: 1 },
			{ provider: "local-cluster", model: "model-a", tokens: 150, missing: 0 },
			{ provider: "local-cluster", model: "model-a", tokens: 0, missing: 1 },
			{ provider: "local-cluster", model: "model-a", tokens: 150, missing: 0 },
		]);
	});
});

describe("canonical monetary presentation (#434)", () => {
	it("rejects local dollar formatting while allowing time, counts and canonical rendering", () => {
		for (const source of [
			"const label = `$${value.toFixed(2)}`;",
			"const label = costUsd.toLocaleString();",
			'const label = "$0.00";',
			'const label = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });',
		])
			ok(checkCostRendering("src/example.ts", source).some((line) => line.startsWith("rule10:")));
		deepStrictEqual(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: source fixture for the monetary boundary (#434).
			checkCostRendering("src/example.ts", "const label = `${elapsed.toFixed(2)}s ${renderCostAggregate(cost)}`;"),
			[],
		);
		deepStrictEqual(runBoundaryCheck(process.cwd()).violations, []);
	});

	it("rejects a surface that sums a token or cost field, including a field-by-field merge under a computed key", () => {
		for (const source of [
			"function show(rows) { let tokens = 0; for (const row of rows) tokens += row.tokens; return tokens; }",
			"const total = rows.reduce((sum, row) => sum + row.usage.input, 0);",
			"for (const [key] of FIELDS) totals[key] = (totals[key] ?? 0) + (receipt[key] ?? 0);",
		])
			ok(checkSurfaceTotals("src/interactive/example.ts", source).some((line) => line.startsWith("rule14:")));
		deepStrictEqual(
			checkSurfaceTotals(
				"src/interactive/example.ts",
				'let input = ""; for (const chunk of chunks) input += chunk; counts[name] = (counts[name] ?? 0) + 1;',
			),
			[],
		);
		deepStrictEqual(checkSurfaceTotals("src/domains/example.ts", "tokens += row.tokens;"), []);
	});
});
