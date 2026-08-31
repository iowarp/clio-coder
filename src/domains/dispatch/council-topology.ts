/**
 * Read-only reconstruction of council topology from the ordinary run ledger.
 *
 * A council has no durable record of its own. Every one of its runs is an
 * ordinary ledger row, and what makes it a council is the provenance the
 * scheduler stamps on each row: a shared {@link RunCouncilProvenance.group},
 * the seated member's `label`, the round it spoke in, and a `gate.role` of
 * `member` or `synthesis`. So the topology is not stored anywhere; it is a
 * grouping over rows that already exist, which is what this module computes.
 *
 * Everything here is a fact the scheduler wrote. Member answers, the judge's
 * synthesis text, and the vote tally live in receipt output as free model prose
 * and are deliberately outside this projection: what crosses is who was seated,
 * where they ran, how many rounds they took, and whether the council reached a
 * synthesis. This module is pure. It reads no file, opens no ledger, and takes
 * the rows its caller already has.
 */

import type { ExecutionRole } from "./execution-role.js";
import { COUNCIL_MAX_MEMBERS } from "./gate-role-prompts.js";
import type { RunEnvelope, RunOutcome, RunStatus } from "./types.js";

/** How many councils one projection reports, newest first. */
export const COUNCIL_TOPOLOGY_MAX_COUNCILS = 4;

/** Seated members named per council. Mirrors the harness's own roster ceiling. */
export const COUNCIL_TOPOLOGY_MAX_MEMBERS = COUNCIL_MAX_MEMBERS;

/**
 * Turns reported per member. Admission caps a council at three rounds; the
 * bound is restated rather than imported because raising the harness ceiling
 * must widen this window deliberately, and `turnsTruncated` reports the gap in
 * the meantime.
 */
export const COUNCIL_TOPOLOGY_MAX_TURNS = 3;

/**
 * Ledger rows one projection will read.
 *
 * A council is at most five members over three rounds plus a judge and a sealed
 * report, so seventeen rows; four councils fit inside a fraction of this scan
 * even when ordinary dispatch rows are interleaved. The cap is what keeps the
 * projection proportional on an installation whose ring holds a thousand runs.
 */
export const COUNCIL_TOPOLOGY_MAX_SCAN = 256;

/**
 * The synthesis label every council files its verdict under.
 *
 * It is a scheduler constant, not an operator string: member labels are matched
 * against {@link COUNCIL_MEMBER_LABEL}, which this value cannot satisfy anyway,
 * so the two namespaces cannot collide.
 */
const SYNTHESIS_LABEL = "synthesis";

/** The agent id the ledger files a sealed council report under. */
const SEALED_REPORT_AGENT_ID = "council-synthesis";

/**
 * The exact task text {@link sealCouncilSynthesis} mints, per synthesis kind.
 *
 * A run's task is operator or model prose everywhere else in this ledger, so it
 * is never repeated by this projection. The sealed report is the one row whose
 * task the harness writes itself, from a closed set of three, which makes it the
 * only durable record of which synthesis a council was configured for. It is
 * classified against that set, not quoted: an unrecognised string yields no kind
 * rather than crossing as text.
 */
const SEALED_REPORT_TASKS: ReadonlyArray<readonly [string, CouncilSynthesisKind]> = [
	["Council none synthesis", "none"],
	["Council vote synthesis", "vote"],
	["Council judge synthesis", "judge"],
];

/**
 * The label shape both council entry paths already enforce.
 *
 * `dispatch` admission tests member labels against this pattern and settings
 * validation rejects a roster member that fails it, so a stored label outside it
 * was not written by either. Repeating it here makes the projection's own
 * guarantee structural rather than inherited: whatever wrote the row, the label
 * this module reports can carry no path, URL, quote, space, or control byte.
 */
const COUNCIL_MEMBER_LABEL = /^[a-z][a-z0-9_-]{0,31}$/u;

export type CouncilSynthesisKind = "none" | "vote" | "judge";

/** How a council's dispatch plan was admitted, when the row records one. */
export type CouncilApproval = "operator" | "full-auto";

/** Who asked for the council: the operator's `/council`, the model, or the runtime. */
export type CouncilOrigin = "user" | "agent" | "internal";

/** One member's contribution in one round. */
export interface CouncilMemberTurn {
	readonly round: number;
	readonly runId: string;
	readonly status: RunStatus;
	/** Null while the run has not finalized; absent on pre-taxonomy rows. */
	readonly outcome: RunOutcome | null;
	readonly terminal: boolean;
}

/** One seated voice, with every round it spoke in, oldest round first. */
export interface CouncilMember {
	readonly label: string;
	readonly agentId: string;
	readonly targetId: string;
	readonly wireModelId: string;
	/** The role its route statistics were filed under; a council seats researchers. */
	readonly executionRole: ExecutionRole;
	readonly turns: readonly CouncilMemberTurn[];
	readonly turnsTruncated: boolean;
}

/** The judge dispatch a `judge` synthesis runs, as an ordinary ledger row. */
export interface CouncilJudge {
	readonly runId: string;
	readonly agentId: string;
	readonly targetId: string;
	readonly wireModelId: string;
	readonly status: RunStatus;
	readonly outcome: RunOutcome | null;
}

export interface CouncilSynthesisRecord {
	/**
	 * Which synthesis the council was configured for, classified from the sealed
	 * report's harness-minted task. Null when no sealed report is in the window,
	 * which is what an aborted council and an aged-out one both look like.
	 */
	readonly kind: CouncilSynthesisKind | null;
	/** The sealed council-report row, whose text stays host-side. */
	readonly sealedRunId: string | null;
	/** Present only for a judge synthesis, and only while its row is in the window. */
	readonly judge: CouncilJudge | null;
}

export interface CouncilTopology {
	readonly group: string;
	readonly startedAt: string;
	/** Null while any row of the council is still running. */
	readonly endedAt: string | null;
	readonly running: boolean;
	/**
	 * Rounds the council was configured for, recovered from the sealed report's
	 * round stamp. Null when no sealed report is in the window.
	 */
	readonly roundsPlanned: number | null;
	/** Highest round any member row records. Never exceeds `roundsPlanned`. */
	readonly roundsObserved: number;
	readonly origin: CouncilOrigin | null;
	readonly approval: CouncilApproval | null;
	readonly members: readonly CouncilMember[];
	/** True when the council seated more members than this projection names. */
	readonly membersTruncated: boolean;
	/**
	 * Member rows whose stored label failed {@link COUNCIL_MEMBER_LABEL} and were
	 * therefore left unnamed rather than repeated. Non-zero means something other
	 * than council admission wrote a row into this group.
	 */
	readonly membersRejected: number;
	readonly synthesis: CouncilSynthesisRecord;
}

function isRunStatus(value: unknown): value is RunStatus {
	return (
		value === "queued" ||
		value === "running" ||
		value === "completed" ||
		value === "failed" ||
		value === "interrupted" ||
		value === "stale" ||
		value === "dead"
	);
}

function isRunOutcome(value: unknown): value is RunOutcome {
	return (
		value === "succeeded" ||
		value === "failed" ||
		value === "timed_out" ||
		value === "stalled" ||
		value === "canceled" ||
		value === "denied_by_policy" ||
		value === "spawn_failed"
	);
}

function outcomeOf(row: RunEnvelope): RunOutcome | null {
	return isRunOutcome(row.outcome) ? row.outcome : null;
}

function statusOf(row: RunEnvelope): RunStatus {
	// A row written by another build can carry a status this one does not know.
	// Reporting it as `stale` is the closest honest answer: the projection has a
	// row it cannot classify, which is exactly what that state already means.
	return isRunStatus(row.status) ? row.status : "stale";
}

function synthesisKindOf(task: unknown): CouncilSynthesisKind | null {
	return SEALED_REPORT_TASKS.find(([text]) => text === task)?.[1] ?? null;
}

/** Oldest round first, then by run id so a duplicate round still orders stably. */
function byRound(a: CouncilMemberTurn, b: CouncilMemberTurn): number {
	return a.round - b.round || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0);
}

interface CouncilRows {
	readonly group: string;
	readonly members: RunEnvelope[];
	readonly judges: RunEnvelope[];
	readonly sealed: RunEnvelope[];
}

/**
 * Split one group's rows by the part they played.
 *
 * A row is a member unless its council label is the synthesis constant, and a
 * synthesis row is the sealed report only when its agent id is the one the
 * ledger writer uses. That distinction matters: a judge council writes two
 * synthesis rows, one an ordinary dispatch that consumed a model and one a
 * zero-cost record of the council's own report, and conflating them would double
 * the council's apparent judge.
 */
function partition(group: string, rows: ReadonlyArray<RunEnvelope>): CouncilRows {
	const members: RunEnvelope[] = [];
	const judges: RunEnvelope[] = [];
	const sealed: RunEnvelope[] = [];
	for (const row of rows) {
		if (row.council?.label !== SYNTHESIS_LABEL) {
			members.push(row);
			continue;
		}
		if (row.agentId === SEALED_REPORT_AGENT_ID) sealed.push(row);
		else judges.push(row);
	}
	return { group, members, judges, sealed };
}

function projectMembers(rows: ReadonlyArray<RunEnvelope>): {
	members: CouncilMember[];
	truncated: boolean;
	rejected: number;
} {
	const byLabel = new Map<string, RunEnvelope[]>();
	let rejected = 0;
	for (const row of rows) {
		const label = row.council?.label ?? "";
		if (!COUNCIL_MEMBER_LABEL.test(label)) {
			rejected += 1;
			continue;
		}
		const bucket = byLabel.get(label);
		if (bucket === undefined) byLabel.set(label, [row]);
		else bucket.push(row);
	}
	const labels = [...byLabel.keys()].sort();
	const named = labels.slice(0, COUNCIL_TOPOLOGY_MAX_MEMBERS);
	const members: CouncilMember[] = [];
	for (const label of named) {
		const bucket = byLabel.get(label) ?? [];
		// The rows arrive newest first, so the head is the member's latest round
		// and carries the route it most recently ran on. A council can reroute a
		// member between rounds, and the current route is the one an operator is
		// reading the grid to check.
		const head = bucket[0];
		if (head === undefined) continue;
		const turns = bucket
			.map(
				(row): CouncilMemberTurn => ({
					round: row.council?.round ?? 1,
					runId: row.id,
					status: statusOf(row),
					outcome: outcomeOf(row),
					terminal: row.endedAt !== null,
				}),
			)
			.sort(byRound);
		const visible = turns.slice(0, COUNCIL_TOPOLOGY_MAX_TURNS);
		members.push({
			label,
			agentId: head.agentId,
			targetId: head.targetId,
			wireModelId: head.wireModelId,
			executionRole: head.executionRole,
			turns: visible,
			turnsTruncated: turns.length > visible.length,
		});
	}
	return { members, truncated: labels.length > named.length, rejected };
}

function projectSynthesis(rows: CouncilRows): CouncilSynthesisRecord {
	const sealed = rows.sealed[0] ?? null;
	const judge = rows.judges[0] ?? null;
	return {
		kind: sealed === null ? null : synthesisKindOf(sealed.task),
		sealedRunId: sealed?.id ?? null,
		judge:
			judge === null
				? null
				: {
						runId: judge.id,
						agentId: judge.agentId,
						targetId: judge.targetId,
						wireModelId: judge.wireModelId,
						status: statusOf(judge),
						outcome: outcomeOf(judge),
					},
	};
}

function originOf(rows: ReadonlyArray<RunEnvelope>): CouncilOrigin | null {
	const value = rows.find((row) => row.requestOrigin !== undefined)?.requestOrigin;
	return value === "user" || value === "agent" || value === "internal" ? value : null;
}

function approvalOf(rows: ReadonlyArray<RunEnvelope>): CouncilApproval | null {
	const value = rows.find((row) => row.plan !== undefined)?.plan?.approval;
	return value === "operator" || value === "full-auto" ? value : null;
}

/** Earliest start over the council's rows, as an ISO stamp. */
function firstStart(rows: ReadonlyArray<RunEnvelope>): string {
	let earliest = rows[0]?.startedAt ?? new Date(0).toISOString();
	for (const row of rows) if (row.startedAt < earliest) earliest = row.startedAt;
	return earliest;
}

/** Latest end, or null when any row has not finished. */
function lastEnd(rows: ReadonlyArray<RunEnvelope>): string | null {
	let latest: string | null = null;
	for (const row of rows) {
		if (row.endedAt === null) return null;
		if (latest === null || row.endedAt > latest) latest = row.endedAt;
	}
	return latest;
}

export interface CouncilTopologyResult {
	readonly councils: readonly CouncilTopology[];
	/** True when the scanned window held councils older than the reported ones. */
	readonly truncated: boolean;
}

/**
 * Group a newest-first ledger window into bounded council topologies.
 *
 * The rows must arrive in the order the ledger lists them, newest start first,
 * because that ordering is what makes the first council encountered the newest
 * one. Nothing is read from disk and no row is mutated.
 */
export function councilTopologies(rows: ReadonlyArray<RunEnvelope>): CouncilTopologyResult {
	const grouped = new Map<string, RunEnvelope[]>();
	for (const row of rows.slice(0, COUNCIL_TOPOLOGY_MAX_SCAN)) {
		const group = row.council?.group;
		if (typeof group !== "string" || group.length === 0) continue;
		const bucket = grouped.get(group);
		if (bucket === undefined) grouped.set(group, [row]);
		else bucket.push(row);
	}
	const groups = [...grouped.entries()];
	const window = groups.slice(0, COUNCIL_TOPOLOGY_MAX_COUNCILS);
	const councils: CouncilTopology[] = [];
	for (const [group, rowsInGroup] of window) {
		const parts = partition(group, rowsInGroup);
		const { members, truncated, rejected } = projectMembers(parts.members);
		const synthesis = projectSynthesis(parts);
		const roundsObserved = members.reduce(
			(highest, member) => member.turns.reduce((inner, turn) => Math.max(inner, turn.round), highest),
			0,
		);
		const sealedRound = parts.sealed[0]?.council?.round;
		const roundsPlanned =
			typeof sealedRound === "number" && Number.isInteger(sealedRound) && sealedRound > 0 ? sealedRound : null;
		councils.push({
			group,
			startedAt: firstStart(rowsInGroup),
			endedAt: lastEnd(rowsInGroup),
			running: rowsInGroup.some((row) => row.endedAt === null),
			// A sealed report stamps the configured round count, so a member seen in
			// a later round than the report claims means the two disagree about the
			// same council. Reporting the higher of the two keeps the invariant that
			// observed never exceeds planned without hiding the member row.
			roundsPlanned: roundsPlanned === null ? null : Math.max(roundsPlanned, roundsObserved),
			roundsObserved,
			origin: originOf(rowsInGroup),
			approval: approvalOf(rowsInGroup),
			members,
			membersTruncated: truncated,
			membersRejected: rejected,
			synthesis,
		});
	}
	return { councils, truncated: groups.length > window.length };
}
