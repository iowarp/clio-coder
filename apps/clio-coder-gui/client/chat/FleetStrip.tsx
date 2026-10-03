// Fleet run rows: one row per dispatched run, never one per event. The live rows sit at the
// transcript's edge; the pane's Agents view (./WorkerGraph.tsx) lists every run and borrows the
// steering control from here. The taxonomy and the fold live in ./fleet-facts.ts.

import { useMutation, useQuery } from "@tanstack/react-query";
import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import type { FleetItem } from "../../contracts/fleet-events.js";
import { routes } from "../../contracts/routes.js";
import { STEER_TEXT_MAX_BYTES } from "../../contracts/steering.js";
import type { Client } from "../api/client.js";
import { StatusMark } from "../design/status.js";
import { ClioPulse, PULSE_SIZE } from "../shell/ClioMark.js";
import { capabilityRefusal, steeringAffordances } from "./composer-model.js";
import {
	FLEET_GLYPHS,
	FLEET_STATE_TONES,
	type FleetRun,
	fleetRunDetail,
	fleetRunNote,
	fleetRunTitle,
	foldFleetRuns,
	guidanceReady,
	isLiveRun,
	isWorkingRun,
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
export function RunSteer({ run, steering }: { run: FleetRun; steering: RunSteering }) {
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

function FleetRunRows({
	runs,
	steering,
	sessionOpen = false,
}: {
	runs: readonly FleetRun[];
	steering?: RunSteering | undefined;
	/** A worker spins only while its session is open. In a recorded session "running" is a record. */
	sessionOpen?: boolean;
}) {
	return (
		<ul className="fleet-runs">
			{runs.map((run) => {
				const note = fleetRunNote(run);
				const working = sessionOpen && isWorkingRun(run);
				return (
					<li className="fleet-run" key={run.runId}>
						<span className="fleet-run__glyph" aria-hidden="true">
							{working ? <ClioPulse size={PULSE_SIZE.inline} /> : FLEET_GLYPHS[run.state]}
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

/**
 * The workers running right now, at the transcript's live edge after the last turn, so a run that an
 * earlier turn dispatched still shows where the operator is reading. Each row can be guided or
 * stopped. A run leaves the strip once it settles; the delegation row in its turn records how it
 * ended, and the task pane's Agents view keeps the full fleet history.
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
			<FleetRunRows runs={live} steering={steering} sessionOpen={sessionOpen} />
		</section>
	);
});

export const workerCount = (count: number): string => (count === 1 ? "1 worker" : `${count} workers`);
export const liveWorkersLabel = (count: number): string => `${workerCount(count)} running`;
