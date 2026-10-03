import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useId, useRef } from "react";
import { useNavigate } from "react-router";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { notify } from "../design/notifications.js";
import { type BranchRow, branchView, FORKED_NOTE, SWITCHED_NOTE } from "./branch-model.js";
import "./session-board.css";

const excerpt = (text: string) => (text.length > 80 ? `${text.slice(0, 79)}…` : text);

/**
 * The terminal's /tree and /fork. Continue moves where the next request lands and keeps every other
 * branch; Fork starts a new conversation from a turn. Neither rewinds files in the project, and both
 * wait for a running turn, because each replaces the context that turn is reading.
 */
export const BranchPanel = memo(function BranchPanel({
	client,
	sessionId,
	sessionOpen,
	capabilities,
	settledTurns,
	running,
}: {
	client: Client;
	sessionId: string;
	sessionOpen: boolean;
	capabilities: AgentCapabilities | undefined;
	/** Changes when a turn settles, which is when the tree can have grown. */
	settledTurns: number;
	running: boolean;
	/** Render without the disclosure frame, for a host that supplies its own heading. */
}) {
	const panel = useRef<HTMLDivElement>(null);
	const headingId = useId();
	const navigate = useNavigate();
	const queries = useQueryClient();
	const params = { params: { id: sessionId }, query: {} };
	const supported = !!capabilities?.branches;
	const tree = useQuery({
		queryKey: ["session-tree", sessionId, settledTurns],
		queryFn: () => client.call(routes.sessionTree, { ...params, body: {} }),
		enabled: sessionOpen && supported,
		retry: false,
	});
	const change = useMutation({
		mutationFn: async ({ action, row }: { action: "continue" | "fork"; row: BranchRow }) =>
			action === "continue"
				? {
						action,
						row,
						result: await client.call(
							routes.switchSessionBranch,
							{ ...params, body: { turnId: row.id } },
							crypto.randomUUID(),
						),
					}
				: {
						action,
						row,
						fork: await client.call(routes.forkSession, { ...params, body: { turnId: row.id } }, crypto.randomUUID()),
					},
		onSuccess: async (outcome) => {
			if ("fork" in outcome && outcome.fork) {
				notify({ tone: "success", title: "Conversation forked", detail: FORKED_NOTE });
				if (!outcome.fork.replayed)
					notify({
						tone: "warning",
						title: "The forked conversation starts empty",
						detail: "Clio Coder created the fork but could not replay its earlier turns.",
					});
				await Promise.all([
					queries.invalidateQueries({ queryKey: ["sessions"] }),
					queries.invalidateQueries({ queryKey: ["session-history"] }),
				]);
				void navigate(`/sessions/${outcome.fork.sessionId}`);
				return;
			}
			notify({ tone: "success", title: `Continuing from “${excerpt(outcome.row.text)}”`, detail: SWITCHED_NOTE });
			await queries.invalidateQueries({ queryKey: ["session-tree", sessionId] });
			// The pressed row is now the tip and disabled, so focus moves to a stable landmark.
			requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>("h3")?.focus());
		},
	});
	const view = tree.data ? branchView(tree.data) : null;
	const busy = change.isPending || running;
	const body = (
		<>
			{!sessionOpen ? <p>This session is not open. Load it to read its branches.</p> : null}
			{sessionOpen && !supported ? <p>This Clio Coder session does not report its branches.</p> : null}
			{tree.isPending && sessionOpen && supported ? <p>Reading the branches…</p> : null}
			{tree.error ? <p role="alert">{tree.error.message}</p> : null}
			{view ? (
				<section aria-labelledby={headingId}>
					<h3 id={headingId} tabIndex={-1}>
						{view.branchPoints === 0 ? "One line of turns" : `${view.branchPoints + 1} branches`}
					</h3>
					<p className="session-board__note">
						Continue moves where the next request lands and keeps the other branches. Fork starts a new conversation from a
						turn. Files in the project are never rewound.
						{running ? " Both wait for the current turn to finish." : ""}
					</p>
					{view.forkedFrom ? (
						<p className="session-board__note">
							Forked from an earlier conversation at turn <span className="session-board__hash">{view.forkedFrom.turnId}</span>
							.
						</p>
					) : null}
					{view.rows.length === 0 ? (
						<p className="session-board__empty">No request has been recorded in this conversation yet.</p>
					) : null}
					<ol className="session-board__rows branch-panel__rows">
						{view.rows.map((row) => (
							<li
								key={row.id}
								className={row.active ? "branch-panel__row branch-panel__row--active" : "branch-panel__row"}
								style={{ "--branch-depth": Math.min(row.depth, 6) } as React.CSSProperties}
							>
								<span className="session-board__id">{row.word}</span>
								<span className="session-board__title">
									{row.text}
									<small>
										{row.label ? `${row.label} · ` : ""}
										<time dateTime={row.at}>{formatTime(row.at)}</time>
										{row.tip ? " · The next request continues here" : row.active ? " · On the current branch" : ""}
									</small>
								</span>
								{row.selectable ? (
									<span className="session-board__actions">
										<button
											type="button"
											disabled={busy || row.tip}
											{...(row.tip ? { "data-tip": "" } : {})}
											onClick={() => change.mutate({ action: "continue", row })}
											aria-label={`Continue from this ${row.word.toLowerCase()}: ${excerpt(row.text)}`}
										>
											Continue here
										</button>
										<button
											type="button"
											disabled={busy}
											data-fork
											onClick={() => change.mutate({ action: "fork", row })}
											aria-label={`Fork a new conversation from this ${row.word.toLowerCase()}: ${excerpt(row.text)}`}
										>
											Fork
										</button>
									</span>
								) : null}
							</li>
						))}
					</ol>
					{view.foldedSteps > 0 ? (
						<p className="session-board__note">
							{view.foldedSteps} tool {view.foldedSteps === 1 ? "step is" : "steps are"} folded into the replies around them.
						</p>
					) : null}
					{view.truncated ? (
						<p className="session-board__note">
							Only the current branch and the newest 400 turns are shown; the terminal's /tree shows the rest.
						</p>
					) : null}
					{change.error ? <p role="alert">{change.error.message}</p> : null}
				</section>
			) : null}
		</>
	);
	return (
		<div ref={panel} className="session-board branch-panel branch-panel--bare">
			{body}
		</div>
	);
});
