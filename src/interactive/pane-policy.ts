/**
 * The one decision function for opening a run-watching pane.
 *
 * Policy, stated whole: panes are pulled by the operator, never pushed by the
 * fleet. A dispatch starting, detaching, backgrounding, or failing opens
 * nothing; the native surfaces (transcript, Alt+W board, footer) already carry
 * that state, and the v0.3/v0.4 behavior of opening a hidden viewer pane per
 * dispatch produced panes nobody had asked for. A pane opens only when the
 * operator names a run: Enter in the workers view, `/panes show`, or the
 * `panes` tool acting on the conversation's behalf.
 *
 * The `dispatch` source is the seam for ever marking a dispatch watchable at
 * enqueue time. It exists so the decision stays in this one function; today it
 * always refuses, and any future exception must be argued here, not in a
 * config key.
 *
 * This module is a leaf on purpose: `panes-runtime.ts` is a boundaries seam
 * whose value closure must stay off the render graph, so the policy cannot
 * live beside the dispatch board that shares its status vocabulary.
 */

export type PaneWatchSource = "workers-view" | "slash" | "tool" | "dispatch";

/** Statuses with a live process behind them, in the dispatch board's vocabulary. */
const WATCHABLE_STATUSES = new Set(["running", "stale", "cancelling", "enqueued", "retrying"]);

export interface PaneWatchRequest {
	source: PaneWatchSource;
	/** The run's lifecycle status; anything unrecognized reads as terminal. */
	runStatus: string;
}

export type PaneWatchDecision = { open: true } | { open: false; reason: string };

export function paneWatchDecision(request: PaneWatchRequest): PaneWatchDecision {
	if (request.source === "dispatch") {
		return { open: false, reason: "dispatches run headless; watch a run from the workers view or /panes show" };
	}
	if (!WATCHABLE_STATUSES.has(request.runStatus)) {
		return {
			open: false,
			reason: `run is ${request.runStatus}; use \`clio-coder fleet view <runId>\` for the post-mortem`,
		};
	}
	return { open: true };
}
