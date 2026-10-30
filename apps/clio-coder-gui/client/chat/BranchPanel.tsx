import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { SessionTree } from "../../contracts/branches.js";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { notify } from "../design/notifications.js";
import { type BranchRow, branchView, FORKED_NOTE, SWITCHED_NOTE } from "./branch-model.js";
import "./session-board.css";
import "./pane-inspection.css";
import { paneBranchRows } from "./pane-inspection-model.js";

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
	const [query, setQuery] = useState("");
	const [kind, setKind] = useState("");
	const panel = useRef<HTMLDivElement>(null);
	const headingId = useId();
	const navigate = useNavigate();
	const queries = useQueryClient();
	const params = { params: { id: sessionId }, query: {} };
	const supported = !!capabilities?.branches;
	const tree = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["session-tree", sessionId, settledTurns],
		queryFn: () => client.call(routes.sessionTree, { ...params, body: {} }),
		// A continue replays turns and moves the key; the panel and its heading stay mounted meanwhile,
		// so the focus it hands to the heading afterwards has somewhere to land.
		placeholderData: keepPreviousData,
		enabled: sessionOpen && supported,
		retry: false,
	});
	const change = useMutation({
		meta: { errorSurface: "inline" },
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
	// A switch also publishes session.reset, which resets this read in place: the key does not move, so
	// keepPreviousData has nothing to keep and the section would unmount until the refetch lands. When that reset
	// arrives after the heading took focus, focus fell to the page. The last tree read for this session stays on
	// screen until the next one does.
	const held = useRef<{ sessionId: string; data: SessionTree } | undefined>(undefined);
	if (tree.data) held.current = { sessionId, data: tree.data };
	const data =
		tree.data ??
		(sessionOpen && supported && !tree.error && held.current?.sessionId === sessionId ? held.current.data : undefined);
	const view = data ? branchView(data) : null;
	const busy = change.isPending || running;
	const rows = paneBranchRows(view?.rows ?? [], query, kind);
	const tip = view?.rows.find((row) => row.tip && row.active);
	const body = (
		<>
			{!sessionOpen ? <p>This task is not open. Open it to read its branches.</p> : null}
			{sessionOpen && !supported ? <p>Clio does not report branches for this task.</p> : null}
			{tree.isPending && sessionOpen && supported && !data ? <p>Reading the branches…</p> : null}
			{tree.error ? (
				<div className="pane-inspection-error" role="alert">
					<p>{tree.error.message}</p>
					<button
						type="button"
						disabled={tree.isFetching}
						onClick={() => {
							void tree.refetch();
						}}
					>
						Retry branch history
					</button>
				</div>
			) : null}
			{view ? (
				<section aria-labelledby={headingId}>
					<div className="pane-inspection-toolbar">
						<p>{view.rows.length} recorded turns</p>
						<button
							type="button"
							disabled={tree.isFetching || !sessionOpen || !supported}
							onClick={() => {
								void tree.refetch();
							}}
						>
							{tree.isFetching ? "Refreshing…" : "Refresh history"}
						</button>
					</div>
					<h3 id={headingId} tabIndex={-1}>
						{view.branchPoints === 0 ? "One line of turns" : `${view.branchPoints + 1} branches`}
					</h3>
					{tip && (
						<p className="pane-inspection-lead">
							<small>The next request continues after</small>
							{tip.text}
						</p>
					)}
					<details className="pane-inspection-disclosure">
						<summary>How continuing and forking work</summary>
						<p className="session-board__note">
							Continue moves where the next request lands and keeps the other branches. Fork starts a new conversation from a
							turn. Files in the project are never rewound.
							{running ? " Both wait for the current turn to finish." : ""}
						</p>
					</details>
					{view.forkedFrom ? (
						<p className="session-board__note">
							Forked from an earlier conversation at turn <span className="session-board__hash">{view.forkedFrom.turnId}</span>
							.
						</p>
					) : null}
					{view.rows.length === 0 ? (
						<p className="session-board__empty">No request has been recorded in this conversation yet.</p>
					) : null}
					<div className="pane-inspection-filters">
						<label>
							Find a turn
							<input
								type="search"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								maxLength={256}
								placeholder="Request, reply or label"
							/>
						</label>
						<label>
							Turn kind
							<select value={kind} onChange={(event) => setKind(event.target.value)}>
								<option value="">All turns</option>
								<option value="request">Requests</option>
								<option value="reply">Replies</option>
							</select>
						</label>
						{(query || kind) && (
							<button
								type="button"
								onClick={() => {
									setQuery("");
									setKind("");
								}}
							>
								Reset filters
							</button>
						)}
					</div>
					<p className="pane-inspection-count" role="status">
						{rows.length} of {view.rows.length} turns shown
					</p>
					{view.rows.length > 0 && !rows.length && (
						<p className="session-board__empty">No recorded turn matches these filters.</p>
					)}
					<ol className="session-board__rows branch-panel__rows">
						{rows.map((row) => (
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
					{change.error ? (
						<div role="alert" className="pane-inspection-error">
							<p>{change.error.message}</p>
							<p>Your requested continuation was not confirmed. Refresh the history before choosing where to continue.</p>
							<button
								type="button"
								disabled={tree.isFetching}
								onClick={() => {
									void tree.refetch();
								}}
							>
								Refresh branch state
							</button>
						</div>
					) : null}
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
