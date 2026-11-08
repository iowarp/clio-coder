import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import type { ArenaMatch, ArenaMatchSummary, ArenaStartRequest } from "../../contracts/arena.js";
import { routes } from "../../contracts/runtime-routes.js";
import { ApiProblem, type Client } from "../api/client.js";
import { useOperation } from "../api/queries.js";
import { Boundary, PanelEmpty, PanelHeading } from "../design/panel.js";
import { emptyState } from "../design/panel-model.js";
import { InspectionError } from "../design/run-inspection.js";
import { Splitter } from "../design/Splitter.js";
import { MarkdownContent } from "../render/Markdown.js";
import {
	ARENA_MAX_CONTENDERS,
	ARENA_PANEL,
	ARENA_PROMPT_MAX,
	type ArenaChoice,
	type ArenaDraft,
	arenaColumnSpec,
	arenaGridTemplate,
	arenaRequest,
	choiceText,
	entryFacts,
	standingRows,
	voteOptions,
	voteState,
} from "./arena-model.js";
import { operationUnsettled } from "./toolchain-model.js";
import { useWorkspaceSelection, WorkspacePicker } from "./workspace-selection.js";
import "./arena.css";

const problemText = (error: unknown) =>
	error instanceof ApiProblem
		? error.problem.detail || error.problem.title
		: error instanceof Error
			? error.message
			: String(error);

export function ArenaPage({ client }: { client: Client }) {
	const selection = useWorkspaceSelection(client);
	const [search, setSearch] = useSearchParams();
	const matchId = search.get("match");
	const [composing, setComposing] = useState(false);
	const pick = (id: string | null) =>
		setSearch((current) => {
			const next = new URLSearchParams(current);
			if (id) next.set("match", id);
			else next.delete("match");
			return next;
		});
	const matches = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["arena-matches", selection.id],
		enabled: !!selection.id,
		queryFn: ({ signal }) =>
			client.call(routes.arenaMatches, { params: { id: selection.id }, query: {}, body: {} }, undefined, signal),
	});
	const standings = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["arena-standings", selection.id],
		enabled: !!selection.id,
		queryFn: ({ signal }) =>
			client.call(routes.arenaStandings, { params: { id: selection.id }, query: {}, body: {} }, undefined, signal),
	});
	return (
		<section className="arena-page">
			<PanelHeading
				panel={ARENA_PANEL}
				level={1}
				action={
					<button type="button" className="primary" disabled={!selection.id} onClick={() => setComposing(true)}>
						New match
					</button>
				}
			/>
			<p className="intro">
				One prompt, two to four contenders, side by side with their names hidden. You vote; Clio records it and keeps the
				standings.
			</p>
			<div className="arena-scope">
				<WorkspacePicker selection={selection} />
			</div>
			{!selection.id && <PanelEmpty>{emptyState.unread("arena for this workspace")}</PanelEmpty>}
			{selection.id && composing && (
				<NewMatch
					client={client}
					workspaceId={selection.id}
					onClose={() => setComposing(false)}
					onStarted={(id) => {
						setComposing(false);
						pick(id);
					}}
				/>
			)}
			{selection.id && (
				<div className="arena-layout">
					<MatchList
						matches={matches.data?.matches}
						pending={matches.isPending}
						error={matches.error}
						retry={() => void matches.refetch()}
						selected={matchId}
						onPick={pick}
					/>
					<div className="arena-main">
						{matchId ? (
							<MatchView client={client} workspaceId={selection.id} matchId={matchId} />
						) : (
							<PanelEmpty>Pick a match to see its contenders side by side, or start a new one.</PanelEmpty>
						)}
						<section className="arena-standings" aria-label="Standings">
							<h2>Standings</h2>
							{standings.error && (
								<InspectionError
									title="Standings unavailable"
									error={standings.error}
									busy={standings.isFetching}
									retry={() => void standings.refetch()}
								/>
							)}
							{standings.data && standings.data.standings.length === 0 && (
								<PanelEmpty>{emptyState.emptyStore("arena votes", "in this workspace")}</PanelEmpty>
							)}
							{standings.data && standings.data.standings.length > 0 && (
								<>
									<table>
										<thead>
											<tr>
												<th scope="col">Contender</th>
												<th scope="col">Votes</th>
												<th scope="col">Won-lost-tied</th>
												<th scope="col">All bad</th>
												<th scope="col">Elo</th>
											</tr>
										</thead>
										<tbody>
											{standingRows(standings.data).map((row) => (
												<tr key={row.identity}>
													<th scope="row">{row.identity}</th>
													<td>{row.votes}</td>
													<td>{row.record}</td>
													<td>{row.bad}</td>
													<td>{row.score}</td>
												</tr>
											))}
										</tbody>
									</table>
									<p className="panel-note">
										{standings.data.votedMatches} of {standings.data.matches} matches have a vote. An Elo rating appears
										once a contender has {standings.data.minVotesForScore} votes.
									</p>
								</>
							)}
						</section>
					</div>
				</div>
			)}
			<Boundary panel={ARENA_PANEL} />
		</section>
	);
}

function MatchList({
	matches,
	pending,
	error,
	retry,
	selected,
	onPick,
}: {
	matches: ArenaMatchSummary[] | undefined;
	pending: boolean;
	error: Error | null;
	retry: () => void;
	selected: string | null;
	onPick: (id: string) => void;
}) {
	return (
		<nav className="arena-list" aria-label="Arena matches">
			{pending && <p role="status">Reading arena matches…</p>}
			{error && <InspectionError title="Matches unavailable" error={error} busy={false} retry={retry} />}
			{matches && matches.length === 0 && (
				<PanelEmpty>{emptyState.emptyStore("arena matches", "in this workspace")}</PanelEmpty>
			)}
			{matches && matches.length > 0 && (
				<ul>
					{matches.map((match) => (
						<li key={match.id}>
							<button type="button" aria-current={selected === match.id ? "true" : undefined} onClick={() => onPick(match.id)}>
								<span className="arena-list__prompt">{match.prompt}</span>
								<span className="arena-list__meta">
									{match.contenders} contenders · {match.status}
									{match.vote ? ` · ${choiceText(match.vote)}` : match.status === "complete" ? " · awaiting your vote" : ""}
									{match.suite ? ` · ${match.suite}` : ""}
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</nav>
	);
}

function MatchView({ client, workspaceId, matchId }: { client: Client; workspaceId: string; matchId: string }) {
	const queries = useQueryClient();
	const match = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["arena-match", workspaceId, matchId],
		queryFn: ({ signal }) =>
			client.call(routes.arenaMatch, { params: { id: workspaceId, matchId }, query: {}, body: {} }, undefined, signal),
		refetchInterval: (query) => (query.state.data?.status === "running" ? 5000 : false),
	});
	if (match.isPending) return <p role="status">Reading match {matchId}…</p>;
	if (match.error)
		return (
			<InspectionError
				title="Match unavailable"
				error={match.error}
				busy={match.isFetching}
				retry={() => void match.refetch()}
			/>
		);
	const data = match.data;
	return (
		<article className="arena-match" aria-label={`Match ${data.id}`}>
			<header>
				<p className="eyebrow">
					MATCH {data.id} · {data.status.toUpperCase()} ·{" "}
					{data.isolation === "worktree" ? "ISOLATED WORKTREES" : "READ ONLY"}
					{data.suite ? ` · SUITE ${data.suite.toUpperCase()}` : ""}
				</p>
				<details className="arena-prompt" open>
					<summary>Prompt</summary>
					<p>{data.prompt}</p>
				</details>
				{data.error && <p className="arena-error">{data.error}</p>}
			</header>
			<div className="arena-columns" style={{ gridTemplateColumns: arenaGridTemplate(data.entries.length) }}>
				{data.entries.map((entry, index) => (
					<section key={entry.label} className="arena-column" aria-label={`Contender ${entry.label}`}>
						<h3>
							{entry.label}
							{entry.reveal && <span className="arena-reveal">{`${entry.reveal.target}/${entry.reveal.model}`}</span>}
						</h3>
						<dl className="arena-facts">
							{entryFacts(entry).map((fact) => (
								<div key={fact.label}>
									<dt>{fact.label}</dt>
									<dd>{fact.value}</dd>
								</div>
							))}
						</dl>
						{entry.error && <p className="arena-error">{entry.error}</p>}
						<h4>Answer</h4>
						<div className="arena-answer">
							{entry.finalText ? (
								<MarkdownContent source={entry.finalText} complete />
							) : (
								<PanelEmpty>No final answer recorded.</PanelEmpty>
							)}
						</div>
						<details className="arena-diff" open={!!entry.diff}>
							<summary>Diff{entry.diffTruncated ? " (truncated)" : ""}</summary>
							{entry.diff ? <pre>{entry.diff}</pre> : <PanelEmpty>No changes in this contender's worktree.</PanelEmpty>}
						</details>
						{entry.check && (
							<details className="arena-check">
								<summary>Check {entry.check.id} output</summary>
								<pre>{entry.check.tail}</pre>
							</details>
						)}
						{index < data.entries.length - 1 && (
							<Splitter
								spec={arenaColumnSpec(index)}
								edge="end"
								label={`Resize column ${entry.label}`}
								host=".arena-columns"
							/>
						)}
					</section>
				))}
			</div>
			<VotePanel
				client={client}
				workspaceId={workspaceId}
				match={data}
				onVoted={() => {
					void queries.invalidateQueries({ queryKey: ["arena-match", workspaceId, matchId] });
					void queries.invalidateQueries({ queryKey: ["arena-matches", workspaceId] });
					void queries.invalidateQueries({ queryKey: ["arena-standings", workspaceId] });
				}}
			/>
		</article>
	);
}

function VotePanel({
	client,
	workspaceId,
	match,
	onVoted,
}: {
	client: Client;
	workspaceId: string;
	match: ArenaMatch;
	onVoted: () => void;
}) {
	const state = voteState(match);
	const [note, setNote] = useState("");
	const [replacing, setReplacing] = useState(false);
	const vote = useMutation({
		meta: { errorSurface: "inline" },
		mutationFn: (choice: ArenaChoice) =>
			client.call(
				routes.arenaVote,
				{
					params: { id: workspaceId, matchId: match.id },
					query: {},
					body: { choice, replace: state.kind === "recorded", ...(note.trim() ? { note: note.trim() } : {}) },
				},
				crypto.randomUUID(),
			),
		onSuccess: () => {
			setReplacing(false);
			setNote("");
			onVoted();
		},
	});
	if (state.kind === "waiting")
		return (
			<p className="arena-vote" role="status">
				{state.reason}
			</p>
		);
	if (state.kind === "recorded" && !replacing)
		return (
			<section className="arena-vote" aria-label="Your vote">
				<p>
					<strong>Your vote: {choiceText(state.choice)}.</strong> {state.note ? `“${state.note}” ` : ""}The names above are
					revealed now that the vote is in.
				</p>
				<button type="button" onClick={() => setReplacing(true)}>
					Change vote
				</button>
			</section>
		);
	return (
		<section className="arena-vote" aria-label="Vote">
			<p>
				{state.kind === "recorded"
					? "Replacing your vote keeps the earlier one in the journal."
					: "Which did better? The names stay hidden until you vote."}
			</p>
			<label>
				Note (optional)
				<input
					type="text"
					maxLength={500}
					value={note}
					onChange={(event) => setNote(event.target.value.replace(/[\r\n]/g, " "))}
				/>
			</label>
			<div className="arena-vote__choices">
				{voteOptions(match.entries.map((entry) => entry.label)).map((option) => (
					<button key={option.choice} type="button" disabled={vote.isPending} onClick={() => vote.mutate(option.choice)}>
						{option.label}
					</button>
				))}
				{state.kind === "recorded" && (
					<button type="button" onClick={() => setReplacing(false)}>
						Keep my vote
					</button>
				)}
			</div>
			{vote.error && (
				<p className="arena-error" role="alert">
					{problemText(vote.error)}
				</p>
			)}
		</section>
	);
}

const emptyDraft = (): ArenaDraft => ({
	prompt: "",
	contenders: [
		{ target: "", model: "" },
		{ target: "", model: "" },
	],
	timeoutSeconds: "600",
	suite: "",
	check: "",
});

function NewMatch({
	client,
	workspaceId,
	onClose,
	onStarted,
}: {
	client: Client;
	workspaceId: string;
	onClose: () => void;
	onStarted: (matchId: string) => void;
}) {
	const queries = useQueryClient();
	const [draft, setDraft] = useState(emptyDraft);
	const [operationId, setOperationId] = useState<string | null>(null);
	const operation = useOperation(client, operationId);
	const targets = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["targets", workspaceId],
		queryFn: ({ signal }) =>
			client.call(routes.targetsList, { params: { id: workspaceId }, query: {}, body: {} }, undefined, signal),
	});
	const start = useMutation({
		meta: { errorSurface: "inline" },
		mutationFn: (request: ArenaStartRequest) =>
			client.call(routes.arenaStart, { params: { id: workspaceId }, query: {}, body: request }, crypto.randomUUID()),
		onSuccess: (result) => setOperationId(result.operationId),
	});
	const status = operation.data?.status;
	const running = start.isPending || operationUnsettled(operationId, status);
	useEffect(() => {
		if (!operation.data || operationUnsettled(operationId, status)) return;
		void queries.invalidateQueries({ queryKey: ["arena-matches", workspaceId] });
		void queries.invalidateQueries({ queryKey: ["arena-standings", workspaceId] });
		if (operation.data.status === "succeeded" && operation.data.result && "id" in operation.data.result)
			onStarted(operation.data.result.id);
	}, [operation.data, operationId, status, queries, workspaceId, onStarted]);
	const outcome = arenaRequest(draft);
	const setContender = (index: number, patch: Partial<ArenaDraft["contenders"][number]>) =>
		setDraft((current) => ({
			...current,
			contenders: current.contenders.map((contender, k) => (k === index ? { ...contender, ...patch } : contender)),
		}));
	const progress = operation.data?.progress.at(-1)?.message;
	return (
		<form
			className="arena-new"
			aria-label="New arena match"
			onSubmit={(event) => {
				event.preventDefault();
				if (running || "problem" in outcome) return;
				setOperationId(null);
				start.mutate(outcome.request);
			}}
		>
			<h2>New match</h2>
			<label>
				Prompt
				<textarea
					rows={4}
					maxLength={ARENA_PROMPT_MAX}
					value={draft.prompt}
					disabled={running}
					onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
				/>
			</label>
			<fieldset disabled={running}>
				<legend>Contenders</legend>
				{targets.error && <p className="arena-error">Targets could not be read: {problemText(targets.error)}</p>}
				{draft.contenders.map((contender, index) => {
					const target = targets.data?.targets.find((item) => item.id === contender.target);
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional slots, not records.
						<div className="arena-new__contender" key={index}>
							<span>{index + 1}</span>
							<select
								aria-label={`Contender ${index + 1} target`}
								value={contender.target}
								onChange={(event) => {
									const next = targets.data?.targets.find((item) => item.id === event.target.value);
									setContender(index, { target: event.target.value, model: next?.defaultModel ?? next?.models[0] ?? "" });
								}}
							>
								<option value="">Pick a target</option>
								{targets.data?.targets.map((item) => (
									<option key={item.id} value={item.id}>
										{item.id}
									</option>
								))}
							</select>
							<input
								aria-label={`Contender ${index + 1} model`}
								list={`arena-models-${index}`}
								value={contender.model}
								placeholder="model id"
								onChange={(event) => setContender(index, { model: event.target.value.trim() })}
							/>
							<datalist id={`arena-models-${index}`}>
								{target?.models.map((model) => (
									<option key={model} value={model} />
								))}
							</datalist>
							{draft.contenders.length > 2 && (
								<button
									type="button"
									aria-label={`Remove contender ${index + 1}`}
									onClick={() => setDraft({ ...draft, contenders: draft.contenders.filter((_, k) => k !== index) })}
								>
									Remove
								</button>
							)}
						</div>
					);
				})}
				{draft.contenders.length < ARENA_MAX_CONTENDERS && (
					<button
						type="button"
						onClick={() => setDraft({ ...draft, contenders: [...draft.contenders, { target: "", model: "" }] })}
					>
						Add contender
					</button>
				)}
			</fieldset>
			<div className="arena-new__options">
				<label>
					Timeout per contender (seconds)
					<input
						type="number"
						min={30}
						max={3600}
						value={draft.timeoutSeconds}
						disabled={running}
						onChange={(event) => setDraft({ ...draft, timeoutSeconds: event.target.value })}
					/>
				</label>
				<label>
					Suite (optional)
					<input
						value={draft.suite}
						disabled={running}
						onChange={(event) => setDraft({ ...draft, suite: event.target.value })}
					/>
				</label>
				<label>
					Check, a verifier id (optional)
					<input
						value={draft.check}
						disabled={running}
						onChange={(event) => setDraft({ ...draft, check: event.target.value })}
					/>
				</label>
			</div>
			{"problem" in outcome && draft.prompt && <p className="panel-note">{outcome.problem}</p>}
			<div className="arena-new__actions">
				<button type="submit" className="primary" disabled={running || "problem" in outcome}>
					{running ? "Running contenders…" : "Start match"}
				</button>
				{running && operationId && (
					<button
						type="button"
						onClick={() =>
							void client.call(routes.cancel, { params: { id: operationId }, query: {}, body: {} }, crypto.randomUUID())
						}
					>
						Cancel match
					</button>
				)}
				{!running && (
					<button type="button" onClick={onClose}>
						Close
					</button>
				)}
			</div>
			{running && <p role="status">{progress ?? "Starting the contenders…"}</p>}
			{start.error && (
				<p className="arena-error" role="alert">
					{problemText(start.error)}
				</p>
			)}
			{operation.data?.status === "failed" && (
				<p className="arena-error" role="alert">
					{operation.data.problem.detail || operation.data.problem.title}
				</p>
			)}
			{operation.data?.status === "cancelled" && (
				<p role="status">The match was cancelled; its partial record stays in the list.</p>
			)}
		</form>
	);
}
