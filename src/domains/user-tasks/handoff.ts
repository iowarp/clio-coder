import type { UserTask } from "./store.js";

/** The operator-authored pickup turn shared by CLI, slash, and overlay handoffs. */
export function formatUserTaskHandoff(task: Pick<UserTask, "id" | "title" | "note" | "acceptance">): string {
	const note = task.note ? ` ${task.note}.` : "";
	const acceptance = task.acceptance ? ` Acceptance: ${JSON.stringify(task.acceptance)}.` : "";
	return (
		`Operator task ${task.id}: ${task.title}.${note}${acceptance} ` +
		`Before working this task, call tasks action="pick" id="${task.id}" and confirm its durable session/board link. ` +
		"Use the returned linked tN for start and done; do not replace the pickup with a self-created plan or pick unrelated inbox tasks. " +
		"Respect the task's authorized scope, including proposal-only limits. If pickup fails, report the actual state and stop this task's work. " +
		"After work and required verification, call tasks done on that linked tN with concrete evidence, then tasks list. " +
		`Claim ${task.id} completed only if the linked board row is completed and the durable operator task is done with the same session/board link. ` +
		"Report the IDs, actual state, and verification results or limitations; an unpicked or still-handed task is not done."
	);
}
