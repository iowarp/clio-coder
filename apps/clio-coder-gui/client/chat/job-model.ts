// Recurring job rows: what one canonical `AcpJob` says, in words, and which controls it admits. No React and no
// clock of its own; the caller passes `now`. Every number shown is the engine's own, never derived here.

import type { AcpJob } from "../../contracts/wire.js";
import type { StatusTone } from "../design/status.js";

export type JobAction = "pause" | "resume" | "stop" | "cancel";

export interface JobRowView {
	readonly jobId: string;
	readonly title: string;
	readonly tone: StatusTone;
	readonly state: string;
	/** The engine is doing work for this job right now, so its mark may spin. */
	readonly working: boolean;
	readonly facts: readonly string[];
	/** One sentence the operator needs when something is held, failing or unresolved. */
	readonly note: string | null;
	readonly actions: readonly JobAction[];
}

/** Finished jobs kept in the strip after the live ones; the rest are history the session already counted. */
const FINISHED_KEPT = 2;
const SUMMARY_CHARS = 140;

/** Polling, a held delivery, a cancel in flight or unresolved cleanup: anything that is not settled. */
export const jobIsLive = (job: AcpJob): boolean => job.state !== "terminal" || !job.complete;

/** Live jobs in arrival order, then the newest few finished ones. */
export function visibleJobs(jobs: readonly AcpJob[]): readonly AcpJob[] {
	const live = jobs.filter(jobIsLive);
	const finished = jobs.filter((job) => !jobIsLive(job)).slice(-FINISHED_KEPT);
	return [...live, ...finished];
}

export function formatSpan(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60 === 0 ? "" : ` ${seconds % 60}s`}`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h${minutes % 60 === 0 ? "" : ` ${minutes % 60}m`}`;
	return `${Math.floor(hours / 24)}d`;
}

const OUTCOME_WORDS = {
	succeeded: "succeeded",
	failed: "failed",
	noop: "unchanged",
	canceled: "canceled",
	timed_out: "timed out",
	interrupted: "interrupted",
} as const satisfies Record<NonNullable<AcpJob["last"]>["outcome"], string>;

const ENDED: Record<NonNullable<AcpJob["reason"]>, { state: string; tone: StatusTone }> = {
	count: { state: "Finished", tone: "success" },
	condition: { state: "Condition met", tone: "success" },
	stopped: { state: "Stopped", tone: "neutral" },
	canceled: { state: "Canceled", tone: "warn" },
	deadline: { state: "Deadline reached", tone: "warn" },
	failure: { state: "Failed", tone: "fail" },
};

const DELIVERY_WORDS = {
	pending: "analysis pending",
	running: "analysis running",
	delivered: "analysis delivered",
	dropped: "analysis dropped",
	failed: "analysis failed",
} as const satisfies Record<NonNullable<AcpJob["delivery"]>["state"], string>;

function costFact(job: AcpJob): string | null {
	if (job.starts === 0) return null;
	// A command-only job makes no model call. A main run, or a command job whose match requested a main-turn
	// analysis, spends model tokens, so its recorded cost is shown and an unrecorded one is unknown, never free.
	if (job.runner === "command" && job.delivery?.kind !== "main_turn") return "no model cost";
	return job.costUsd === null
		? "cost unknown"
		: `$${job.costUsd.toFixed(job.costUsd > 0 && job.costUsd < 0.01 ? 4 : 2)}`;
}

function stateOf(job: AcpJob): { state: string; tone: StatusTone; working: boolean } {
	const working = job.running || job.turn || job.delivery?.state === "running";
	if (!job.saved) return { state: "Not saved", tone: "fail", working };
	if (job.state === "terminal") {
		if (!job.complete) return { state: "Finishing", tone: working ? "running" : "warn", working };
		const ended = job.reason === null ? { state: "Ended", tone: "neutral" as const } : ENDED[job.reason];
		return { ...ended, working: false };
	}
	if (job.state === "paused")
		return job.reason === "failure"
			? { state: "Paused after failure", tone: "fail", working }
			: { state: "Paused", tone: "warn", working };
	if (working) return { state: "Running", tone: "running", working };
	return job.pendingReason === null
		? { state: "Scheduled", tone: "neutral", working }
		: { state: "Waiting", tone: "warn", working };
}

function actionsOf(job: AcpJob): readonly JobAction[] {
	if (job.state === "terminal") return job.complete ? [] : ["cancel"];
	return job.state === "paused" ? ["resume", "stop", "cancel"] : ["pause", "stop", "cancel"];
}

function noteOf(job: AcpJob): string | null {
	if (!job.saved) return "The job could not be saved, so its execution is suspended.";
	if (job.cancelRequested) return "Cancel requested. Waiting for the current work to settle.";
	if (job.consecutiveFailures !== null && job.consecutiveFailures > 0 && job.state !== "terminal")
		return `${job.consecutiveFailures} consecutive ${job.consecutiveFailures === 1 ? "failure" : "failures"}.`;
	return job.pendingReason;
}

export function jobRowView(job: AcpJob, now: number): JobRowView {
	const { state, tone, working } = stateOf(job);
	const facts: string[] = [];
	if (job.intervalMs !== null) facts.push(`every ${formatSpan(job.intervalMs)}`);
	facts.push(
		job.starts === null
			? "starts not recorded"
			: job.count === null
				? `${job.starts} started`
				: `${job.starts} of ${job.count} started`,
	);
	if (job.state === "active" && !working && job.nextDueAt !== null)
		facts.push(job.nextDueAt <= now ? "due now" : `next in ${formatSpan(job.nextDueAt - now)}`);
	if (job.state !== "terminal" && job.deadlineAt !== null)
		facts.push(job.deadlineAt <= now ? "past its deadline" : `ends in ${formatSpan(job.deadlineAt - now)}`);
	if (job.delivery !== null) facts.push(DELIVERY_WORDS[job.delivery.state]);
	if (job.last !== null) {
		const summary = job.last.summary.replace(/\s+/gu, " ").trim();
		const clipped = summary.length > SUMMARY_CHARS ? `${summary.slice(0, SUMMARY_CHARS)}…` : summary;
		facts.push(
			`last ${OUTCOME_WORDS[job.last.outcome]}${clipped === "" ? "" : `: ${clipped}`}${job.last.truncated ? " (truncated)" : ""}`,
		);
	}
	const cost = costFact(job);
	if (cost !== null) facts.push(cost);
	return {
		jobId: job.jobId,
		title: job.taskPreview === "" ? (job.runner === "command" ? "Command poll" : "Scheduled task") : job.taskPreview,
		tone,
		state,
		working,
		facts,
		note: noteOf(job),
		actions: actionsOf(job),
	};
}

export const JOB_CONFIRMATIONS: Readonly<
	Record<"stop" | "cancel", { readonly ask: string; readonly confirm: string }>
> = {
	stop: { ask: "Stop this loop? It starts no new runs and lets the current run finish.", confirm: "Stop loop" },
	cancel: {
		ask: "Cancel this loop? The current run is aborted and pending work is dropped.",
		confirm: "Cancel loop",
	},
};

export const JOB_ACTION_LABELS: Readonly<Record<JobAction, string>> = {
	pause: "Pause",
	resume: "Resume",
	stop: "Stop",
	cancel: "Cancel",
};

export const liveJobsLabel = (count: number): string => (count === 1 ? "1 loop" : `${count} loops`);
