// biome-ignore-all lint/a11y/noNoninteractiveTabindex: The replay region supports scoped keyboard playback and has a visible focus ring.
import type { KeyboardEvent } from "react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { TraceRun } from "../../../contracts/traces.js";
import type { RunTimelineEntry } from "../../../contracts/wire.js";
import { clock, formatDuration, formatTime } from "../../api/clock.js";
import { Icon } from "../../design/icons.js";
import { EntryRow, Json } from "./panels.js";
import { entryLabel, runSpan } from "./trace-model.js";
import {
	filterReplayEntries,
	REPLAY_SPEEDS,
	replayDelay,
	replayEntries,
	replayEntryKinds,
	replayIndex,
	replayWindow,
} from "./trace-replay-model.js";
import "./trace-replay.css";

interface TraceReplayProps {
	run: TraceRun;
	timeline: RunTimelineEntry[];
	/** The run is still live, so the timeline grows as its journal is re-read. */
	live: boolean;
}

export function TraceReplay({ run, timeline, live }: TraceReplayProps) {
	const id = useId();
	const root = useRef<HTMLElement>(null);
	const [query, setQuery] = useState("");
	const [kind, setKind] = useState("");
	const kinds = useMemo(() => replayEntryKinds(timeline), [timeline]);
	const runStart = runSpan(run, clock.now())?.start ?? null;
	const entries = useMemo(
		() => replayEntries(filterReplayEntries(timeline, query, kind), runStart),
		[timeline, runStart, query, kind],
	);
	const latestId = entries.at(-1)?.key ?? null;
	const [eventId, setEventId] = useState<string | null>(() => entries[0]?.key ?? null);
	const [playing, setPlaying] = useState(false);
	const [following, setFollowing] = useState(false);
	const [speed, setSpeed] = useState(1);
	const [visible, setVisible] = useState(() => !document.hidden);
	const [reducedMotion, setReducedMotion] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
	const capturing = live;
	const index = replayIndex(entries, following && capturing ? latestId : eventId);
	const current = entries[index];
	const next = entries[index + 1];
	const nearby = replayWindow(entries, index);
	const currentId = current?.key ?? null;
	const nextId = next?.key ?? null;
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
		setEventId(entries[Math.max(0, Math.min(entries.length - 1, position))]?.key ?? null);
	};
	const toggle = () => {
		if (following) {
			seek(index);
			return;
		}
		if (!current || entries.length < 2) return;
		setFollowing(false);
		setEventId(playing ? currentId : atEnd ? (entries[0]?.key ?? null) : currentId);
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
			<p className="panel-note">
				Step through the run journal: calls, the run feed and the worker process. Playback never executes commands.
			</p>
			<div className="trace-replay__controls">
				<button type="button" onClick={() => seek(index - 1)} disabled={index <= 0} title="Previous entry">
					<Icon name="arrowLeft" />
					<span>Back</span>
				</button>
				<button
					type="button"
					className="trace-replay__play"
					onClick={toggle}
					disabled={entries.length < 2 && !following}
					aria-label={following || playing ? "Pause replay" : atEnd ? "Replay from first entry" : "Play recorded entries"}
				>
					<Icon name={following || playing ? "stop" : "play"} />
					{following || playing ? "Pause" : atEnd && entries.length > 1 ? "Replay" : "Play"}
				</button>
				<button type="button" onClick={() => seek(index + 1)} disabled={!next} title="Next entry">
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
					Entry <strong>{index < 0 ? 0 : index + 1}</strong> / {entries.length.toLocaleString("en-US")} recorded
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
				aria-valuetext={
					current ? `Entry ${index + 1} of ${entries.length}: ${entryLabel(current.entry).title}` : "No recorded entries"
				}
				onChange={(event) => seek(Number(event.target.value))}
			/>
			<div className="trace-filters trace-replay__filters">
				<label>
					Find recorded entries
					<input
						type="search"
						value={query}
						maxLength={256}
						placeholder="Entry, tool or call ID"
						onChange={(event) => {
							setPlaying(false);
							setFollowing(false);
							setEventId(null);
							setQuery(event.target.value);
						}}
					/>
				</label>
				<label>
					Entry kind
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
						Reset entry filters
					</button>
				)}
			</div>
			{current ? (
				<div className="trace-replay__workspace">
					<div className="trace-replay__sequence">
						<h3>Entry navigator</h3>
						<p className="panel-note">
							Showing {nearby.start + 1}–{nearby.start + nearby.entries.length} of {entries.length}. Scrub to any entry.
						</p>
						<ol start={nearby.start + 1}>
							{nearby.entries.map((entry, offset) => (
								<li key={entry.key}>
									<button
										type="button"
										aria-current={entry.key === currentId ? "step" : undefined}
										onClick={() => seek(nearby.start + offset)}
									>
										<span className="trace-replay__ordinal">{nearby.start + offset + 1}</span>
										<span>
											<strong>{entryLabel(entry.entry).title}</strong>
											<small>
												{entryLabel(entry.entry).kind} ·{" "}
												{entry.elapsedMs === null ? "time unavailable" : `+${formatDuration(entry.elapsedMs)}`}
											</small>
										</span>
									</button>
								</li>
							))}
						</ol>
					</div>
					<div className="trace-replay__detail" key={currentId}>
						<p className="eyebrow">Selected entry · {formatTime(current.entry.at)}</p>
						<EntryRow entry={current.entry} start={runStart} />
						<h3>Exact journal entry</h3>
						<Json value={current.entry} />
					</div>
				</div>
			) : (
				<p className="trace-replay__empty">
					{query || kind
						? "No recorded entry matches these filters. Reset entry filters to restore the sequence."
						: "Nothing has been journaled for this run."}
				</p>
			)}
			<p className="trace-replay__timing">
				Ordered by recorded time, in journal order within an instant. Idle gaps are capped at 5s; equal or missing times
				advance every 0.5s before speed adjustment.{" "}
				{reducedMotion ? "Reduced motion limits playback to two entries per second. " : ""}A live run's timeline grows as
				its journal is re-read.
			</p>
			<p id={`${id}-keys`} className="trace-replay__keys">
				Focus this player: <kbd>Space</kbd> / <kbd>K</kbd> play or pause · <kbd>←</kbd> <kbd>→</kbd> step · <kbd>Home</kbd>{" "}
				/ <kbd>End</kbd> first or last. Playback pauses when out of view.
			</p>
		</section>
	);
}
