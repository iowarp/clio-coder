import { Link } from "react-router";
import { Icon } from "../design/icons.js";
import { TopBar } from "../shell/TopBar.js";
import "./session-states.css";

/** What a task screen shows while its first snapshot loads. Placeholder shapes, not a spinner: nothing is working yet. */
export function TaskSkeleton() {
	return (
		<section className="conversation" data-pane="closed" aria-busy="true">
			<div className="conversation__main task-skeleton">
				<TopBar />
				<span className="sr-only" role="status">
					Loading task
				</span>
				<div className="task-skeleton__body" aria-hidden="true">
					<span className="task-skeleton__line task-skeleton__line--request" />
					<span className="task-skeleton__line" />
					<span className="task-skeleton__line task-skeleton__line--wide" />
					<span className="task-skeleton__line task-skeleton__line--short" />
				</div>
			</div>
		</section>
	);
}

/** The task could not be read at all. The way back is always on screen. */
export function TaskUnavailable({
	message,
	retrying,
	onRetry,
}: {
	message: string;
	retrying: boolean;
	onRetry: () => void;
}) {
	return (
		<>
			<TopBar />
			<div className="task-state" role="alert">
				<Icon name="warn" />
				<h1>This task could not be opened</h1>
				<p>{message}</p>
				<div className="task-state__actions">
					<button type="button" className="primary" disabled={retrying} onClick={onRetry}>
						{retrying ? "Trying again…" : "Try again"}
					</button>
					<Link to="/">Back to a new task</Link>
				</div>
			</div>
		</>
	);
}

/**
 * A slim notice above the conversation. `warn` is a condition the operator can act on, `quiet` is a
 * fact about the record. Both say what is still true: the transcript below is the last state received.
 */
export function ConversationBanner({
	tone,
	title,
	children,
	action,
}: {
	tone: "warn" | "quiet";
	title: string;
	children?: React.ReactNode;
	action?: React.ReactNode;
}) {
	return (
		<div className="conv-banner" data-tone={tone} role="status">
			<p>
				<strong>{title}</strong> {children}
			</p>
			{action}
		</div>
	);
}
