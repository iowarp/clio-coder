import { useId, useLayoutEffect, useRef, useState } from "react";
import { StatusMark } from "../design/status.js";
import type { ContextWorkView } from "./context-work-model.js";
import "./context-work.css";

/**
 * A context operation stays outside the transcript, including when it runs between turns. This card is the
 * only place its progress and result are written: the composer's command line stays quiet for it.
 */
export function ContextWorkCard({
	view,
	compact = false,
	onCancel,
	cancelling = false,
	cancelLabel = "Stop context work",
	onDismiss,
}: {
	view: ContextWorkView;
	compact?: boolean;
	onCancel?: () => void;
	cancelling?: boolean;
	cancelLabel?: string;
	/** `keyboard` is true when the press came from the keyboard or an assistive technology, which has a place to return to. */
	onDismiss?: (keyboard: boolean) => void;
}) {
	const id = useId();
	const [open, setOpen] = useState(false);
	const stop = useRef<HTMLButtonElement>(null);
	const toggle = useRef<HTMLButtonElement>(null);
	// Stop leaves the page when the operation concludes. If it held focus then, focus would fall to the
	// document, so the committed live-to-finished transition hands it to Details. Focus is tracked by the
	// button's own events. A blur clears the flag only if the button is still on the page once the event has
	// settled: a button removed with focus may or may not blur first, and either way it still held focus.
	const stopHeld = useRef(false);
	const wasLive = useRef(view.live);
	useLayoutEffect(() => {
		const concluded = wasLive.current && !view.live;
		wasLive.current = view.live;
		if (!concluded || !stopHeld.current) return;
		stopHeld.current = false;
		if (document.activeElement === null || document.activeElement === document.body) toggle.current?.focus();
	}, [view.live]);
	const { issues, details } = view;
	const failed = view.tone === "fail";
	return (
		<section
			className="context-work"
			data-tone={view.tone}
			data-live={view.live}
			data-compact={compact}
			aria-labelledby={id}
		>
			<header className="context-work__head">
				<h3 id={id}>{view.title}</h3>
				<StatusMark tone={view.tone} label={view.label} live={view.live} />
				{view.elapsed ? (
					<span className="context-work__time">
						{view.elapsed}
						<span className="sr-only"> elapsed</span>
					</span>
				) : null}
				<span className="context-work__actions">
					<button
						ref={toggle}
						type="button"
						className="context-work__toggle"
						aria-expanded={open}
						aria-controls={`${id}-details`}
						onClick={() => setOpen((previous) => !previous)}
					>
						Details
					</button>
					{view.live && onCancel ? (
						// aria-disabled, not disabled: a keyboard user who pressed Stop keeps their place while it works.
						<button
							ref={stop}
							type="button"
							className="context-work__cancel"
							onFocus={() => {
								stopHeld.current = true;
							}}
							onBlur={() => {
								queueMicrotask(() => {
									if (stop.current?.isConnected) stopHeld.current = false;
								});
							}}
							aria-disabled={cancelling || undefined}
							onClick={cancelling ? undefined : onCancel}
						>
							{cancelling ? "Stopping…" : cancelLabel}
						</button>
					) : null}
					{!view.live && onDismiss ? (
						<button
							type="button"
							className="context-work__dismiss"
							onClick={(event) => onDismiss(event.detail === 0)}
							aria-label={`Dismiss ${view.title} result`}
						>
							Dismiss
						</button>
					) : null}
				</span>
			</header>
			{/* One polite region speaks for the operation. Time, the current file and the count sit outside
			    it, so a tick of work never reads aloud; a failure is the one thing that interrupts. */}
			<div className="context-work__body" role="status">
				<span className="sr-only">
					{view.label}. {view.live && cancelling ? "Stopping. " : ""}
				</span>
				{view.message ? (
					<p className="context-work__message">
						{view.message}
						{view.step ? <span className="context-work__step"> · {view.step}</span> : null}
					</p>
				) : null}
				{view.summary.length > 0 ? (
					<p className="context-work__summary">
						{view.summary.map((part, index) => (
							<span className="context-work__part" key={part.key}>
								{/* Flex items have no spaces between them in the text; a spoken pause keeps "files" and "Preserved" apart. */}
								{index > 0 ? <span className="sr-only">. </span> : null}
								<span className="context-work__verb">{part.verb}</span>{" "}
								{part.code ? (
									<bdi dir="ltr" className="context-work__code">
										{part.value}
									</bdi>
								) : (
									part.value
								)}
							</span>
						))}
						{view.more > 0 ? (
							<span className="context-work__part context-work__verb">
								<span className="sr-only">. </span>+{view.more} more in Details
							</span>
						) : null}
					</p>
				) : null}
				{issues && !failed ? <Issues issues={issues} /> : null}
			</div>
			{issues && failed ? (
				<div role="alert">
					<Issues issues={issues} />
				</div>
			) : null}
			{view.current || view.progress ? (
				<div className="context-work__work">
					<p className="context-work__current">
						{view.current ? (
							<bdi dir="ltr" title={view.current}>
								{view.current}
							</bdi>
						) : null}
					</p>
					{view.progress ? <span className="context-work__count">{view.progress.text}</span> : null}
					{view.progress ? (
						<progress
							max={view.progress.total}
							value={view.progress.current}
							aria-label={`${view.title} progress`}
							aria-valuetext={view.progress.text}
						/>
					) : null}
				</div>
			) : null}
			{open ? (
				<div className="context-work__details" id={`${id}-details`}>
					<dl className="context-work__rows">
						{details.rows.map((row) => (
							<div key={row.term}>
								<dt>{row.term}</dt>
								<dd>
									{row.code ? (
										<bdi dir="ltr" className="context-work__code">
											{row.text}
										</bdi>
									) : (
										row.text
									)}
								</dd>
							</div>
						))}
					</dl>
					{details.phases.length > 1 ? (
						<ol className="context-work__phases" aria-label="Context work phases">
							{details.phases.map((phase) => (
								<li key={phase.key} aria-current={phase.current ? "step" : undefined}>
									{phase.label}
								</li>
							))}
						</ol>
					) : null}
					{details.facts.length > 0 ? (
						<ul className="context-work__facts" aria-label="Evidence">
							{details.facts.map((fact) => (
								<li key={fact.key}>
									<p>
										<span className="context-work__verb">{fact.verb}</span> {fact.value}
									</p>
									{fact.paths.length > 0 ? (
										<ul>
											{fact.paths.map((path) => (
												<li key={path}>
													<bdi dir="ltr">{path}</bdi>
												</li>
											))}
										</ul>
									) : null}
								</li>
							))}
						</ul>
					) : null}
					{details.warnings.length > (issues?.items.length ?? 0) ? (
						<ul className="context-work__facts" aria-label="All warnings">
							{details.warnings.map((warning) => (
								<li key={warning}>{warning}</li>
							))}
						</ul>
					) : null}
				</div>
			) : null}
		</section>
	);
}

function Issues({ issues }: { issues: NonNullable<ContextWorkView["issues"]> }) {
	return (
		<ul className="context-work__issues" data-kind={issues.kind}>
			{issues.items.map((item) => (
				<li key={item}>
					{issues.kind === "warning" ? <span className="sr-only">Warning: </span> : null}
					{item}
				</li>
			))}
			{issues.hidden > 0 ? (
				<li className="context-work__verb">
					+{issues.hidden} more {issues.hidden === 1 ? "warning" : "warnings"} in Details
				</li>
			) : null}
		</ul>
	);
}
