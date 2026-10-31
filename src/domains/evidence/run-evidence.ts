/**
 * A finished run's evidence as every surface reads it (#434): the run DTO's seal verdict and, under a seal that
 * verifies, the assessment its producer journaled before sealing. The sealed run scope is the evidence; nothing here
 * reads the mutable run ledger.
 */

import { readdir } from "node:fs/promises";
import type { RunTelemetryV1 } from "../../core/telemetry/dto.js";
import { isDecisionRecord } from "../session/entries.js";
import { telemetryRunsDirectory } from "../telemetry/paths.js";
import { readRunRecordAsync } from "../telemetry/run-record.js";
import { compareCodepoints } from "./ordering.js";
import type { RunProvenanceView } from "./provenance.js";
import { composeTrustStatus, inspectRunTrustStatus, normalizeTrustStatus } from "./trust-status.js";
import type { EvidenceDecision, EvidenceFinding, EvidenceTag, RunEvidence } from "./types.js";

/** The run's evidence from its DTO; null when no run scope was read. */
export function runEvidence(runId: string, record: RunTelemetryV1 | null): RunEvidence {
	const inspection = inspectRunTrustStatus(record);
	const integrity = inspection.integrity;
	const verified = integrity.state === "verified";
	const settled = record?.settled ?? null;
	const assessment = verified ? (record?.assessment ?? null) : null;
	let trust = inspection.status;
	const findings: EvidenceFinding[] = [];
	const decisions: EvidenceDecision[] = [];
	let provenance: RunProvenanceView | null = null;
	if (integrity.state !== "verified") {
		// A seal that was checked and rejected is the security warning; a run not yet sealed is only not evidence.
		findings.push({
			id: "finding-000",
			severity: integrity.state === "failed" ? "warn" : "info",
			tag: "run-seal",
			runId,
			message: integrity.reason,
		});
	}
	if (assessment !== null) {
		// The seal now vouches for the record the producer assessed, so its verdict replaces the producer's.
		trust = composeTrustStatus(normalizeTrustStatus(assessment.trust), {
			artifactIntegrity: inspection.status.artifactIntegrity,
		});
		const content = assessment.content?.state === "resolved" ? assessment.content.value : null;
		const messages = new Map((content?.findings ?? []).map((entry) => [entry.id, entry.message]));
		for (const entry of assessment.findings)
			findings.push({
				id: entry.id,
				severity: entry.severity,
				tag: entry.tag,
				runId,
				message: messages.get(entry.id) ?? "finding text unavailable in this run scope",
			});
		for (const decision of content?.decisions ?? [])
			if (isDecisionRecord(decision.record))
				decisions.push({ runId, sessionId: decision.sessionId, ref: decision.ref, record: decision.record });
		const recorded = assessment.provenance;
		provenance = {
			...(recorded?.pipeline ? { pipeline: recorded.pipeline } : {}),
			...(recorded?.personaOverride ? { personaOverride: recorded.personaOverride } : {}),
		};
	}
	if (verified && settled?.escalations) provenance = { ...(provenance ?? {}), escalation: { ...settled.escalations } };
	const tools = verified && settled ? settled.tools : [];
	const grounding = verified ? settled?.validationGrounding : null;
	return {
		runId,
		sessionId: record?.row.sessionId ?? null,
		integrity,
		trust,
		assessedAt: assessment?.at ?? null,
		settled:
			settled === null
				? null
				: {
						at: settled.at,
						startedAt: settled.startedAt,
						endedAt: settled.endedAt,
						agentId: settled.agentId,
						targetId: settled.route.targetId,
						runtimeId: settled.route.runtimeId,
						wireModelId: settled.route.wireModelId,
						outcome: settled.outcome,
						exitCode: settled.exitCode,
					},
		firstPassSuccess: assessment?.firstPassSuccess ?? null,
		failureCause: assessment?.failureCause ?? null,
		tags: [...new Set(findings.map((entry) => entry.tag))].sort(compareCodepoints) as EvidenceTag[],
		findings,
		verdicts: (assessment?.verdicts ?? []).map((verdict) => ({ ...verdict })),
		provenance: provenance !== null && Object.keys(provenance).length > 0 ? provenance : null,
		decisions,
		ungroundedClaims: grounding ? Math.max(0, grounding.claimed - grounding.grounded) : 0,
		totals:
			record === null || !verified || settled === null
				? null
				: {
						toolCalls: settled.toolCalls,
						toolErrors: tools.reduce((total, stat) => total + stat.errors, 0),
						blockedToolCalls: tools.reduce((total, stat) => total + stat.blocked, 0),
						// The folded quantities keep a partially measured run's known subtotal and its coverage (#434).
						tokens: record.row.tokens,
						usd: record.row.usd,
						wallTimeMs: Math.max(0, Date.parse(settled.endedAt) - Date.parse(settled.startedAt) || 0),
					},
	};
}

/** One run's evidence read from its run scope. */
export async function inspectRunEvidence(stateDir: string, runId: string): Promise<RunEvidence> {
	return runEvidence(runId, await readRunRecordAsync(stateDir, runId));
}

/** Every run scope on this host, newest settlement first; a run that never settled sorts last. */
export async function listRunEvidence(stateDir: string): Promise<RunEvidence[]> {
	let names: string[];
	try {
		names = await readdir(telemetryRunsDirectory(stateDir));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const out: RunEvidence[] = [];
	for (const runId of names.sort(compareCodepoints)) {
		try {
			out.push(await inspectRunEvidence(stateDir, runId));
		} catch {
			// A directory that is not a readable run scope is not a run; the listing stays scriptable.
		}
	}
	return out.sort(
		(left, right) =>
			compareCodepoints(right.settled?.at ?? "", left.settled?.at ?? "") || compareCodepoints(left.runId, right.runId),
	);
}
