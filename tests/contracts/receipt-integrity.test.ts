import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	computeReceiptIntegrity,
	RECEIPT_INTEGRITY_FIELD_COVERAGE,
	RUN_RECEIPT_INTEGRITY_VERSION,
	verifyReceiptIntegrity,
	withReceiptIntegrity,
} from "../../src/domains/dispatch/receipt-integrity.js";
import { decideRoute, type RouteCandidate } from "../../src/domains/dispatch/route-decision.js";
import { DEFAULT_ROUTE_PRIOR, estimateRoute } from "../../src/domains/dispatch/route-policy.js";
import type {
	RunEnvelope,
	RunReceipt,
	RunReceiptDraft,
	RunReceiptFindingsSummary,
	RunReceiptIntegrity,
} from "../../src/domains/dispatch/types.js";
import { receiptResponseModelIdObservationLabel } from "../../src/tools/dispatch-event-text.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

function fixtureRouteCandidate(overrides: Partial<RouteCandidate> = {}): RouteCandidate {
	return {
		agentId: "coder",
		specFingerprint: "d".repeat(64),
		executionRole: "builder",
		targetId: "local",
		modelId: "model-a",
		runtimeId: "openai",
		nodeId: "local",
		toolSignature: "e".repeat(64),
		promptCompositionHash: "f".repeat(64),
		endpointIdentityHash: "1".repeat(64),
		settingsFingerprint: "2".repeat(64),
		...overrides,
	};
}

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`fixture field missing: ${label}`);
	return value;
}

const sampleSummary: RunReceiptFindingsSummary = {
	tags: ["test-failure"],
	firstPassSuccess: false,
	findingCount: 1,
};

describe("contracts/receipt-integrity", () => {
	it("renders every response model id observation state with the shared vocabulary", () => {
		strictEqual(
			receiptResponseModelIdObservationLabel({
				upstreamResponses: [
					{
						requestedModelId: "model-a",
						responseModelIdObservation: { state: "reported", reportedModelId: "model-a-2026" },
						differingResponseModelId: "model-a-2026",
						providerResponseId: "response-1",
					},
					{
						requestedModelId: "model-b",
						responseModelIdObservation: { state: "not-reported" },
						differingResponseModelId: null,
						providerResponseId: "response-2",
					},
					{
						requestedModelId: "model-c",
						responseModelIdObservation: { state: "not-observed" },
						differingResponseModelId: null,
						providerResponseId: "response-3",
					},
				],
			}),
			"response_model_id_observation=reported:model-a-2026,not-reported,not-observed",
		);
	});

	it("labels receipt response fields written before #193 as legacy difference-only", () => {
		const historical = {
			upstreamResponses: [{ model: "model-a", responseModel: "peer-model", responseId: "response-1" }],
		} as unknown as Pick<RunReceipt, "upstreamResponses">;
		strictEqual(
			receiptResponseModelIdObservationLabel(historical),
			"response_model_id_observation=legacy-difference-only:peer-model",
		);
	});

	it("keeps evidence verification and round-trips host verification", () => {
		const envelope = fixtureEnvelope();
		const draft: RunReceiptDraft = {
			...fixtureReceiptDraft(envelope),
			findingsSummary: sampleSummary,
			hostVerification: { status: "verified", checks: [] },
		};
		const receipt = withReceiptIntegrity(draft, envelope);

		strictEqual(receipt.integrity.version, RUN_RECEIPT_INTEGRITY_VERSION);
		strictEqual(receipt.verification.state, "unverified");
		deepStrictEqual(receipt.hostVerification, { status: "verified", checks: [] });
		deepStrictEqual(receipt.findingsSummary, sampleSummary);
		deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
	});

	// #104 added rulesApplied / operatorProfileApplied without an integrity
	// version bump: a receipt sealed before the fields existed carries neither
	// and must still verify, because the digest skips absent fields.
	it("verifies a pre-#104 receipt that carries neither rulesApplied nor operatorProfileApplied", () => {
		const envelope = fixtureEnvelope("run-pre-104");
		const receipt = withReceiptIntegrity(fixtureReceiptDraft(envelope), envelope);
		strictEqual("rulesApplied" in receipt || "operatorProfileApplied" in receipt, false);
		deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
	});

	it("requires and integrity-covers the run-local quality block", () => {
		const envelope = fixtureEnvelope("run-quality-required");
		const draft = fixtureReceiptDraft(envelope);
		const receipt = withReceiptIntegrity(draft, envelope);
		deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
		const { quality: _quality, ...withoutQuality } = receipt;
		deepStrictEqual(verifyReceiptIntegrity(withoutQuality as RunReceipt, envelope), {
			ok: false,
			reason: "integrity invalid",
		});
	});

	it("requires and integrity-covers the typed result-contract fact", () => {
		const envelope = fixtureEnvelope("run-result-contract");
		const receipt = withReceiptIntegrity(
			{
				...fixtureReceiptDraft(envelope),
				quality: {
					...fixtureReceiptDraft(envelope).quality,
					resultContract: {
						sourceId: "agent-result-contract:verifier-report:test",
						validatorDigest: "a".repeat(64),
						conformance: "pass",
						quality: "pass",
					},
				},
			},
			envelope,
		);
		strictEqual(
			verifyReceiptIntegrity({ ...receipt, quality: { ...receipt.quality, resultContract: null } }, envelope).ok,
			false,
		);
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
		if (draft.routingIntent === undefined) throw new Error("fixture routing intent missing");

		// Every shape before routing intent became required is rejected, never upgraded.
		for (const version of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]) {
			const integrity = { ...current, version } as unknown as RunReceiptIntegrity;
			const receipt: RunReceipt = { ...draft, routingIntent: draft.routingIntent, integrity };
			deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: false, reason: "integrity invalid" });
		}
	});

	it("requires and integrity-covers the typed execution role", () => {
		const envelope = fixtureEnvelope("run-execution-role");
		const draft = fixtureReceiptDraft(envelope);
		strictEqual(RECEIPT_INTEGRITY_FIELD_COVERAGE.executionRole, true);
		strictEqual(RUN_RECEIPT_INTEGRITY_VERSION, 19);

		const sealed = withReceiptIntegrity(draft, envelope);
		strictEqual(sealed.executionRole, "builder");
		deepStrictEqual(verifyReceiptIntegrity(sealed, envelope), { ok: true });

		// The role is required and typed: an absent or unknown value is not a receipt.
		const { executionRole: _omitted, ...withoutRole } = draft;
		throws(
			() => withReceiptIntegrity(withoutRole as unknown as RunReceiptDraft, envelope),
			/required execution role invalid/,
		);
		throws(
			() => withReceiptIntegrity({ ...draft, executionRole: "auditor" } as unknown as RunReceiptDraft, envelope),
			/required execution role invalid/,
		);
		deepStrictEqual(verifyReceiptIntegrity({ ...sealed, executionRole: "auditor" } as unknown as RunReceipt, envelope), {
			ok: false,
			reason: "execution role invalid",
		});

		// It is digest-covered on both sides and cross-checked against the ledger.
		deepStrictEqual(verifyReceiptIntegrity({ ...sealed, executionRole: "reviewer" }, envelope), {
			ok: false,
			reason: "ledger mismatch: executionRole",
		});
		deepStrictEqual(verifyReceiptIntegrity(sealed, { ...envelope, executionRole: "reviewer" }), {
			ok: false,
			reason: "ledger mismatch: executionRole",
		});
		const reviewerEnvelope: RunEnvelope = { ...envelope, executionRole: "reviewer" };
		const reviewerSealed = withReceiptIntegrity({ ...draft, executionRole: "reviewer" }, reviewerEnvelope);
		deepStrictEqual(verifyReceiptIntegrity(reviewerSealed, reviewerEnvelope), { ok: true });
		// A different role is a different sealed receipt, which is what keeps role
		// statistics from being forgeable after the fact.
		strictEqual(sealed.integrity.digest === reviewerSealed.integrity.digest, false);
	});

	it("detects mutation of every current receipt provenance field", () => {
		const envelope: RunEnvelope = {
			...fixtureEnvelope("run-all-fields"),
			agentAudience: "base",
			requestOrigin: "user",
			budget: {
				version: 1,
				policy: {
					recipeId: "coder",
					default: { toolCalls: 32, readReserve: 5, synthesis: true },
					maximum: { toolCalls: 32, readReserve: 5 },
					exact: true,
				},
				request: null,
				effective: { toolCalls: 32, readReserve: 5, synthesis: true, hardCap: 150 },
				reasons: [],
			},
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
			council: { group: "council-1", label: "alpha", round: 1 },
			plan: {
				hash: "b".repeat(64),
				topology: "parallel",
				taskCount: 2,
				approval: "operator",
				source: null,
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
			budget: required(envelope.budget, "budget"),
			lineage: required(envelope.lineage, "lineage"),
			identity: required(envelope.identity, "identity"),
			node: required(envelope.node, "node"),
			attestation: {
				protocolVersion: 1,
				host: "node-a.example",
				pid: 4242,
				processGroupId: 4242,
				settingsFingerprint: "3".repeat(64),
				specDigest: "4".repeat(64),
				targetId: envelope.targetId,
				endpointIdentityHash: "5".repeat(64),
				wireModelId: envelope.wireModelId,
				runtimeId: envelope.runtimeId,
				toolSignature: "6".repeat(64),
				resources: {
					labels: ["gpu"],
					cpuCount: 8,
					totalMemoryBytes: 17179869184,
					gpuCount: null,
					vramBytes: null,
				},
			},
			reroutes: required(envelope.reroutes, "reroutes"),
			pipeline: required(envelope.pipeline, "pipeline"),
			gate: required(envelope.gate, "gate"),
			council: required(envelope.council, "council"),
			plan: required(envelope.plan, "plan"),
			fleetGate: { path: "tests/acceptance.mjs", pathHash: "7".repeat(64) },
			personaOverride: required(envelope.personaOverride, "personaOverride"),
			briefing: required(envelope.briefing, "briefing"),
			intent: {
				version: 1,
				readRoots: ["src"],
				writeRoots: ["tests"],
				relevantPaths: ["src/domains/dispatch/types.ts"],
				expectedOutputs: ["dist/cli.js"],
				verification: [{ check: "test", timeoutMs: 30_000 }],
			},
			steering: required(envelope.steering, "steering"),
			outcomeCode: required(envelope.outcomeCode, "outcomeCode"),
			projectContext: {
				tier: "bounded",
				chars: 120,
				contentHash: "d".repeat(64),
				sections: ["verification-expectations"],
			},
			rulesApplied: ["typescript.md"],
			operatorProfileApplied: true,
			failureMessage: "diagnostic retained for evidence",
			costProvenance: "known",
			upstreamResponses: [
				{
					requestedModelId: "model-a",
					responseModelIdObservation: { state: "reported", reportedModelId: "model-a-2026" },
					differingResponseModelId: "model-a-2026",
					providerResponseId: "response-1",
				},
			],
			output: { state: "final", text: "the durable final answer", bytes: 24, truncated: false },
			promptSignature: required(envelope.promptSignature, "promptSignature"),
			toolSignature: required(envelope.toolSignature, "toolSignature"),
			toolStats: [{ tool: "read", count: 1, ok: 1, errors: 0, blocked: 0, totalDurationMs: 3 }],
			toolActivity: { calls: 1, succeeded: 1, failed: 0, blocked: 0, mutatingSucceeded: false },
			verification: { state: "verified", basis: "validation-tool" },
			hostVerification: {
				status: "verified",
				checks: [
					{
						check: "test",
						argv: ["npm", "run", "test"],
						cwd: "/workspace",
						exitCode: 0,
						durationMs: 42,
						memo: false,
						outputTail: "pass",
						artifactPath: "/state/artifacts/run/test.log",
					},
				],
			},
			worktree: {
				path: "/workspace/.clio-coder/worktrees/run-all-fields",
				branch: "clio/task/run-all-fields",
				diffHash: "f".repeat(64),
				apply: "merge",
				applied: true,
			},
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
					projectPolicyPath: "/workspace/.clio-coder/safety.yaml",
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
			ledgerContribution: {
				ledgerId: "agent-ledger-1",
				posted: 3,
				refused: 1,
				digest: "7".repeat(64),
			},
			validationGrounding: {
				claimed: 1,
				grounded: 0,
				ungrounded: ["npm run typecheck"],
				basis: "no-command-executed" as const,
			},
			capabilityMismatch: {
				agentId: "verifier",
				capabilityClass: "verification",
				taskType: "debug",
				suggestedAgentId: "coder",
			},
			routeDecision: decideRoute({
				mode: "shadow",
				posture: "balanced",
				executedRoute: fixtureRouteCandidate(),
				candidates: [
					{
						candidate: fixtureRouteCandidate(),
						estimate: estimateRoute([]),
						activeReadiness: { ready: false, gaps: ["insufficient-quality-labels"], labelsNeeded: 6 },
						rejection: null,
					},
					{
						candidate: fixtureRouteCandidate({ targetId: "alt" }),
						estimate: estimateRoute([]),
						activeReadiness: { ready: false, gaps: ["insufficient-quality-labels"], labelsNeeded: 6 },
						rejection: "node-eligibility",
					},
				],
				independenceSubject: null,
				hardConstraints: ["node-eligibility"],
				maxFallbacks: 2,
				decisionDurationMs: 1,
				agentSelection: {
					request: "explicit",
					baselineAgentId: "coder",
					evaluations: [
						{
							agentId: "coder",
							specFingerprint: "d".repeat(64),
							executionRole: "builder",
							authority: "workspace-edit",
							rejections: [],
							coldPrior: DEFAULT_ROUTE_PRIOR,
							priorReasons: [],
						},
					],
					readiness: [
						{
							agentId: "coder",
							specFingerprint: "d".repeat(64),
							executionRole: "builder",
							ready: false,
							candidateCount: 2,
							readyCandidateCount: 0,
							routes: [
								{
									candidate: fixtureRouteCandidate(),
									report: {
										ready: false,
										gaps: ["insufficient-quality-labels"],
										labelsNeeded: 6,
									},
								},
								{
									candidate: fixtureRouteCandidate({ targetId: "alt" }),
									report: {
										ready: false,
										gaps: ["insufficient-quality-labels"],
										labelsNeeded: 6,
									},
								},
							],
						},
					],
					authorityBasis: null,
				},
			}),
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
