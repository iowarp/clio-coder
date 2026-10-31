/**
 * A finished run's trust as every projection reads it (#434): the run DTO's seal verdict, the assessment its producer
 * sealed into the run scope, and the review gates decided about the run after it sealed. The sealed assessment stays
 * as journaled; a later gate decision composes over it only when its artifact verifies and it cites the run by the
 * digest of the run.settled the seal covers. `runEvidence` and the dispatch domain's `runEvidenceOf` both read this,
 * so the two projections of one run cannot disagree on its trust.
 */

import type { RunTelemetryV1 } from "../../core/telemetry/dto.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import { readSealedScopeRecords } from "../telemetry/run-record.js";
import { telemetryScopeOf } from "../telemetry/seal.js";
import { compareCodepoints } from "./ordering.js";
import {
	adaptGateDecisionReviewStatus,
	type CanonicalTrustStatus,
	composeTrustStatus,
	type GateDecisionFacts,
	inspectRunTrustStatus,
	normalizeTrustStatus,
	type RunIntegrity,
} from "./trust-status.js";
import type { EvidenceSeverity, EvidenceTag, EvidenceVerdict } from "./types.js";

export type SealedRunAssessment = NonNullable<RunTelemetryV1["assessment"]>;

export interface RunTrustFinding {
	id: string;
	severity: EvidenceSeverity;
	tag: EvidenceTag;
	/** The finding's prose from the scope's findings object; null when the scope does not hold it. */
	message: string | null;
}

export interface RunTrustRead {
	integrity: RunIntegrity;
	trust: CanonicalTrustStatus;
	/** The sealed assessment; null unless the seal verifies and the run was assessed before it sealed. */
	assessment: SealedRunAssessment | null;
	verdicts: EvidenceVerdict[];
	findings: RunTrustFinding[];
}

/** A `gate.decided` record from a journal whose seal verifies, with the time it was journaled (#434). */
export type GateReview = GateDecisionFacts & { at: string };

/** Gates in decision order: the latest one is the run's review, earlier cycles stay listed as verdicts. */
export function compareGates(left: GateReview, right: GateReview): number {
	return (
		compareCodepoints(left.at, right.at) ||
		left.cycle - right.cycle ||
		compareCodepoints(left.decisionId, right.decisionId)
	);
}

/** The finding the independent-review axis yields, worded once for the assessment and its later recomposition. */
export function reviewFinding(
	review: CanonicalTrustStatus["independentReview"]["state"],
	succeeded: boolean,
): { severity: EvidenceSeverity; tag: EvidenceTag; message: string } | null {
	if (review === "failed")
		return { severity: "warn", tag: "independent-review", message: "independent review failed for this run" };
	if (review === "not_independent")
		return {
			severity: "warn",
			tag: "independent-review",
			message: "review was not independent of the run it judged",
		};
	if (review === "inconclusive")
		return { severity: "info", tag: "independent-review", message: "independent review was inconclusive" };
	if (succeeded && (review === "absent" || review === "unknown"))
		return {
			severity: "info",
			tag: "independent-review",
			message: "run was not independently reviewed; its result rests on its own record",
		};
	return null;
}

/**
 * The run's trust from its DTO and the authenticated gate decisions naming it (`readRunGateIndex`). `gates` may hold
 * any decisions; only those the seal's assessment did not already judge and whose subject digest is the sealed
 * run.settled's compose over it.
 */
export function readRunTrust(record: RunTelemetryV1 | null, gates: ReadonlyArray<GateReview> = []): RunTrustRead {
	const inspection = inspectRunTrustStatus(record);
	const verified = inspection.integrity.state === "verified";
	const assessment = verified ? (record?.assessment ?? null) : null;
	// The seal now vouches for the record the producer assessed, so its verdict replaces the producer's.
	let trust =
		assessment === null
			? inspection.status
			: composeTrustStatus(normalizeTrustStatus(assessment.trust), {
					artifactIntegrity: inspection.status.artifactIntegrity,
				});
	const content = assessment?.content?.state === "resolved" ? assessment.content.value : null;
	const messages = new Map((content?.findings ?? []).map((entry) => [entry.id, entry.message]));
	let findings: RunTrustFinding[] = (assessment?.findings ?? []).map((entry) => ({
		id: entry.id,
		severity: entry.severity,
		tag: entry.tag,
		message: messages.get(entry.id) ?? null,
	}));
	const verdicts: EvidenceVerdict[] = (assessment?.verdicts ?? []).map((verdict) => ({ ...verdict }));
	const settled = verified && record !== null ? record.settled : null;
	if (settled === null || record === null)
		return { integrity: inspection.integrity, trust, assessment, verdicts, findings };
	const runId = record.row.runId;
	const judged = new Set(verdicts.map((verdict) => verdict.decisionId));
	let reviewed = false;
	for (const gate of [...gates].sort(compareGates)) {
		if (judged.has(gate.decisionId)) continue;
		// A gate cites the run by the digest of its run.settled; a decision about another settlement is not this run's.
		if (gate.subjects.find((subject) => subject.runId === runId)?.digest !== settled.digest) continue;
		const review = adaptGateDecisionReviewStatus(gate, runId, { ok: true });
		verdicts.push({ decisionId: gate.decisionId, digest: gate.digest, outcome: gate.outcome, review: review.state });
		trust = composeTrustStatus(trust, { independentReview: review });
		reviewed = true;
	}
	if (reviewed && assessment !== null) {
		// The sealed finding spoke for the review as it stood at the seal; the later decision replaces it.
		const prior = findings.find((entry) => entry.tag === "independent-review");
		findings = findings.filter((entry) => entry.tag !== "independent-review");
		const finding = reviewFinding(trust.independentReview.state, settled.outcome === "succeeded");
		if (finding !== null)
			findings.push({
				id: prior?.id ?? `finding-${String(assessment.findings.length + 1).padStart(3, "0")}`,
				...finding,
			});
	}
	return { integrity: inspection.integrity, trust, assessment, verdicts, findings };
}

/** How far a run's lineage is followed to its coordinator: past this, no fleet nests (#434). */
const MAX_LINEAGE = 32;

interface ScopeFacts {
	/** The gate decisions the scope's own owner journaled. */
	gates: GateReview[];
	parentRunId: string | null;
	sessionId: string | null;
}

/** The lineage a run's records name: the run that dispatched it and the session that owns it. */
function lineageOf(runId: string, records: ReadonlyArray<TelemetryRecord>) {
	let parentRunId: string | null = null;
	let sessionId: string | null = null;
	for (const record of records) {
		if (record.ctx.runId !== runId) continue;
		parentRunId ??= record.ctx.parentRunId ?? null;
		sessionId ??= record.ctx.sessionId;
		if (parentRunId !== null && sessionId !== null) break;
	}
	return { parentRunId, sessionId };
}

function scopeFacts(
	scope: { kind: "run" | "session"; id: string },
	records: ReadonlyArray<TelemetryRecord>,
): ScopeFacts {
	const gates: GateReview[] = [];
	for (const record of records) {
		if (record.k !== "gate.decided") continue;
		let owner: { kind: string; id: string };
		try {
			owner = telemetryScopeOf(record.ctx);
		} catch {
			// A record with no owner speaks for no scope.
			continue;
		}
		// Only the scope's own owner decides in it; the seal binds the scope, not each record's claim to it.
		if (owner.kind === scope.kind && owner.id === scope.id) gates.push({ ...record.data, at: record.t });
	}
	return { gates, ...(scope.kind === "run" ? lineageOf(scope.id, records) : { parentRunId: null, sessionId: null }) };
}

/** A reader of sealed scopes' gate facts that opens each scope once. */
function sealedScopeReader(stateDir: string) {
	const cache = new Map<string, ScopeFacts | null>();
	return (scope: { kind: "run" | "session"; id: string }): ScopeFacts | null => {
		const key = `${scope.kind}:${scope.id}`;
		if (cache.has(key)) return cache.get(key) ?? null;
		let facts: ScopeFacts | null = null;
		try {
			const records = readSealedScopeRecords(stateDir, scope);
			facts = records === null ? null : scopeFacts(scope, records);
		} catch {
			// An unreadable scope authenticates nothing.
			facts = null;
		}
		cache.set(key, facts);
		return facts;
	};
}

/**
 * The review gates decided about a run, from the `gate.decided` records its coordinators and sessions journaled under
 * a seal that verifies (#434). The run's own records, authenticated by its seal or held by its producer, name the run
 * that dispatched it, whose own records name the next, up to the lineage root, and the session owning each. Gate artifact files are dispatch state and never a source here, so a removed or swapped sidecar changes
 * nothing; a decision whose coordinator scope has not sealed yet is not admitted until it does.
 */
function gateReviewsOf(runId: string, own: ScopeFacts, read: ReturnType<typeof sealedScopeReader>): GateReview[] {
	const out: GateReview[] = [];
	const seen = new Set<string>();
	const sessions = new Set<string>();
	const admit = (facts: ScopeFacts | null) => {
		for (const gate of facts?.gates ?? []) {
			if (!gate.subjects.some((subject) => subject.runId === runId)) continue;
			const key = `${gate.decisionId}\u0000${gate.digest}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(gate);
		}
	};
	// A run that coordinated its own gate, such as a headless main agent, journaled the decision in its own scope.
	admit(own);
	let parentRunId = own.parentRunId;
	if (own.sessionId !== null) sessions.add(own.sessionId);
	const visited = new Set([runId]);
	while (parentRunId !== null && !visited.has(parentRunId) && visited.size <= MAX_LINEAGE) {
		visited.add(parentRunId);
		const facts = read({ kind: "run", id: parentRunId });
		admit(facts);
		if (facts?.sessionId) sessions.add(facts.sessionId);
		parentRunId = facts?.parentRunId ?? null;
	}
	for (const session of sessions) admit(read({ kind: "session", id: session }));
	return out.sort(compareGates);
}

/** The review gates decided about a run whose own records its producer holds, before its scope seals. */
export function readGateReviews(
	stateDir: string,
	runId: string,
	records: ReadonlyArray<TelemetryRecord>,
): GateReview[] {
	return gateReviewsOf(runId, scopeFacts({ kind: "run", id: runId }, records), sealedScopeReader(stateDir));
}

/**
 * The review gates decided about each run on this host, reading each coordinator and session scope once, so a listing
 * does not reread a shared coordinator per run. A run whose own scope does not verify has no authenticated lineage and
 * composes no later review.
 */
export function readRunGateIndex(stateDir: string): (runId: string) => GateReview[] {
	const read = sealedScopeReader(stateDir);
	return (runId) => {
		const own = read({ kind: "run", id: runId });
		return own === null ? [] : gateReviewsOf(runId, own, read);
	};
}
