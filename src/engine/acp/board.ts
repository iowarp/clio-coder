/**
 * `_clio-coder/session/board`: the read half of the terminal's /tasks and
 * /decisions overlays and the /memory status line, as one bounded projection.
 *
 * A client may change operator tasks through the `tasks` command family; this
 * method only reads. It carries what those overlays show a person and nothing
 * the ledger keeps for itself: no transcript paths, no exposure records, no
 * run ids. Every list and string is bounded so a long session cannot turn one
 * poll into a megabyte line on the stdio transport.
 */

import type { TaskMemorySnapshot } from "../../domains/memory/index.js";
import type { DecisionLedgerEntry } from "../../domains/session/entries.js";
import type { TaskBoardSnapshot } from "../../domains/session/task-board.js";
import type { UserTask } from "../../domains/user-tasks/store.js";

export const ACP_BOARD_METHOD = "_clio-coder/session/board";
export const ACP_BOARD_META_KEY = "clio-coder/board";
export const ACP_BOARD_MAX_ITEMS = 100;
const MAX_TEXT_BYTES = 1024;
const MAX_EXPECTED_OUTPUTS = 8;

/** What the composition root hands over; the projection decides what reaches the wire. */
export interface AcpBoardSource {
	operatorTasks: ReadonlyArray<UserTask>;
	plan: TaskBoardSnapshot | null;
	decisions: ReadonlyArray<DecisionLedgerEntry>;
	memory: { enabled: boolean; tier: "llm" | "rules"; bank: TaskMemorySnapshot; stepInFlight: boolean } | null;
}

export interface AcpSessionBoard {
	version: 1;
	operatorTasks: Array<{
		id: string;
		title: string;
		status: UserTask["status"];
		expectedOutputs: string[];
		verificationChecks: number;
	}>;
	plan: {
		title: string;
		tasks: Array<{ id: string; title: string; status: string; origin: "agent" | "user"; reason: string | null }>;
	} | null;
	decisions: Array<{
		ref: string;
		/** With {@link key}, what `_clio-coder/decisions/supersede` names. */
		interviewId: string;
		key: string;
		label: string | null;
		value: string;
		status: "active" | "superseded";
		source: "operator" | "agent" | null;
		decidedAt: string;
		rationale: string | null;
		correction: string | null;
	}>;
	memory: {
		enabled: boolean;
		tier: "llm" | "rules";
		entries: number;
		stepInFlight: boolean;
		/** Knowledge and procedural entries a person may propose as durable memory; status stays private. */
		bank: Array<{ id: string; kind: "knowledge" | "procedural"; content: string }>;
	} | null;
	/** True when any list was cut at {@link ACP_BOARD_MAX_ITEMS}. */
	truncated: boolean;
}

function bounded(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= MAX_TEXT_BYTES) return text;
	let cut = text.slice(0, MAX_TEXT_BYTES);
	while (Buffer.byteLength(cut, "utf8") > MAX_TEXT_BYTES - 3) cut = cut.slice(0, -1);
	return `${cut}…`;
}
const optional = (text: string | undefined) => (text === undefined || text === "" ? null : bounded(text));

export function projectSessionBoard(source: AcpBoardSource): AcpSessionBoard {
	let truncated = false;
	const capped = <T>(items: ReadonlyArray<T>): ReadonlyArray<T> => {
		if (items.length <= ACP_BOARD_MAX_ITEMS) return items;
		truncated = true;
		return items.slice(0, ACP_BOARD_MAX_ITEMS);
	};
	// The ledger keeps every revision of an interview newest first; a person reads each decision once.
	const decisions = source.decisions.flatMap((entry) =>
		entry.decisions.map((decision) => ({
			ref: `${entry.interviewId}/${decision.key}`,
			interviewId: entry.interviewId,
			key: bounded(decision.key),
			label: optional(decision.label),
			value: bounded(decision.value),
			status: decision.status,
			source: decision.source ?? null,
			decidedAt: decision.decidedAt,
			rationale: optional(decision.rationale),
			correction: optional(decision.correction),
		})),
	);
	return {
		version: 1,
		operatorTasks: capped(source.operatorTasks).map((task) => ({
			id: task.id,
			title: bounded(task.title),
			status: task.status,
			expectedOutputs: (task.acceptance?.expectedOutputs ?? []).slice(0, MAX_EXPECTED_OUTPUTS).map(bounded),
			verificationChecks: task.acceptance?.verification.length ?? 0,
		})),
		plan:
			source.plan === null
				? null
				: {
						title: bounded(source.plan.title),
						tasks: capped(source.plan.tasks).map((task) => ({
							id: task.id,
							title: bounded(task.title),
							status: task.status,
							origin: task.origin ?? "agent",
							reason: optional(task.reason),
						})),
					},
		decisions: [...capped(decisions)],
		memory:
			source.memory === null
				? null
				: {
						enabled: source.memory.enabled,
						tier: source.memory.tier,
						entries:
							(source.memory.bank.status === null ? 0 : 1) +
							source.memory.bank.knowledge.length +
							source.memory.bank.procedural.length,
						stepInFlight: source.memory.stepInFlight,
						bank: [...source.memory.bank.knowledge, ...source.memory.bank.procedural]
							.filter((entry) => typeof entry?.id === "string" && typeof entry.content === "string")
							.slice(0, ACP_BOARD_MAX_ITEMS)
							.map((entry) => ({
								id: entry.id,
								kind: entry.kind === "procedural" ? ("procedural" as const) : ("knowledge" as const),
								content: bounded(entry.content),
							})),
					},
		truncated,
	};
}
