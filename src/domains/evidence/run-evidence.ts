/**
 * A finished run's evidence as every surface reads it (#434): the run DTO's seal verdict and, under a seal that
 * verifies, the assessment its producer journaled before sealing. The sealed run scope is the evidence; nothing here
 * reads the mutable run ledger.
 */

import { listStateDirectory } from "../../core/state-boundary.js";
import type { RunTelemetryV1 } from "../../core/telemetry/dto.js";
import { isBaselineValidation } from "../agents/result-contract.js";
import { sanitizeCallTargetText } from "../safety/call-target.js";
import { isDecisionRecord } from "../session/entries.js";
import { telemetryRunsDirectory } from "../telemetry/paths.js";
import { readRunRecordAsync } from "../telemetry/run-record.js";
import { compareCodepoints } from "./ordering.js";
import type { RunProvenanceView } from "./provenance.js";
import { type GateReview, readRunGateIndex, readRunTrust } from "./run-trust.js";
import { settledQualityFails, settledQualityValidates } from "./trust-status.js";
import type { EvidenceDecision, EvidenceFinding, EvidenceTag, RunEvidence } from "./types.js";

/**
 * The run's evidence from its DTO and the journaled gate decisions naming it (`readRunGateIndex`); a later review
 * composes over the sealed assessment as `readRunTrust` admits it.
 */
export function runEvidence(
	runId: string,
	record: RunTelemetryV1 | null,
	gates: ReadonlyArray<GateReview> = [],
): RunEvidence {
	const read = readRunTrust(record, gates);
	const integrity = read.integrity;
	const verified = integrity.state === "verified";
	const settled = record?.settled ?? null;
	const assessment = read.assessment;
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
		for (const entry of read.findings)
			findings.push({
				id: entry.id,
				severity: entry.severity,
				tag: entry.tag,
				runId,
				message: entry.message ?? "finding text unavailable in this run scope",
			});
		const content = assessment.content?.state === "resolved" ? assessment.content.value : null;
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
	const unclassified = verified ? settled?.unclassifiedAfterLastCheck : undefined;
	return {
		runId,
		sessionId: record?.row.sessionId ?? null,
		cwd: assessment?.content?.state === "resolved" ? assessment.content.value.cwd : null,
		integrity,
		trust: read.trust,
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
						...(settled.stepPipeline !== undefined ? { stepPipeline: { ...settled.stepPipeline } } : {}),
					},
		firstPassSuccess: assessment?.firstPassSuccess ?? null,
		failureCause: assessment?.failureCause ?? null,
		tags: [...new Set(findings.map((entry) => entry.tag))].sort(compareCodepoints) as EvidenceTag[],
		findings,
		verdicts: read.verdicts,
		provenance: provenance !== null && Object.keys(provenance).length > 0 ? provenance : null,
		decisions,
		ungroundedClaims: grounding ? Math.max(0, grounding.claimed - grounding.grounded) : 0,
		...(unclassified
			? { unclassifiedAfterLastCheck: { count: unclassified.count, commands: [...unclassified.commands] } }
			: {}),
		quality: verified ? storedQuality(record) : null,
		totals:
			record === null || !verified || settled === null
				? null
				: {
						toolCalls: settled.toolCalls,
						toolErrors: tools.reduce((total, stat) => total + stat.errors, 0),
						// A refused ask is a call that did not run, as the run line and `toolActivity` count it (FX-3).
						blockedToolCalls: tools.reduce((total, stat) => total + stat.blocked + (stat.asked ?? 0), 0),
						// The folded quantities keep a partially measured run's known subtotal and its coverage (#434).
						tokens: record.row.tokens,
						usd: record.row.usd,
						wallTimeMs: Math.max(0, Date.parse(settled.endedAt) - Date.parse(settled.startedAt) || 0),
					},
	};
}

const VALIDATION_NAME_MAX_CHARS = 200;

/**
 * The quality verdict the run settled, the validation names its result object reports as failed, and its baselines. All
 * are read as stored; nothing here judges the result again. A baseline ran before the change, so it is listed apart and
 * never as a failure, by the rule the result contract judged quality with. A run no result contract judged, such as a
 * main-agent run, reads its sealed typed checks by the rule its trust status reads them with, so a green verify on the
 * final tree is a pass rather than unmeasured (bt-27).
 */
function storedQuality(record: RunTelemetryV1 | null): RunEvidence["quality"] {
	const quality = record?.settled?.quality ?? null;
	if (quality === null) return null;
	const contract = quality.resultContract;
	const reported =
		record?.result?.state === "resolved" ? record.result.value.output?.structured?.data.validations : null;
	const failedValidations: string[] = [];
	const baselines: { name: string; passed: boolean }[] = [];
	if (Array.isArray(reported))
		for (const entry of reported) {
			if (entry === null || typeof entry !== "object") continue;
			const { name, passed } = entry as { name?: unknown; passed?: unknown };
			if (typeof name !== "string" || name.trim().length === 0 || typeof passed !== "boolean") continue;
			const shown = sanitizeCallTargetText(name).slice(0, VALIDATION_NAME_MAX_CHARS);
			if (isBaselineValidation(entry)) baselines.push({ name: shown, passed });
			else if (!passed) failedValidations.push(shown);
		}
	const verdict =
		contract !== null
			? contract.quality
			: settledQualityFails(quality)
				? "fail"
				: settledQualityValidates(quality)
					? "pass"
					: "unmeasured";
	return { verdict, failedValidations, baselines };
}

/** One run's evidence read from its run scope beneath the state root, with the review gates decided about it. */
export async function inspectRunEvidence(stateDir: string, runId: string): Promise<RunEvidence> {
	return runEvidence(runId, await readRunRecordAsync(stateDir, runId), readRunGateIndex(stateDir)(runId));
}

/**
 * The information-flow restrictions a run's settled record carries: the set it inherited plus what it read, kept apart
 * from `RunEvidence` because only a caller about to carry the run's words somewhere durable asks. `known` is false when
 * the run never settled, so no record holds them.
 */
export async function inspectRunFlowProvenance(
	stateDir: string,
	runId: string,
): Promise<{ sessionId: string | null; restricted: boolean; known: boolean }> {
	const record = await readRunRecordAsync(stateDir, runId);
	const settled = record?.settled ?? null;
	return {
		sessionId: record?.row.sessionId ?? null,
		restricted: (settled?.flowRestrictions?.restrictions.length ?? 0) > 0,
		known: settled !== null,
	};
}

/**
 * Every run scope on this host, newest settlement first; a run that never settled sorts last. `skip` leaves out runs a
 * caller already holds without opening their scopes.
 */
export async function listRunEvidence(stateDir: string, skip?: (runId: string) => boolean): Promise<RunEvidence[]> {
	let names: string[];
	try {
		// A run store that is symlinked or resolves outside the state root is not this host's evidence (#434).
		names = await listStateDirectory(stateDir, telemetryRunsDirectory(stateDir));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const gates = readRunGateIndex(stateDir);
	const out: RunEvidence[] = [];
	for (const runId of names.sort(compareCodepoints)) {
		if (skip?.(runId)) continue;
		try {
			out.push(runEvidence(runId, await readRunRecordAsync(stateDir, runId), gates(runId)));
		} catch {
			// A directory that is not a readable run scope is not a run; the listing stays scriptable.
		}
	}
	return out.sort(
		(left, right) =>
			compareCodepoints(right.settled?.at ?? "", left.settled?.at ?? "") || compareCodepoints(left.runId, right.runId),
	);
}
