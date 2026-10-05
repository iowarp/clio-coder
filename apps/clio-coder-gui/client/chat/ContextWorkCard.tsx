import { useId } from "react";
import { StatusMark } from "../design/status.js";
import type { ContextWorkView } from "./context-work-model.js";
import "./context-work.css";

/** A context operation stays outside the transcript, including when it runs between turns. */
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
	onDismiss?: () => void;
}) {
	const id = useId();
	const evidence = view.facts.some((fact) => fact.paths.length > 0);
	return (
		<section className="context-work" data-tone={view.tone} data-compact={compact} aria-labelledby={id}>
			<header className="context-work__head">
				<h3 id={id}>{view.title}</h3>
				<StatusMark tone={view.tone} label={view.label} live={view.live} />
				{!view.live && onDismiss ? (
					<button
						type="button"
						className="context-work__dismiss"
						onClick={onDismiss}
						aria-label={`Dismiss ${view.title} result`}
					>
						Dismiss
					</button>
				) : null}
			</header>
			<p className="context-work__message" role={view.tone === "fail" ? "alert" : "status"}>
				{view.message}
			</p>
			<p className="context-work__meta">{[view.origin, view.timing].filter(Boolean).join(" · ")}</p>
			{view.facts.length > 0 ? (
				<p className="context-work__summary">
					{view.facts.map((fact) => `${fact.label}${fact.count === null ? "" : ` ${fact.count}`} ${fact.unit}`).join(" · ")}
				</p>
			) : null}
			{view.tokens ? <p className="context-work__detail">{view.tokens}</p> : null}
			{[...new Set(view.warnings)].map((warning) => (
				<p className="context-work__warning" key={warning}>
					Warning: {warning}
				</p>
			))}
			{view.phases.length > 0 && view.live ? (
				<ol className="context-work__phases" aria-label="Context work phases">
					{view.phases.map((phase) => (
						<li key={phase.key} aria-current={phase.current ? "step" : undefined}>
							{phase.label}
						</li>
					))}
				</ol>
			) : null}
			{view.detail ? <p className="context-work__detail">{view.detail}</p> : null}
			{view.progress ? (
				<div className="context-work__progress">
					<progress max={view.progress.total} value={view.progress.current} aria-label={view.message} />
					<span>
						{view.progress.current.toLocaleString("en-US")} of {view.progress.total.toLocaleString("en-US")}
					</span>
				</div>
			) : null}
			{evidence ? (
				<details className="context-work__evidence" open={compact ? undefined : true}>
					<summary>Paths and evidence</summary>
					{view.facts.length > 0 ? (
						<ul className="context-work__facts">
							{view.facts.map((fact) => (
								<li key={JSON.stringify(fact)}>
									<p>
										<strong>{fact.label}</strong>
										{fact.count === null ? "" : ` ${fact.count}`} {fact.unit}
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
				</details>
			) : null}
			{view.live && onCancel ? (
				<button type="button" className="context-work__cancel" disabled={cancelling} onClick={onCancel}>
					{cancelling ? "Stopping…" : cancelLabel}
				</button>
			) : null}
		</section>
	);
}
