// The fleet strip: one row per dispatched run, inside the conversation. It replaces a list that
// printed one row per event with a JSON payload underneath, which meant five rows for one run and
// no way to see what any of them was doing.
//
// The Running-only filter is off by default and says how many rows it hid, because a settled row
// must never disappear unannounced. The taxonomy and the fold live in ./fleet-facts.ts.

import { useMutation, useQuery } from "@tanstack/react-query";
import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import type { FleetItem } from "../../contracts/fleet-events.js";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import { STEER_TEXT_MAX_BYTES } from "../../contracts/steering.js";
import type { Client } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { StatusMark } from "../design/status.js";
import { capabilityRefusal, steeringAffordances } from "./composer.js";
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
	guidanceReady,
	isLiveRun,
	type SteerOutcome,
	steerOutcome,
} from "./fleet-facts.js";
import "./approval.css";

export interface RunSteering {
	readonly client: Client;
	readonly sessionId: string;
}

/**
 * Guide or stop one live worker. Stop is a two-press control because it discards the worker's
 * in-flight work and there is no undo. `accepted` only means the engine queued the request, so
 * the outcome sentence never claims the worker has read or obeyed it.
 */
function RunSteer({ run, steering }: { run: FleetRun; steering: RunSteering }) {
	const [mode, setMode] = useState<"idle" | "guide" | "confirm-stop">("idle");
	const [text, setText] = useState("");
	const [outcome, setOutcome] = useState<SteerOutcome | null>(null);
	const field = useId();
	// Leaving the form or the question puts focus back on the button that opened it, instead of
	// dropping it on the page when that part of the row unmounts.
	const opened = useRef<"guide" | "stop" | null>(null);
	const guideButton = useRef<HTMLButtonElement>(null);
	const stopButton = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (mode !== "idle" || opened.current === null) return;
		(opened.current === "guide" ? guideButton : stopButton).current?.focus();
		opened.current = null;
	}, [mode]);
	const steer = useMutation({
		mutationFn: (body: { action: "guide" | "cancel"; message?: string }) =>
			steering.client.call(routes.steerDispatchRun, {
				params: { id: steering.sessionId },
				query: {},
				body: { runId: run.runId, ...body },
			}),
		onSuccess: (result, body) => {
			setOutcome(steerOutcome(body.action, result));
			if (result.accepted && body.action === "guide") setText("");
			setMode("idle");
		},
		onError: (error) => {
			setOutcome({
				tone: capabilityRefusal(error) === null ? "fail" : "warn",
				message: capabilityRefusal(error) ?? (error instanceof Error ? error.message : String(error)),
			});
			setMode("idle");
		},
	});
	return (
		<div className="fleet-steer" data-mode={mode}>
			{mode === "guide" ? (
				<form
					className="fleet-steer__form"
					onSubmit={(event) => {
						event.preventDefault();
						if (guidanceReady(text)) steer.mutate({ action: "guide", message: text.trim() });
					}}
				>
					<label htmlFor={field}>Guidance for {run.agentId}</label>
					<textarea
						id={field}
						rows={2}
						value={text}
						maxLength={STEER_TEXT_MAX_BYTES / 4}
						onChange={(event) => setText(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								event.stopPropagation();
								setMode("idle");
							}
						}}
						// biome-ignore lint/a11y/noAutofocus: the operator just pressed Guide; the field is the next thing they type in.
						autoFocus
					/>
					<div className="fleet-steer__actions">
						<button type="submit" disabled={!guidanceReady(text) || steer.isPending}>
							Send guidance
						</button>
						<button type="button" onClick={() => setMode("idle")}>
							Cancel
						</button>
					</div>
				</form>
			) : mode === "confirm-stop" ? (
				<div className="fleet-steer__actions">
					<span>Stop this worker? Its unfinished work is discarded.</span>
					<button
						type="button"
						className="fleet-steer__stop"
						disabled={steer.isPending}
						onClick={() => steer.mutate({ action: "cancel" })}
					>
						Stop run
					</button>
					<button
						type="button"
						onClick={() => setMode("idle")}
						// biome-ignore lint/a11y/noAutofocus: the operator just pressed Stop; the safe answer takes focus.
						autoFocus
					>
						Keep running
					</button>
				</div>
			) : (
				<div className="fleet-steer__actions">
					<button
						type="button"
						ref={guideButton}
						onClick={() => {
							opened.current = "guide";
							setMode("guide");
						}}
						aria-label={`Guide ${run.agentId}`}
					>
						Guide
					</button>
					<button
						type="button"
						ref={stopButton}
						onClick={() => {
							opened.current = "stop";
							setMode("confirm-stop");
						}}
						aria-label={`Stop ${run.agentId}`}
					>
						Stop
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

/** The run rows alone, so a dispatch tool card can render its own matching runs inline. */
export function FleetRunRows({ runs, steering }: { runs: readonly FleetRun[]; steering?: RunSteering | undefined }) {
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
						{steering !== undefined && isLiveRun(run) ? <RunSteer run={run} steering={steering} /> : null}
					</li>
				);
			})}
		</ul>
	);
}

export function FleetStrip({ client, session }: { client: Client; session: SessionSnapshot }) {
	// Off by default, and it says how many rows it hid.
	const [runningOnly, setRunningOnly] = useState(false);
	// Same key as the composer, so this is one request per session. A build that announced no
	// dispatch steering gets no controls at all rather than buttons that answer 409.
	const capabilities = useQuery({
		queryKey: ["session-capabilities", session.id],
		queryFn: () => client.call(routes.sessionCapabilities, { params: { id: session.id }, query: {}, body: {} }),
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
		enabled: session.state === "open",
	});
	const steering =
		session.state === "open" && steeringAffordances(capabilities.data).dispatch
			? { client, sessionId: session.id }
			: undefined;
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
						<button type="button" aria-pressed={runningOnly} onClick={() => setRunningOnly(!runningOnly)}>
							Running only
						</button>
						<p role="status">{fleetFilterStatus(shown.length, runs.length)}</p>
					</div>
					{shown.length === 0 ? <p>{FLEET_EMPTY_FILTERED}</p> : <FleetRunRows runs={shown} steering={steering} />}
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

/**
 * The workers running right now, at the transcript's live edge after the last turn, so a run that an
 * earlier turn dispatched still shows where the operator is reading. Each row can be guided or
 * stopped. A run leaves the strip once it settles; the delegation row in its turn records how it
 * ended, and Session tools keep the full fleet history.
 *
 * `fleet` keeps its identity across narrative deltas, so streamed text never re-renders this.
 */
export const LiveWorkers = memo(function LiveWorkers({
	client,
	sessionId,
	sessionOpen,
	fleet,
}: {
	client: Client;
	sessionId: string;
	sessionOpen: boolean;
	fleet: readonly FleetItem[];
}) {
	// The composer's key, so this is the same single request per session.
	const capabilities = useQuery({
		queryKey: ["session-capabilities", sessionId],
		queryFn: () => client.call(routes.sessionCapabilities, { params: { id: sessionId }, query: {}, body: {} }),
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
		enabled: sessionOpen,
	});
	const live = useMemo(() => foldFleetRuns(fleet).filter(isLiveRun), [fleet]);
	if (live.length === 0) return null;
	const steering = sessionOpen && steeringAffordances(capabilities.data).dispatch ? { client, sessionId } : undefined;
	return (
		<section className="live-workers" aria-label={liveWorkersLabel(live.length)}>
			<FleetRunRows runs={live} steering={steering} />
		</section>
	);
});

export const workerCount = (count: number): string => (count === 1 ? "1 worker" : `${count} workers`);
export const liveWorkersLabel = (count: number): string => `${workerCount(count)} running`;
