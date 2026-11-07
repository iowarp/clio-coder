import { useState } from "react";

// Deleting a saved task. Naming, working freedom and closing moved to the top bar, the composer and
// the task actions menu; the approval cards, cancellation and the fleet feed live in chat/.

import type { Client } from "../api/client.js";
import { useDeleteTask } from "../shell/tasks.js";

/**
 * Deleting a closed session removes its saved conversation for good, so it takes two presses: the
 * first asks in place, and focus lands on Keep so a repeated press cannot confirm by accident.
 */
export function DeleteSession({
	client,
	id,
	workspaceId,
	name = "this session",
}: {
	client: Client;
	id: string;
	workspaceId: string;
	/** What the accessible names call the session, for a list where every row has a Delete. */
	name?: string;
}) {
	const [confirming, setConfirming] = useState(false);
	const remove = useDeleteTask(client);
	return (
		<div className="delete-session">
			{confirming ? (
				<>
					<span className="delete-session__ask">Delete its saved conversation for good?</span>
					<span className="delete-session__choices">
						<button
							type="button"
							className="delete-session__confirm"
							disabled={remove.isPending}
							onClick={() => remove.mutate({ sessionId: id, workspaceId })}
							aria-label={`Delete ${name} for good`}
						>
							{remove.isPending ? "Deleting…" : "Delete"}
						</button>
						<button
							type="button"
							onClick={() => setConfirming(false)}
							// biome-ignore lint/a11y/noAutofocus: the operator just pressed Delete; the safe answer takes focus.
							autoFocus
						>
							Keep
						</button>
					</span>
				</>
			) : (
				<button
					type="button"
					className="delete-session__start"
					onClick={() => setConfirming(true)}
					aria-label={`Delete ${name}`}
				>
					Delete
				</button>
			)}
			{remove.error ? <p role="alert">{remove.error.message}</p> : null}
		</div>
	);
}
