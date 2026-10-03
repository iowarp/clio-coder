import type { SessionPlan } from "../../contracts/session-telemetry.js";
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
