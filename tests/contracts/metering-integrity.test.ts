import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { projectDispatchJsonEvent } from "../../src/cli/modes/json-stream.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import { messageUsageForAccounting, rememberMessageCalls } from "../../src/core/message-accounting.js";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import type { CallSettled } from "../../src/core/telemetry/schemas.js";
import type { MiddlewareToolChoiceControl } from "../../src/domains/middleware/index.js";
import type { SessionContract, TurnInput } from "../../src/domains/session/contract.js";
import type { SessionEntry } from "../../src/domains/session/index.js";
import { callSettlementFromMessage } from "../../src/domains/telemetry/call-facts.js";
import { callCoverageForRun, createCostTracker, renderCostAggregate } from "../../src/domains/telemetry/cost.js";
import { createTelemetryBundle } from "../../src/domains/telemetry/extension.js";
import {
	remainingContextMaxTokens,
	resolveReservedOutputTokens,
	setGlobalDefaultMaxOutputTokens,
} from "../../src/engine/apis/output-budget.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { reseedSessionUsageFromLedger } from "../../src/interactive/session-usage-reseed.js";
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
	checkLedgerUsageKeys,
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
			strictEqual((message as unknown as { usage: unknown }).usage, zeroUsage);
		}
	});

	it("keeps provider usage immutable while accounting reads separate annotations", () => {
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
		// Nor does a ledger payload gain a usage-shaped key beside the provider's own usage (#434 §5.1).
		for (const source of [
			"payload.estimatedUsage = estimate;",
			'payload["costUsd"] = 0.25;',
			'session.append({ kind: "message", payload: { text, inputTokens: 3 } });',
			"Object.assign(payload, { callAccounting });",
			'for (const key of ["usage", "callAccounting"]) if (raw[key] !== undefined) payload[key] = raw[key];',
		])
			strictEqual(checkLedgerUsageKeys("src/session-control/example.ts", source).length, 1, source);
		deepStrictEqual(
			checkLedgerUsageKeys(
				"src/session-control/example.ts",
				'for (const key of ["usage", "callId"]) payload[key] = raw[key]; payload.apiMs = 3;',
			),
			[],
		);
		deepStrictEqual(checkLedgerUsageKeys("src/domains/dispatch/example.ts", "payload.estimatedUsage = estimate;"), []);
		const file = "src/session-control/chat-loop-messages.ts";
		const copyList = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
		deepStrictEqual(checkLedgerUsageKeys(file, copyList), []);
		strictEqual(
			checkLedgerUsageKeys(file, copyList.replace('"callInvoked",', '"callInvoked",\n\t\t"estimatedUsage",')).length,
			1,
			"re-adding the estimate to assistantSessionPayload's copy list",
		);
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
		const { contract: telemetry, extension } = createTelemetryBundle({ bus: createTelemetryHub() } as DomainContext);
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
				telemetry,
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
			strictEqual(telemetry.snapshot().session.tokens.neverSentCalls, 3);
			strictEqual(telemetry.snapshot().session.tokens.apiCalls ?? 0, 0);
			strictEqual(telemetry.snapshot().session.cost.calls, 0);
			deepStrictEqual(telemetry.costEntries(), []);
			reseedSessionUsageFromLedger(telemetry, []);
			strictEqual(telemetry.snapshot().session.tokens.neverSentCalls ?? 0, 0);
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
