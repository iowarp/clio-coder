import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { GateDecisionArtifact } from "../../src/domains/dispatch/gate-decisions.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type {
	RunEnvelope,
	RunReceipt,
	RunReceiptDraft,
	RunReceiptQuality,
	RunReceiptVerification,
} from "../../src/domains/dispatch/types.js";
import {
	adaptFinishContractCompletionStatus,
	adaptGateDecisionReviewStatus,
	buildEvidence,
	composeTrustStatus,
	inspectEvidence,
	inspectRunReceiptTrustStatus,
} from "../../src/domains/evidence/index.js";

const scratchRoots: string[] = [];
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

function scratchDir(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-evidence-trust-"));
	scratchRoots.push(root);
	return root;
}

const EMPTY_QUALITY: RunReceiptQuality = {
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

interface ReceiptFixtureOptions {
	outcome?: RunReceiptDraft["outcome"];
	exitCode?: number;
	verification?: RunReceiptVerification;
	quality?: RunReceiptQuality;
	executionRole?: RunReceiptDraft["executionRole"];
	autonomyEnforcement?: RunReceiptDraft["autonomyEnforcement"];
	validationGrounding?: RunReceiptDraft["validationGrounding"];
}

function sealedFixture(
	runId: string,
	options: ReceiptFixtureOptions = {},
): {
	envelope: RunEnvelope;
	receipt: RunReceipt;
} {
	const executionRole = options.executionRole ?? "builder";
	const outcome = options.outcome ?? "succeeded";
	const exitCode = options.exitCode ?? (outcome === "succeeded" ? 0 : 1);
	const draft: RunReceiptDraft = {
		runId,
		agentId: executionRole === "researcher" ? "scout" : "coder",
		executionRole,
		task: `canonical trust fixture ${runId}`,
		briefing: { bytes: 18, contentHash: DIGEST_A },
		targetId: "local",
		wireModelId: "fixture-model",
		runtimeId: "fixture-runtime",
		runtimeKind: "http",
		startedAt: "2026-08-21T10:00:00.000Z",
		endedAt: "2026-08-21T10:00:01.000Z",
		outcome,
		exitCode,
		tokenCount: 12,
		costUsd: 0,
		costProvenance: "unknown",
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "test",
		piMonoVersion: "test",
		platform: "test",
		nodeVersion: process.version,
		toolCalls: 1,
		toolStats: [],
		toolActivity: { calls: 1, succeeded: 1, failed: 0, blocked: 0, mutatingSucceeded: false },
		verification: options.verification ?? { state: "verified", basis: "validation-tool" },
		routingIntent: {
			posture: "balanced",
			maxCostUsd: null,
			deadlineMs: null,
			minimumQuality: null,
			requiredCapabilities: [],
			locality: "any",
			failover: "none",
		},
		quality: options.quality ?? EMPTY_QUALITY,
		projectContext: { tier: "bounded", chars: 240, contentHash: DIGEST_B },
		autonomyEnforcement: options.autonomyEnforcement ?? { grade: "mediated", autonomy: "auto-edit" },
		...(options.validationGrounding === undefined ? {} : { validationGrounding: options.validationGrounding }),
		sessionId: null,
	};
	const envelope: RunEnvelope = {
		id: runId,
		agentId: draft.agentId,
		executionRole,
		task: draft.task,
		briefing: { bytes: 18, contentHash: DIGEST_A },
		targetId: draft.targetId,
		wireModelId: draft.wireModelId,
		runtimeId: draft.runtimeId,
		runtimeKind: draft.runtimeKind,
		startedAt: draft.startedAt,
		endedAt: draft.endedAt,
		status: outcome === "succeeded" ? "completed" : "failed",
		outcome,
		outcomeDetail: null,
		outcomeCode: null,
		exitCode,
		pid: null,
		heartbeatAt: null,
		receiptPath: null,
		sessionId: null,
		cwd: "/tmp",
		tokenCount: draft.tokenCount,
		costUsd: draft.costUsd,
	};
	return { envelope, receipt: withReceiptIntegrity(draft, envelope) };
}

function persistFixture(root: string, fixture: { envelope: RunEnvelope; receipt: RunReceipt }): void {
	const stateDir = join(root, "state");
	const receiptPath = join(stateDir, "receipts", `${fixture.receipt.runId}.json`);
	mkdirSync(join(stateDir, "receipts"), { recursive: true });
	const envelope = { ...fixture.envelope, receiptPath };
	const resealed = withReceiptIntegrity(
		(({ integrity: _integrity, ...draft }) => draft)(fixture.receipt) as RunReceiptDraft,
		envelope,
	);
	writeFileSync(join(stateDir, "runs.json"), `${JSON.stringify([envelope], null, 2)}\n`, "utf8");
	writeFileSync(receiptPath, `${JSON.stringify(resealed, null, 2)}\n`, { encoding: "utf8", flag: "w" });
}

function gateArtifact(): GateDecisionArtifact {
	return {
		version: 2,
		id: "gate-reviewed",
		group: "canonical-trust",
		topology: "review",
		cycle: 1,
		outcome: "pass",
		subjects: [{ runId: "reviewed", digest: DIGEST_A }],
		decider: { runId: "reviewer", digest: DIGEST_B },
		correlation: {
			agent: false,
			target: true,
			modelFamily: false,
			runtime: true,
			node: true,
			independent: true,
		},
		createdAt: "2026-08-21T10:00:02.000Z",
		integrity: { algorithm: "sha256", digest: DIGEST_C },
	};
}

describe("contracts/evidence canonical trust projection", () => {
	afterEach(() => {
		for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("covers succeeded, failed, read-only, approximated, bypassed, reviewed, and unvalidated runs", () => {
		const failedQuality: RunReceiptQuality = {
			...EMPTY_QUALITY,
			typedValidations: [{ sourceId: "pytest", validatorDigest: DIGEST_C, passed: false }],
		};
		const fixtures = [
			["succeeded", sealedFixture("succeeded"), "validationGrounding", "validated"],
			["failed", sealedFixture("failed", { outcome: "failed", quality: failedQuality }), "validationGrounding", "failed"],
			[
				"read-only",
				sealedFixture("read-only", {
					executionRole: "researcher",
					verification: { state: "not_applicable", basis: "read-only-agent" },
				}),
				"validationGrounding",
				"not_applicable",
			],
			[
				"approximated",
				sealedFixture("approximated", {
					autonomyEnforcement: {
						grade: "approximated",
						autonomy: "auto-edit",
						externalMode: "external-default",
					},
				}),
				"autonomyEnforcement",
				"approximated",
			],
			[
				"bypassed",
				sealedFixture("bypassed", {
					autonomyEnforcement: {
						grade: "bypassed",
						autonomy: "full-auto",
						externalMode: "bypassPermissions",
						dangerousBypass: true,
					},
				}),
				"autonomyEnforcement",
				"bypassed",
			],
			[
				"unvalidated",
				sealedFixture("unvalidated", {
					verification: { state: "unverified", basis: "no-validation-tool" },
				}),
				"validationGrounding",
				"absent",
			],
		] as const;
		for (const [name, fixture, axis, expected] of fixtures) {
			const inspection = inspectRunReceiptTrustStatus(fixture.receipt, fixture.envelope);
			strictEqual(inspection.integrity.ok, true, name);
			strictEqual(inspection.status[axis].state, expected, name);
		}

		const reviewedFixture = sealedFixture("reviewed");
		const reviewed = composeTrustStatus(
			inspectRunReceiptTrustStatus(reviewedFixture.receipt, reviewedFixture.envelope).status,
			{ independentReview: adaptGateDecisionReviewStatus(gateArtifact(), "reviewed", { ok: true }) },
		);
		strictEqual(reviewed.independentReview.state, "passed");
	});

	it("makes receipt inspection and a rebuilt bundle deeply equivalent and byte-stable", async () => {
		const root = scratchDir();
		const fixture = sealedFixture("equivalent-run");
		persistFixture(root, fixture);
		const stateDir = join(root, "state");
		const dataDir = join(root, "data");
		const persistedEnvelope = JSON.parse(readFileSync(join(stateDir, "runs.json"), "utf8"))[0] as RunEnvelope;
		const persistedReceipt = JSON.parse(readFileSync(persistedEnvelope.receiptPath as string, "utf8")) as RunReceipt;
		const inspectedReceipt = inspectRunReceiptTrustStatus(persistedReceipt, persistedEnvelope);
		const first = await buildEvidence({ dataDir, stateDir, runId: persistedEnvelope.id });
		deepStrictEqual(first.trustStatus.runs[0]?.status, inspectedReceipt.status);

		const context = first.trustStatus.runs[0]?.status.contextProvenance;
		if (context?.state === "absent" || context === undefined) throw new Error("expected recorded context provenance");
		deepStrictEqual(
			context.artifacts.map((artifact) => artifact.kind),
			["briefing", "project_context", "run_receipt"],
		);
		const firstBytes = new Map(
			first.overview.files.map((file) => [file, readFileSync(join(first.directory, file))] as const),
		);
		const second = await buildEvidence({ dataDir, stateDir, runId: persistedEnvelope.id });
		deepStrictEqual(second.trustStatus, first.trustStatus);
		for (const [file, bytes] of firstBytes) {
			deepStrictEqual(readFileSync(join(second.directory, file)), bytes, file);
		}
	});

	it("fails closed for tampered and unsupported receipts while preserving the invalid diagnostic", async () => {
		const root = scratchDir();
		const fixture = sealedFixture("tampered-run");
		persistFixture(root, fixture);
		const stateDir = join(root, "state");
		const envelope = JSON.parse(readFileSync(join(stateDir, "runs.json"), "utf8"))[0] as RunEnvelope;
		const receiptPath = envelope.receiptPath as string;
		const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as RunReceipt;
		const tampered: RunReceipt = {
			...receipt,
			verification: { state: "verified", basis: "validation-tool" },
			autonomyEnforcement: { grade: "mediated", autonomy: "full-auto" },
		};
		writeFileSync(receiptPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
		const result = await buildEvidence({ dataDir: join(root, "data"), stateDir, runId: envelope.id });
		const status = result.trustStatus.runs[0]?.status;
		if (status === undefined) throw new Error("missing tampered status");
		strictEqual(status.artifactIntegrity.state, "failed");
		const forbidden = new Set(["verified", "validated", "passed", "recorded", "enforced", "evidenced"]);
		for (const axis of [
			status.artifactIntegrity,
			status.validationGrounding,
			status.independentReview,
			status.contextProvenance,
			status.autonomyEnforcement,
			status.completionEvidence,
		]) {
			strictEqual(forbidden.has(axis.state), false, axis.state);
		}
		ok(result.findings.some((finding) => finding.tag === "receipt-integrity"));

		const unsupported = {
			...receipt,
			integrity: { ...receipt.integrity, version: 14 },
		} as unknown as RunReceipt;
		const unsupportedInspection = inspectRunReceiptTrustStatus(unsupported, envelope);
		strictEqual(unsupportedInspection.integrity.ok, false);
		strictEqual(unsupportedInspection.status.artifactIntegrity.state, "failed");
		strictEqual(unsupportedInspection.status.validationGrounding.state, "absent");
	});

	it("keeps claims separate and retains gate and finish-contract authorities and references", () => {
		const claimed = sealedFixture("claimed-run", {
			quality: {
				...EMPTY_QUALITY,
				typedValidations: [{ sourceId: "claimed-pytest", validatorDigest: DIGEST_C, passed: true }],
			},
			validationGrounding: {
				claimed: 1,
				grounded: 0,
				ungrounded: [],
				basis: "no-command-executed",
			},
		});
		strictEqual(
			inspectRunReceiptTrustStatus(claimed.receipt, claimed.envelope).status.validationGrounding.state,
			"ungrounded",
		);

		const review = adaptGateDecisionReviewStatus(gateArtifact(), "reviewed", { ok: true });
		if (review.state === "absent") throw new Error("expected attributed review");
		deepStrictEqual(review.authority, { kind: "reviewer", id: "reviewer" });
		deepStrictEqual(review.artifacts, [
			{ kind: "gate_decision", id: "gate-reviewed", digest: { algorithm: "sha256", value: DIGEST_C } },
		]);

		const completion = adaptFinishContractCompletionStatus(
			{
				kind: "ok",
				reason: "validation_evidence",
				evidence: [{ kind: "validation_command", summary: "npm test", turnId: "turn-157" }],
				mutatedPaths: ["src/app.ts"],
			},
			{
				sourceId: "finish-audit-157",
				artifacts: [
					{ kind: "finish_contract_evidence", id: "finish-audit-157" },
					{ kind: "session_entry", id: "turn-157" },
				],
			},
		);
		if (completion.state === "absent") throw new Error("expected attributed completion evidence");
		deepStrictEqual(completion.source, { kind: "finish_contract", id: "finish-audit-157" });
		deepStrictEqual(completion.authority, { kind: "clio", id: "finish-contract" });
		deepStrictEqual(completion.artifacts, [
			{ kind: "finish_contract_evidence", id: "finish-audit-157" },
			{ kind: "session_entry", id: "turn-157" },
		]);
	});

	it("marks a bundle without the canonical projection as historical", async () => {
		const root = scratchDir();
		const fixture = sealedFixture("legacy-bundle-run");
		persistFixture(root, fixture);
		const dataDir = join(root, "data");
		const stateDir = join(root, "state");
		const built = await buildEvidence({ dataDir, stateDir, runId: fixture.envelope.id });
		unlinkSync(join(built.directory, "trust-status.json"));
		const inspected = await inspectEvidence(dataDir, built.evidenceId);
		deepStrictEqual(inspected.trustStatus, {
			version: 1,
			evidenceId: built.evidenceId,
			projection: "historical_format",
			runs: [],
		});
	});
});
