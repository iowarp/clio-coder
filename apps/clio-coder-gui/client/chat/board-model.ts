// What the session board says, before any of it is drawn. The operator's tasks carry the actions
// the `tasks` command family accepts for their state; the plan and the decisions are Clio Coder's
// report and carry none. Pure, so the wording and the permitted actions are testable without a DOM.

import type { DecisionSuperseded, MemoryProposed, SessionBoard } from "../../contracts/board.js";
import type { StatusTone } from "../design/status.js";

export type OperatorTaskAction = "hand" | "done" | "drop";

export interface OperatorTaskRow {
	id: string;
	title: string;
	tone: StatusTone;
	word: string;
	/** Expected outputs and declared checks, in words; empty when the task declared none. */
	acceptance: string;
	actions: OperatorTaskAction[];
}

export interface PlanRow {
	id: string;
	title: string;
	tone: StatusTone;
	word: string;
	reason: string | null;
}

export interface DecisionRow {
	ref: string;
	name: string;
	value: string;
	who: string;
	/** Rationale for an agent decision, or the correction that replaced a superseded one. */
	note: string | null;
	/** What a supersede names; null when the agent did not report the interview. */
	target: { interviewId: string; key: string } | null;
}

export interface BankRow {
	id: string;
	word: string;
	content: string;
}

export interface BoardView {
	tasks: OperatorTaskRow[];
	plan: { title: string; rows: PlanRow[] } | null;
	activeDecisions: DecisionRow[];
	earlierDecisions: DecisionRow[];
	memory: string;
	/** Task-bank entries a person may propose as durable memory. */
	bank: BankRow[];
	truncated: boolean;
}

const TASK_STATES: Record<SessionBoard["operatorTasks"][number]["status"], [StatusTone, string]> = {
	open: ["neutral", "Open"],
	handed: ["running", "Handed to Clio Coder"],
	picked: ["running", "In Clio Coder's plan"],
	done: ["success", "Done"],
	dropped: ["neutral", "Dropped"],
};

/** Plan states are Clio Coder's own report; the section says so, and "Completed" is its claim. */
function planState(status: string): [StatusTone, string] {
	switch (status) {
		case "pending":
			return ["neutral", "Pending"];
		case "active":
			return ["running", "In progress"];
		case "completed":
			return ["success", "Completed"];
		case "blocked":
			return ["warn", "Blocked"];
		case "cancelled":
			return ["neutral", "Cancelled"];
		default:
			return ["unverified", status];
	}
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function acceptance(task: SessionBoard["operatorTasks"][number]) {
	const parts = [
		task.expectedOutputs.length ? `expects ${task.expectedOutputs.join(", ")}` : "",
		task.verificationChecks ? `${plural(task.verificationChecks, "declared check")}` : "",
	].filter(Boolean);
	return parts.join(" · ");
}

function decision(row: SessionBoard["decisions"][number]): DecisionRow {
	return {
		ref: row.ref,
		name: row.label ?? row.key,
		value: row.value,
		who: row.source === "agent" ? "Decided by Clio Coder" : row.source === "operator" ? "Your answer" : "Recorded",
		note: row.status === "superseded" ? row.correction : row.rationale,
		target: row.interviewId === undefined ? null : { interviewId: row.interviewId, key: row.key },
	};
}

export function memoryLine(memory: SessionBoard["memory"]): string {
	if (memory === null) return "Clio does not report task memory here.";
	if (!memory.enabled) return "Task memory is off.";
	const tier = memory.tier === "llm" ? "model tier" : "rules tier";
	return `Task memory is on, ${tier}, ${plural(memory.entries, "entry", "entries")}${memory.stepInFlight ? ", updating now" : ""}.`;
}

export function boardView(board: SessionBoard): BoardView {
	return {
		tasks: board.operatorTasks.map((task) => {
			const [tone, word] = TASK_STATES[task.status];
			return {
				id: task.id,
				title: task.title,
				tone,
				word,
				acceptance: acceptance(task),
				// Settled tasks take no action; a live one can be finished or dropped by its owner.
				actions:
					task.status === "open"
						? ["hand", "done", "drop"]
						: task.status === "done" || task.status === "dropped"
							? []
							: ["done", "drop"],
			};
		}),
		plan:
			board.plan === null
				? null
				: {
						title: board.plan.title,
						rows: board.plan.tasks.map((task) => {
							const [tone, word] = planState(task.status);
							return { id: task.id, title: task.title, tone, word, reason: task.reason };
						}),
					},
		activeDecisions: board.decisions.filter((row) => row.status === "active").map(decision),
		earlierDecisions: board.decisions.filter((row) => row.status === "superseded").map(decision),
		memory: memoryLine(board.memory),
		bank: (board.memory?.bank ?? []).map((entry) => ({
			id: entry.id,
			word: entry.kind === "procedural" ? "How to" : "Fact",
			content: entry.content,
		})),
		truncated: board.truncated,
	};
}

/** What a proposal did, in words; the review step is always named because a proposal is not an approval. */
export function memoryOutcome(result: MemoryProposed): { tone: "success" | "warning" | "error"; text: string } {
	if ("recordId" in result) {
		const review = `Review it, then run clio-coder memory approve ${result.recordId}.`;
		return {
			tone: "success",
			text:
				result.status === "proposed"
					? `Proposed ${result.recordId}. ${review}`
					: `Already proposed as ${result.recordId}. ${review}`,
		};
	}
	if (result.status === "needs_acknowledgement")
		return {
			tone: "warning",
			text: "Every project broadens where this lesson applies. Press again to propose it everywhere.",
		};
	return { tone: "error", text: `Not proposed: ${result.reason}.` };
}

/** What a supersede did; a correction's request is sent separately and named here. */
export function supersedeOutcome(
	result: DecisionSuperseded,
	corrected: boolean,
): { tone: "success" | "error"; text: string } {
	if (result.status === "refused") return { tone: "error", text: `Not superseded: ${result.reason}.` };
	if (result.status === "already_superseded")
		return { tone: "success", text: "This decision was already superseded; nothing was written." };
	return {
		tone: "success",
		text: corrected
			? "Superseded. The new direction was sent to Clio Coder as a request."
			: "Superseded. It stays in the record under earlier decisions.",
	};
}

/** The Decisions section's empty line: none recorded, or none still active while earlier ones remain. */
export function decisionsEmptyLine(view: Pick<BoardView, "activeDecisions" | "earlierDecisions">): string | null {
	if (view.activeDecisions.length > 0) return null;
	if (view.earlierDecisions.length === 0) return "No decision has been recorded in this task.";
	return view.earlierDecisions.length === 1
		? "No decision is active. The earlier one is below."
		: `No decision is active. The ${view.earlierDecisions.length} earlier ones are below.`;
}
