import { useQuery } from "@tanstack/react-query";
import { memo, useId, useMemo, useState } from "react";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { formatClock, formatTime } from "../api/clock.js";
import { StatusMark } from "../design/status.js";
import { Explained } from "../telemetry/Explained.js";
import { TIMELINE_PAGE, timelineKinds, timelinePage, timelineRows } from "../telemetry/timeline-model.js";
import "./session-board.css";
import "./pane-inspection.css";
import "./timeline-panel.css";

/**
 * The session's journal in time order (#434 §11.3): calls, turns, tools, settings, budget and quota readings, and
 * every other kind the read model folds, newest first. Read cold, so a closed task has one too; a live
 * telemetry_update for the timeline re-reads it.
 */
export const TimelinePanel = memo(function TimelinePanel({
	client,
	sessionId,
	active,
}: {
	client: Client;
	sessionId: string;
	active: boolean;
}) {
	const id = useId();
	const [kind, setKind] = useState("");
	const [limit, setLimit] = useState(TIMELINE_PAGE);
	const timeline = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["telemetry", sessionId, "timeline"],
		queryFn: ({ signal }) =>
			client.call(routes.telemetryTimeline, { params: { id: sessionId }, query: {}, body: {} }, undefined, signal),
		enabled: active,
		retry: false,
	});
	const rows = useMemo(() => (timeline.data ? timelineRows(timeline.data.entries) : []), [timeline.data]);
	const kinds = useMemo(() => timelineKinds(rows), [rows]);
	const page = useMemo(() => timelinePage(rows, kind, limit), [rows, kind, limit]);
	return (
		<div className="pane-drill drill timeline-panel">
			{timeline.isPending && active ? <p className="pane-empty">Reading the journal…</p> : null}
			{timeline.error ? (
				<p role="alert" className="pane-empty">
					{timeline.error.message}{" "}
					<button type="button" disabled={timeline.isFetching} onClick={() => void timeline.refetch()}>
						Retry timeline
					</button>
				</p>
			) : null}
			{timeline.data && rows.length === 0 ? (
				<p className="pane-empty">Nothing has been journaled for this task yet.</p>
			) : null}
			{rows.length > 0 ? (
				<section className="drill__section" aria-labelledby={`${id}-entries`}>
					<h3 id={`${id}-entries`}>Newest first</h3>
					<div className="pane-inspection-filters">
						<label>
							Entry kind
							<select
								value={kind}
								onChange={(event) => {
									setKind(event.target.value);
									setLimit(TIMELINE_PAGE);
								}}
							>
								<option value="">All entries</option>
								{kinds.map((word) => (
									<option key={word} value={word}>
										{word}
									</option>
								))}
							</select>
						</label>
					</div>
					<ol className="drill__rows timeline-panel__rows" aria-label="Journal entries, newest first">
						{page.rows.map((row) => (
							<li key={row.key}>
								<StatusMark tone={row.tone} label={row.kind} />
								<span className="drill__main">
									<strong className="timeline-panel__title">{row.title}</strong>
									{row.stages.length > 0 ? (
										<span className="timeline-panel__stages" aria-hidden="true">
											{row.stages.map((bar) => (
												<i
													key={bar.stage}
													className="trace-stage"
													data-stage={bar.stage}
													title={bar.stage}
													style={{ left: `${bar.left}%`, width: `${Math.max(0.5, bar.width)}%` }}
												/>
											))}
										</span>
									) : null}
									{row.details.length > 0 ? (
										<dl className="timeline-panel__details">
											{row.details.map((detail) => (
												<div key={detail.label}>
													<dt>{detail.label}</dt>
													<dd className="drill__num">
														<Explained
															client={client}
															label={`${detail.label}, ${row.title}`}
															value={detail.value}
															ref={detail.ref}
														/>
													</dd>
												</div>
											))}
										</dl>
									) : null}
								</span>
								<time className="drill__num timeline-panel__at" dateTime={row.at} title={formatTime(row.at)}>
									{formatClock(row.at)}
								</time>
							</li>
						))}
					</ol>
					{page.earlier > 0 ? (
						<button
							type="button"
							className="timeline-panel__more"
							onClick={() => setLimit((current) => current + TIMELINE_PAGE)}
						>
							Show earlier entries ({page.earlier} more)
						</button>
					) : null}
				</section>
			) : null}
		</div>
	);
});
