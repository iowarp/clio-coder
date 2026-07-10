import { ToolNames } from "../../core/tool-names.js";
import type { DispatchContract } from "../dispatch/contract.js";
import { isTerminalRunEnvelope } from "../dispatch/types.js";
import type { MiddlewareHookRegistration } from "./runtime.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "./types.js";

/**
 * Detached-dispatch collection nudge, packaged as a turn_end hook
 * registration (same shape as the open-tasks nudge in task-nudge.ts).
 *
 * A detached batch returns before its runs finish, so nothing in the turn
 * forces the model back to the results. When a settled turn ends while at
 * least one uncollected batch has every run terminal, the turn is carried
 * onward with a `request_continuation` plus a paired reminder naming the
 * ready batches. Collecting a batch (monitor mode="collect") marks it in the
 * durable store, which removes it from the open list and silences the nudge,
 * including across session resume.
 *
 * Deliberate non-triggers: batches with runs still in flight (there is
 * nothing to collect yet; the dispatch board shows live progress), aborted or
 * errored turns, and surfaces without the monitor tool (nudging them would
 * loop against a wall).
 */

export const DETACHED_DISPATCH_NUDGE_REGISTRATION_ID = "nudge.detached-dispatch";

export interface DetachedBatchNudgeView {
	id: string;
	total: number;
	terminal: number;
}

/**
 * Open (uncollected) detached batches with terminal-run progress, computed
 * from the durable batch store and the run ledger. A ledger row pruned from
 * the bounded ring counts as terminal: it can never complete, so the batch
 * must stay collectible instead of pending forever.
 */
export function openDetachedBatchViews(
	dispatch: Pick<DispatchContract, "detached" | "getRun">,
): DetachedBatchNudgeView[] {
	const detached = dispatch.detached;
	if (!detached) return [];
	let records: ReturnType<typeof detached.list>;
	try {
		records = detached.list();
	} catch {
		return [];
	}
	return records.map((record) => {
		let terminal = 0;
		for (const run of record.runs) {
			const row = dispatch.getRun(run.runId);
			if (row === null || isTerminalRunEnvelope(row)) terminal += 1;
		}
		return { id: record.id, total: record.runs.length, terminal };
	});
}

export function buildDetachedBatchesMessage(
	ready: ReadonlyArray<DetachedBatchNudgeView>,
	running: ReadonlyArray<DetachedBatchNudgeView>,
): string {
	const rows = ready.map((view) => `  - batch ${view.id}: ${view.terminal}/${view.total} run(s) done`);
	const runningNote =
		running.length > 0 ? `\n${running.length} other detached batch(es) are still running; leave those for later.` : "";
	return (
		`[Clio Coder] ${ready.length} detached dispatch batch(es) finished and are uncollected:\n` +
		`${rows.join("\n")}\n` +
		`Collect each with monitor mode="collect" batch_id=<id> and act on the results. ` +
		`A batch stays open (and keeps nudging) until it is collected.${runningNote}`
	);
}

export interface CreateDetachedDispatchNudgeRegistrationOptions {
	/** Live view of open detached batches; see openDetachedBatchViews. */
	getOpenBatches: () => ReadonlyArray<DetachedBatchNudgeView>;
}

export function createDetachedDispatchNudgeRegistration(
	options: CreateDetachedDispatchNudgeRegistrationOptions,
): MiddlewareHookRegistration {
	return {
		id: DETACHED_DISPATCH_NUDGE_REGISTRATION_ID,
		description: "carry the turn onward when detached dispatch results are ready to collect",
		hooks: ["turn_end"],
		evaluate(input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> {
			if (input.hook !== "turn_end") return [];
			// Only settled stop turns are candidates; aborted and errored turns
			// already carry their own recovery path. Absent stopReason is "stop",
			// mirroring the finish contract.
			const stopReason = input.metadata?.stopReason;
			if (stopReason !== undefined && stopReason !== "stop") return [];
			// A surface without the monitor tool can never collect a batch, so
			// nudging it would loop against a wall.
			const activeToolNames = input.metadata?.activeToolNames;
			if (typeof activeToolNames === "string" && !activeToolNames.split(",").includes(ToolNames.Monitor)) return [];
			let views: ReadonlyArray<DetachedBatchNudgeView>;
			try {
				views = options.getOpenBatches();
			} catch {
				return [];
			}
			const ready = views.filter((view) => view.total > 0 && view.terminal >= view.total);
			if (ready.length === 0) return [];
			const running = views.filter((view) => view.total > 0 && view.terminal < view.total);
			const message = buildDetachedBatchesMessage(ready, running);
			return [
				{ kind: "request_continuation", message },
				{ kind: "inject_reminder", message, severity: "warn" },
			];
		},
	};
}
