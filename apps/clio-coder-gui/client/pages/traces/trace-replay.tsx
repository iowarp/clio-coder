// biome-ignore-all lint/a11y/noNoninteractiveTabindex: The replay region supports scoped keyboard playback and has a visible focus ring.
import type { KeyboardEvent } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { TraceEvent, TracePhase, TraceRun } from "../../../contracts/traces.js";
import { formatDuration, formatTime } from "../../api/clock.js";
import { Icon } from "../../design/icons.js";
import { EventRow, Facts, Json, parseJson } from "./panels.js";
import type { TraceLiveState } from "./trace-live-model.js";
import {
	filterReplayEvents,
	latestReplayEvent,
	REPLAY_SPEEDS,
	replayDelay,
	replayEntries,
	replayEventKinds,
	replayIndex,
	replayWindow,
} from "./trace-replay-model.js";
import "./trace-replay.css";

interface TraceReplayProps {
	run: TraceRun;
	events: TraceEvent[];
	phases: TracePhase[];
	phaseId: string | null;
	selectPhase: (id: string) => void;
	live: TraceLiveState;
}

export function TraceReplay({ run, events, phases, phaseId, selectPhase, live }: TraceReplayProps) {
	const id = useId();
	const root = useRef<HTMLElement>(null);
	const [query, setQuery] = useState("");
	const [kind, setKind] = useState("");
	const kinds = useMemo(() => replayEventKinds(events), [events]);
	const entries = useMemo(
		() => replayEntries(filterReplayEvents(events, query, kind), run.started_at, phaseId),
		[events, run.started_at, phaseId, query, kind],
	);
	const latestId = useMemo(() => latestReplayEvent(entries), [entries]);
	const phaseNames = useMemo(() => new Map(phases.map((phase) => [phase.phase_id, phase.name])), [phases]);
	const phaseCounts = useMemo(() => {
		const counts = new Map<string, number>();
		for (const event of events) counts.set(event.phase_id, (counts.get(event.phase_id) ?? 0) + 1);
		return counts;
	}, [events]);
	const [eventId, setEventId] = useState<string | null>(() => entries[0]?.event.event_id ?? null);
	const [playing, setPlaying] = useState(false);
	const [following, setFollowing] = useState(false);
	const [speed, setSpeed] = useState(1);
	const [visible, setVisible] = useState(() => !document.hidden);
	const [reducedMotion, setReducedMotion] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
	const capturing = run.status === "running" && live === "live";
	const index = replayIndex(entries, following && capturing ? latestId : eventId);
	const current = entries[index];
	const next = entries[index + 1];
	const nearby = replayWindow(entries, index);
	const currentId = current?.event.event_id ?? null;
	const nextId = next?.event.event_id ?? null;
	const delay = current && next ? replayDelay(current, next, speed, reducedMotion) : null;
	const atEnd = index === entries.length - 1;

	useEffect(() => {
		if (eventId === null && currentId !== null) setEventId(currentId);
	}, [eventId, currentId]);

	useEffect(() => {
		let inView = true;
		const update = () => {
			const shown = !document.hidden && inView;
			setVisible(shown);
			if (!shown) setPlaying(false);
		};
		const observer = new IntersectionObserver(([entry]) => {
			inView = entry?.isIntersecting ?? false;
			update();
		});
		if (root.current) observer.observe(root.current);
		document.addEventListener("visibilitychange", update);
		const preference = matchMedia("(prefers-reduced-motion: reduce)");
		const changeMotion = () => {
			setReducedMotion(preference.matches);
			setPlaying(false);
		};
		preference.addEventListener("change", changeMotion);
		return () => {
			observer.disconnect();
			document.removeEventListener("visibilitychange", update);
			preference.removeEventListener("change", changeMotion);
		};
	}, []);

	useEffect(() => {
		if (!playing || !visible || following) return;
		if (nextId === null || delay === null) {
			setPlaying(false);
			return;
		}
		const timer = setTimeout(() => setEventId(nextId), delay);
		return () => clearTimeout(timer);
	}, [playing, visible, following, nextId, delay]);

	useEffect(() => {
		if (following && (!capturing || !visible)) {
			setEventId(latestId);
			setFollowing(false);
		}
	}, [following, capturing, visible, latestId]);

	const seek = (position: number) => {
		setPlaying(false);
		setFollowing(false);
		setEventId(entries[Math.max(0, Math.min(entries.length - 1, position))]?.event.event_id ?? null);
	};
	const toggle = () => {
		if (following) {
			seek(index);
			return;
		}
		if (!current || entries.length < 2) return;
		setFollowing(false);
		setEventId(playing ? currentId : atEnd ? (entries[0]?.event.event_id ?? null) : currentId);
		setPlaying(!playing);
	};
	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		const target = event.target;
		if (
			event.altKey ||
			event.ctrlKey ||
			event.metaKey ||
			event.shiftKey ||
			(target instanceof HTMLElement &&
				target !== event.currentTarget &&
				(target.closest("button, input, select, textarea, a, summary") || target.isContentEditable))
		)
			return;
		if (event.key === " " || event.key.toLowerCase() === "k") toggle();
		else if (event.key === "ArrowLeft") seek(index - 1);
		else if (event.key === "ArrowRight") seek(index + 1);
		else if (event.key === "Home") seek(0);
		else if (event.key === "End") seek(entries.length - 1);
		else return;
		event.preventDefault();
	};

	return (
		<section
			className="trace-panel trace-replay"
			ref={root}
			tabIndex={0}
			aria-labelledby={`${id}-title`}
			aria-describedby={`${id}-keys`}
			onKeyDown={onKeyDown}
		>
			<div className="trace-replay__heading">
				<div>
					<p className="eyebrow">Recorded sequence</p>
					<h2 id={`${id}-title`}>Trace replay</h2>
				</div>
				<span className="trace-replay__state" role="status">
					{following && capturing ? "Following capture" : playing ? "Playing recording" : "Recording paused"}
				</span>
			</div>
			<p className="panel-note">Inspect captured activity and its payloads. Playback never executes commands.</p>
			<div className="trace-replay__controls">
				<button type="button" onClick={() => seek(index - 1)} disabled={index <= 0} title="Previous event">
					<Icon name="arrowLeft" />
					<span>Back</span>
				</button>
				<button
					type="button"
					className="trace-replay__play"
					onClick={toggle}
					disabled={entries.length < 2 && !following}
					aria-label={following || playing ? "Pause replay" : atEnd ? "Replay from first event" : "Play recorded events"}
				>
					<Icon name={following || playing ? "stop" : "play"} />
					{following || playing ? "Pause" : atEnd && entries.length > 1 ? "Replay" : "Play"}
				</button>
				<button type="button" onClick={() => seek(index + 1)} disabled={!next} title="Next event">
					<span>Step</span>
					<Icon name="chevronRight" />
				</button>
				<label className="trace-replay__speed">
					Speed
					<select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
						{REPLAY_SPEEDS.map((rate) => (
							<option key={rate} value={rate}>
								{rate}×
							</option>
						))}
					</select>
				</label>
				{capturing ? (
					<button
						type="button"
						className="trace-replay__follow"
						aria-pressed={following}
						onClick={() => {
							if (following) seek(index);
							else {
								setPlaying(false);
								setFollowing(true);
							}
						}}
					>
						<Icon name="running" />
						{following ? "Following capture" : "Follow capture"}
					</button>
				) : null}
			</div>
			<div className="trace-replay__position">
				<label htmlFor={`${id}-scrubber`}>
					Event <strong>{index < 0 ? 0 : index + 1}</strong> / {entries.length.toLocaleString("en-US")} recorded
					{phaseId ? " in phase" : ""}
				</label>
				<span>
					<Icon name="clock" />
					{current?.elapsedMs != null ? `+${formatDuration(current.elapsedMs)} from run start` : "Elapsed time unavailable"}
				</span>
			</div>
			<input
				id={`${id}-scrubber`}
				className="trace-replay__scrubber"
				type="range"
				min={0}
				max={Math.max(0, entries.length - 1)}
				step={1}
				value={Math.max(0, index)}
				disabled={entries.length < 2}
				aria-valuetext={current ? `Event ${index + 1} of ${entries.length}: ${current.event.name}` : "No recorded events"}
				onChange={(event) => seek(Number(event.target.value))}
			/>
			<section className="trace-replay__phases" aria-label="Filter replay by phase">
				<button type="button" aria-pressed={phaseId === null} onClick={() => selectPhase("all")}>
					All phases <small>{events.length}</small>
				</button>
				{phases.map((phase) => (
					<button
						key={phase.phase_id}
						type="button"
						aria-pressed={phaseId === phase.phase_id}
						data-current={current?.event.phase_id === phase.phase_id}
						onClick={() => selectPhase(phase.phase_id)}
					>
						{phase.name}
						<small>{phaseCounts.get(phase.phase_id) ?? 0}</small>
						{current?.event.phase_id === phase.phase_id ? (
							<span className="trace-replay__phase-cursor">Current event</span>
						) : null}
					</button>
				))}
			</section>
			<div className="trace-filters trace-replay__filters">
				<label>
					Find recorded events
					<input
						type="search"
						value={query}
						maxLength={256}
						placeholder="Event name, ID or payload text"
						onChange={(event) => {
							setPlaying(false);
							setFollowing(false);
							setEventId(null);
							setQuery(event.target.value);
						}}
					/>
				</label>
				<label>
					Event kind
					<select
						value={kind}
						onChange={(event) => {
							setPlaying(false);
							setFollowing(false);
							setEventId(null);
							setKind(event.target.value);
						}}
					>
						<option value="">All kinds</option>
						{kinds.map((value) => (
							<option key={value}>{value}</option>
						))}
					</select>
				</label>
				{(query || kind) && (
					<button
						type="button"
						onClick={() => {
							setPlaying(false);
							setFollowing(false);
							setQuery("");
							setKind("");
							setEventId(null);
						}}
					>
						Reset event filters
					</button>
				)}
			</div>
			{current ? (
				<div className="trace-replay__workspace">
					<div className="trace-replay__sequence">
						<h3>Event navigator</h3>
						<p className="panel-note">
							Showing {nearby.start + 1}–{nearby.start + nearby.entries.length} of {entries.length}. Scrub to any event.
						</p>
						<ol start={nearby.start + 1}>
							{nearby.entries.map((entry, offset) => (
								<li key={entry.event.event_id}>
									<button
										type="button"
										aria-current={entry.event.event_id === currentId ? "step" : undefined}
										onClick={() => seek(nearby.start + offset)}
									>
										<span className="trace-replay__ordinal">{nearby.start + offset + 1}</span>
										<span>
											<strong>{entry.event.name || entry.event.type}</strong>
											<small>
												{entry.event.type} · {entry.elapsedMs === null ? "time unavailable" : `+${formatDuration(entry.elapsedMs)}`}
											</small>
										</span>
									</button>
								</li>
							))}
						</ol>
					</div>
					<div className="trace-replay__detail" key={currentId}>
						<p className="eyebrow">Selected event / {phaseNames.get(current.event.phase_id) ?? current.event.phase_id}</p>
						<EventRow event={current.event} start={run.started_at} payload={false} />
						<details>
							<summary>Exact event record</summary>
							<Facts
								entries={[
									["Event ID", current.event.event_id],
									["Row", current.event.rowid],
									["Phase ID", current.event.phase_id],
									["Parent event", current.event.parent_id],
									["Started", current.event.started_at],
									["Ended", current.event.ended_at ?? "not recorded"],
									["Recorded time", formatTime(current.event.started_at)],
								]}
							/>
						</details>
						<h3>Recorded payload</h3>
						<Json value={parseJson(current.event.payload_json)} />
						<details>
							<summary>Raw recorded payload</summary>
							<pre className="trace-replay__raw">{current.event.payload_json ?? "No payload recorded."}</pre>
						</details>
					</div>
				</div>
			) : (
				<p className="trace-replay__empty">
					{query || kind
						? "No recorded event matches these filters. Reset event filters to restore the sequence."
						: phaseId
							? "No events were recorded for this phase."
							: "No events have been recorded for this run."}
				</p>
			)}
			<p className="trace-replay__timing">
				Ordered by recorded start, then row. Events without a valid start appear last. Idle gaps are capped at 5s; equal or
				missing times advance every 0.5s before speed adjustment.{" "}
				{reducedMotion ? "Reduced motion limits playback to two events per second. " : ""}
				Live span details may update as capture arrives; earlier span versions are not reconstructed.
			</p>
			<p id={`${id}-keys`} className="trace-replay__keys">
				Focus this player: <kbd>Space</kbd> / <kbd>K</kbd> play or pause · <kbd>←</kbd> <kbd>→</kbd> step · <kbd>Home</kbd>{" "}
				/ <kbd>End</kbd> first or last. Playback pauses when out of view.
			</p>
		</section>
	);
}
