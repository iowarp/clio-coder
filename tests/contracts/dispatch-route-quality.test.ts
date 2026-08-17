import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	type GateDecisionArtifact,
	type GateDecisionDraft,
	materializePendingGateDecision,
	stagePendingGateDecision,
} from "../../src/domains/dispatch/gate-decisions.js";
import { canonicalResponseSchemaDigest, createRunReceiptQuality } from "../../src/domains/dispatch/receipt-findings.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { decideRoute, type RouteCandidate } from "../../src/domains/dispatch/route-decision.js";
import { createRouteHistoryStore } from "../../src/domains/dispatch/route-history.js";
import {
	clearsPostureFloors,
	DEFAULT_ROUTE_PRIOR,
	estimateRoute,
	type RouteObservation,
} from "../../src/domains/dispatch/route-policy.js";
import { reduceRouteQuality, routeQualityEvalDigest } from "../../src/domains/dispatch/route-quality.js";
import type { RunEnvelope, RunReceipt, RunReceiptDraft } from "../../src/domains/dispatch/types.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const roots: string[] = [];
let isolated: Awaited<ReturnType<typeof isolateClioEnv>> | null = null;

function envelope(id: string, overrides: Partial<RunEnvelope> = {}): RunEnvelope {
	return {
		id,
		agentId: "builder",
		executionRole: "builder",
		task: "implement",
		targetId: "local",
		wireModelId: "builder-model",
		runtimeId: "llamacpp",
		runtimeKind: "http",
		startedAt: "2026-07-20T00:00:00.000Z",
		endedAt: "2026-07-20T00:00:01.000Z",
		status: "completed",
		outcome: "succeeded",
		outcomeDetail: null,
		exitCode: 0,
		pid: null,
		heartbeatAt: null,
		receiptPath: null,
		sessionId: null,
		cwd: "/workspace",
		tokenCount: 0,
		costUsd: 0.1,
		...overrides,
	};
}

function receipt(
	id: string,
	options: {
		envelope?: Partial<RunEnvelope>;
		quality?: RunReceiptDraft["quality"];
		verification?: RunReceiptDraft["verification"];
		outcome?: RunReceiptDraft["outcome"];
	} = {},
): { receipt: RunReceipt; envelope: RunEnvelope } {
	const run = envelope(id, options.envelope);
	const draft: RunReceiptDraft = {
		runId: run.id,
		agentId: run.agentId,
		executionRole: "builder",
		task: run.task,
		targetId: run.targetId,
		wireModelId: run.wireModelId,
		runtimeId: run.runtimeId,
		runtimeKind: run.runtimeKind,
		startedAt: run.startedAt,
		endedAt: run.endedAt ?? run.startedAt,
		outcome: options.outcome ?? "succeeded",
		outcomeDetail: null,
		exitCode: 0,
		tokenCount: 0,
		costUsd: run.costUsd,
		costProvenance: "unknown",
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "test",
		piMonoVersion: "test",
		platform: "test",
		nodeVersion: process.version,
		toolCalls: 0,
		toolStats: [],
		verification: options.verification ?? { state: "unverified", basis: "no-validation-tool" },
		routingIntent: {
			posture: "balanced",
			maxCostUsd: null,
			deadlineMs: null,
			minimumQuality: null,
			requiredCapabilities: [],
			locality: "any",
			failover: "none",
		},
		quality: options.quality ?? createRunReceiptQuality({ runtimeEnforceable: false, enforcementPassed: null }),
		sessionId: null,
	};
	return { receipt: withReceiptIntegrity(draft, run), envelope: run };
}

function typedQuality(passed: boolean): RunReceiptDraft["quality"] {
	return createRunReceiptQuality({
		runtimeEnforceable: false,
		enforcementPassed: null,
		typedValidations: [{ sourceId: "typed-validator", validatorDigest: "a".repeat(64), passed }],
	});
}

function candidate(): RouteCandidate {
	return {
		agentId: "builder",
		specFingerprint: "spec",
		executionRole: "builder",
		targetId: "local",
		modelId: "builder-model",
		runtimeId: "llamacpp",
		nodeId: "local",
		toolSignature: "tools",
		promptCompositionHash: "prompt",
		endpointIdentityHash: "endpoint",
		settingsFingerprint: "settings",
	};
}

function routeSample(qualityLabel: RouteObservation["qualityLabel"]): RouteObservation {
	return {
		qualityLabel,
		reliability: "success",
		firstPass: true,
		completedCostUsd: 0.1,
		completedEndToEndMs: 100,
		cacheRead: false,
		queueWaitMs: 0,
	};
}

/** Independent decider correlation, the ordinary case for a gated fixture. */
const INDEPENDENT_GATE_CORRELATION = {
	agent: false,
	target: true,
	modelFamily: false,
	runtime: true,
	node: true,
	independent: true,
} as const;

describe("dispatch route quality", { concurrency: false }, () => {
	// Nested inside the describe, not at module top level: under
	// --experimental-test-isolation=none every file shares one root test
	// context, so a top-level beforeEach/afterEach runs around every test in
	// every file, not just this one's.
	afterEach(() => {
		isolated?.restore();
		isolated = null;
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("not_applicable is unmeasured rather than successful quality", () => {
		const subject = receipt("read-only", { verification: { state: "not_applicable", basis: "read-only-agent" } });
		strictEqual(reduceRouteQuality({ subject, receipts: [subject] }).label, "unmeasured");
	});

	// reduceRouteQuality verifies the whole receipt set on every call, which is
	// fine for one subject and quadratic for a batch. Reconciling route history
	// is a batch, and on a 1247-receipt ledger with 359 records it measured 70
	// seconds of CPU on the dispatch decision path, past the 60-second
	// admission deadline. Dispatch had stopped working entirely, reporting that
	// no worker slots were free while zero were in use.
	//
	// Verification is the only thing that reads a source's envelope, so counting
	// envelope reads counts verifications exactly.
	it("verifies each receipt once across a batch of reductions", () => {
		let envelopeReads = 0;
		const counted = (source: ReturnType<typeof receipt>): ReturnType<typeof receipt> => ({
			receipt: source.receipt,
			get envelope() {
				envelopeReads += 1;
				return source.envelope;
			},
		});
		const ledger = Array.from({ length: 12 }, (_, index) => counted(receipt(`ledger-${index}`)));

		for (const subject of ledger) reduceRouteQuality({ subject, receipts: ledger });

		strictEqual(envelopeReads, ledger.length, `12 receipts reduced 12 times must verify 12 times, not ${12 * 13}`);
	});

	it("typed validation pass and failure produce opposite quality labels", () => {
		const pass = receipt("pass", { quality: typedQuality(true) });
		const fail = receipt("fail", { quality: typedQuality(false) });
		strictEqual(reduceRouteQuality({ subject: pass, receipts: [pass] }).label, "pass");
		strictEqual(reduceRouteQuality({ subject: fail, receipts: [fail] }).label, "fail");
	});

	it("process success without correctness evidence remains unmeasured", () => {
		const subject = receipt("process-success");
		strictEqual(subject.receipt.outcome, "succeeded");
		strictEqual(reduceRouteQuality({ subject, receipts: [subject] }).label, "unmeasured");
	});

	it("independent gate pass labels the referenced builder and not the reviewer", async () => {
		isolated = await isolateClioEnv("clio-route-quality-gate-");
		const builder = receipt("builder", {
			quality: createRunReceiptQuality({ runtimeEnforceable: false, enforcementPassed: null }),
		});
		const reviewer = receipt("reviewer", {
			envelope: { agentId: "reviewer", wireModelId: "reviewer-model" },
		});
		const gate = writeGateDecision({
			group: "quality",
			topology: "review",
			cycle: 1,
			outcome: "pass",
			subjects: [{ runId: builder.receipt.runId, digest: builder.receipt.integrity.digest }],
			decider: { runId: reviewer.receipt.runId, digest: reviewer.receipt.integrity.digest },
			correlation: INDEPENDENT_GATE_CORRELATION,
		});
		strictEqual(
			reduceRouteQuality({
				subject: builder,
				receipts: [builder, reviewer],
				gateArtifacts: [gate.artifact],
			}).label,
			"pass",
		);
		strictEqual(
			reduceRouteQuality({
				subject: reviewer,
				receipts: [builder, reviewer],
				gateArtifacts: [gate.artifact],
			}).label,
			"unmeasured",
		);
	});

	it("correlated self-review remains visible and unmeasured", async () => {
		isolated = await isolateClioEnv("clio-route-quality-correlated-");
		const builder = receipt("builder");
		const reviewer = receipt("reviewer", { envelope: { agentId: "builder", wireModelId: "builder-model-v2" } });
		const gate = writeGateDecision({
			group: "correlated",
			topology: "review",
			cycle: 1,
			outcome: "pass",
			subjects: [{ runId: builder.receipt.runId, digest: builder.receipt.integrity.digest }],
			decider: { runId: reviewer.receipt.runId, digest: reviewer.receipt.integrity.digest },
			correlation: INDEPENDENT_GATE_CORRELATION,
		});
		const reduced = reduceRouteQuality({
			subject: builder,
			receipts: [builder, reviewer],
			gateArtifacts: [gate.artifact],
		});
		strictEqual(reduced.label, "unmeasured");
		strictEqual(reduced.correlatedGates.length, 1);
	});

	it("tampered gate or mismatched subject digest contributes no label", async () => {
		isolated = await isolateClioEnv("clio-route-quality-tampered-");
		const builder = receipt("builder");
		const reviewer = receipt("reviewer", { envelope: { agentId: "reviewer", wireModelId: "reviewer-model" } });
		const gate = writeGateDecision({
			group: "tampered",
			topology: "review",
			cycle: 1,
			outcome: "pass",
			subjects: [{ runId: builder.receipt.runId, digest: "f".repeat(64) }],
			decider: { runId: reviewer.receipt.runId, digest: reviewer.receipt.integrity.digest },
			correlation: INDEPENDENT_GATE_CORRELATION,
		});
		const tampered = { ...gate.artifact, integrity: { ...gate.artifact.integrity, digest: "0".repeat(64) } };
		strictEqual(
			reduceRouteQuality({ subject: builder, receipts: [builder, reviewer], gateArtifacts: [tampered] }).label,
			"unmeasured",
		);
		strictEqual(
			reduceRouteQuality({ subject: builder, receipts: [builder, reviewer], gateArtifacts: [gate.artifact] }).label,
			"unmeasured",
		);
	});

	it("eval linkage requires an exact assignment and receipt digest", () => {
		const subject = receipt("assignment", {
			quality: createRunReceiptQuality({ runtimeEnforceable: false, enforcementPassed: null }),
		});
		const artifact = {
			version: 4 as const,
			evalId: "eval-1",
			results: [
				{ assignmentId: subject.receipt.runId, terminalReceiptDigest: subject.receipt.integrity.digest, pass: true },
			],
		};
		const source = { artifact, digest: routeQualityEvalDigest(artifact) };
		strictEqual(reduceRouteQuality({ subject, receipts: [subject], evalArtifacts: [source] }).label, "pass");
		const wrong = {
			version: 4 as const,
			evalId: artifact.evalId,
			results: [{ assignmentId: subject.receipt.runId, terminalReceiptDigest: "b".repeat(64), pass: true }],
		};
		strictEqual(
			reduceRouteQuality({
				subject,
				receipts: [subject],
				evalArtifacts: [{ artifact: wrong, digest: routeQualityEvalDigest(wrong) }],
			}).label,
			"unmeasured",
		);
	});

	it("response schema evidence seals the canonical schema digest", () => {
		const left = createRunReceiptQuality({
			responseSchema: { type: "object", properties: { answer: { type: "string" } } },
			runtimeEnforceable: true,
			enforcementPassed: true,
		});
		const right = createRunReceiptQuality({
			responseSchema: { properties: { answer: { type: "string" } }, type: "object" },
			runtimeEnforceable: true,
			enforcementPassed: true,
		});
		strictEqual(left.responseSchema.schemaDigest, right.responseSchema.schemaDigest);
		strictEqual(
			left.responseSchema.schemaDigest,
			canonicalResponseSchemaDigest({ type: "object", properties: { answer: { type: "string" } } }),
		);
	});

	it("duplicate source ingestion is idempotent", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "clio-route-history-idempotent-"));
		roots.push(stateDir);
		const history = createRouteHistoryStore({ stateDir });
		const record = {
			version: 3 as const,
			receiptDigest: "a".repeat(64),
			assignmentId: "assignment",
			route: candidate(),
			executionRole: "builder" as const,
			qualityLabel: "pass" as const,
			reliability: "success" as const,
			firstPass: true,
			completedCostUsd: 0.1,
			completedPhaseTiming: null,
			cacheRead: false,
			sourceDigests: ["a".repeat(64)],
			settledAt: "2026-07-20T00:00:01.000Z",
		};
		strictEqual(history.upsert(record), "inserted");
		strictEqual(history.upsert(record), "duplicate");
		strictEqual(history.all().length, 1);
	});

	it("quality lower bound ignores unmeasured observations", () => {
		const measured = estimateRoute(Array.from({ length: 6 }, () => routeSample("pass")));
		const mixed = estimateRoute([
			...Array.from({ length: 6 }, () => routeSample("pass")),
			...Array.from({ length: 50 }, () => routeSample("unmeasured")),
		]);
		strictEqual(mixed.qualityLabeledCount, 6);
		strictEqual(mixed.unmeasuredCount, 50);
		strictEqual(mixed.qualityLowerBound, measured.qualityLowerBound);
	});

	it("active eligibility requires six labeled outcomes and the posture floor", () => {
		const fivePasses = estimateRoute(Array.from({ length: 5 }, () => routeSample("pass")));
		const sixFailures = estimateRoute(Array.from({ length: 6 }, () => routeSample("fail")));
		const sixPasses = estimateRoute(Array.from({ length: 6 }, () => routeSample("pass")));
		strictEqual(clearsPostureFloors(fivePasses, "balanced"), false);
		strictEqual(sixFailures.qualityLowerBound, 0);
		ok(sixPasses.qualityLowerBound >= 0.6);
		strictEqual(clearsPostureFloors(sixPasses, "balanced"), true);
	});

	it("active mode refuses unsatisfiable posture floors", () => {
		const route = candidate();
		const activeReadiness = { ready: true, gaps: [], labelsNeeded: 0 };
		throws(
			() =>
				decideRoute({
					mode: "active",
					posture: "balanced",
					executedRoute: route,
					candidates: [
						{
							candidate: route,
							estimate: estimateRoute([]),
							activeReadiness,
							rejection: null,
						},
					],
					independenceSubject: null,
					hardConstraints: ["authority"],
					maxFallbacks: 0,
					decisionDurationMs: 0,
					agentSelection: {
						request: "explicit",
						baselineAgentId: route.agentId,
						evaluations: [
							{
								agentId: route.agentId,
								specFingerprint: route.specFingerprint,
								executionRole: route.executionRole,
								authority: "workspace-edit",
								rejections: [],
								coldPrior: DEFAULT_ROUTE_PRIOR,
								priorReasons: [],
							},
						],
						readiness: [
							{
								agentId: route.agentId,
								specFingerprint: route.specFingerprint,
								executionRole: route.executionRole,
								ready: true,
								candidateCount: 1,
								readyCandidateCount: 1,
								routes: [{ candidate: route, report: activeReadiness }],
							},
						],
						authorityBasis: null,
					},
				}),
			/posture-floors-unsatisfiable/,
		);
	});

	it("cancellation policy and permission outcomes are reliability-neutral", () => {
		const neutral = estimateRoute([
			{
				...routeSample("unmeasured"),
				reliability: "neutral",
				firstPass: false,
				completedCostUsd: null,
				completedEndToEndMs: null,
			},
		]);
		strictEqual(neutral.reliability, 0.5);
	});

	it("failed fast attempts do not improve completed cost or latency", () => {
		const failed = estimateRoute([
			{ ...routeSample("fail"), reliability: "failure", completedCostUsd: null, completedEndToEndMs: null },
		]);
		deepStrictEqual([failed.expectedCostUsd, failed.expectedEndToEndMs], [1, 120_000]);
	});
});

/** Every decision crosses the staged durable boundary; there is no direct writer. */
function writeGateDecision(draft: GateDecisionDraft): { artifact: GateDecisionArtifact; path: string } {
	return materializePendingGateDecision(stagePendingGateDecision(draft));
}
