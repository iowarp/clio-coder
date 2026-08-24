/**
 * `/oracle <question>`: the briefing an advisor is given, and the note its
 * answer becomes.
 *
 * Oracle never receives a forked transcript. A transcript is the session's raw
 * history, and handing it to an advisor makes the advisor agree with whatever
 * the session already believes, which is the opposite of what an operator asks
 * an oracle for. It is briefed on the record instead: the decisions the
 * operator settled, the work the board still owes, and the last compaction
 * summary when one exists.
 *
 * Pure: no I/O, no bus, no session, no dispatch. The caller owns the run.
 */

import type { OracleResult } from "../domains/agents/index.js";
import type { DecisionLedgerEntry } from "../domains/session/entries.js";
import type { TaskBoardTask } from "../domains/session/task-board.js";

/** The recipe `/oracle` dispatches. Shadow, so `/run` can never reach it. */
export const ORACLE_AGENT_ID = "oracle";

/**
 * Total bound on the packed briefing, in UTF-8 bytes. Well under the 64 KiB
 * an internal-origin dispatch briefing may carry, because the point of the
 * digest is that a small local advisor can hold all of it at once.
 */
export const ORACLE_DIGEST_MAX_BYTES = 12 * 1024;

/**
 * Per-section byte caps. They sum to 11776, which leaves 512 bytes of the
 * total for the section headers and blank lines the packer writes between
 * them. Each section is clamped on its own before the whole digest is clamped
 * again, so one runaway section can never starve the others: a 40 KiB
 * compaction summary loses its own tail rather than the question's.
 */
export const ORACLE_DECISIONS_MAX_BYTES = 5120;
export const ORACLE_TASKS_MAX_BYTES = 3072;
export const ORACLE_COMPACTION_MAX_BYTES = 2048;
export const ORACLE_QUESTION_MAX_BYTES = 1536;

/** Row caps, applied before the byte caps. Newest decisions and lowest task ids first. */
export const ORACLE_DECISIONS_MAX_ROWS = 24;
export const ORACLE_TASKS_MAX_ROWS = 24;

/** Appended wherever a cap cut content, so the advisor knows it is reading a tail-less record. */
export const ORACLE_TRUNCATION_MARKER = "\n[truncated]";

export const ORACLE_NO_DECISIONS = "(no settled decisions on this branch)";
export const ORACLE_NO_TASKS = "(no open tasks on the board)";

export interface OracleDigestSources {
	/** Settled interviews, newest first, exactly as the decision board folds them. */
	decisions: ReadonlyArray<DecisionLedgerEntry>;
	/** The live task board's tasks; the packer keeps the open ones. */
	tasks: ReadonlyArray<TaskBoardTask>;
	/** The most recent compaction summary on the active branch, or null when the session never compacted. */
	compactionSummary: string | null;
	question: string;
}

export interface OracleDigest {
	text: string;
	/** True when any cap cut content. The digest says so in its own text as well. */
	truncated: boolean;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/**
 * Clamp to `maxBytes` including the marker, never past a UTF-8 code point. A
 * marker that pushed the result over its own cap would make the section caps
 * unable to add up to the total, which is the one property the packer relies
 * on.
 */
function clamp(text: string, maxBytes: number): { text: string; truncated: boolean } {
	if (byteLength(text) <= maxBytes) return { text, truncated: false };
	const room = Math.max(0, maxBytes - byteLength(ORACLE_TRUNCATION_MARKER));
	const buffer = Buffer.from(text, "utf8");
	let cut = Math.min(room, buffer.byteLength);
	while (cut > 0) {
		const next = buffer[cut];
		if (next === undefined || (next & 0xc0) !== 0x80) break;
		cut -= 1;
	}
	return { text: `${buffer.subarray(0, cut).toString("utf8")}${ORACLE_TRUNCATION_MARKER}`, truncated: true };
}

/** One decision line. Superseded decisions carry their correction so a reversal is visible. */
function decisionLine(decision: DecisionLedgerEntry["decisions"][number]): string {
	const label = decision.label ? ` (${decision.label})` : "";
	if (decision.status === "superseded") {
		const correction = decision.correction ? `; corrected to ${decision.correction}` : "";
		return `- ${decision.key}${label}: ${decision.value} [superseded${correction}]`;
	}
	return `- ${decision.key}${label}: ${decision.value}`;
}

function taskLine(task: TaskBoardTask): string {
	return `- ${task.id} [${task.status}] ${task.title}`;
}

function isOpenTask(task: TaskBoardTask): boolean {
	return task.status === "pending" || task.status === "active";
}

/**
 * Pack the briefing. Sections are fixed and always present, so an advisor
 * reading an empty one learns that the board is empty rather than that the
 * packer omitted it.
 */
export function packOracleDigest(sources: OracleDigestSources): OracleDigest {
	let truncated = false;

	const decisionRows = sources.decisions
		.flatMap((entry) => entry.decisions.map(decisionLine))
		.slice(0, ORACLE_DECISIONS_MAX_ROWS);
	if (decisionRows.length < sources.decisions.reduce((total, entry) => total + entry.decisions.length, 0)) {
		truncated = true;
	}
	const decisions = clamp(decisionRows.join("\n") || ORACLE_NO_DECISIONS, ORACLE_DECISIONS_MAX_BYTES);
	truncated = truncated || decisions.truncated;

	const openTasks = sources.tasks.filter(isOpenTask);
	const taskRows = openTasks.map(taskLine).slice(0, ORACLE_TASKS_MAX_ROWS);
	if (taskRows.length < openTasks.length) truncated = true;
	const tasks = clamp(taskRows.join("\n") || ORACLE_NO_TASKS, ORACLE_TASKS_MAX_BYTES);
	truncated = truncated || tasks.truncated;

	const summaryText = sources.compactionSummary?.trim() ?? "";
	const summary = clamp(summaryText, ORACLE_COMPACTION_MAX_BYTES);
	truncated = truncated || summary.truncated;

	const question = clamp(sources.question.trim(), ORACLE_QUESTION_MAX_BYTES);
	truncated = truncated || question.truncated;

	const sections = [
		"## Settled decisions",
		decisions.text,
		"",
		"## Open tasks",
		tasks.text,
		"",
		"## Last compaction summary",
		summary.text.length > 0 ? summary.text : "(this session has not compacted)",
		"",
		"## Question",
		question.text,
	];
	const whole = clamp(sections.join("\n"), ORACLE_DIGEST_MAX_BYTES);
	return { text: whole.text, truncated: truncated || whole.truncated };
}

/** The bounded task an oracle run is given. The briefing carries the record; this carries the job. */
export const ORACLE_TASK =
	"Answer the question in the briefing's Question section. Check it against the settled decisions first, " +
	"then return the strongest challenge you can support and the evidence that would change your mind.";

/**
 * The advisor's structured answer as the prose the operator note carries. The
 * contract keeps the four fields typed so a run cannot half-answer; the note
 * renders them because the main agent reads prose, not a payload.
 */
export function formatOracleAnswer(result: OracleResult): string {
	const cited =
		result.citedDecisions.length === 0
			? "Cited decisions: none bear on this question."
			: `Cited decisions: ${result.citedDecisions.join(", ")}`;
	return [
		`Verdict: ${result.verdict}`,
		"",
		`Strongest challenge: ${result.challenge}`,
		"",
		`What would change its mind: ${result.changesMyMind}`,
		"",
		cited,
	].join("\n");
}
