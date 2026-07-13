import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	computeReceiptIntegrity,
	RECEIPT_INTEGRITY_FIELD_COVERAGE,
	RUN_RECEIPT_INTEGRITY_VERSION,
	verifyReceiptIntegrity,
	withReceiptIntegrity,
} from "../../src/domains/dispatch/receipt-integrity.js";
import type {
	RunEnvelope,
	RunReceipt,
	RunReceiptDraft,
	RunReceiptFindingsSummary,
	RunReceiptIntegrity,
} from "../../src/domains/dispatch/types.js";

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`fixture field missing: ${label}`);
	return value;
}

function fixtureEnvelope(runId = "run-1"): RunEnvelope {
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
		inputTokenCount: 20,
		outputTokenCount: 22,
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

describe("contracts/receipt-integrity", () => {
	it("seals a receipt with a findings summary and round-trips verification", () => {
		const envelope = fixtureEnvelope();
		const draft: RunReceiptDraft = { ...fixtureReceiptDraft(envelope), findingsSummary: sampleSummary };
		const receipt = withReceiptIntegrity(draft, envelope);

		strictEqual(receipt.integrity.version, RUN_RECEIPT_INTEGRITY_VERSION);
		deepStrictEqual(receipt.findingsSummary, sampleSummary);
		deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
	});

	it("integrity-covers the worker_final_output_missing outcome code", () => {
		const envelope: RunEnvelope = {
			...fixtureEnvelope("run-final-output-missing"),
			outcome: "failed",
			outcomeCode: "worker_final_output_missing",
		};
		const receipt = withReceiptIntegrity(
			{
				...fixtureReceiptDraft(envelope),
				outcome: "failed",
				outcomeCode: "worker_final_output_missing",
			},
			envelope,
		);
		deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
		strictEqual(verifyReceiptIntegrity({ ...receipt, outcomeCode: null }, envelope).ok, false);
		strictEqual(verifyReceiptIntegrity(receipt, { ...envelope, outcomeCode: null }).ok, false);
	});

	it("rejects receipts sealed under retired integrity versions", () => {
		const envelope = fixtureEnvelope("run-retired-version");
		const draft = fixtureReceiptDraft(envelope);
		const current = computeReceiptIntegrity(draft, envelope);

		for (const version of [1, 2, 3, 7]) {
			const integrity = { ...current, version } as unknown as RunReceiptIntegrity;
			const receipt: RunReceipt = { ...draft, integrity };
			deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: false, reason: "integrity invalid" });
		}
	});

	it("verifies a genuine historical v4 digest through the frozen v4 path", () => {
		const envelope: RunEnvelope = {
			id: "legacy-v4-run",
			agentId: "coder",
			task: "historical v4",
			targetId: "local",
			wireModelId: "model-a",
			runtimeId: "openai",
			runtimeKind: "http",
			startedAt: "2026-07-01T00:00:00.000Z",
			endedAt: "2026-07-01T00:00:01.000Z",
			status: "completed",
			outcome: "succeeded",
			outcomeDetail: null,
			exitCode: 0,
			pid: null,
			heartbeatAt: null,
			receiptPath: null,
			sessionId: null,
			cwd: "/workspace",
			tokenCount: 3,
			inputTokenCount: 2,
			outputTokenCount: 1,
			cacheReadTokenCount: 0,
			cacheWriteTokenCount: 0,
			reasoningTokenCount: 0,
			staticShellHash: null,
			sessionShellHash: null,
			dynamicHash: null,
			costUsd: 0,
		};
		const draft: RunReceiptDraft = {
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
			tokenCount: 3,
			inputTokenCount: 2,
			outputTokenCount: 1,
			cacheReadTokenCount: 0,
			cacheWriteTokenCount: 0,
			reasoningTokenCount: 0,
			costUsd: 0,
			compiledPromptHash: null,
			staticCompositionHash: null,
			staticShellHash: null,
			sessionShellHash: null,
			dynamicHash: null,
			clioVersion: "0.2.8",
			piMonoVersion: "0.80.3",
			platform: "linux",
			nodeVersion: "v22.19.0",
			toolCalls: 0,
			toolStats: [],
			sessionId: null,
		};
		const receipt: RunReceipt = {
			...draft,
			integrity: {
				version: 4,
				algorithm: "sha256",
				digest: "d3d3f9258807a23b0b895bd540aaefe4297bbe4dbbd2cc3ca10997f112ded052",
			},
		};
		deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
		const injectedValues: ReadonlyArray<["briefing" | "outcomeCode" | "steering", unknown]> = [
			["briefing", { bytes: 1, contentHash: "f".repeat(64) }],
			["briefing", null],
			["briefing", undefined],
			["outcomeCode", "worker_tool_call_cap_exhausted"],
			["outcomeCode", null],
			["outcomeCode", undefined],
			["steering", null],
			["steering", undefined],
			["steering", []],
			[
				"steering",
				[
					{
						sequence: 1,
						bytes: 5,
						contentHash: "e".repeat(64),
						sentAt: "2026-07-10T00:00:00.500Z",
						acknowledged: false,
					},
				],
			],
		];
		for (const [field, value] of injectedValues) {
			const injectedReceipt = Object.assign({}, receipt, { [field]: value }) as RunReceipt;
			strictEqual(verifyReceiptIntegrity(injectedReceipt, envelope).ok, false, `receipt own ${field} must fail`);
			const injectedLedger = Object.assign({}, envelope, { [field]: value }) as RunEnvelope;
			strictEqual(verifyReceiptIntegrity(receipt, injectedLedger).ok, false, `ledger own ${field} must fail`);
		}
	});

	it("verifies a genuine historical v5 digest and rejects injected v6 steering", () => {
		const envelope: RunEnvelope = {
			id: "legacy-v5-run",
			agentId: "coder",
			task: "historical v5",
			targetId: "local",
			wireModelId: "model-a",
			runtimeId: "openai",
			runtimeKind: "http",
			startedAt: "2026-07-10T00:00:00.000Z",
			endedAt: "2026-07-10T00:00:01.000Z",
			status: "completed",
			outcome: "succeeded",
			outcomeDetail: null,
			outcomeCode: null,
			exitCode: 0,
			pid: null,
			heartbeatAt: null,
			receiptPath: null,
			sessionId: null,
			cwd: "/workspace",
			tokenCount: 3,
			inputTokenCount: 2,
			outputTokenCount: 1,
			cacheReadTokenCount: 0,
			cacheWriteTokenCount: 0,
			reasoningTokenCount: 0,
			staticShellHash: null,
			sessionShellHash: null,
			dynamicHash: null,
			costUsd: 0,
		};
		const draft: RunReceiptDraft = {
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
			outcomeCode: null,
			exitCode: 0,
			tokenCount: 3,
			inputTokenCount: 2,
			outputTokenCount: 1,
			cacheReadTokenCount: 0,
			cacheWriteTokenCount: 0,
			reasoningTokenCount: 0,
			costUsd: 0,
			compiledPromptHash: null,
			staticCompositionHash: null,
			staticShellHash: null,
			sessionShellHash: null,
			dynamicHash: null,
			clioVersion: "0.2.8",
			piMonoVersion: "0.80.3",
			platform: "linux",
			nodeVersion: "v22.19.0",
			toolCalls: 0,
			toolStats: [],
			sessionId: null,
		};
		const receipt: RunReceipt = {
			...draft,
			integrity: {
				version: 5,
				algorithm: "sha256",
				digest: "9b6cd563e45af706527adf80c502223ba9f7be08f6a0fb6b1d39eb1d76aa4b99",
			},
		};
		deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });

		const injectedValues: ReadonlyArray<unknown> = [
			null,
			undefined,
			[],
			[
				{
					sequence: 1,
					bytes: 5,
					contentHash: "e".repeat(64),
					sentAt: "2026-07-10T00:00:00.500Z",
					acknowledged: false,
				},
			],
		];
		for (const value of injectedValues) {
			const injectedReceipt = Object.assign({}, receipt, { steering: value }) as RunReceipt;
			deepStrictEqual(verifyReceiptIntegrity(injectedReceipt, envelope), {
				ok: false,
				reason: "integrity invalid: v5 contains unauthenticated steering",
			});
			const injectedLedger = Object.assign({}, envelope, { steering: value }) as RunEnvelope;
			deepStrictEqual(verifyReceiptIntegrity(receipt, injectedLedger), {
				ok: false,
				reason: "integrity invalid: v5 contains unauthenticated steering",
			});
		}
	});

	it("detects mutation of every current receipt provenance field", () => {
		const envelope: RunEnvelope = {
			...fixtureEnvelope("run-all-fields"),
			agentAudience: "base",
			requestOrigin: "user",
			lineage: { parentRunId: null, rootRunId: "run-all-fields", attempt: 0, depth: 0 },
			identity: { host: "host", user: "user", hpc: null },
			node: { id: "node-a", kind: "ssh", host: "node-a.example" },
			reroutes: [{ attempt: 1, fromNode: "node-b", toNode: "node-a", reason: "node unavailable" }],
			pipeline: { fromRunId: "upstream", position: 2, inputBytes: 12, inputTruncated: false },
			gate: {
				role: "reviewer",
				group: "gate-1",
				cycle: 1,
				subjects: [{ runId: "builder", digest: "a".repeat(64) }],
			},
			plan: {
				hash: "b".repeat(64),
				topology: "parallel",
				taskCount: 2,
				approval: "operator",
				costCeilingUsd: 1.5,
			},
			personaOverride: { promptHash: "c".repeat(64) },
			briefing: { bytes: 12, contentHash: "9".repeat(64) },
			steering: [
				{
					sequence: 1,
					bytes: 12,
					contentHash: "8".repeat(64),
					sentAt: "2026-06-25T12:00:02.000Z",
					acknowledged: true,
					acknowledgedAt: "2026-06-25T12:00:02.100Z",
				},
			],
			outcomeCode: "worker_tool_call_cap_exhausted",
			promptSignature: "prompt-signature",
			toolSignature: "tool-signature",
		};
		const draft: RunReceiptDraft = {
			...fixtureReceiptDraft(envelope),
			agentAudience: required(envelope.agentAudience, "agentAudience"),
			requestOrigin: required(envelope.requestOrigin, "requestOrigin"),
			lineage: required(envelope.lineage, "lineage"),
			identity: required(envelope.identity, "identity"),
			node: required(envelope.node, "node"),
			reroutes: required(envelope.reroutes, "reroutes"),
			pipeline: required(envelope.pipeline, "pipeline"),
			gate: required(envelope.gate, "gate"),
			plan: required(envelope.plan, "plan"),
			personaOverride: required(envelope.personaOverride, "personaOverride"),
			briefing: required(envelope.briefing, "briefing"),
			steering: required(envelope.steering, "steering"),
			outcomeCode: required(envelope.outcomeCode, "outcomeCode"),
			projectContext: {
				tier: "bounded",
				chars: 120,
				contentHash: "d".repeat(64),
				sections: ["verification-expectations"],
			},
			failureMessage: "diagnostic retained for evidence",
			costProvenance: "known",
			upstreamResponses: [{ model: "model-a", responseModel: "model-a-2026", responseId: "response-1" }],
			output: { state: "final", text: "the durable final answer", bytes: 24, truncated: false },
			promptSignature: required(envelope.promptSignature, "promptSignature"),
			toolSignature: required(envelope.toolSignature, "toolSignature"),
			toolStats: [{ tool: "read", count: 1, ok: 1, errors: 0, blocked: 0, totalDurationMs: 3 }],
			toolActivity: { calls: 1, succeeded: 1, failed: 0, blocked: 0, mutatingSucceeded: false },
			verification: { state: "verified", basis: "validation-tool" },
			skillActivations: [
				{
					name: "test-skill",
					filePath: "/skills/test/SKILL.md",
					hash: "e".repeat(64),
					source: "test",
					sourceOrigin: "test:fixture",
					drift: "match",
					triggeredBy: "tool",
					turnId: "turn-1",
					runId: envelope.id,
				},
			],
			autonomyEnforcement: {
				grade: "mediated",
				autonomy: "auto-edit",
				externalMode: "default",
				dangerousBypass: false,
			},
			safety: {
				decisions: { allowed: 1, blocked: 0, permissionRequested: 0 },
				blockedAttempts: [],
				requestedActions: ["observe"],
				toolProfile: "full-agent",
				runtimeLimitations: [],
			},
			reproducibility: {
				cwd: envelope.cwd,
				git: { branch: "main", commit: "f".repeat(40), dirty: false, dirtyEntries: 0, statusHash: "0".repeat(64) },
				safetyPolicy: {
					version: 1,
					rulePackHash: "1".repeat(64),
					rulePackVersion: 1,
					projectPolicyPath: "/workspace/.clio/safety.yaml",
					projectPolicyHash: "2".repeat(64),
					projectPolicyValid: true,
				},
			},
			runtimeResolution: {
				targetId: "local",
				runtimeId: "openai",
				runtimeKind: "http",
				apiFamily: "openai-responses",
				auth: "api-key",
				authRequired: true,
				wireModelId: "model-a",
				requestedThinkingLevel: "medium",
				effectiveThinkingLevel: "medium",
				capabilities: {
					chat: true,
					tools: true,
					reasoning: true,
					vision: false,
					streaming: true,
					contextWindow: 128_000,
					maxTokens: 8_192,
				},
				thinking: {
					mechanism: "effort-levels",
					class: "switchable",
					display: "medium",
					supportedLevels: ["off", "low", "medium", "high"],
					budgetEnforcement: "enforced",
					noticeKind: "applied",
					notice: "medium reasoning",
				},
				request: { reasoningEffort: "medium", budgetEnforcement: "enforced" },
				response: { parser: "none", stripTokenizerSentinels: false },
				diagnostics: [],
			},
			delegation: {
				agentConfigId: "acp-agent",
				command: "agent",
				args: ["--stdio"],
				acpSessionId: "acp-session",
				acpProtocolVersion: 1,
				acpAgentName: "Agent",
				acpAgentVersion: "1.0.0",
				agentCapabilities: { tools: true },
				toolCallsRequested: 1,
				toolCallsApproved: 1,
				toolCallsDenied: 0,
				toolGovernance: "clio-policy",
				toolCallLog: [
					{
						callId: "call-1",
						tool: "read",
						arguments: { path: "/workspace/file.ts" },
						decision: "approved",
						durationMs: 1,
						timestamp: envelope.endedAt ?? envelope.startedAt,
					},
				],
			},
			findingsSummary: sampleSummary,
		};
		const receipt = withReceiptIntegrity(draft, envelope);
		deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });

		const mutate = (value: unknown): unknown => {
			if (value === null) return "tampered";
			if (typeof value === "string") return `${value}-tampered`;
			if (typeof value === "number") return value + 1;
			if (typeof value === "boolean") return !value;
			if (Array.isArray(value)) return [...value, "tampered"];
			if (typeof value === "object") return { ...value, tampered: true };
			throw new Error(`unsupported fixture value: ${String(value)}`);
		};

		deepStrictEqual(
			Object.keys(RECEIPT_INTEGRITY_FIELD_COVERAGE).sort(),
			Object.keys(draft).sort(),
			"the all-fields fixture and compile-time coverage table must stay complete together",
		);
		for (const field of Object.keys(draft) as Array<keyof RunReceiptDraft>) {
			const tampered = { ...receipt, [field]: mutate(draft[field]) } as unknown as RunReceipt;
			strictEqual(verifyReceiptIntegrity(tampered, envelope).ok, false, `expected ${field} mutation to fail`);
		}

		strictEqual(
			verifyReceiptIntegrity(receipt, { ...envelope, briefing: { bytes: 13, contentHash: "9".repeat(64) } }).ok,
			false,
		);
		strictEqual(verifyReceiptIntegrity(receipt, { ...envelope, outcomeCode: null }).ok, false);
		strictEqual(verifyReceiptIntegrity(receipt, { ...envelope, steering: [] }).ok, false);
	});

	it("integrity-covers every steering provenance value and its ledger copy", () => {
		const steering = [
			{
				sequence: 1,
				bytes: 13,
				contentHash: "a".repeat(64),
				sentAt: "2026-06-25T12:00:02.000Z",
				acknowledged: true,
				acknowledgedAt: "2026-06-25T12:00:02.050Z",
			},
			{
				sequence: 2,
				bytes: 17,
				contentHash: "b".repeat(64),
				sentAt: "2026-06-25T12:00:03.000Z",
				acknowledged: false,
			},
		] as const;
		const envelope: RunEnvelope = { ...fixtureEnvelope("run-steering-tamper"), steering };
		const receipt = withReceiptIntegrity({ ...fixtureReceiptDraft(envelope), steering }, envelope);
		deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });

		const first = steering[0];
		const tampers: ReadonlyArray<NonNullable<RunReceipt["steering"]>> = [
			[{ ...first, sequence: 9 }, steering[1]],
			[{ ...first, bytes: 99 }, steering[1]],
			[{ ...first, contentHash: "c".repeat(64) }, steering[1]],
			[{ ...first, sentAt: "2026-06-25T12:00:04.000Z" }, steering[1]],
			[{ ...first, acknowledged: false }, steering[1]],
			[{ ...first, acknowledgedAt: "2026-06-25T12:00:05.000Z" }, steering[1]],
		];
		for (const tampered of tampers) {
			strictEqual(verifyReceiptIntegrity({ ...receipt, steering: tampered }, envelope).ok, false);
			strictEqual(verifyReceiptIntegrity(receipt, { ...envelope, steering: tampered }).ok, false);
		}
	});

	it("detects tampering with every durable output field on a sealed receipt", () => {
		const envelope = fixtureEnvelope("run-output-tamper");
		const draft: RunReceiptDraft = {
			...fixtureReceiptDraft(envelope),
			output: { state: "final", text: "authentic answer", bytes: 16, truncated: false },
		};
		const receipt = withReceiptIntegrity(draft, envelope);
		deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });

		const tampers: Array<NonNullable<RunReceipt["output"]>> = [
			{ state: "final", text: "forged answer", bytes: 16, truncated: false },
			{ state: "partial", text: "authentic answer", bytes: 16, truncated: false },
			{ state: "final", text: "authentic answer", bytes: 99, truncated: false },
			{ state: "final", text: "authentic answer", bytes: 16, truncated: true },
		];
		for (const output of tampers) {
			deepStrictEqual(
				verifyReceiptIntegrity({ ...receipt, output }, envelope),
				{ ok: false, reason: "integrity mismatch" },
				`expected output tamper to fail: ${JSON.stringify(output)}`,
			);
		}
		// Dropping the output entirely must also break the digest.
		const { output: _output, ...withoutOutput } = receipt;
		deepStrictEqual(verifyReceiptIntegrity(withoutOutput as RunReceipt, envelope), {
			ok: false,
			reason: "integrity mismatch",
		});
	});

	it("detects tampering with the findings summary on a sealed receipt", () => {
		const envelope = fixtureEnvelope("run-tamper");
		const draft: RunReceiptDraft = {
			...fixtureReceiptDraft(envelope),
			findingsSummary: { tags: ["test-failure"], firstPassSuccess: false, findingCount: 1 },
		};
		const receipt = withReceiptIntegrity(draft, envelope);
		deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });

		const tampered: RunReceipt = {
			...receipt,
			findingsSummary: { ...sampleSummary, firstPassSuccess: true },
		};
		deepStrictEqual(verifyReceiptIntegrity(tampered, envelope), { ok: false, reason: "integrity mismatch" });
	});

	it("detects tampering with autonomy enforcement on a sealed receipt", () => {
		const envelope = fixtureEnvelope("run-autonomy-enforcement");
		const draft: RunReceiptDraft = {
			...fixtureReceiptDraft(envelope),
			autonomyEnforcement: {
				grade: "bypassed",
				autonomy: "full-auto",
				externalMode: "bypassPermissions",
				dangerousBypass: true,
			},
		};
		const receipt = withReceiptIntegrity(draft, envelope);
		deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });

		const tampered: RunReceipt = {
			...receipt,
			autonomyEnforcement: {
				grade: "bypassed",
				autonomy: "full-auto",
				externalMode: "bypassPermissions",
				dangerousBypass: false,
			},
		};
		deepStrictEqual(verifyReceiptIntegrity(tampered, envelope), { ok: false, reason: "integrity mismatch" });
	});

	it("detects tampering with every findings summary field", () => {
		const envelope = fixtureEnvelope("run-summary-fields");
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
		const envelope = fixtureEnvelope("run-canonical-summary");
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
