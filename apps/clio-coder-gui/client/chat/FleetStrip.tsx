// The fleet strip: one row per dispatched run, inside the conversation. It replaces a list that
// printed one row per event with a JSON payload underneath, which meant five rows for one run and
// no way to see what any of them was doing.
//
// The Running-only filter is off by default and says how many rows it hid, because a settled row
// must never disappear unannounced. The taxonomy and the fold live in ./fleet-facts.ts.

import type { SessionSnapshot } from "../../contracts/sessions.js";
import { formatTime } from "../api/clock.js";
import { StatusMark } from "../design/status.js";
import {
	FLEET_EMPTY,
	FLEET_EMPTY_FILTERED,
	FLEET_GLYPHS,
	FLEET_STATE_TONES,
	FLEET_SUMMARY_GLYPH,
	type FleetRun,
	fleetFilterStatus,
	fleetNotices,
	fleetRunDetail,
	fleetRunNote,
	fleetRunTitle,
	fleetSummaryLabel,
	foldFleetRuns,
	isLiveRun,
} from "./fleet-facts.js";
import "./approval.css";

/** The run rows alone, so a dispatch tool card can render its own matching runs inline. */
export function FleetRunRows({ runs }: { runs: readonly FleetRun[] }) {
	return (
		<ul className="fleet-runs">
			{runs.map((run) => {
				const note = fleetRunNote(run);
				return (
					<li className="fleet-run" key={run.runId}>
						<span className="fleet-run__glyph" aria-hidden="true">
							{FLEET_GLYPHS[run.state]}
						</span>
						<span className="fleet-run__agent">{run.agentId}</span>
						<span className="fleet-run__task">
							{fleetRunTitle(run)}
							{note === null ? null : <small className="fleet-run__note">{note}</small>}
						</span>
						<span className="fleet-run__state">
							<StatusMark tone={FLEET_STATE_TONES[run.state]} label={fleetRunDetail(run)} />
						</span>
					</li>
				);
			})}
		</ul>
	);
}

export function FleetStrip({
	session,
	runningOnly = false,
	onRunningOnly,
}: {
	session: SessionSnapshot;
	/** Off by default. Owned by the caller so the choice survives a re-render of the conversation. */
	runningOnly?: boolean;
	onRunningOnly?: (next: boolean) => void;
}) {
	const runs = foldFleetRuns(session.fleet);
	const notices = fleetNotices(session.fleet);
	if (runs.length === 0 && notices.length === 0) return null;
	const shown = runningOnly ? runs.filter(isLiveRun) : runs;
	const live = runs.filter(isLiveRun).length;
	return (
		<details className="fleet-strip fleet-strip--runs" open={live > 0}>
			<summary>
				<span aria-hidden="true">{FLEET_SUMMARY_GLYPH}</span> {fleetSummaryLabel(runs)}
				<span className="fleet-strip__count">{runs.length}</span>
			</summary>
			{runs.length > 0 ? (
				<>
					<div className="fleet-strip__filter">
						<button
							type="button"
							aria-pressed={runningOnly}
							onClick={() => onRunningOnly?.(!runningOnly)}
							disabled={onRunningOnly === undefined}
						>
							Running only
						</button>
						<p role="status">{fleetFilterStatus(shown.length, runs.length)}</p>
					</div>
					{shown.length === 0 ? <p>{FLEET_EMPTY_FILTERED}</p> : <FleetRunRows runs={shown} />}
				</>
			) : (
				<p>{FLEET_EMPTY}</p>
			)}
			{notices.length > 0 ? (
				<ul className="fleet-runs fleet-runs--notices">
					{notices.map((notice) => (
						<li className="fleet-run" key={notice.id}>
							<span className="fleet-run__agent">{notice.presentation.label}</span>
							<span className="fleet-run__task">{notice.presentation.summary}</span>
							<span className="fleet-run__state">
								<StatusMark tone={notice.presentation.tone} label={formatTime(notice.at)} />
							</span>
						</li>
					))}
				</ul>
			) : null}
		</details>
	);
}
