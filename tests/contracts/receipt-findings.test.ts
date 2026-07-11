import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	computeReceiptFindingsSummary,
	deriveReceiptVerification,
	readReceiptVerification,
} from "../../src/domains/dispatch/receipt-findings.js";
import type { RunEnvelope, RunLineage, RunReceiptDraft, ToolCallStat } from "../../src/domains/dispatch/types.js";

function lineage(attempt: number): RunLineage {
	return {
		parentRunId: attempt === 0 ? null : "run-root",
		rootRunId: "run-root",
		attempt,
		depth: attempt,
	};
}

function envelope(partial: Partial<RunEnvelope> = {}): RunEnvelope {
	return {
		id: "run-root",
		agentId: "coder",
		task: "validate the change",
		targetId: "local",
		wireModelId: "model-a",
		runtimeId: "runtime-a",
		runtimeKind: "subprocess",
		startedAt: "2026-06-25T12:00:00.000Z",
		endedAt: "2026-06-25T12:00:05.000Z",
		status: "completed",
		outcome: "succeeded",
		outcomeDetail: null,
		lineage: lineage(0),
		exitCode: 0,
		pid: null,
		heartbeatAt: null,
		receiptPath: null,
		sessionId: "session-1",
		cwd: "/workspace",
		tokenCount: 42,
		reasoningTokenCount: 0,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		staticShellHash: null,
		sessionShellHash: null,
		dynamicHash: null,
		costUsd: 0.01,
		...partial,
	};
}

function toolStat(partial: Partial<ToolCallStat> & Pick<ToolCallStat, "tool">): ToolCallStat {
	return {
		count: 1,
		ok: 1,
		errors: 0,
		blocked: 0,
		totalDurationMs: 25,
		...partial,
	};
}

function draft(partial: Partial<RunReceiptDraft> = {}): RunReceiptDraft {
	return {
		runId: "run-root",
		agentId: "coder",
		task: "validate the change",
		targetId: "local",
		wireModelId: "model-a",
		runtimeId: "runtime-a",
		runtimeKind: "subprocess",
		startedAt: "2026-06-25T12:00:00.000Z",
		endedAt: "2026-06-25T12:00:05.000Z",
		outcome: "succeeded",
		outcomeDetail: null,
		lineage: lineage(0),
		exitCode: 0,
		tokenCount: 42,
		inputTokenCount: 20,
		outputTokenCount: 22,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		costUsd: 0.01,
		compiledPromptHash: null,
		staticCompositionHash: null,
		staticShellHash: null,
		sessionShellHash: null,
		dynamicHash: null,
		clioVersion: "0.2.7-test",
		piMonoVersion: "0.79.1",
		platform: "linux",
		nodeVersion: "v22.19.0",
		toolCalls: 0,
		toolStats: [],
		sessionId: "session-1",
		...partial,
	};
}

describe("contracts/receipt findings summary", () => {
	it("derives evidence confidence without changing execution outcome semantics", () => {
		deepStrictEqual(deriveReceiptVerification(draft({ toolStats: [toolStat({ tool: "pytest" })] })), {
			state: "verified",
			basis: "validation-tool",
		});
		deepStrictEqual(deriveReceiptVerification(draft(), { capabilityClass: "read-only" }), {
			state: "not_applicable",
			basis: "read-only-agent",
		});
		deepStrictEqual(deriveReceiptVerification(draft(), { acpDelegation: true }), {
			state: "unknown",
			basis: "acp-external-unobserved",
		});
		deepStrictEqual(deriveReceiptVerification(draft()), {
			state: "unverified",
			basis: "no-validation-tool",
		});
	});

	it("prefers observed validation over ACP uncertainty", () => {
		deepStrictEqual(
			deriveReceiptVerification(draft({ toolStats: [toolStat({ tool: "verify" })] }), { acpDelegation: true }),
			{ state: "verified", basis: "validation-tool" },
		);
	});

	it("reads a missing legacy verification field as unknown, never verified", () => {
		deepStrictEqual(readReceiptVerification(draft()), { state: "unknown", basis: "legacy-receipt" });
		deepStrictEqual(readReceiptVerification(draft({ verification: { state: "verified", basis: "validation-tool" } })), {
			state: "verified",
			basis: "validation-tool",
		});
	});

	it("does not mark a succeeded first attempt as first-pass without validation evidence", () => {
		const summary = computeReceiptFindingsSummary(draft({ toolStats: [] }), envelope());

		deepStrictEqual(summary, {
			tags: [],
			firstPassSuccess: false,
			findingCount: 0,
		});
	});

	it("marks a clean first attempt first-pass when receipt stats include validation evidence", () => {
		const summary = computeReceiptFindingsSummary(draft({ toolStats: [toolStat({ tool: "pytest" })] }), envelope());

		deepStrictEqual(summary, {
			tags: [],
			firstPassSuccess: true,
			findingCount: 0,
		});
	});

	it("uses envelope retry lineage when a receipt draft omits lineage", () => {
		const { lineage: _omitted, ...draftWithoutLineage } = draft({ toolStats: [toolStat({ tool: "pytest" })] });
		const summary = computeReceiptFindingsSummary(draftWithoutLineage, envelope({ lineage: lineage(1) }));

		strictEqual(summary.firstPassSuccess, false);
	});

	it("keeps validation failures out of first-pass and records the failure cause", () => {
		const summary = computeReceiptFindingsSummary(
			draft({
				exitCode: 1,
				outcome: "failed",
				toolStats: [toolStat({ tool: "pytest", ok: 0, errors: 1 })],
			}),
			envelope({ exitCode: 1, outcome: "failed" }),
		);

		deepStrictEqual(summary, {
			tags: ["test-failure"],
			firstPassSuccess: false,
			findingCount: 1,
		});
	});
});
