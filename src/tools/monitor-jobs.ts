import type { JobRecord } from "../core/job-types.js";
import { jobIsComplete } from "../domains/scheduling/index.js";
import type { JobOperations } from "./job-types.js";
import { monitorToolSurface } from "./monitor-surface.js";
import type { ToolInvokeOptions, ToolResult, ToolSpec } from "./registry.js";

function jobLine(job: JobRecord): string {
	return `job ${job.id}: ${job.state}${job.reason ? ` (${job.reason})` : ""}; runner=${job.spec.runner.kind}; starts=${job.starts}/${job.spec.count ?? "deadline"}; settled=${job.settled}; every=${job.spec.intervalMs}ms; timeout=${job.spec.timeoutMs}ms; next=${job.nextDueAt === null ? "none" : new Date(job.nextDueAt).toISOString()}; active=${job.active?.id ?? "none"}; pending=${job.pending?.id ?? "none"}${job.pendingReason ? ` (${job.pendingReason})` : ""}; delivery=${job.delivery?.state ?? "none"}; complete=${jobIsComplete(job)}; costUsd=${job.costUsd ?? "not measured"}${job.persistenceError ? `; persistence=${job.persistenceError}` : ""}`;
}

export function listJobMonitor(jobs: JobOperations): ToolResult {
	const all = jobs.list();
	const shown = [...all].sort((left, right) => right.createdAt - left.createdAt).slice(0, 20);
	return {
		kind: "ok",
		output: shown.length
			? `jobs (this conversation, ${shown.length} of ${all.length}):\n${shown.map(jobLine).join("\n")}`
			: "No interval jobs recorded for this conversation.",
		details: { jobs: shown, jobCount: all.length },
	};
}

/** Observation never consumes or cancels a controller delivery (#411). */
export async function runJobMonitor(
	jobs: JobOperations | undefined,
	args: Record<string, unknown>,
	options?: ToolInvokeOptions,
): Promise<ToolResult | null> {
	if (args.job_id === undefined && args.scope !== "jobs") return null;
	if (!jobs)
		return {
			kind: "error",
			message: "monitor: this host has no session-owned job controller. Use an attended terminal or ACP conversation.",
		};
	if (args.run_id !== undefined || args.run_ids !== undefined || args.batch_id !== undefined)
		return { kind: "error", message: "monitor: inspect job_id/scope=jobs separately from worker run IDs and batches." };
	const id = typeof args.job_id === "string" ? args.job_id.trim() : "";
	const mode = args.mode ?? (id ? "status" : "list");
	if (mode === "list" && !id) return listJobMonitor(jobs);
	if (!id || (mode !== "status" && mode !== "wait"))
		return {
			kind: "error",
			message:
				"monitor: jobs support scope=jobs mode=list, or job_id with mode=status/wait. Jobs carry occurrence evidence, not worker receipts.",
		};
	const timeout = args.timeout_ms ?? 60_000;
	if (
		mode === "wait" &&
		(typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 600_000)
	)
		return { kind: "error", message: "monitor: job wait timeout_ms must be an integer from 1 through 600000." };
	let job = jobs.status(id);
	if (!job)
		return { kind: "error", message: "monitor: unknown job or creator session/process/cwd ownership does not match." };
	if (
		mode === "wait" &&
		options?.turnId !== undefined &&
		!jobIsComplete(job) &&
		(job.spec.runner.kind === "main" || job.spec.onMatch.kind === "main_turn")
	) {
		return {
			kind: "ok",
			output: `${jobLine(job)}\nPending: this caller occupies the main conversation lane needed by this job or its match analysis. End the current turn, then inspect status or wait from the operator host. Observation did not complete or cancel the job.`,
			details: { job, complete: false, pendingCapacity: "caller occupies main conversation" },
		};
	}
	let timedOut = false;
	let canceled = false;
	if (mode === "wait" && !jobIsComplete(job)) {
		await new Promise<void>((resolve) => {
			let finished = false;
			let unsubscribe = (): void => {};
			let timer: ReturnType<typeof setTimeout> | null = null;
			const finish = (): void => {
				if (finished) return;
				finished = true;
				unsubscribe();
				if (timer !== null) clearTimeout(timer);
				options?.signal?.removeEventListener("abort", abort);
				resolve();
			};
			const abort = (): void => {
				canceled = true;
				finish();
			};
			unsubscribe = jobs.subscribe((view) => {
				if (view.id === id) {
					job = view;
					if (jobIsComplete(view)) finish();
				}
			});
			options?.signal?.addEventListener("abort", abort, { once: true });
			timer = setTimeout(() => {
				timedOut = true;
				finish();
			}, timeout as number);
			// Re-read after subscription so a settlement cannot fall between the two (#411).
			job = jobs.status(id);
			if (!job || jobIsComplete(job)) finish();
			else if (options?.signal?.aborted) abort();
		});
		job = jobs.status(id);
		if (!job)
			return {
				kind: "error",
				message: "monitor: the creator conversation changed while waiting; this observation ended.",
			};
	}
	const last = job.history.at(-1)?.evidence;
	return {
		kind: "ok",
		output: `${jobLine(job)}\nsession=${job.owner.sessionId}; cwd=${job.owner.cwd}${mode === "wait" ? `\nwait: ${canceled ? "observation canceled" : timedOut ? "timed out" : "settled"}` : ""}${last ? `\nlast occurrence: ${last.outcome}; displayTruncated=${last.truncated}; jsonComplete=${last.jsonComplete}\n${last.summary}` : ""}`,
		details: { job, complete: jobIsComplete(job), timedOut, canceled },
	};
}

export function createJobMonitorTool(jobs: JobOperations): ToolSpec {
	return {
		...monitorToolSurface,
		async run(args, options) {
			return (
				(await runJobMonitor(jobs, args, options)) ??
				(args.mode === undefined || args.mode === "list"
					? listJobMonitor(jobs)
					: { kind: "error", message: "monitor: worker monitoring is unavailable on this host; use scope=jobs or job_id." })
			);
		},
	};
}
