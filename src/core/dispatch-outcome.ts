/**
 * Shared mapping from a `DispatchFailed` payload's `reason` field to the
 * terminal status it implies. Both the observability projection's run
 * summary (src/domains/observability/projection.ts) and the interactive
 * dispatch board (src/interactive/dispatch-board.ts) derive a run's status
 * from the same DispatchCompleted/DispatchFailed bus events; before this
 * module existed they each carried their own copy of this exact mapping,
 * kept in sync only by a comment asking the next editor to remember to.
 */
export type DispatchFailureStatus = "dead" | "aborted" | "failed";

export function resolveDispatchFailureStatus(reason: unknown): DispatchFailureStatus {
	if (reason === "dead" || reason === "stalled") return "dead";
	if (reason === "interrupted" || reason === "canceled") return "aborted";
	return "failed";
}
