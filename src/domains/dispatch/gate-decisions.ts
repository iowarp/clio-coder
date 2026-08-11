/**
 * Append-only coordinator evidence for review and compete decisions.
 *
 * Worker receipts seal before a reviewer verdict or judge winner can be
 * parsed. Mutating those receipts would invalidate their evidence, so the
 * coordinator writes a separate integrity-covered artifact that links the
 * decider receipt to every subject receipt. One file per decision keeps the
 * crash boundary atomic and makes pass/fail/winner evidence recoverable
 * without an in-memory tool result.
 */

import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { clioStateDir } from "../../core/xdg.js";
import { atomicWrite } from "../../engine/session.js";
import { parseVerifierResult, type VerifierCheck, type VerifierResult } from "../agents/result-contract.js";
import type { GateRouteCorrelation } from "./execution-role.js";
import type { RunGateSubjectRef } from "./types.js";

export type GateDecisionOutcome =
	| "pass"
	| "fail"
	| "revise"
	| "exhausted"
	| "winner"
	| "no-winner"
	| "operator-confirmed"
	| "full-auto-applied";

export interface GateDecisionRef {
	id: string;
	digest: string;
}

/**
 * Sealed correlation between the decider route and the subject route it graded.
 *
 * A verdict from a route that shares the subject's agent or model family is a
 * measurement of the same system twice. Recording the correlation on the
 * decision means a small fleet still produces a usable audit trail: the gate is
 * visible and its independence is a stated fact rather than an assumption.
 */
export type GateDecisionCorrelation = Pick<
	GateRouteCorrelation,
	"agent" | "target" | "modelFamily" | "runtime" | "node" | "independent"
>;

export interface GateDecisionArtifact {
	version: 2;
	id: string;
	group: string;
	topology: "review" | "compete";
	cycle: number;
	outcome: GateDecisionOutcome;
	subjects: RunGateSubjectRef[];
	decider?: RunGateSubjectRef;
	/** Required whenever a decider run produced this decision. */
	correlation?: GateDecisionCorrelation;
	winner?: { index: number; subject: RunGateSubjectRef; branch: string };
	/** Prior judge decision explicitly confirmed by a supervised operator. */
	confirmation?: GateDecisionRef;
	detail?: string;
	createdAt: string;
	integrity: { algorithm: "sha256"; digest: string };
}

// ---------------------------------------------------------------------------
// Structured gate results
// ---------------------------------------------------------------------------

/**
 * A gate result is a typed answer to the coordinator's question, not a trailing
 * prose line. Two schemas exist because the two topologies ask different
 * questions:
 *
 *   - Review asks "does this work pass?", which is exactly the Slice 2
 *     `verifier-report` contract. There is deliberately no `revise` verdict:
 *     whether a failure is worth another cycle is the coordinator's bounded
 *     continuation policy, not a decision the reviewed model gets to author.
 *   - Compete asks "which candidate wins?", which no recipe contract expresses
 *     because it is a property of the topology rather than of any one agent.
 *     That schema therefore lives here, next to the winner shape the decision
 *     artifact already validates, and reuses the same typed check evidence.
 */
export type GateCheck = VerifierCheck;

export type ReviewGateResult = VerifierResult;

export interface CompeteGateResult {
	/** 1-based candidate ordinal, validated against the enumerated subjects. */
	winner: number;
	checks: ReadonlyArray<GateCheck>;
}

export type GateResultParse<T> = { ok: true; result: T } | { ok: false; reason: string };

/** Parse a reviewer answer under the Slice 2 Verifier contract. */
function parseReviewGateResult(output: string): GateResultParse<ReviewGateResult> {
	const result = parseVerifierResult(output);
	return result === null
		? { ok: false, reason: "reviewer did not return a valid verifier report" }
		: { ok: true, result };
}

export interface ReviewGateDecisionInput {
	group: string;
	cycle: number;
	/** True when this cycle is the configured bound, so a failure is terminal. */
	terminalCycle: boolean;
	subjects: RunGateSubjectRef[];
	decider: RunGateSubjectRef;
	correlation: GateDecisionCorrelation;
	output: string;
}

export interface ReviewGateDecision {
	draft: GateDecisionDraft;
	/** Terminal verdict, or null when the gate continues or needs the operator. */
	verdict: "pass" | "fail" | null;
	/** Structured findings threaded to the next builder, or null when the gate ended. */
	findings: string | null;
	/** Operator-facing reason when the gate ended without a verdict. */
	needsDecision: string | null;
}

/**
 * Apply the coordinator's review policy to one reviewer answer.
 *
 * The reviewer answers pass or fail under its Slice 2 contract and nothing
 * else. `revise` is this function's bounded continuation decision: a failure
 * with cycles left earns another builder attempt, the same failure at the bound
 * is simply the terminal fail, and an answer that does not satisfy the contract
 * is a broken gate rather than a free extra cycle. The live loop and the
 * crash-replay path share this so a recovered decision is byte-identical to the
 * one the original process would have written.
 */
export function decideReviewGate(input: ReviewGateDecisionInput): ReviewGateDecision {
	const base = {
		group: input.group,
		topology: "review" as const,
		cycle: input.cycle,
		subjects: input.subjects,
		decider: input.decider,
		correlation: input.correlation,
	};
	const parsed = parseReviewGateResult(input.output);
	if (!parsed.ok) {
		return {
			draft: { ...base, outcome: "exhausted", detail: parsed.reason },
			verdict: null,
			findings: null,
			needsDecision: `review gate produced no structured verdict in cycle ${input.cycle}: ${parsed.reason}`,
		};
	}
	if (parsed.result.verdict === "pass" || input.terminalCycle) {
		return {
			draft: { ...base, outcome: parsed.result.verdict },
			verdict: parsed.result.verdict,
			findings: null,
			needsDecision: null,
		};
	}
	const failed = parsed.result.checks.filter((check) => !check.passed);
	return {
		draft: { ...base, outcome: "revise", detail: `reviewer reported ${failed.length} failed check(s)` },
		verdict: null,
		findings: JSON.stringify({ verdict: "fail", checks: failed }),
		needsDecision: null,
	};
}

function parseGateChecks(value: unknown): GateCheck[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const checks: GateCheck[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) return null;
		const keys = Object.keys(entry);
		if (
			keys.some((key) => key !== "name" && key !== "passed" && key !== "evidence") ||
			typeof entry.name !== "string" ||
			entry.name.trim().length === 0 ||
			typeof entry.passed !== "boolean" ||
			typeof entry.evidence !== "string" ||
			entry.evidence.trim().length === 0
		) {
			return null;
		}
		checks.push({ name: entry.name, passed: entry.passed, evidence: entry.evidence });
	}
	return checks;
}

/** Parse a judge answer. The winner must name an enumerated candidate ordinal. */
export function parseCompeteGateResult(output: string, candidateCount: number): GateResultParse<CompeteGateResult> {
	let value: unknown;
	try {
		value = JSON.parse(output) as unknown;
	} catch {
		return { ok: false, reason: "judge result must be valid JSON" };
	}
	if (!isRecord(value)) return { ok: false, reason: "judge result must be a JSON object" };
	if (Object.keys(value).some((key) => key !== "winner" && key !== "checks")) {
		return { ok: false, reason: "judge result has unknown fields" };
	}
	const winner = value.winner;
	if (typeof winner !== "number" || !Number.isSafeInteger(winner) || winner < 1 || winner > candidateCount) {
		return { ok: false, reason: `judge winner must be an integer 1..${candidateCount}` };
	}
	const checks = parseGateChecks(value.checks);
	if (checks === null) return { ok: false, reason: "judge result must carry typed checks with evidence" };
	return { ok: true, result: { winner, checks } };
}

export type GateDecisionDraft = Omit<GateDecisionArtifact, "version" | "id" | "createdAt" | "integrity"> & {
	createdAt?: string;
};

export type GateDecisionVerification = { ok: true } | { ok: false; reason: string };

/**
 * Raw terminal output staged as soon as the reviewer/judge event stream
 * settles. At this point the decider receipt may still be finalizing, so the
 * run id is durable but its receipt digest is intentionally not guessed.
 */
export interface PendingGateOutputDraft {
	group: string;
	topology: "review" | "compete";
	cycle: number;
	subjects: RunGateSubjectRef[];
	deciderRunId: string;
	finalOutput: string;
	/** Review cycle bound was reached; revise/unparseable also implies exhaustion. */
	terminalCycle?: boolean;
	/** Repository resource owner for compete restart settlement. */
	resourceRoot?: string;
	createdAt?: string;
}

export interface PendingGateOutputRecord {
	version: 1;
	kind: "output";
	id: string;
	group: string;
	topology: "review" | "compete";
	cycle: number;
	subjects: RunGateSubjectRef[];
	deciderRunId: string;
	finalOutput: string;
	terminalCycle?: boolean;
	resourceRoot?: string;
	createdAt: string;
	integrity: { algorithm: "sha256"; digest: string };
}

/**
 * A fully resolved decision waiting to be materialized. The nested artifact
 * already has its final id and digest, making replay safe when a process dies
 * after the artifact rename but before pending-file removal.
 */
export interface PendingGateArtifactRecord {
	version: 1;
	kind: "decision";
	id: string;
	decision: GateDecisionArtifact;
	finalOutput?: string;
	resourceRoot?: string;
	createdAt: string;
	integrity: { algorithm: "sha256"; digest: string };
}

export type PendingGateDecisionRecord = PendingGateOutputRecord | PendingGateArtifactRecord;

export interface PendingGateDecisionHandle {
	record: PendingGateDecisionRecord;
	path: string;
	stateDir: string;
}

export interface PendingGateDecisionReadResult {
	records: PendingGateDecisionHandle[];
	errors: Array<{ path: string; message: string }>;
}

export interface PendingGateDecisionRecoveryPlan {
	/** Resolved records that passed final-artifact collision checks but are not materialized yet. */
	ready: PendingGateDecisionHandle[];
	/** Output-first records need the caller's protocol/policy parser and receipt digest. */
	unresolved: PendingGateDecisionHandle[];
}

export interface StagePendingGateDecisionOptions {
	/** Exact final assistant output, retained until the artifact is durable. */
	finalOutput?: string;
	resourceRoot?: string;
	stateDir?: string;
}

function decisionsDirectory(stateDir = clioStateDir()): string {
	return join(stateDir, "gate-decisions");
}

function pendingDecisionsDirectory(stateDir = clioStateDir()): string {
	return join(decisionsDirectory(stateDir), "pending");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSubjectRef(value: unknown): value is RunGateSubjectRef {
	if (!isRecord(value) || typeof value.runId !== "string" || value.runId.trim().length === 0) return false;
	return typeof value.digest === "string" && /^[0-9a-f]{64}$/.test(value.digest);
}

function isSafeDecisionId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 256 && /^[A-Za-z0-9._-]+$/.test(value);
}

function isCorrelation(value: unknown): value is GateDecisionCorrelation {
	if (!isRecord(value)) return false;
	const fields = ["agent", "target", "modelFamily", "runtime", "node", "independent"] as const;
	if (Object.keys(value).some((key) => !(fields as ReadonlyArray<string>).includes(key))) return false;
	if (!fields.every((field) => typeof value[field] === "boolean")) return false;
	// The independence rule is part of the sealed fact, not the writer's opinion:
	// a shared agent or model family is what makes a verdict self-confirming.
	return value.independent === (!value.agent && !value.modelFamily);
}

function semanticError(value: unknown): string | null {
	if (!isRecord(value)) return "gate decision is not an object";
	if (value.version !== 2) return "unsupported gate decision version";
	if (!isSafeDecisionId(value.id)) return "gate decision id invalid";
	if (typeof value.group !== "string" || value.group.length === 0) return "gate decision group invalid";
	if (value.topology !== "review" && value.topology !== "compete") return "gate decision topology invalid";
	if (typeof value.cycle !== "number" || !Number.isInteger(value.cycle) || value.cycle < 1) {
		return "gate decision cycle invalid";
	}
	const reviewOutcome =
		value.outcome === "pass" || value.outcome === "fail" || value.outcome === "revise" || value.outcome === "exhausted";
	const competeOutcome =
		value.outcome === "winner" ||
		value.outcome === "no-winner" ||
		value.outcome === "operator-confirmed" ||
		value.outcome === "full-auto-applied";
	if ((value.topology === "review" && !reviewOutcome) || (value.topology === "compete" && !competeOutcome)) {
		return "gate decision outcome is incompatible with topology";
	}
	if (!Array.isArray(value.subjects) || value.subjects.length === 0 || !value.subjects.every(isSubjectRef)) {
		return "gate decision subjects invalid";
	}
	if (value.decider !== undefined && !isSubjectRef(value.decider)) return "gate decision decider invalid";
	if (value.decider === undefined) {
		if (value.correlation !== undefined) return "gate decision correlation requires a decider";
	} else if (!isCorrelation(value.correlation)) {
		return "gate decision correlation invalid";
	}
	if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
		return "gate decision timestamp invalid";
	}
	const needsWinner =
		value.outcome === "winner" || value.outcome === "operator-confirmed" || value.outcome === "full-auto-applied";
	if (needsWinner) {
		if (
			!isRecord(value.winner) ||
			typeof value.winner.index !== "number" ||
			!Number.isInteger(value.winner.index) ||
			value.winner.index < 1 ||
			!isSubjectRef(value.winner.subject) ||
			typeof value.winner.branch !== "string" ||
			value.winner.branch !== `clio/compete/${value.group}/${value.winner.index}`
		) {
			return "gate decision winner invalid";
		}
		const winnerSubject = value.winner.subject as RunGateSubjectRef;
		if (!value.subjects.some((subject) => subject.runId === winnerSubject.runId)) {
			return "gate decision winner is not a subject";
		}
	} else if (value.winner !== undefined) {
		return "gate decision winner is not valid for this outcome";
	}
	const needsConfirmation = value.outcome === "operator-confirmed" || value.outcome === "full-auto-applied";
	if (needsConfirmation) {
		if (
			!isRecord(value.confirmation) ||
			typeof value.confirmation.id !== "string" ||
			value.confirmation.id.length === 0 ||
			typeof value.confirmation.digest !== "string" ||
			!/^[0-9a-f]{64}$/.test(value.confirmation.digest)
		) {
			return "gate decision confirmation invalid";
		}
	} else if (value.confirmation !== undefined) {
		return "gate decision confirmation is not valid for this outcome";
	}
	if (value.detail !== undefined && typeof value.detail !== "string") return "gate decision detail invalid";
	if (
		!isRecord(value.integrity) ||
		value.integrity.algorithm !== "sha256" ||
		typeof value.integrity.digest !== "string"
	) {
		return "gate decision integrity invalid";
	}
	return null;
}

function safeGroup(group: string): string {
	const safe = group.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
	return safe.length > 0 ? safe : "gate";
}

function newDecisionId(group: string): string {
	return `${safeGroup(group)}-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
}

function decisionArtifactPath(id: string, stateDir = clioStateDir()): string {
	return join(decisionsDirectory(stateDir), `${id}.json`);
}

function pendingDecisionPath(id: string, stateDir = clioStateDir()): string {
	return join(pendingDecisionsDirectory(stateDir), `${id}.json`);
}

function decisionPayload(decision: Omit<GateDecisionArtifact, "integrity">): Record<string, unknown> {
	return {
		contract: "clio.gateDecision.integrity",
		version: decision.version,
		id: decision.id,
		group: decision.group,
		topology: decision.topology,
		cycle: decision.cycle,
		outcome: decision.outcome,
		subjects: decision.subjects.map((subject) => ({ runId: subject.runId, digest: subject.digest })),
		...(decision.decider !== undefined
			? { decider: { runId: decision.decider.runId, digest: decision.decider.digest } }
			: {}),
		...(decision.correlation !== undefined ? { correlation: { ...decision.correlation } } : {}),
		...(decision.winner !== undefined
			? {
					winner: {
						index: decision.winner.index,
						subject: {
							runId: decision.winner.subject.runId,
							digest: decision.winner.subject.digest,
						},
						branch: decision.winner.branch,
					},
				}
			: {}),
		...(decision.confirmation !== undefined
			? { confirmation: { id: decision.confirmation.id, digest: decision.confirmation.digest } }
			: {}),
		...(decision.detail !== undefined ? { detail: decision.detail } : {}),
		createdAt: decision.createdAt,
	};
}

function decisionDigest(decision: Omit<GateDecisionArtifact, "integrity">): string {
	return createHash("sha256")
		.update(JSON.stringify(decisionPayload(decision)), "utf8")
		.digest("hex");
}

function artifactWithoutIntegrity(artifact: GateDecisionArtifact): Omit<GateDecisionArtifact, "integrity"> {
	const result: Omit<GateDecisionArtifact, "integrity"> = {
		version: artifact.version,
		id: artifact.id,
		group: artifact.group,
		topology: artifact.topology,
		cycle: artifact.cycle,
		outcome: artifact.outcome,
		subjects: artifact.subjects.map((subject) => ({ ...subject })),
		createdAt: artifact.createdAt,
	};
	if (artifact.decider !== undefined) result.decider = { ...artifact.decider };
	if (artifact.correlation !== undefined) result.correlation = { ...artifact.correlation };
	if (artifact.winner !== undefined) {
		result.winner = {
			index: artifact.winner.index,
			subject: { ...artifact.winner.subject },
			branch: artifact.winner.branch,
		};
	}
	if (artifact.confirmation !== undefined) result.confirmation = { ...artifact.confirmation };
	if (artifact.detail !== undefined) result.detail = artifact.detail;
	return result;
}

export function verifyGateDecisionArtifact(artifact: GateDecisionArtifact): GateDecisionVerification {
	const invalid = semanticError(artifact);
	if (invalid !== null) return { ok: false, reason: invalid };
	if (!/^[0-9a-f]{64}$/.test(artifact.integrity.digest)) return { ok: false, reason: "gate decision integrity invalid" };
	return decisionDigest(artifactWithoutIntegrity(artifact)) === artifact.integrity.digest
		? { ok: true }
		: { ok: false, reason: "gate decision integrity mismatch" };
}

function buildGateDecisionArtifact(
	draft: GateDecisionDraft,
	id = newDecisionId(draft.group),
	createdAt = draft.createdAt ?? new Date().toISOString(),
): GateDecisionArtifact {
	if (draft.group.trim().length === 0) throw new Error("gate decision group is required");
	if (!Number.isInteger(draft.cycle) || draft.cycle < 1)
		throw new Error("gate decision cycle must be a positive integer");
	if (draft.subjects.length === 0) throw new Error("gate decision requires at least one subject receipt");
	const withoutIntegrity: Omit<GateDecisionArtifact, "integrity"> = {
		version: 2,
		id,
		group: draft.group,
		topology: draft.topology,
		cycle: draft.cycle,
		outcome: draft.outcome,
		subjects: draft.subjects.map((subject) => ({ ...subject })),
		createdAt,
	};
	if (draft.decider !== undefined) withoutIntegrity.decider = { ...draft.decider };
	if (draft.correlation !== undefined) withoutIntegrity.correlation = { ...draft.correlation };
	if (draft.winner !== undefined) {
		withoutIntegrity.winner = {
			index: draft.winner.index,
			subject: { ...draft.winner.subject },
			branch: draft.winner.branch,
		};
	}
	if (draft.confirmation !== undefined) withoutIntegrity.confirmation = { ...draft.confirmation };
	if (draft.detail !== undefined) withoutIntegrity.detail = draft.detail;
	const artifact: GateDecisionArtifact = {
		...withoutIntegrity,
		integrity: { algorithm: "sha256", digest: decisionDigest(withoutIntegrity) },
	};
	const verification = verifyGateDecisionArtifact(artifact);
	if (!verification.ok) throw new Error(verification.reason);
	return artifact;
}

function readVerifiedArtifact(path: string): GateDecisionArtifact {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch (error) {
		throw new Error(
			`gate decision artifact is unreadable at ${path}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const artifact = value as GateDecisionArtifact;
	const verification = verifyGateDecisionArtifact(artifact);
	if (!verification.ok) throw new Error(`gate decision artifact is invalid at ${path}: ${verification.reason}`);
	return artifact;
}

function persistGateDecisionArtifact(
	artifact: GateDecisionArtifact,
	stateDir: string,
	allowIdenticalExisting: boolean,
): { artifact: GateDecisionArtifact; path: string } {
	const verification = verifyGateDecisionArtifact(artifact);
	if (!verification.ok) throw new Error(verification.reason);
	const directory = decisionsDirectory(stateDir);
	mkdirSync(directory, { recursive: true });
	const path = decisionArtifactPath(artifact.id, stateDir);
	if (existsSync(path)) {
		const existing = readVerifiedArtifact(path);
		if (
			allowIdenticalExisting &&
			existing.id === artifact.id &&
			existing.integrity.digest === artifact.integrity.digest
		) {
			return { artifact: existing, path };
		}
		throw new Error(`gate decision artifact collision: ${artifact.id}`);
	}
	atomicWrite(path, JSON.stringify(artifact, null, 2));
	return { artifact, path };
}

type PendingGateRecordWithoutIntegrity =
	| Omit<PendingGateOutputRecord, "integrity">
	| Omit<PendingGateArtifactRecord, "integrity">;

function cloneGateDecisionArtifact(artifact: GateDecisionArtifact): GateDecisionArtifact {
	return {
		...artifactWithoutIntegrity(artifact),
		integrity: { ...artifact.integrity },
	};
}

function pendingRecordPayload(record: PendingGateRecordWithoutIntegrity): Record<string, unknown> {
	if (record.kind === "output") {
		return {
			contract: "clio.gateDecision.pending",
			version: record.version,
			kind: record.kind,
			id: record.id,
			group: record.group,
			topology: record.topology,
			cycle: record.cycle,
			subjects: record.subjects.map((subject) => ({ runId: subject.runId, digest: subject.digest })),
			deciderRunId: record.deciderRunId,
			finalOutput: record.finalOutput,
			...(record.terminalCycle !== undefined ? { terminalCycle: record.terminalCycle } : {}),
			...(record.resourceRoot !== undefined ? { resourceRoot: record.resourceRoot } : {}),
			createdAt: record.createdAt,
		};
	}
	const decisionWithoutIntegrity = artifactWithoutIntegrity(record.decision);
	return {
		contract: "clio.gateDecision.pending",
		version: record.version,
		kind: record.kind,
		id: record.id,
		decision: {
			...decisionPayload(decisionWithoutIntegrity),
			integrity: { ...record.decision.integrity },
		},
		...(record.finalOutput !== undefined ? { finalOutput: record.finalOutput } : {}),
		...(record.resourceRoot !== undefined ? { resourceRoot: record.resourceRoot } : {}),
		createdAt: record.createdAt,
	};
}

function pendingRecordDigest(record: PendingGateRecordWithoutIntegrity): string {
	return createHash("sha256")
		.update(JSON.stringify(pendingRecordPayload(record)), "utf8")
		.digest("hex");
}

function pendingRecordWithoutIntegrity(record: PendingGateDecisionRecord): PendingGateRecordWithoutIntegrity {
	if (record.kind === "output") {
		return {
			version: record.version,
			kind: record.kind,
			id: record.id,
			group: record.group,
			topology: record.topology,
			cycle: record.cycle,
			subjects: record.subjects.map((subject) => ({ ...subject })),
			deciderRunId: record.deciderRunId,
			finalOutput: record.finalOutput,
			...(record.terminalCycle !== undefined ? { terminalCycle: record.terminalCycle } : {}),
			...(record.resourceRoot !== undefined ? { resourceRoot: record.resourceRoot } : {}),
			createdAt: record.createdAt,
		};
	}
	return {
		version: record.version,
		kind: record.kind,
		id: record.id,
		decision: cloneGateDecisionArtifact(record.decision),
		...(record.finalOutput !== undefined ? { finalOutput: record.finalOutput } : {}),
		...(record.resourceRoot !== undefined ? { resourceRoot: record.resourceRoot } : {}),
		createdAt: record.createdAt,
	};
}

function pendingSemanticError(value: unknown): string | null {
	if (!isRecord(value)) return "pending gate decision is not an object";
	if (value.version !== 1) return "unsupported pending gate decision version";
	if (!isSafeDecisionId(value.id)) return "pending gate decision id invalid";
	if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) {
		return "pending gate decision timestamp invalid";
	}
	if (
		!isRecord(value.integrity) ||
		value.integrity.algorithm !== "sha256" ||
		typeof value.integrity.digest !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.integrity.digest)
	) {
		return "pending gate decision integrity invalid";
	}
	if (value.kind === "output") {
		if (typeof value.group !== "string" || value.group.trim().length === 0) {
			return "pending gate output group invalid";
		}
		if (value.topology !== "review" && value.topology !== "compete") {
			return "pending gate output topology invalid";
		}
		if (typeof value.cycle !== "number" || !Number.isInteger(value.cycle) || value.cycle < 1) {
			return "pending gate output cycle invalid";
		}
		if (!Array.isArray(value.subjects) || value.subjects.length === 0 || !value.subjects.every(isSubjectRef)) {
			return "pending gate output subjects invalid";
		}
		if (typeof value.deciderRunId !== "string" || value.deciderRunId.trim().length === 0) {
			return "pending gate output decider run id invalid";
		}
		if (typeof value.finalOutput !== "string") return "pending gate output text invalid";
		if (value.terminalCycle !== undefined && typeof value.terminalCycle !== "boolean") {
			return "pending gate output terminal-cycle marker invalid";
		}
		if (value.resourceRoot !== undefined && (typeof value.resourceRoot !== "string" || value.resourceRoot.length === 0)) {
			return "pending gate output resource root invalid";
		}
		return null;
	}
	if (value.kind !== "decision") return "pending gate decision kind invalid";
	if (!isRecord(value.decision)) return "pending gate decision artifact invalid";
	const verification = verifyGateDecisionArtifact(value.decision as unknown as GateDecisionArtifact);
	if (!verification.ok) return `pending gate decision artifact invalid: ${verification.reason}`;
	if (value.decision.id !== value.id) return "pending gate decision artifact id mismatch";
	if (value.decision.createdAt !== value.createdAt) return "pending gate decision artifact timestamp mismatch";
	if (value.finalOutput !== undefined && typeof value.finalOutput !== "string") {
		return "pending gate decision output invalid";
	}
	if (value.resourceRoot !== undefined && (typeof value.resourceRoot !== "string" || value.resourceRoot.length === 0)) {
		return "pending gate decision resource root invalid";
	}
	return null;
}

/** Verify both the pending envelope and its nested final artifact, when resolved. */
export function verifyPendingGateDecisionRecord(record: PendingGateDecisionRecord): GateDecisionVerification {
	const invalid = pendingSemanticError(record);
	if (invalid !== null) return { ok: false, reason: invalid };
	return pendingRecordDigest(pendingRecordWithoutIntegrity(record)) === record.integrity.digest
		? { ok: true }
		: { ok: false, reason: "pending gate decision integrity mismatch" };
}

function clonePendingGateDecisionRecord(record: PendingGateDecisionRecord): PendingGateDecisionRecord {
	const without = pendingRecordWithoutIntegrity(record);
	return {
		...without,
		integrity: { ...record.integrity },
	} as PendingGateDecisionRecord;
}

function parsePendingGateDecisionRecord(value: unknown): PendingGateDecisionRecord {
	const invalid = pendingSemanticError(value);
	if (invalid !== null) throw new Error(invalid);
	const record = clonePendingGateDecisionRecord(value as PendingGateDecisionRecord);
	const verification = verifyPendingGateDecisionRecord(record);
	if (!verification.ok) throw new Error(verification.reason);
	return record;
}

function assertPendingHandlePath(handle: PendingGateDecisionHandle): void {
	const expected = pendingDecisionPath(handle.record.id, handle.stateDir);
	if (resolve(handle.path) !== resolve(expected)) {
		throw new Error(`pending gate decision path does not match id ${handle.record.id}`);
	}
}

function pendingHandle(record: PendingGateDecisionRecord, stateDir: string): PendingGateDecisionHandle {
	return {
		record: clonePendingGateDecisionRecord(record),
		path: pendingDecisionPath(record.id, stateDir),
		stateDir,
	};
}

function persistPendingGateDecision(
	record: PendingGateDecisionRecord,
	stateDir: string,
	allowReplace: boolean,
): PendingGateDecisionHandle {
	const verification = verifyPendingGateDecisionRecord(record);
	if (!verification.ok) throw new Error(verification.reason);
	const path = pendingDecisionPath(record.id, stateDir);
	mkdirSync(dirname(path), { recursive: true });
	if (!allowReplace && existsSync(path)) throw new Error(`pending gate decision collision: ${record.id}`);
	atomicWrite(path, JSON.stringify(record, null, 2));
	return pendingHandle(record, stateDir);
}

function loadPendingGateDecision(handle: PendingGateDecisionHandle): PendingGateDecisionHandle | null {
	assertPendingHandlePath(handle);
	if (!existsSync(handle.path)) return null;
	const record = parsePendingGateDecisionRecord(JSON.parse(readFileSync(handle.path, "utf8")) as unknown);
	if (record.id !== handle.record.id) throw new Error("pending gate decision changed identity on disk");
	return pendingHandle(record, handle.stateDir);
}

function fsyncDirectoryBestEffort(path: string): void {
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		fsyncSync(fd);
	} catch {
		// Some filesystems/platforms reject directory fsync. A resurrected
		// pending record is harmless because materialization is idempotent.
	} finally {
		if (fd !== null) closeSync(fd);
	}
}

function clearPendingGateDecision(handle: PendingGateDecisionHandle): void {
	assertPendingHandlePath(handle);
	rmSync(handle.path, { force: true });
	fsyncDirectoryBestEffort(dirname(handle.path));
}

function sameSubjectRefs(left: ReadonlyArray<RunGateSubjectRef>, right: ReadonlyArray<RunGateSubjectRef>): boolean {
	return (
		left.length === right.length &&
		left.every((subject, index) => {
			const other = right[index];
			return other !== undefined && subject.runId === other.runId && subject.digest === other.digest;
		})
	);
}

/**
 * Cross the output-loss boundary before waiting for the decider receipt. The
 * returned handle is later resolved with that receipt's authenticated digest.
 */
export function stagePendingGateOutput(
	draft: PendingGateOutputDraft,
	stateDir = clioStateDir(),
): PendingGateDecisionHandle {
	const id = newDecisionId(draft.group);
	const withoutIntegrity: Omit<PendingGateOutputRecord, "integrity"> = {
		version: 1,
		kind: "output",
		id,
		group: draft.group,
		topology: draft.topology,
		cycle: draft.cycle,
		subjects: draft.subjects.map((subject) => ({ ...subject })),
		deciderRunId: draft.deciderRunId,
		finalOutput: draft.finalOutput,
		...(draft.terminalCycle !== undefined ? { terminalCycle: draft.terminalCycle } : {}),
		...(draft.resourceRoot !== undefined ? { resourceRoot: draft.resourceRoot } : {}),
		createdAt: draft.createdAt ?? new Date().toISOString(),
	};
	const record: PendingGateOutputRecord = {
		...withoutIntegrity,
		integrity: { algorithm: "sha256", digest: pendingRecordDigest(withoutIntegrity) },
	};
	if (existsSync(decisionArtifactPath(id, stateDir))) throw new Error(`gate decision artifact collision: ${id}`);
	return persistPendingGateDecision(record, stateDir, false);
}

/** Stage a fully parsed decision before attempting its final artifact write. */
export function stagePendingGateDecision(
	draft: GateDecisionDraft,
	options: StagePendingGateDecisionOptions = {},
): PendingGateDecisionHandle {
	const stateDir = options.stateDir ?? clioStateDir();
	const id = newDecisionId(draft.group);
	const createdAt = draft.createdAt ?? new Date().toISOString();
	const decision = buildGateDecisionArtifact(draft, id, createdAt);
	const withoutIntegrity: Omit<PendingGateArtifactRecord, "integrity"> = {
		version: 1,
		kind: "decision",
		id,
		decision,
		...(options.finalOutput !== undefined ? { finalOutput: options.finalOutput } : {}),
		...(options.resourceRoot !== undefined ? { resourceRoot: options.resourceRoot } : {}),
		createdAt,
	};
	const record: PendingGateArtifactRecord = {
		...withoutIntegrity,
		integrity: { algorithm: "sha256", digest: pendingRecordDigest(withoutIntegrity) },
	};
	if (existsSync(decisionArtifactPath(id, stateDir))) throw new Error(`gate decision artifact collision: ${id}`);
	return persistPendingGateDecision(record, stateDir, false);
}

/**
 * Bind a staged reviewer/judge output to its now-sealed receipt and parsed
 * outcome. The decision-bearing replacement is atomic; either the raw output
 * or the complete artifact survives a crash.
 */
export function resolvePendingGateDecision(
	handle: PendingGateDecisionHandle,
	draft: GateDecisionDraft,
): PendingGateDecisionHandle {
	const loaded = loadPendingGateDecision(handle);
	if (loaded === null) throw new Error(`pending gate decision is missing: ${handle.record.id}`);
	if (loaded.record.kind === "decision") {
		const expected = buildGateDecisionArtifact(draft, loaded.record.id, loaded.record.createdAt);
		if (expected.integrity.digest !== loaded.record.decision.integrity.digest) {
			throw new Error("pending gate decision was already resolved to a different artifact");
		}
		return loaded;
	}
	const pending = loaded.record;
	if (
		draft.group !== pending.group ||
		draft.topology !== pending.topology ||
		draft.cycle !== pending.cycle ||
		!sameSubjectRefs(draft.subjects, pending.subjects)
	) {
		throw new Error("resolved gate decision does not match staged output context");
	}
	if (draft.decider === undefined || draft.decider.runId !== pending.deciderRunId) {
		throw new Error("resolved gate decision does not match staged decider run");
	}
	if (draft.createdAt !== undefined && draft.createdAt !== pending.createdAt) {
		throw new Error("resolved gate decision cannot change the staged timestamp");
	}
	const decision = buildGateDecisionArtifact(draft, pending.id, pending.createdAt);
	const withoutIntegrity: Omit<PendingGateArtifactRecord, "integrity"> = {
		version: 1,
		kind: "decision",
		id: pending.id,
		decision,
		finalOutput: pending.finalOutput,
		...(pending.resourceRoot !== undefined ? { resourceRoot: pending.resourceRoot } : {}),
		createdAt: pending.createdAt,
	};
	const resolvedRecord: PendingGateArtifactRecord = {
		...withoutIntegrity,
		integrity: { algorithm: "sha256", digest: pendingRecordDigest(withoutIntegrity) },
	};
	return persistPendingGateDecision(resolvedRecord, loaded.stateDir, true);
}

/** Write/reuse the reserved final artifact, then durably remove its WAL record. */
export function materializePendingGateDecision(handle: PendingGateDecisionHandle): {
	artifact: GateDecisionArtifact;
	path: string;
} {
	const loaded = loadPendingGateDecision(handle);
	if (loaded === null) {
		if (handle.record.kind !== "decision") {
			throw new Error(`pending gate output is missing before resolution: ${handle.record.id}`);
		}
		const path = decisionArtifactPath(handle.record.decision.id, handle.stateDir);
		if (!existsSync(path)) throw new Error(`pending gate decision and artifact are both missing: ${handle.record.id}`);
		const artifact = readVerifiedArtifact(path);
		if (artifact.integrity.digest !== handle.record.decision.integrity.digest) {
			throw new Error(`gate decision artifact conflicts with completed pending record: ${handle.record.id}`);
		}
		return { artifact, path };
	}
	if (loaded.record.kind !== "decision") {
		throw new Error(`pending gate output requires receipt resolution: ${loaded.record.id}`);
	}
	const written = persistGateDecisionArtifact(loaded.record.decision, loaded.stateDir, true);
	const persisted = readVerifiedArtifact(written.path);
	if (persisted.integrity.digest !== loaded.record.decision.integrity.digest) {
		throw new Error(`materialized gate decision does not match pending record: ${loaded.record.id}`);
	}
	clearPendingGateDecision(loaded);
	return { artifact: persisted, path: written.path };
}

/** Resolve an output-first record, materialize its artifact, and clear the WAL. */
export function finalizePendingGateDecision(
	handle: PendingGateDecisionHandle,
	draft: GateDecisionDraft,
): { artifact: GateDecisionArtifact; path: string } {
	return materializePendingGateDecision(resolvePendingGateDecision(handle, draft));
}

export function readPendingGateDecisions(stateDir = clioStateDir()): PendingGateDecisionReadResult {
	const directory = pendingDecisionsDirectory(stateDir);
	if (!existsSync(directory)) return { records: [], errors: [] };
	const records: PendingGateDecisionHandle[] = [];
	const errors: PendingGateDecisionReadResult["errors"] = [];
	for (const name of readdirSync(directory)
		.filter((entry) => entry.endsWith(".json"))
		.sort()) {
		const path = join(directory, name);
		try {
			const record = parsePendingGateDecisionRecord(JSON.parse(readFileSync(path, "utf8")) as unknown);
			if (name !== `${record.id}.json`) throw new Error("pending gate decision filename does not match its id");
			records.push({ record, path, stateDir });
		} catch (error) {
			errors.push({ path, message: error instanceof Error ? error.message : String(error) });
		}
	}
	return { records, errors };
}

/** Fail closed on any final artifact that conflicts with a resolved WAL record. */
export function preflightPendingGateDecisionMaterialization(handles: ReadonlyArray<PendingGateDecisionHandle>): void {
	for (const handle of handles) {
		if (handle.record.kind !== "decision") continue;
		const path = decisionArtifactPath(handle.record.decision.id, handle.stateDir);
		if (!existsSync(path)) continue;
		const existing = readVerifiedArtifact(path);
		if (existing.integrity.digest !== handle.record.decision.integrity.digest) {
			throw new Error(`gate decision artifact conflicts with pending record: ${handle.record.id}`);
		}
	}
}

/**
 * Build a mutation-free restart plan. Raw-output records remain unresolved so
 * dispatch can apply its receipt-backed protocol parser. Corrupt journals and
 * conflicting final artifacts fail closed before external resources settle.
 */
export function preparePendingGateDecisionRecovery(stateDir = clioStateDir()): PendingGateDecisionRecoveryPlan {
	const pending = readPendingGateDecisions(stateDir);
	if (pending.errors.length > 0) {
		throw new Error(
			`pending gate decision journal is untrustworthy: ${pending.errors
				.map((entry) => `${entry.path}: ${entry.message}`)
				.join("; ")}`,
		);
	}
	const ready = pending.records.filter((handle) => handle.record.kind === "decision");
	preflightPendingGateDecisionMaterialization(ready);
	return {
		ready,
		unresolved: pending.records.filter((handle) => handle.record.kind === "output"),
	};
}

export function readGateDecisionArtifacts(
	group?: string,
	stateDir = clioStateDir(),
): Array<{ artifact: GateDecisionArtifact; path: string }> {
	const directory = decisionsDirectory(stateDir);
	if (!existsSync(directory)) return [];
	const out: Array<{ artifact: GateDecisionArtifact; path: string }> = [];
	for (const name of readdirSync(directory)
		.filter((entry) => entry.endsWith(".json"))
		.sort()) {
		const path = join(directory, name);
		try {
			const artifact = JSON.parse(readFileSync(path, "utf8")) as GateDecisionArtifact;
			if (group !== undefined && artifact.group !== group) continue;
			if (!verifyGateDecisionArtifact(artifact).ok) continue;
			out.push({ artifact, path });
		} catch {
			// Read APIs ignore malformed artifacts; verification tooling can inspect
			// the file directly without treating it as trusted evidence.
		}
	}
	return out;
}

/** Discover trusted coordinator decisions from receipt identities alone. */
export function readGateDecisionArtifactsForRunIds(
	runIds: ReadonlySet<string>,
	stateDir = clioStateDir(),
): Array<{ artifact: GateDecisionArtifact; path: string }> {
	if (runIds.size === 0) return [];
	return readGateDecisionArtifacts(undefined, stateDir).filter(({ artifact }) => {
		if (artifact.subjects.some((subject) => runIds.has(subject.runId))) return true;
		if (artifact.decider !== undefined && runIds.has(artifact.decider.runId)) return true;
		return artifact.winner !== undefined && runIds.has(artifact.winner.subject.runId);
	});
}
