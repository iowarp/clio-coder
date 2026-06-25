import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	computeReceiptIntegrity,
	RUN_RECEIPT_INTEGRITY_VERSION,
	verifyReceiptIntegrity,
	withReceiptIntegrity,
} from "../../src/domains/dispatch/receipt-integrity.js";
import type {
	RunEnvelope,
	RunReceipt,
	RunReceiptDraft,
	RunReceiptFindingsSummary,
} from "../../src/domains/dispatch/types.js";

function fixtureEnvelope(runId = "run-v3-1"): RunEnvelope {
	return {
		id: runId,
		agentId: "coder",
		task: "run the test suite",
		targetId: "local",
		wireModelId: "model-a",
		runtimeId: "openai",
		runtimeKind: "http",
		startedAt: "2026-06-25T12:00:00.000Z",
		endedAt: "2026-06-25T12:00:05.000Z",
		status: "completed",
		outcome: "succeeded",
		outcomeDetail: null,
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
	};
}

function fixtureReceiptDraft(envelope: RunEnvelope): RunReceiptDraft {
	return {
		runId: envelope.id,
		agentId: envelope.agentId,
		task: envelope.task,
		targetId: envelope.targetId,
		wireModelId: envelope.wireModelId,
		runtimeId: envelope.runtimeId,
		runtimeKind: envelope.runtimeKind,
		startedAt: envelope.startedAt,
		endedAt: envelope.endedAt ?? envelope.startedAt,
		outcome: "succeeded",
		outcomeDetail: null,
		exitCode: 0,
		tokenCount: envelope.tokenCount,
		inputTokenCount: 20,
		outputTokenCount: 22,
		cacheReadTokenCount: 0,
		cacheWriteTokenCount: 0,
		reasoningTokenCount: 0,
		costUsd: envelope.costUsd,
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
		sessionId: envelope.sessionId,
	};
}

const sampleSummary: RunReceiptFindingsSummary = {
	tags: ["test-failure"],
	firstPassSuccess: false,
	findingCount: 1,
};

describe("contracts/receipt-v3-integrity", () => {
	it("seals a v3 receipt with a findings summary and round-trips verification", () => {
		const envelope = fixtureEnvelope();
		const draft: RunReceiptDraft = { ...fixtureReceiptDraft(envelope), findingsSummary: sampleSummary };
		const receipt = withReceiptIntegrity(draft, envelope);

		strictEqual(receipt.integrity.version, 3);
		strictEqual(RUN_RECEIPT_INTEGRITY_VERSION, 3);
		deepStrictEqual(receipt.findingsSummary, sampleSummary);
		deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
	});

	it("verifies a hand-built v2 receipt under the retained v2 branch", () => {
		const envelope = fixtureEnvelope("run-v2-1");
		const draft: RunReceiptDraft = fixtureReceiptDraft(envelope);
		// Compute the digest at v2 explicitly: the v2 branch does not fold
		// findingsSummary, so a v2 receipt has no summary contribution to its digest.
		const v2Receipt: RunReceipt = { ...draft, integrity: computeReceiptIntegrity(draft, envelope, 2) };

		strictEqual(v2Receipt.integrity.version, 2);
		deepStrictEqual(verifyReceiptIntegrity(v2Receipt, envelope), { ok: true });

		// A v3-only field on a v2 receipt is unauthenticated. Reject it instead
		// of presenting a forged summary beside a verified v2 digest.
		const v2WithSummary: RunReceipt = { ...v2Receipt, findingsSummary: sampleSummary };
		deepStrictEqual(verifyReceiptIntegrity(v2WithSummary, envelope), {
			ok: false,
			reason: "v3 findings summary on v2 receipt",
		});
	});

	it("detects tampering with the findings summary on a sealed v3 receipt", () => {
		const envelope = fixtureEnvelope("run-v3-tamper");
		const draft: RunReceiptDraft = {
			...fixtureReceiptDraft(envelope),
			findingsSummary: { tags: ["test-failure"], firstPassSuccess: false, findingCount: 1 },
		};
		const receipt = withReceiptIntegrity(draft, envelope);
		deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });

		// Mutate the summary after hashing; the v3 digest covers it, so verification fails.
		const tampered: RunReceipt = {
			...receipt,
			findingsSummary: { ...sampleSummary, firstPassSuccess: true },
		};
		deepStrictEqual(verifyReceiptIntegrity(tampered, envelope), { ok: false, reason: "integrity mismatch" });
	});

	it("detects tampering with every findings summary field on a v3 receipt", () => {
		const envelope = fixtureEnvelope("run-v3-summary-fields");
		const draft: RunReceiptDraft = {
			...fixtureReceiptDraft(envelope),
			findingsSummary: { tags: ["build-failure", "test-failure"], firstPassSuccess: false, findingCount: 2 },
		};
		const receipt = withReceiptIntegrity(draft, envelope);

		deepStrictEqual(
			verifyReceiptIntegrity(
				{
					...receipt,
					findingsSummary: { tags: ["test-failure", "build-failure"], firstPassSuccess: false, findingCount: 2 },
				},
				envelope,
			),
			{ ok: false, reason: "integrity mismatch" },
		);
		deepStrictEqual(
			verifyReceiptIntegrity(
				{
					...receipt,
					findingsSummary: { tags: ["build-failure", "test-failure"], firstPassSuccess: false, findingCount: 1 },
				},
				envelope,
			),
			{ ok: false, reason: "integrity mismatch" },
		);
	});

	it("canonicalizes findings summary object key order in the digest", () => {
		const envelope = fixtureEnvelope("run-v3-canonical-summary");
		const summaryA: RunReceiptFindingsSummary = {
			tags: ["test-failure"],
			firstPassSuccess: false,
			findingCount: 1,
		};
		const summaryB = JSON.parse(
			'{"findingCount":1,"firstPassSuccess":false,"tags":["test-failure"]}',
		) as RunReceiptFindingsSummary;
		const digestA = computeReceiptIntegrity(
			{ ...fixtureReceiptDraft(envelope), findingsSummary: summaryA },
			envelope,
		).digest;
		const digestB = computeReceiptIntegrity(
			{ ...fixtureReceiptDraft(envelope), findingsSummary: summaryB },
			envelope,
		).digest;

		strictEqual(digestA, digestB);
	});
});
