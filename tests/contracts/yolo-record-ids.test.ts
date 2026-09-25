import { deepStrictEqual, equal } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { councilTopologies } from "../../src/domains/dispatch/council-topology.js";
import {
	type GateDecisionArtifact,
	gateDecisionsDirectory,
	materializePendingGateDecision,
	preparePendingGateDecisionRecovery,
	stagePendingGateDecision,
	verifyGateDecisionArtifact,
} from "../../src/domains/dispatch/gate-decisions.js";
import { gateTopology } from "../../src/domains/dispatch/gate-topology.js";
import { verifyReceiptIntegrity, withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { fixedRouteDecision, isRouteDecisionAgentSelection } from "../../src/domains/dispatch/route-decision.js";
import { explainRouteDecision } from "../../src/domains/dispatch/routing-intent.js";
import type { RunPlanProvenance } from "../../src/domains/dispatch/types.js";
import {
	adaptGateDecisionReviewStatus,
	composeTrustStatus,
	validateTrustStatus,
} from "../../src/domains/evidence/trust-status.js";
import type { ResolvedDispatchPlanArtifact } from "../../src/tools/dispatch-plan.js";
import { scoutPlanAuthorityGranted } from "../../src/tools/dispatch-scout.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";

const oldBasis = "full-auto-policy";
const newBasis = "yolo-policy";

test("old and new route authority ids verify in sealed receipts", () => {
	const envelope = fixtureEnvelope("yolo-route");
	const candidate = {
		agentId: "coder",
		specFingerprint: "spec",
		executionRole: "builder" as const,
		targetId: "local",
		modelId: "model-a",
		runtimeId: "openai",
		nodeId: "local",
		toolSignature: "tools",
		promptCompositionHash: "prompt",
		endpointIdentityHash: "endpoint",
		settingsFingerprint: "settings",
	};
	for (const basis of [oldBasis, newBasis]) {
		const decision = fixedRouteDecision(candidate);
		decision.agentSelection.request = "auto";
		decision.agentSelection.activation = "active";
		decision.agentSelection.authorityBasis = basis as typeof decision.agentSelection.authorityBasis;
		decision.agentSelection.authorityTransition = {
			from: "coder",
			to: "coder",
			basis: basis as "yolo-policy",
		};
		equal(isRouteDecisionAgentSelection(decision.agentSelection), true);
		const receipt = withReceiptIntegrity({ ...fixtureReceiptDraft(envelope), routeDecision: decision }, envelope);
		deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
		if (receipt.routingIntent === undefined) throw new Error("routing intent unexpectedly absent");
		equal(explainRouteDecision(decision, receipt.routingIntent).agentSelection.authorityTransition?.basis, newBasis);
	}
});

test("old and new gate outcomes verify and project under the yolo names", () => {
	const stateDir = mkdtempSync(join(tmpdir(), "clio-yolo-gate-"));
	try {
		const subject = { runId: "candidate", digest: "a".repeat(64) };
		const confirmation = { id: "judge", digest: "b".repeat(64) };
		const base = {
			group: "yolo-gate",
			topology: "compete" as const,
			cycle: 1,
			subjects: [subject],
			winner: { index: 1, subject, branch: "clio-coder/compete/yolo-gate/1" },
			confirmation,
			detail: "full-auto applied judge",
		};
		const newArtifact = materializePendingGateDecision(
			stagePendingGateDecision(
				{
					...base,
					outcome: "yolo-applied" as const,
					detail: "yolo applied judge",
				},
				{ stateDir },
			),
		).artifact;
		deepStrictEqual(verifyGateDecisionArtifact(newArtifact), { ok: true });
		const oldDecision = {
			version: 2,
			id: "old-yolo-gate",
			group: base.group,
			topology: base.topology,
			cycle: base.cycle,
			outcome: "full-auto-applied",
			subjects: [subject],
			winner: base.winner,
			confirmation,
			detail: base.detail,
			createdAt: "2026-09-05T00:00:00.000Z",
		};
		const oldPayload = { contract: "clio-coder.gateDecision.integrity", ...oldDecision };
		const oldArtifact = {
			...oldDecision,
			integrity: {
				algorithm: "sha256" as const,
				digest: createHash("sha256").update(JSON.stringify(oldPayload)).digest("hex"),
			},
		} as unknown as GateDecisionArtifact;
		deepStrictEqual(verifyGateDecisionArtifact(oldArtifact), { ok: true });
		const pendingPayload = {
			contract: "clio-coder.gateDecision.pending",
			version: 1,
			kind: "decision",
			id: oldArtifact.id,
			decision: { ...oldPayload, integrity: oldArtifact.integrity },
			createdAt: oldArtifact.createdAt,
		};
		const pendingRecord = {
			version: 1,
			kind: "decision",
			id: oldArtifact.id,
			decision: oldArtifact,
			createdAt: oldArtifact.createdAt,
			integrity: {
				algorithm: "sha256",
				digest: createHash("sha256").update(JSON.stringify(pendingPayload)).digest("hex"),
			},
		};
		const pendingDir = join(gateDecisionsDirectory(stateDir), "pending");
		mkdirSync(pendingDir, { recursive: true });
		writeFileSync(join(pendingDir, `${oldArtifact.id}.json`), JSON.stringify(pendingRecord));
		const recovered = preparePendingGateDecisionRecovery(stateDir);
		equal(recovered.ready.length, 1);
		const ready = recovered.ready[0];
		if (ready === undefined) throw new Error("pending gate record was not recovered");
		deepStrictEqual(materializePendingGateDecision(ready).artifact, oldArtifact);
		const projected = gateTopology(stateDir).decisions;
		equal(projected.length, 2);
		for (const decision of projected) {
			equal(decision.outcome, "yolo-applied");
			equal(decision.reason, "yolo-applied-winner");
		}
		const status = adaptGateDecisionReviewStatus(oldArtifact, subject.runId, { ok: true });
		if (status.state === "absent") throw new Error("gate status unexpectedly absent");
		equal(status.authority.id, "yolo-gate-policy");
		const historical = {
			...composeTrustStatus({ independentReview: status }),
			independentReview: { ...status, authority: { ...status.authority, id: "full-auto-gate-policy" } },
		};
		const readBack = validateTrustStatus(historical);
		if (!readBack.ok) throw new Error(readBack.reason);
		const review = readBack.status.independentReview;
		if (review.state === "absent") throw new Error("gate status unexpectedly absent");
		equal(review.authority.id, "yolo-gate-policy");
	} finally {
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("historical council approval projects as yolo", () => {
	const envelope = fixtureEnvelope("council-old-approval");
	const plan: RunPlanProvenance = {
		hash: "plan",
		topology: "council",
		taskCount: 1,
		approval: "full-auto" as RunPlanProvenance["approval"],
		source: null,
	};
	const council = councilTopologies([{ ...envelope, plan, council: { group: "council-1", label: "member", round: 1 } }]);
	equal(council.councils[0]?.approval, "yolo");
});

test("historical Scout plan authority remains valid at yolo", () => {
	const artifact = {
		tasks: [{ authorityGrant: { basis: oldBasis, requested: "read-only" } }],
	} as unknown as ResolvedDispatchPlanArtifact;
	equal(scoutPlanAuthorityGranted(artifact, false, true), true);
	equal(scoutPlanAuthorityGranted(artifact, false, false), false);
});
