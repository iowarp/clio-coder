// Recurring jobs at the transcript's live edge, beside the running workers. One row per job, never one per
// run: the engine's own counts, next due time and last outcome, and the controls its command admits. The
// fold and the wording live in ./job-model.ts.

import { useMutation, useQuery } from "@tanstack/react-query";
import { memo, useEffect, useMemo, useState } from "react";
import { routes } from "../../contracts/routes.js";
import type { AcpJob } from "../../contracts/wire.js";
import type { Client } from "../api/client.js";
import { clock } from "../api/clock.js";
import { StatusMark } from "../design/status.js";
import { capabilityRefusal } from "./composer-model.js";
import {
	JOB_ACTION_LABELS,
	JOB_CONFIRMATIONS,
	type JobAction,
	jobRowView,
	liveJobsLabel,
	visibleJobs,
} from "./job-model.js";
import "./approval.css";

type Outcome = { tone: "success" | "warn" | "fail"; message: string };

function JobControls({
	client,
	sessionId,
	jobId,
	actions,
}: {
	client: Client;
	sessionId: string;
	jobId: string;
	actions: readonly JobAction[];
}) {
	const [confirm, setConfirm] = useState<"stop" | "cancel" | null>(null);
	const [outcome, setOutcome] = useState<Outcome | null>(null);
	// Pause and resume go through the same `/loop` command the terminal types. Stop and cancel stay two
	// distinct requests: stop lets the current run settle, cancel aborts it.
	const control = useMutation({
		mutationFn: (action: JobAction) =>
			client.call(routes.invokeSessionCommand, {
				params: { id: sessionId },
				query: {},
				body: { command: "loop", argv: [action, jobId] },
			}),
		onSuccess: (result) => {
			setOutcome({
				tone: result.level === "error" ? "fail" : result.level === "warn" ? "warn" : "success",
				message: result.lines.slice(0, 3).join(" "),
			});
			setConfirm(null);
		},
		onError: (error) => {
			setOutcome({
				tone: capabilityRefusal(error) === null ? "fail" : "warn",
				message: capabilityRefusal(error) ?? (error instanceof Error ? error.message : String(error)),
			});
			setConfirm(null);
		},
	});
	return (
		<div className="fleet-steer" data-mode={confirm === null ? "idle" : `confirm-${confirm}`}>
			{confirm === null ? (
				<div className="fleet-steer__actions">
					{actions.map((action) => (
						<button
							key={action}
							type="button"
							disabled={control.isPending}
							aria-label={`${JOB_ACTION_LABELS[action]} loop ${jobId}`}
							onClick={() => {
								setOutcome(null);
								if (action === "stop" || action === "cancel") setConfirm(action);
								else control.mutate(action);
							}}
						>
							{JOB_ACTION_LABELS[action]}
						</button>
					))}
				</div>
			) : (
				<div className="fleet-steer__actions">
					<span>{JOB_CONFIRMATIONS[confirm].ask}</span>
					<button
						type="button"
						className="fleet-steer__stop"
						disabled={control.isPending}
						onClick={() => control.mutate(confirm)}
					>
						{JOB_CONFIRMATIONS[confirm].confirm}
					</button>
					<button
						type="button"
						onClick={() => setConfirm(null)}
						// biome-ignore lint/a11y/noAutofocus: the operator just asked to end work; the safe answer takes focus.
						autoFocus
					>
						Keep running
					</button>
				</div>
			)}
			{outcome === null ? null : (
				<p role="status" className="fleet-steer__outcome" data-tone={outcome.tone}>
					{outcome.message}
				</p>
			)}
		</div>
	);
}

/** One re-render a second while a due time or a deadline is counting down, and none otherwise. */
function useNow(counting: boolean): number {
	const [now, setNow] = useState(() => clock.now());
	useEffect(() => {
		if (!counting) return;
		setNow(clock.now());
		const timer = setInterval(() => setNow(clock.now()), 1000);
		return () => clearInterval(timer);
	}, [counting]);
	return now;
}

/**
 * The session's recurring jobs: every live one, then the newest few that finished. `jobs` keeps its identity
 * across narrative deltas, so streamed text never re-renders this.
 */
export const LiveJobs = memo(function LiveJobs({
	client,
	sessionId,
	sessionOpen,
	jobs,
}: {
	client: Client;
	sessionId: string;
	sessionOpen: boolean;
	jobs: readonly AcpJob[] | undefined;
}) {
	// The composer's key, so this is the same single request per session.
	const capabilities = useQuery({
		queryKey: ["session-capabilities", sessionId],
		queryFn: () => client.call(routes.sessionCapabilities, { params: { id: sessionId }, query: {}, body: {} }),
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
		enabled: sessionOpen,
	});
	const shown = useMemo(() => visibleJobs(jobs ?? []), [jobs]);
	const counting = shown.some((job) => job.state !== "terminal" && (job.nextDueAt !== null || job.deadlineAt !== null));
	const now = useNow(counting);
	if (shown.length === 0) return null;
	const controllable = sessionOpen && capabilities.data?.commands !== undefined;
	return (
		<section className="live-workers live-jobs" aria-label={liveJobsLabel(shown.length)}>
			<ul className="fleet-runs">
				{shown.map((job) => {
					const view = jobRowView(job, now);
					return (
						<li className="fleet-run" key={view.jobId}>
							<span className="fleet-run__glyph" aria-hidden="true">
								↻
							</span>
							<span className="fleet-run__agent">{view.jobId}</span>
							<span className="fleet-run__task">
								{view.title}
								<small className="fleet-run__note">{view.facts.join(" · ")}</small>
								{view.note === null ? null : <small className="fleet-run__note">{view.note}</small>}
							</span>
							<span className="fleet-run__state">
								<StatusMark tone={view.tone} label={view.state} live={view.working} />
							</span>
							{controllable && view.actions.length > 0 ? (
								<JobControls client={client} sessionId={sessionId} jobId={view.jobId} actions={view.actions} />
							) : null}
						</li>
					);
				})}
			</ul>
		</section>
	);
});
