import type {
	MemoryPromptSelection,
	MemoryRecord,
	TaskMemoryEntry,
	TaskMemoryOperatorStatus,
	TaskMemorySnapshot,
} from "../domains/memory/index.js";
import { lessonSubject, MEMORY_MAIN_PROMPT_SCOPES } from "../domains/memory/index.js";

export type MemoryReviewState = "approved" | "pending" | "rejected";

export function memoryReviewState(record: MemoryRecord): MemoryReviewState {
	if (record.rejectedAt !== undefined) return "rejected";
	return record.approved ? "approved" : "pending";
}

export function memoryBankEntries(snapshot: TaskMemorySnapshot): TaskMemoryEntry[] {
	return [...(snapshot.status === null ? [] : [snapshot.status]), ...snapshot.knowledge, ...snapshot.procedural];
}

/**
 * How a lesson reaches this session's main agent: its prompt, `memory_recall`
 * alone, or neither. The prompt draws from {@link MEMORY_MAIN_PROMPT_SCOPES};
 * every other eligible scope is reachable only by recall.
 */
export type MemoryReach = "prompt" | "recall" | "none";

export function memoryReach(record: MemoryRecord, eligible: boolean): MemoryReach {
	if (!eligible) return "none";
	return MEMORY_MAIN_PROMPT_SCOPES.includes(record.scope) ? "prompt" : "recall";
}

/** The commands, paths and variables a lesson's own text names; no model reads it. */
function memorySubjectLines(text: string): string[] {
	const subject = lessonSubject(text);
	const lines = [
		...subject.commands.map((command) => `Command \`${command}\``),
		...(subject.paths.length ? [`Paths: ${subject.paths.join(", ")}`] : []),
		...(subject.envVars.length ? [`Environment: ${subject.envVars.join(", ")}`] : []),
	];
	return lines.length ? lines : ["No command, path or environment variable named."];
}

function applicability(record: MemoryRecord): string {
	if (record.scope === "repo")
		return record.repository ? `Repository ${record.repository.key}` : "Repository not recorded";
	if (record.scope === "global") return "Every repository";
	if (record.scope === "runtime") return record.runtime ? `Runtime ${record.runtime.key}` : "Runtime not recorded";
	if (record.scope === "agent") return record.agent ? `Worker agent ${record.agent.key}` : "Worker agent not recorded";
	return `${record.scope} scope`;
}

/** Eligibility belongs to memory policy; inspection explains its result without adding another gate. */
function reachLine(record: MemoryRecord, eligible: boolean, selection: MemoryPromptSelection | null): string {
	if (record.rejectedAt !== undefined) return "Rejected by operator; never shown.";
	if (record.regressions?.length) return "Contradicted; excluded from the prompt and recall.";
	if (!record.approved) return "Awaiting approval; excluded from the prompt and recall.";
	if (!record.evidenceRefs.length) return "No evidence recorded; excluded from the prompt and recall.";
	const reach = memoryReach(record, eligible);
	if (reach === "none")
		return record.scope === "agent"
			? "Delegated workers only; not this session's agent."
			: "Outside this session's repository or runtime.";
	if (reach === "recall") return `Through memory_recall only; the prompt does not carry ${record.scope} scope.`;
	const item = selection?.items.find((candidate) => candidate.id === record.id);
	if (item === undefined) return "Prompt scope; no prompt has been built with it yet.";
	return item.reason === "selected"
		? `In this session's prompt, rank ${item.rank}.`
		: `Eligible, but the prompt's ${item.reason === "token-budget" ? "token budget" : "item limit"} left it out.`;
}

/** Outcomes counted once per session: two observations from one session are one track-record entry. */
function trackRecord(record: MemoryRecord): string[] {
	const sessions = (kind: "delivered" | "held" | "contradicted") =>
		new Set((record.observations ?? []).filter((item) => item.kind === kind).map((item) => item.sessionId));
	const held = sessions("held");
	const source = record.provenance?.sourceSessionId;
	const heldElsewhere = [...held].filter((sessionId) => sessionId !== source).length;
	return [
		`Delivered in ${sessions("delivered").size} sessions; held in ${heldElsewhere} later sessions${
			source !== undefined && held.has(source) ? " and in the session it came from" : ""
		}; contradicted in ${sessions("contradicted").size}.`,
		`Last verified ${record.lastVerifiedAt ?? "never"}; learned ${record.createdAt}.`,
	];
}

export function memoryLessonDetail(
	record: MemoryRecord,
	eligible: boolean,
	selection: MemoryPromptSelection | null = null,
): string[] {
	const observations = record.observations ?? [];
	// The repository condition repeats the applicability line above it.
	const when = record.appliesWhen.filter((condition) => !condition.startsWith("repository:"));
	const approval = record.rejectedAt
		? `Rejected by operator at ${record.rejectedAt}.`
		: record.approved
			? record.approval
				? `Approved by ${record.approval.by} at ${record.approval.at}.`
				: "Approved; reviewer and approval time were not recorded."
			: "Not approved.";
	return [
		"## Concerns",
		...memorySubjectLines(record.lesson),
		"",
		"## Lesson",
		record.lesson,
		"",
		"## Applies",
		applicability(record),
		reachLine(record, eligible, selection),
		...when.map((condition) => `When: ${condition}`),
		...record.avoidWhen.map((condition) => `Not when: ${condition}`),
		...(record.regressions ?? []).map((regression) => `Contradiction: ${regression}`),
		"",
		"## Track record",
		...trackRecord(record),
		"Delivery and recall do not prove that a lesson changed the result of a task.",
		"",
		"## Evidence",
		...(record.evidenceRefs.length ? record.evidenceRefs.map((ref) => `- ${ref}`) : ["No evidence reference recorded."]),
		...(record.provenance?.evidenceId ? [`Evidence artifact: ${record.provenance.evidenceId}`] : []),
		approval,
		...observations
			.slice(-6)
			.reverse()
			.map((item) => `- ${item.kind} at ${item.at}; session ${item.sessionId}`),
		"",
		`Record ID: ${record.id}`,
	];
}

export function memoryTaskDetail(entry: TaskMemoryEntry): string[] {
	const subject = [
		...(entry.evidenceCommand ? [`Command \`${entry.evidenceCommand}\``] : []),
		...(entry.evidenceSource ? [`Path ${entry.evidenceSource.path}`] : []),
	];
	return [
		"## Concerns",
		...(subject.length ? subject : memorySubjectLines(entry.content)),
		"",
		"## Current task state",
		entry.content,
		"",
		"## Lifetime and visibility",
		entry.kind === "status"
			? "Private session status. It is excluded from memory_recall and cannot be promoted."
			: "This entry belongs to the current session. Approval as a reusable lesson is shown separately in Lessons.",
		entry.kind === "procedural"
			? "Recorded attempt and outcome."
			: entry.kind === "knowledge"
				? "Recorded task knowledge."
				: "",
		...(entry.evidenceSource ? ["", "## Source evidence", entry.evidenceSource.path, entry.evidenceSource.quote] : []),
		"",
		"## History",
		`Created: ${entry.createdAt}`,
		`Last touched: ${entry.lastTouchedAt}`,
		`Recorded reminder contributions: ${entry.injectionCount}. This does not prove causal use.`,
		"",
		`Entry ID: ${entry.id}`,
	].filter((line, index, lines) => line !== "" || lines[index - 1] !== "");
}

/** Every displayed field participates, including changed text, applicability and feedback. */
export function memoryViewSignature(
	status: TaskMemoryOperatorStatus,
	records: readonly MemoryRecord[],
	eligibility: unknown,
): string {
	return JSON.stringify([status, records, eligibility]);
}
