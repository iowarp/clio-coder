import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentMessage } from "../../src/engine/types.js";
import { type ReduceContext, reduceStatus, type StatusInputEvent } from "../../src/interactive/status/state-machine.js";
import { buildSummary } from "../../src/interactive/status/summary.js";
import { INITIAL_STATUS } from "../../src/interactive/status/types.js";

// Regression for the v0.2.8 demo session: a loop-guard abort ended a turn that
// had consumed millions of tokens across dozens of tool rounds, yet the footer
// showed "up 0 down 0" and "tools none". run_aborted stamps an empty summary
// immediately (correct: the run has not settled), but the agent_end that
// follows must rebuild the summary from the run's real message window and keep
// the abort provenance run_aborted stamped.

function ctx(now: number): ReduceContext {
	return { now, localRuntime: true, modelId: "m", targetId: "t", runId: "r" };
}

describe("contracts/status aborted runs keep usage and abort provenance", () => {
	it("preserves a provider-reported zero and labels a mixed reasoning total", () => {
		const base = {
			startedAt: 0,
			endedAt: 1,
			modelId: "m",
			targetId: "t",
			watchdogPeak: 0 as const,
			cancelled: false,
		};
		const providerZero = buildSummary({
			...base,
			messages: [
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "provider reported no hidden tokens" }],
					usage: { reasoningTokens: 0 },
				},
			] as unknown as ReadonlyArray<AgentMessage>,
		});
		strictEqual(providerZero.reasoningTokens, 0);
		strictEqual(providerZero.reasoningTokenProvenance, "provider");

		const mixed = buildSummary({
			...base,
			messages: [
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "provider turn" }],
					usage: { reasoningTokens: 0 },
				},
				{
					role: "assistant",
					content: [{ type: "thinking", thinking: "unreported turn with enough text to estimate" }],
				},
			] as unknown as ReadonlyArray<AgentMessage>,
		});
		strictEqual(mixed.reasoningTokenProvenance, "mixed");
		ok((mixed.reasoningTokens ?? 0) > 0, "the unreported thinking block contributes an estimate");
	});

	it("the settled agent_end after run_aborted carries the run's usage and keeps stopDetail", () => {
		let status = { ...INITIAL_STATUS };
		status = reduceStatus(status, { type: "agent_start", messages: [] } as unknown as StatusInputEvent, ctx(0));
		status = reduceStatus(
			status,
			{ type: "run_aborted", source: "loop_guard", reason: "loop: context repeated 4x" } as StatusInputEvent,
			ctx(120_000),
		);
		strictEqual(status.phase, "ended");
		strictEqual(status.summary?.inputTokens, 0, "the immediate abort summary has no usage yet");
		ok(status.summary?.stopDetail?.includes("loop guard"), "abort provenance is stamped");

		const messages = [
			{
				role: "assistant",
				content: [{ type: "text", text: "gathering" }],
				stopReason: "toolUse",
				usage: { input: 52_000, output: 900, cacheRead: 0, cacheWrite: 0 },
			},
			{ role: "toolResult", isError: false, content: [] },
			{
				role: "assistant",
				content: [],
				stopReason: "aborted",
				errorMessage: "Request was aborted",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		];
		status = reduceStatus(status, { type: "agent_end", messages } as unknown as StatusInputEvent, ctx(146_000));
		strictEqual(status.phase, "ended");
		strictEqual(status.summary?.inputTokens, 52_000, "the run's real input tokens replace the empty abort summary");
		strictEqual(status.summary?.outputTokens, 900);
		strictEqual(status.summary?.toolCount, 1, "tool results in the window are counted");
		strictEqual(status.summary?.stopReason, "aborted");
		ok(status.summary?.stopDetail?.includes("loop guard"), "abort provenance survives the rebuild");
	});

	it("a later notice message_end does not rebuild or wipe the ended usage summary", () => {
		let status = { ...INITIAL_STATUS };
		status = reduceStatus(status, { type: "agent_start", messages: [] } as unknown as StatusInputEvent, ctx(0));

		const messages = [
			{
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				stopReason: "stop",
				usage: { input: 12_345, output: 678, cacheRead: 90, cacheWrite: 0 },
			},
			{ role: "toolResult", isError: false, content: [] },
		];
		status = reduceStatus(status, { type: "agent_end", messages } as unknown as StatusInputEvent, ctx(2_000));
		strictEqual(status.phase, "ended");
		strictEqual(status.summary?.inputTokens, 12_345);
		strictEqual(status.summary?.outputTokens, 678);
		strictEqual(status.summary?.cacheReadTokens, 90);
		strictEqual(status.summary?.toolCount, 1);

		status = reduceStatus(
			status,
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "[Clio Coder] notice after the run" }],
					stopReason: "stop",
				},
			} as unknown as StatusInputEvent,
			ctx(3_000),
		);

		strictEqual(status.phase, "ended");
		strictEqual(status.summary?.inputTokens, 12_345);
		strictEqual(status.summary?.outputTokens, 678);
		strictEqual(status.summary?.cacheReadTokens, 90);
		strictEqual(status.summary?.toolCount, 1);
	});
});
