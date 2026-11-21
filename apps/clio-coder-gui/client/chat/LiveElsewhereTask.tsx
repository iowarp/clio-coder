import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { routes } from "../../contracts/runtime-routes.js";
import type { LiveElsewhere } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { Icon } from "../design/icons.js";
import { MarkdownContent } from "../render/Markdown.js";
import { liveElsewhereLabel, takeOverExplanation } from "./live-elsewhere-model.js";
import "./live-elsewhere.css";

/**
 * A saved task another process holds open (#439). Its history is read from the ledger, so it stays readable;
 * nothing is sent into it until the operator takes it over, which asks the holder to end and then resumes the
 * task here.
 */
export function LiveElsewhereTask({
	client,
	sessionId,
	workspaceId,
	live,
	resuming,
	resumeError,
	onReleased,
	onRecheck,
}: {
	client: Client;
	sessionId: string;
	workspaceId: string;
	live: LiveElsewhere;
	resuming: boolean;
	resumeError: Error | null;
	onReleased: () => void;
	onRecheck: () => void;
}) {
	const params = { id: workspaceId, sessionId };
	const transcript = useQuery({
		queryKey: ["stored-transcript", workspaceId, sessionId],
		queryFn: () => client.call(routes.storedTranscript, { params, query: {}, body: {} }),
		retry: false,
		meta: { errorSurface: "inline" },
	});
	const takeOver = useMutation({
		mutationFn: () => client.call(routes.takeOverSession, { params, query: {}, body: {} }),
		onSuccess: (result) => (result.released ? onReleased() : onRecheck()),
	});
	const label = liveElsewhereLabel(live, formatTime(live.since));
	const busy = takeOver.isPending || resuming;
	return (
		<div className="live-elsewhere">
			<div className="task-state live-elsewhere__banner" role="status">
				<Icon name="warn" />
				<h1>{label}</h1>
				<p>{takeOverExplanation(live)}</p>
				{takeOver.data && !takeOver.data.released ? <p>{takeOver.data.message}</p> : null}
				{takeOver.error ? <p role="alert">Could not take this task over. {takeOver.error.message}</p> : null}
				{resumeError ? <p role="alert">Could not resume this task. {resumeError.message}</p> : null}
				<div className="task-state__actions">
					<button type="button" className="primary" disabled={!live.canTakeOver || busy} onClick={() => takeOver.mutate()}>
						{takeOver.isPending ? "Taking over…" : resuming ? "Resuming…" : "Take over"}
					</button>
					<button type="button" disabled={busy} onClick={onRecheck}>
						Check again
					</button>
					<Link to="/">Back to a new task</Link>
				</div>
			</div>
			<section className="live-elsewhere__history" aria-label="Saved history">
				{transcript.data ? (
					<>
						{transcript.data.truncated ? (
							<p className="live-elsewhere__note">Showing the latest part of a long history.</p>
						) : null}
						<MarkdownContent source={transcript.data.markdown} complete />
					</>
				) : transcript.error ? (
					<p role="alert">The saved history could not be read. {transcript.error.message}</p>
				) : (
					<p role="status">Reading the saved history…</p>
				)}
			</section>
			<form className="live-elsewhere__composer" aria-label="Message" onSubmit={(event) => event.preventDefault()}>
				<textarea disabled aria-label="Message" placeholder="Take over to send a message in this task." />
				<button type="submit" disabled>
					Send
				</button>
			</form>
		</div>
	);
}
