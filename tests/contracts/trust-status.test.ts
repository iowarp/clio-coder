import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import type { GateDecisionArtifact } from "../../src/domains/dispatch/gate-decisions.js";
import type { RunReceiptQuality } from "../../src/domains/dispatch/types.js";
import type {
	CanonicalTrustStatus,
	PersistedRunReceiptTrustFacts,
	TrustStatusAxis,
	TrustStatusSourceKind,
} from "../../src/domains/evidence/index.js";
import {
	absentTrustStatus,
	adaptFinishContractCompletionStatus,
	adaptGateDecisionReviewStatus,
	adaptGroundedEvidenceValidationStatus,
	adaptReceiptIntegrityStatus,
	adaptRunReceiptAutonomyStatus,
	adaptRunReceiptContextStatus,
	adaptRunReceiptTrustStatus,
	adaptRunReceiptValidationStatus,
	composeTrustStatus,
	formatTrustAxes,
	formatTrustSummary,
	normalizeTrustStatus,
	projectTrustStatus,
	retiredIntegrityVersionOf,
	retiredReceiptIntegrity,
	TRUST_STATUS_AXES,
	TRUST_STATUS_MAX_ARTIFACT_REFERENCES,
	TRUST_STATUS_STATES,
	TRUST_STATUS_VERSION,
	validateTrustStatus,
} from "../../src/domains/evidence/index.js";
import type { FinishContractAssessment } from "../../src/domains/safety/finish-contract.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

const QUALITY_EMPTY: RunReceiptQuality = {
	version: 1,
	typedValidations: [],
	responseSchema: {
		sourceId: null,
		schemaDigest: null,
		runtimeEnforceable: false,
		enforcementPassed: null,
	},
	resultContract: null,
};

function currentReceipt(overrides: Partial<PersistedRunReceiptTrustFacts> = {}): PersistedRunReceiptTrustFacts {
	return {
		runId: "run-154",
		integrity: { version: 20, algorithm: "sha256", digest: DIGEST_A },
		verification: { state: "verified", basis: "validation-tool" },
		quality: QUALITY_EMPTY,
		projectContext: { tier: "bounded", chars: 240, contentHash: DIGEST_B },
		autonomyEnforcement: { grade: "mediated", autonomy: "auto-edit" },
		...overrides,
	};
}

function rawAggregate(): Record<string, unknown> {
	return {
		version: TRUST_STATUS_VERSION,
		artifactIntegrity: absentTrustStatus("not_recorded"),
		validationGrounding: absentTrustStatus("not_recorded"),
		independentReview: absentTrustStatus("not_recorded"),
		contextProvenance: absentTrustStatus("not_recorded"),
		autonomyEnforcement: absentTrustStatus("not_recorded"),
		completionEvidence: absentTrustStatus("not_recorded"),
	};
}

const AXIS_CASES = {
	artifactIntegrity: {
		source: "receipt_integrity_verification",
		states: ["verified", "failed", "unknown", "not_applicable"],
	},
	validationGrounding: {
		source: "run_receipt",
		states: ["validated", "failed", "ungrounded", "unknown", "not_applicable"],
	},
	independentReview: {
		source: "gate_decision",
		states: ["passed", "failed", "inconclusive", "not_independent", "unknown", "not_applicable"],
	},
	contextProvenance: {
		source: "run_receipt",
		states: ["recorded", "invalid", "unknown", "not_applicable"],
	},
	autonomyEnforcement: {
		source: "run_receipt",
		states: ["enforced", "approximated", "bypassed", "unknown", "not_applicable"],
	},
	completionEvidence: {
		source: "finish_contract",
		states: ["evidenced", "incomplete", "limited", "unknown", "not_applicable"],
	},
} as const satisfies Record<TrustStatusAxis, { source: TrustStatusSourceKind; states: ReadonlyArray<string> }>;

function attributedRaw(state: string, source: TrustStatusSourceKind): Record<string, unknown> {
	return {
		state,
		source: { kind: source, id: `source:${state}` },
		authority: { kind: "clio", id: "contracts" },
		artifacts: [{ kind: "run_receipt", id: "run-154", digest: { algorithm: "sha256", value: DIGEST_A } }],
	};
}

function gateArtifact(
	outcome: GateDecisionArtifact["outcome"],
	options: { independent?: boolean; decider?: boolean; winnerRunId?: string } = {},
): GateDecisionArtifact {
	const hasDecider = options.decider ?? true;
	const subject = { runId: "subject", digest: DIGEST_A };
	return {
		version: 2,
		id: `gate-${outcome}`,
		group: "trust-contract",
		topology:
			outcome === "winner" ||
			outcome === "no-winner" ||
			outcome === "operator-confirmed" ||
			outcome === "full-auto-applied"
				? "compete"
				: "review",
		cycle: 1,
		outcome,
		subjects: [subject, { runId: "other-subject", digest: DIGEST_B }],
		...(hasDecider
			? {
					decider: { runId: "reviewer", digest: DIGEST_C },
					correlation: {
						agent: !(options.independent ?? true),
						target: true,
						modelFamily: false,
						runtime: true,
						node: true,
						independent: options.independent ?? true,
					},
				}
			: {}),
		...(outcome === "winner" || outcome === "operator-confirmed" || outcome === "full-auto-applied"
			? {
					winner: {
						index: options.winnerRunId === "other-subject" ? 2 : 1,
						subject: {
							runId: options.winnerRunId ?? "subject",
							digest: options.winnerRunId === "other-subject" ? DIGEST_B : DIGEST_A,
						},
						branch: `clio/compete/trust-contract/${options.winnerRunId === "other-subject" ? 2 : 1}`,
					},
				}
			: {}),
		...(outcome === "operator-confirmed" || outcome === "full-auto-applied"
			? { confirmation: { id: "prior-gate", digest: DIGEST_C } }
			: {}),
		createdAt: "2026-08-21T12:00:00.000Z",
		integrity: { algorithm: "sha256", digest: DIGEST_C },
	};
}

describe("contracts/trust-status", () => {
	it("exports a closed vocabulary for every orthogonal axis", () => {
		deepStrictEqual(Object.keys(AXIS_CASES), TRUST_STATUS_AXES);
		for (const axis of TRUST_STATUS_AXES) {
			deepStrictEqual(
				[...AXIS_CASES[axis].states, "absent"].sort(),
				[...TRUST_STATUS_STATES[axis]].sort(),
				`${axis} type and value vocabulary stay aligned`,
			);
			const absent = rawAggregate();
			absent[axis] = { state: "absent", reason: "not_observed" };
			strictEqual(validateTrustStatus(absent).ok, true, `${axis} accepts absent`);

			for (const state of AXIS_CASES[axis].states) {
				const aggregate = rawAggregate();
				aggregate[axis] = attributedRaw(state, AXIS_CASES[axis].source);
				const result = validateTrustStatus(aggregate);
				strictEqual(result.ok, true, `${axis} accepts ${state}`);
				if (result.ok) {
					const fact = result.status[axis];
					strictEqual(fact.state, state);
					strictEqual(fact.source.kind, AXIS_CASES[axis].source);
					strictEqual(fact.authority.id, "contracts");
				}
			}
		}
	});

	it("rejects contradictory attribution and bounds references deterministically", () => {
		const attributedAbsence = rawAggregate();
		attributedAbsence.artifactIntegrity = {
			state: "absent",
			reason: "not_recorded",
			source: { kind: "receipt_integrity_verification", id: "receipt" },
			authority: { kind: "clio", id: "integrity" },
			artifacts: [],
		};
		deepStrictEqual(validateTrustStatus(attributedAbsence), {
			ok: false,
			reason: "artifactIntegrity absent state is invalid",
		});

		const promotedSource = rawAggregate();
		promotedSource.validationGrounding = attributedRaw("validated", "receipt_integrity_verification");
		deepStrictEqual(validateTrustStatus(promotedSource), {
			ok: false,
			reason: "validationGrounding.source is invalid",
		});

		const contradictoryAuthority = rawAggregate();
		contradictoryAuthority.artifactIntegrity = {
			...attributedRaw("verified", "receipt_integrity_verification"),
			authority: { kind: "reviewer", id: "self-asserted-integrity" },
		};
		deepStrictEqual(validateTrustStatus(contradictoryAuthority), {
			ok: false,
			reason: "artifactIntegrity.authority is invalid",
		});

		const promotedCompatibility = rawAggregate();
		promotedCompatibility.validationGrounding = {
			...attributedRaw("validated", "compatibility"),
			authority: { kind: "unknown", id: "legacy" },
		};
		deepStrictEqual(validateTrustStatus(promotedCompatibility), {
			ok: false,
			reason: "validationGrounding compatibility source cannot establish validated",
		});

		const tooMany = rawAggregate();
		tooMany.contextProvenance = {
			...attributedRaw("recorded", "run_receipt"),
			artifacts: Array.from({ length: TRUST_STATUS_MAX_ARTIFACT_REFERENCES + 1 }, (_, index) => ({
				kind: "project_context",
				id: `context-${index}`,
			})),
		};
		const tooManyResult = validateTrustStatus(tooMany);
		strictEqual(tooManyResult.ok, false);
		if (!tooManyResult.ok) match(tooManyResult.reason, /bounded reference list/);

		const duplicate = rawAggregate();
		duplicate.completionEvidence = {
			...attributedRaw("evidenced", "finish_contract"),
			artifacts: [
				{ kind: "session_entry", id: "turn-1" },
				{ kind: "session_entry", id: "turn-1" },
			],
		};
		const duplicateResult = validateTrustStatus(duplicate);
		strictEqual(duplicateResult.ok, false);
		if (!duplicateResult.ok) match(duplicateResult.reason, /duplicate reference/);

		const unsorted = rawAggregate();
		unsorted.artifactIntegrity = {
			...attributedRaw("verified", "receipt_integrity_verification"),
			artifacts: [
				{ kind: "run_receipt", id: "z" },
				{ kind: "run_receipt", id: "a" },
			],
		};
		const first = normalizeTrustStatus(unsorted);
		const second = normalizeTrustStatus(unsorted);
		deepStrictEqual(first, second);
		if (first.artifactIntegrity.state !== "absent") {
			deepStrictEqual(
				first.artifactIntegrity.artifacts.map((reference) => reference.id),
				["a", "z"],
			);
		}
	});

	it("composes and projects exact axes without trust promotion", () => {
		const baseline = composeTrustStatus({
			validationGrounding: {
				state: "unknown",
				source: { kind: "compatibility", id: "legacy-validation" },
				authority: { kind: "unknown", id: "legacy" },
				artifacts: [],
			},
			contextProvenance: absentTrustStatus("historical_format"),
			completionEvidence: {
				state: "incomplete",
				source: { kind: "finish_contract", id: "unvalidated_mutation" },
				authority: { kind: "clio", id: "finish-contract" },
				artifacts: [],
			},
		});
		const receipt = currentReceipt();

		const withIntegrity = composeTrustStatus(baseline, {
			artifactIntegrity: adaptReceiptIntegrityStatus(receipt, { ok: true }),
		});
		strictEqual(withIntegrity.artifactIntegrity.state, "verified");
		deepStrictEqual(withIntegrity.validationGrounding, baseline.validationGrounding);

		const withProvenance = composeTrustStatus(baseline, {
			contextProvenance: adaptRunReceiptContextStatus(receipt),
		});
		strictEqual(withProvenance.contextProvenance.state, "recorded");
		deepStrictEqual(withProvenance.validationGrounding, baseline.validationGrounding);

		const withReview = composeTrustStatus(baseline, {
			independentReview: adaptGateDecisionReviewStatus(gateArtifact("pass"), "subject", { ok: true }),
		});
		strictEqual(withReview.independentReview.state, "passed");
		deepStrictEqual(withReview.contextProvenance, baseline.contextProvenance);

		const withAutonomy = composeTrustStatus(baseline, {
			autonomyEnforcement: adaptRunReceiptAutonomyStatus(receipt),
		});
		strictEqual(withAutonomy.autonomyEnforcement.state, "enforced");
		deepStrictEqual(withAutonomy.completionEvidence, baseline.completionEvidence);

		deepStrictEqual(projectTrustStatus(withAutonomy, ["autonomyEnforcement", "completionEvidence"]), {
			autonomyEnforcement: withAutonomy.autonomyEnforcement,
			completionEvidence: baseline.completionEvidence,
		});
		// The completion rule is enforced, not documented: a finish-contract
		// self-report cannot ground validation even when handed straight to the
		// grounding adapter.
		deepStrictEqual(
			adaptGroundedEvidenceValidationStatus({
				evidenceId: "evidence-1",
				runId: "subject",
				artifacts: [
					{ kind: "finish_contract_evidence", id: "completion-1" },
					{ kind: "run_receipt", id: "subject" },
				],
			}),
			{ state: "absent", reason: "not_observed" },
		);
		deepStrictEqual(
			adaptGroundedEvidenceValidationStatus({ evidenceId: "evidence-1", runId: "subject", artifacts: [] }),
			{ state: "absent", reason: "not_observed" },
		);
		const observed = adaptGroundedEvidenceValidationStatus({
			evidenceId: "evidence-1",
			runId: "subject",
			artifacts: [
				{ kind: "session_entry", id: "turn-1" },
				{ kind: "finish_contract_evidence", id: "completion-1" },
			],
		});
		strictEqual(observed.state, "validated");
		if (observed.state === "validated") {
			deepStrictEqual(observed.artifacts, [
				{ kind: "evidence_bundle", id: "evidence-1" },
				{ kind: "session_entry", id: "turn-1" },
			]);
		}
	});

	it("adapts current and historical receipt facts conservatively", () => {
		const current = adaptRunReceiptTrustStatus(currentReceipt(), { integrity: { ok: true } });
		deepStrictEqual(
			{
				integrity: current.artifactIntegrity.state,
				validation: current.validationGrounding.state,
				context: current.contextProvenance.state,
				autonomy: current.autonomyEnforcement.state,
				review: current.independentReview.state,
				completion: current.completionEvidence.state,
			},
			{
				integrity: "verified",
				validation: "validated",
				context: "recorded",
				autonomy: "enforced",
				review: "absent",
				completion: "absent",
			},
		);

		const historical = adaptRunReceiptTrustStatus({ runId: "historical-run" }, { integrity: { ok: true } });
		deepStrictEqual(
			{
				integrity: historical.artifactIntegrity.state,
				validation: historical.validationGrounding.state,
				context: historical.contextProvenance.state,
				autonomy: historical.autonomyEnforcement.state,
			},
			{ integrity: "unknown", validation: "unknown", context: "unknown", autonomy: "unknown" },
		);

		const missing = adaptRunReceiptTrustStatus(null);
		for (const axis of TRUST_STATUS_AXES) {
			strictEqual(missing[axis].state, "absent");
			if (missing[axis].state === "absent") strictEqual(missing[axis].reason, "artifact_missing");
		}

		const failedIntegrity = adaptRunReceiptTrustStatus(
			currentReceipt({ verification: { state: "unverified", basis: "no-validation-tool" } }),
			{ integrity: { ok: false, reason: "digest mismatch" } },
		);
		strictEqual(failedIntegrity.artifactIntegrity.state, "failed");
		strictEqual(failedIntegrity.validationGrounding.state, "absent");
	});

	it("distinguishes a retired seal from a rejected one on every projected surface", () => {
		const retired = adaptRunReceiptTrustStatus(currentReceipt(), {
			integrity: {
				ok: false,
				reason: "receipt integrity v19 is retired; this build verifies v20; the receipt is not read as evidence",
				retired: { receiptVersion: 19, supportedVersion: 20 },
			},
		});
		// Nothing was checked, so the seal is unknown through the compatibility
		// source that names its version, and the receipt-owned axes are absent
		// because the format is historical. No receipt claim is read.
		deepStrictEqual(retired.artifactIntegrity, {
			state: "unknown",
			source: { kind: "compatibility", id: "run_receipt:run-154:integrity-v19-retired" },
			authority: { kind: "unknown", id: "historical-persisted-format" },
			artifacts: [{ kind: "run_receipt", id: "run-154", digest: { algorithm: "sha256", value: DIGEST_A } }],
		});
		deepStrictEqual(retired.validationGrounding, absentTrustStatus("historical_format"));
		deepStrictEqual(retired.contextProvenance, absentTrustStatus("historical_format"));
		deepStrictEqual(retired.autonomyEnforcement, absentTrustStatus("historical_format"));
		strictEqual(retiredIntegrityVersionOf(retired.artifactIntegrity), 19);
		ok(
			formatTrustSummary(retired).startsWith("seal v19 retired (this build verifies v20); "),
			formatTrustSummary(retired),
		);
		ok(formatTrustAxes(retired).includes("artifactIntegrity:unknown"), formatTrustAxes(retired));
		// The persisted projection round-trips the version through its source id.
		strictEqual(retiredIntegrityVersionOf(normalizeTrustStatus(retired).artifactIntegrity), 19);

		const rejected = adaptRunReceiptTrustStatus(currentReceipt(), {
			integrity: { ok: false, reason: "integrity mismatch" },
		});
		strictEqual(rejected.artifactIntegrity.state, "failed");
		deepStrictEqual(rejected.autonomyEnforcement, absentTrustStatus("not_observed"));
		strictEqual(retiredIntegrityVersionOf(rejected.artifactIntegrity), null);
		ok(formatTrustSummary(rejected).startsWith("seal broken; "), formatTrustSummary(rejected));

		// Only a lower integer version is retired; the current one, a newer
		// one, and a malformed block all fall through to the verifier.
		deepStrictEqual(retiredReceiptIntegrity({ version: 19, algorithm: "sha256", digest: DIGEST_A }), {
			receiptVersion: 19,
			supportedVersion: 20,
		});
		strictEqual(retiredReceiptIntegrity({ version: 20, algorithm: "sha256", digest: DIGEST_A }), null);
		strictEqual(retiredReceiptIntegrity({ version: 21, algorithm: "sha256", digest: DIGEST_A }), null);
		strictEqual(retiredReceiptIntegrity({ version: "19" }), null);
		strictEqual(retiredReceiptIntegrity(null), null);
	});

	it("adapts positive, negative, ungrounded, absent, unknown, and not applicable validation", () => {
		const typedPass: RunReceiptQuality = {
			...QUALITY_EMPTY,
			typedValidations: [{ sourceId: "pytest", validatorDigest: DIGEST_B, passed: true }],
		};
		const typedFail: RunReceiptQuality = {
			...QUALITY_EMPTY,
			typedValidations: [{ sourceId: "pytest", validatorDigest: DIGEST_B, passed: false }],
		};
		strictEqual(adaptRunReceiptValidationStatus(currentReceipt({ quality: typedPass })).state, "validated");
		strictEqual(adaptRunReceiptValidationStatus(currentReceipt({ quality: typedFail })).state, "failed");
		strictEqual(
			adaptRunReceiptValidationStatus(
				currentReceipt({
					quality: typedPass,
					validationGrounding: {
						claimed: 1,
						grounded: 0,
						ungrounded: ["pytest"],
						basis: "no-command-executed",
					},
				}),
			).state,
			"ungrounded",
		);
		strictEqual(
			adaptRunReceiptValidationStatus(
				currentReceipt({ verification: { state: "unverified", basis: "no-validation-tool" } }),
			).state,
			"absent",
		);
		strictEqual(
			adaptRunReceiptValidationStatus(
				currentReceipt({ verification: { state: "unknown", basis: "acp-external-unobserved" } }),
			).state,
			"unknown",
		);
		strictEqual(
			adaptRunReceiptValidationStatus(
				currentReceipt({ verification: { state: "not_applicable", basis: "read-only-agent" } }),
			).state,
			"not_applicable",
		);
	});

	it("adapts context and autonomy facts without projecting correctness or completion", () => {
		strictEqual(adaptRunReceiptContextStatus(currentReceipt()).state, "recorded");
		strictEqual(
			adaptRunReceiptContextStatus(currentReceipt({ projectContext: { tier: "none" } })).state,
			"not_applicable",
		);
		strictEqual(adaptRunReceiptContextStatus({ runId: "legacy" }).state, "unknown");
		strictEqual(
			adaptRunReceiptContextStatus(
				currentReceipt({ briefing: { bytes: 12, contentHash: DIGEST_C }, projectContext: { tier: "none" } }),
			).state,
			"recorded",
		);
		const invalidContext = currentReceipt({
			projectContext: { tier: "none", contentHash: DIGEST_B } as { tier: "none" },
		});
		strictEqual(adaptRunReceiptContextStatus(invalidContext).state, "invalid");
		// The shape every none-tier receipt on a real install carries (receipt
		// run-l5mithv0l8s8, 2026-08-27): the policy sent no handbook, but the
		// workspace-root message was sent and recorded. That is a consistent
		// record, so it reads recorded and cites the message it hashed.
		const workspaceRootOnly = adaptRunReceiptContextStatus(
			currentReceipt({
				projectContext: {
					tier: "none",
					chars: 187,
					contentHash: "c2d8193b43376f88e0383e94e3c57d232fe768a61d5a88be8d67ccb0e40ffacd",
					sections: ["workspace-root"],
				},
			}),
		);
		strictEqual(workspaceRootOnly.state, "recorded");
		ok(
			workspaceRootOnly.state === "recorded" &&
				workspaceRootOnly.artifacts.some((artifact) => artifact.kind === "project_context"),
			"the workspace-root record is cited as a project_context artifact",
		);
		// A handbook section under a none policy is the contradiction the
		// invalid state exists for.
		strictEqual(
			adaptRunReceiptContextStatus(
				currentReceipt({
					projectContext: { tier: "none", chars: 187, contentHash: DIGEST_B, sections: ["workspace-root", "clio-md"] },
				}),
			).state,
			"invalid",
		);

		strictEqual(adaptRunReceiptAutonomyStatus(currentReceipt()).state, "enforced");
		strictEqual(
			adaptRunReceiptAutonomyStatus(
				currentReceipt({ autonomyEnforcement: { grade: "approximated", autonomy: "auto-edit" } }),
			).state,
			"approximated",
		);
		strictEqual(
			adaptRunReceiptAutonomyStatus(currentReceipt({ autonomyEnforcement: { grade: "bypassed", autonomy: "full-auto" } }))
				.state,
			"bypassed",
		);
		strictEqual(
			adaptRunReceiptAutonomyStatus(
				currentReceipt({
					autonomyEnforcement: { grade: "mediated", autonomy: "full-auto", dangerousBypass: true },
				}),
			).state,
			"bypassed",
		);
		strictEqual(adaptRunReceiptAutonomyStatus({ runId: "legacy" }).state, "unknown");
	});

	it("adapts authenticated independent gate outcomes and never treats artifact presence as review", () => {
		strictEqual(adaptGateDecisionReviewStatus(gateArtifact("pass"), "subject", { ok: true }).state, "passed");
		strictEqual(adaptGateDecisionReviewStatus(gateArtifact("fail"), "subject", { ok: true }).state, "failed");
		strictEqual(
			adaptGateDecisionReviewStatus(gateArtifact("pass", { independent: false }), "subject", { ok: true }).state,
			"not_independent",
		);
		strictEqual(adaptGateDecisionReviewStatus(gateArtifact("revise"), "subject", { ok: true }).state, "inconclusive");
		strictEqual(adaptGateDecisionReviewStatus(gateArtifact("pass"), "subject").state, "unknown");
		strictEqual(
			adaptGateDecisionReviewStatus(gateArtifact("pass"), "subject", { ok: false, reason: "tampered" }).state,
			"unknown",
		);
		strictEqual(
			adaptGateDecisionReviewStatus(gateArtifact("operator-confirmed", { decider: false }), "subject", {
				ok: true,
			}).state,
			"not_applicable",
		);
		strictEqual(
			adaptGateDecisionReviewStatus(gateArtifact("winner", { winnerRunId: "other-subject" }), "subject", {
				ok: true,
			}).state,
			"failed",
		);
		strictEqual(adaptGateDecisionReviewStatus(null, "subject", { ok: true }).state, "absent");
	});

	it("adapts every finish-contract settlement as completion evidence only", () => {
		const cases: ReadonlyArray<[FinishContractAssessment, string]> = [
			[
				{
					kind: "ok",
					reason: "no_mutation",
					evidence: [],
					mutatedPaths: [],
				},
				"not_applicable",
			],
			[
				{
					kind: "ok",
					reason: "validation_evidence",
					evidence: [{ kind: "validation_command", summary: "npm test", turnId: "turn-1" }],
					mutatedPaths: ["src/file.ts"],
				},
				"evidenced",
			],
			[
				{
					kind: "ok",
					reason: "explicit_limitation",
					evidence: [],
					mutatedPaths: ["src/file.ts"],
				},
				"limited",
			],
			[
				{
					kind: "engage",
					reason: "unvalidated_mutation",
					message: "validate the mutation",
					evidence: [],
					mutatedPaths: ["src/file.ts"],
				},
				"incomplete",
			],
		];
		for (const [assessment, expected] of cases) {
			strictEqual(adaptFinishContractCompletionStatus(assessment).state, expected);
		}
		const evidenced = adaptFinishContractCompletionStatus(cases[1]?.[0] as FinishContractAssessment);
		if (evidenced.state === "absent") throw new Error("expected attributed completion evidence");
		deepStrictEqual(evidenced.artifacts, [{ kind: "session_entry", id: "turn-1" }]);
		strictEqual(JSON.stringify(evidenced).includes("npm test"), false, "artifact summaries are not embedded");
	});

	it("rejects unknown aggregate fields and does not expose an overall trust scalar", () => {
		const aggregate = rawAggregate();
		aggregate.overall = true;
		throws(() => normalizeTrustStatus(aggregate), /unknown or missing fields/);
		const canonical: CanonicalTrustStatus = composeTrustStatus();
		strictEqual("overall" in canonical, false);
		strictEqual("score" in canonical, false);
		ok(canonical.version === 1);
	});
});
