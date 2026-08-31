/**
 * Read-only projection of the durable coordinator gate decisions.
 *
 * Unlike a council, a gate has a record of its own. A reviewer verdict and a
 * judge's winner cannot be written back into the subject receipts without
 * invalidating them, so the coordinator seals a separate integrity-covered
 * artifact per decision that links the decider receipt to every subject
 * receipt. {@link gate-decisions.ts} owns writing and verifying those; this
 * module reads a bounded newest-first window of them and projects the shape.
 *
 * Two things stay behind. The decision `detail` is free prose that interpolates
 * a thrown message, a pipeline failure reason, a protected artifact list, or a
 * plan hash, so it is classified against a closed set and never quoted. And the
 * receipt digests are omitted outright: a verified artifact carries one per
 * subject by construction, so repeating them would be a fingerprint that tells
 * a reader nothing the run id does not.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clioStateDir } from "../../core/xdg.js";
import type { GateRouteCorrelation } from "./execution-role.js";
import {
	type GateDecisionArtifact,
	type GateDecisionOutcome,
	gateDecisionsDirectory,
	verifyGateDecisionArtifact,
} from "./gate-decisions.js";

/** How many decisions one projection reports, newest first. */
export const GATE_TOPOLOGY_MAX_DECISIONS = 8;

/** Subject receipts named per decision. A compete gate judges at most four. */
export const GATE_TOPOLOGY_MAX_SUBJECTS = 6;

/**
 * How many artifact files one listing will open.
 *
 * The directory is unbounded and a decision id sorts by its group before its
 * timestamp, so the newest decision is only discoverable by reading each file's
 * `createdAt`. The cap keeps the scan proportional on an installation that has
 * accumulated gates for months, at the cost of missing a decision older than
 * the cap. That is the right trade here, the same one {@link listFleetRuns}
 * takes, because this window only ever wants the recent end.
 */
export const GATE_TOPOLOGY_MAX_SCAN = 128;

/**
 * Why a gate ended the way it did, as a closed set.
 *
 * Every member is the coordinator's own classification of its own branch. The
 * durable `detail` string those branches write is not repeated: several
 * interpolate a receipt's failure reason, the names of protected artifacts a
 * candidate touched, or an approval request id, and any of the three would
 * carry prose across a boundary that exists to stop exactly that. Anything this
 * classifier does not recognise becomes `unclassified` rather than crossing.
 */
export type GateDecisionReason =
	| "all-candidates-failed"
	| "builder-run-failed"
	| "reviewer-run-failed"
	| "reviewer-checks-failed"
	| "reviewer-report-invalid"
	| "judge-run-failed"
	| "judge-result-invalid"
	| "judge-winner-out-of-range"
	| "judge-picked-failed-candidate"
	| "winner-touches-protected-artifact"
	| "operator-confirmed-winner"
	| "full-auto-applied-winner"
	| "unclassified";

export const GATE_DECISION_REASONS: ReadonlyArray<GateDecisionReason> = [
	"all-candidates-failed",
	"builder-run-failed",
	"reviewer-run-failed",
	"reviewer-checks-failed",
	"reviewer-report-invalid",
	"judge-run-failed",
	"judge-result-invalid",
	"judge-winner-out-of-range",
	"judge-picked-failed-candidate",
	"winner-touches-protected-artifact",
	"operator-confirmed-winner",
	"full-auto-applied-winner",
	"unclassified",
];

/**
 * Prefix rules, first match wins, ordered so no rule shadows another.
 *
 * These are matched against the exact strings the coordinator writes. A rule
 * failing to match costs its decision the specific reason and nothing else,
 * because `unclassified` is a real answer here: the operator still learns that
 * the gate ended and how, just not which branch produced the text.
 */
const REASON_RULES: ReadonlyArray<readonly [string, GateDecisionReason]> = [
	["every candidate builder failed", "all-candidates-failed"],
	["builder ended ", "builder-run-failed"],
	["reviewer ended ", "reviewer-run-failed"],
	["reviewer reported ", "reviewer-checks-failed"],
	["reviewer did not return a valid verifier report", "reviewer-report-invalid"],
	["judge ended ", "judge-run-failed"],
	["judge result must", "judge-result-invalid"],
	["judge result has unknown fields", "judge-result-invalid"],
	["judge winner must be an integer", "judge-winner-out-of-range"],
	["judge picked failed or missing candidate", "judge-picked-failed-candidate"],
	["judge-selected candidate ", "winner-touches-protected-artifact"],
	["operator confirmation ", "operator-confirmed-winner"],
	["full-auto applied ", "full-auto-applied-winner"],
];

/**
 * The identifier shape the decision store already guarantees for both its ids
 * and, transitively, its groups.
 *
 * A decision id is minted from a sanitized group plus a timestamp and random
 * suffix, and a group is a coordinator-minted gate id. Re-enforcing the shape
 * here means whatever wrote the file, the identifiers this projection reports
 * can carry no separator, space, quote, or control byte.
 */
const SAFE_GATE_IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/u;

/** The independence facts sealed on the decision, exactly as the artifact holds them. */
export type GateDecisionCorrelationFacts = Pick<
	GateRouteCorrelation,
	"agent" | "target" | "modelFamily" | "runtime" | "node" | "independent"
>;

export interface GateTopologyWinner {
	/** 1-based candidate ordinal the judge picked. */
	readonly index: number;
	readonly runId: string;
}

export interface GateTopologyDecision {
	readonly id: string;
	readonly group: string;
	readonly topology: "review" | "compete";
	readonly cycle: number;
	readonly outcome: GateDecisionOutcome;
	readonly decidedAt: string;
	/** Runs this decision graded, in the order the coordinator sealed them. */
	readonly subjects: readonly string[];
	readonly subjectsTruncated: boolean;
	/** The run that produced the verdict, or null when none ran. */
	readonly decider: string | null;
	/** Present exactly when a decider ran; the store requires the pair. */
	readonly correlation: GateDecisionCorrelationFacts | null;
	readonly winner: GateTopologyWinner | null;
	/** A prior judge decision this one confirmed, by id. */
	readonly confirms: string | null;
	readonly reason: GateDecisionReason | null;
}

export interface GateTopologyResult {
	/**
	 * Whether this installation has a decision store at all.
	 *
	 * An installation that has never run a gate and one whose gates all aged out
	 * both report no decisions, and they are different operator states, so the
	 * fact is read rather than inferred from an empty list.
	 */
	readonly present: boolean;
	readonly decisions: readonly GateTopologyDecision[];
	/** True when the scanned window held decisions older than the reported ones. */
	readonly truncated: boolean;
	/**
	 * Files in the scanned window whose integrity did not verify.
	 *
	 * The store's own read API drops these silently, which is right for a
	 * consumer that must not act on untrusted evidence and wrong for an operator
	 * surface: a gate artifact that no longer authenticates is exactly the thing
	 * worth knowing about. Counted, never opened for content.
	 */
	readonly unverifiable: number;
}

function classifyReason(detail: unknown): GateDecisionReason | null {
	if (typeof detail !== "string" || detail.length === 0) return null;
	return REASON_RULES.find(([prefix]) => detail.startsWith(prefix))?.[1] ?? "unclassified";
}

function safeIdentifier(value: unknown): string | null {
	return typeof value === "string" && SAFE_GATE_IDENTIFIER.test(value) ? value : null;
}

/** Newest decision first. An unparseable stamp sorts oldest rather than throwing. */
function byNewest(a: GateDecisionArtifact, b: GateDecisionArtifact): number {
	return (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
}

/**
 * Read a bounded window of verified decision artifacts, counting the rest.
 *
 * Reads defensively per file for the same reason the ledger scan does: one
 * artifact written by another build, half-written, or removed between the
 * listing and the open must cost that decision its row, never the whole
 * listing. A file that parses but fails its own integrity check is a different
 * state and is counted rather than dropped.
 */
function readDecisionWindow(stateDir: string): {
	present: boolean;
	artifacts: GateDecisionArtifact[];
	unverifiable: number;
} {
	const directory = gateDecisionsDirectory(stateDir);
	if (!existsSync(directory)) return { present: false, artifacts: [], unverifiable: 0 };
	let entries: string[];
	try {
		entries = readdirSync(directory).filter((name) => name.endsWith(".json"));
	} catch {
		// The directory is there and unreadable, which is not the same as absent.
		return { present: true, artifacts: [], unverifiable: 0 };
	}
	const artifacts: GateDecisionArtifact[] = [];
	let unverifiable = 0;
	for (const name of entries.slice(0, GATE_TOPOLOGY_MAX_SCAN)) {
		let artifact: GateDecisionArtifact;
		try {
			artifact = JSON.parse(readFileSync(join(directory, name), "utf8")) as GateDecisionArtifact;
		} catch {
			unverifiable += 1;
			continue;
		}
		if (verifyGateDecisionArtifact(artifact).ok) artifacts.push(artifact);
		else unverifiable += 1;
	}
	artifacts.sort(byNewest);
	return { present: true, artifacts, unverifiable };
}

function projectDecision(artifact: GateDecisionArtifact): GateTopologyDecision | null {
	const id = safeIdentifier(artifact.id);
	const group = safeIdentifier(artifact.group);
	// The store mints both and already refuses either outside this shape, so a
	// stored value failing it means something else wrote the file. A decision
	// this projection cannot name is one it will not report.
	if (id === null || group === null) return null;
	const allSubjects = artifact.subjects.map((subject) => safeIdentifier(subject.runId));
	if (allSubjects.some((runId) => runId === null)) return null;
	const subjects = (allSubjects as string[]).slice(0, GATE_TOPOLOGY_MAX_SUBJECTS);
	const decider = artifact.decider === undefined ? null : safeIdentifier(artifact.decider.runId);
	if (artifact.decider !== undefined && decider === null) return null;
	let winner: GateTopologyWinner | null = null;
	if (artifact.winner !== undefined) {
		const runId = safeIdentifier(artifact.winner.subject.runId);
		if (runId === null) return null;
		winner = { index: artifact.winner.index, runId };
	}
	return {
		id,
		group,
		topology: artifact.topology,
		cycle: artifact.cycle,
		outcome: artifact.outcome,
		decidedAt: new Date(artifact.createdAt).toISOString(),
		subjects,
		subjectsTruncated: allSubjects.length > subjects.length,
		decider,
		correlation: artifact.correlation === undefined ? null : { ...artifact.correlation },
		winner,
		confirms: artifact.confirmation === undefined ? null : safeIdentifier(artifact.confirmation.id),
		reason: classifyReason(artifact.detail),
	};
}

/**
 * Bounded newest-first coordinator gate decisions.
 *
 * Selected by this function, never by a caller's argument, so a host that
 * invokes the command behind it knows the process cannot be steered into a
 * different window.
 */
export function gateTopology(stateDir: string = clioStateDir()): GateTopologyResult {
	const { present, artifacts, unverifiable } = readDecisionWindow(stateDir);
	const window = artifacts.slice(0, GATE_TOPOLOGY_MAX_DECISIONS);
	const decisions: GateTopologyDecision[] = [];
	for (const artifact of window) {
		const decision = projectDecision(artifact);
		if (decision !== null) decisions.push(decision);
	}
	return {
		present,
		decisions,
		truncated: artifacts.length > window.length || decisions.length !== window.length,
		unverifiable,
	};
}
