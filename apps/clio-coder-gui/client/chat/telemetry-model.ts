import type { MemoryGuardian, SessionPlan } from "../../contracts/session-telemetry.js";
import type { StatusTone } from "../design/status.js";
import type { PlanRow } from "./board-model.js";

const states = {
	pending: ["neutral", "Pending"],
	in_progress: ["running", "In progress"],
	completed: ["success", "Completed"],
	blocked: ["warn", "Blocked"],
} as const;

export function livePlanView(plan: SessionPlan): { title: string; rows: PlanRow[] } {
	return {
		title: plan.title ?? "Clio Coder’s plan",
		rows: plan.entries.map((entry) => ({
			id: entry.id,
			title: entry.content,
			reason: entry.reason,
			tone: states[entry.status][0],
			word: states[entry.status][1],
		})),
	};
}

export interface MemoryGuardianMark {
	tone: StatusTone;
	label: string;
	title: string;
	live: boolean;
}

/**
 * The conversation header's memory indicator. It speaks only while the
 * guardian works or cannot, and only for a live session: a parked, closed or
 * unreachable one keeps no indicator from before it stopped.
 */
export function memoryGuardianMark(
	memory: MemoryGuardian | undefined,
	sessionLive: boolean,
): MemoryGuardianMark | null {
	if (!sessionLive || memory === undefined) return null;
	switch (memory.state) {
		case "reviewing":
			return {
				tone: "running",
				label: "Memory reviewing",
				title: "Clio is reviewing finished work and this repository's earlier sessions for lessons",
				live: true,
			};
		case "waiting-capacity":
			return {
				tone: "warn",
				label: "Memory waiting",
				title: "Memory review is waiting for room on its model endpoint and resumes when there is some",
				live: false,
			};
		case "unavailable":
			return {
				tone: "unverified",
				label: "Memory unavailable",
				title: "The memory model is unavailable; rule-based memory keeps working",
				live: false,
			};
		default:
			return null;
	}
}
