import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import type { ResearchCampaign, ResearchCampaignSummary, ResearchStartRequest } from "../../contracts/research.js";
import { routes } from "../../contracts/runtime-routes.js";
import { ApiProblem, type Client } from "../api/client.js";
import { useOperation } from "../api/queries.js";
import { Boundary, PanelEmpty, PanelHeading } from "../design/panel.js";
import { emptyState } from "../design/panel-model.js";
import { InspectionError } from "../design/run-inspection.js";
import {
	aaLine,
	bestCurve,
	campaignFacts,
	campaignFromProgress,
	curveChart,
	emptyResearchDraft,
	iterationRows,
	logLine,
	RESEARCH_PANEL,
	type ResearchDraft,
	regradeLines,
	researchRequest,
	summaryMeta,
	summaryObjective,
} from "./research-model.js";
import { operationUnsettled } from "./toolchain-model.js";
import { useWorkspaceSelection, WorkspacePicker } from "./workspace-selection.js";
import "./research.css";

const problemText = (error: unknown) =>
	error instanceof ApiProblem
		? error.problem.detail || error.problem.title
		: error instanceof Error
			? error.message
			: String(error);

export function ResearchPage({ client }: { client: Client }) {
	const selection = useWorkspaceSelection(client);
	const queries = useQueryClient();
	const [search, setSearch] = useSearchParams();
	const campaignId = search.get("campaign");
	const [composing, setComposing] = useState(false);
	const [operationId, setOperationId] = useState<string | null>(null);
	const operation = useOperation(client, operationId);
	const messages = operation.data?.progress.map((row) => row.message) ?? [];
	const liveCampaign = campaignFromProgress(messages);
	const status = operation.data?.status;
	const running = operationUnsettled(operationId, status);
	const pick = (id: string | null) =>
		setSearch((current) => {
			const next = new URLSearchParams(current);
			if (id) next.set("campaign", id);
			else next.delete("campaign");
			return next;
		});
	const campaigns = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["research-campaigns", selection.id],
		enabled: !!selection.id,
		queryFn: ({ signal }) =>
			client.call(routes.researchCampaigns, { params: { id: selection.id }, query: {}, body: {} }, undefined, signal),
		refetchInterval: running ? 5000 : false,
	});
	// The first progress line names the campaign; open it so the timeline fills in as it runs.
	useEffect(() => {
		if (liveCampaign && running) {
			setComposing(false);
			setSearch((current) => {
				if (current.get("campaign") === liveCampaign) return current;
				const next = new URLSearchParams(current);
				next.set("campaign", liveCampaign);
				return next;
			});
		}
	}, [liveCampaign, running, setSearch]);
	useEffect(() => {
		if (!operationId || running || !operation.data) return;
		void queries.invalidateQueries({ queryKey: ["research-campaigns"] });
		void queries.invalidateQueries({ queryKey: ["research-campaign"] });
	}, [operationId, running, operation.data, queries]);
	const live =
		operationId && liveCampaign && liveCampaign === campaignId
			? {
					operationId,
					messages,
					running,
					status,
					problem: operation.data?.status === "failed" ? operation.data.problem : null,
				}
			: null;
	return (
		<section className="research-page">
			<PanelHeading
				panel={RESEARCH_PANEL}
				level={1}
				action={
					<button type="button" className="primary" disabled={!selection.id || running} onClick={() => setComposing(true)}>
						New campaign
					</button>
				}
			/>
			<p className="intro">
				Name a metric a declared check prints and a budget. Clio lets its agent change an isolated worktree, measures each
				change against the best so far, and keeps it only when it beats noise.
			</p>
			<div className="research-scope">
				<WorkspacePicker selection={selection} />
			</div>
			{!selection.id && <PanelEmpty>{emptyState.unread("research for this workspace")}</PanelEmpty>}
			{selection.id && composing && (
				<NewCampaign
					client={client}
					workspaceId={selection.id}
					operationId={operationId}
					onStarted={setOperationId}
					onClose={() => setComposing(false)}
				/>
			)}
			{selection.id && (
				<div className="research-layout">
					<CampaignList
						campaigns={campaigns.data?.campaigns}
						pending={campaigns.isPending}
						error={campaigns.error}
						retry={() => void campaigns.refetch()}
						selected={campaignId}
						onPick={pick}
					/>
					<div className="research-main">
						{campaignId ? (
							<CampaignView key={campaignId} client={client} workspaceId={selection.id} campaignId={campaignId} live={live} />
						) : (
							<PanelEmpty>Pick a campaign to see its timeline, or start a new one.</PanelEmpty>
						)}
					</div>
				</div>
			)}
			<Boundary panel={RESEARCH_PANEL} />
		</section>
	);
}

function CampaignList({
	campaigns,
	pending,
	error,
	retry,
	selected,
	onPick,
}: {
	campaigns: ResearchCampaignSummary[] | undefined;
	pending: boolean;
	error: Error | null;
	retry: () => void;
	selected: string | null;
	onPick: (id: string) => void;
}) {
	return (
		<nav className="research-list" aria-label="Research campaigns">
			{pending && <p role="status">Reading research campaigns…</p>}
			{error && <InspectionError title="Campaigns unavailable" error={error} busy={false} retry={retry} />}
			{campaigns && campaigns.length === 0 && (
				<PanelEmpty>{emptyState.emptyStore("research campaigns", "in this workspace")}</PanelEmpty>
			)}
			{campaigns && campaigns.length > 0 && (
				<ul>
					{campaigns.map((row) => (
						<li key={row.id}>
							<button type="button" aria-current={selected === row.id ? "true" : undefined} onClick={() => onPick(row.id)}>
								<span className="research-list__objective">{summaryObjective(row)}</span>
								<span className="research-list__meta">
									{row.id} · {summaryMeta(row)}
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</nav>
	);
}

interface Live {
	operationId: string;
	messages: string[];
	running: boolean;
	status: string | undefined;
	problem: { title: string; detail?: string } | null;
}

function CampaignView({
	client,
	workspaceId,
	campaignId,
	live,
}: {
	client: Client;
	workspaceId: string;
	campaignId: string;
	live: Live | null;
}) {
	const campaign = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["research-campaign", workspaceId, campaignId],
		queryFn: ({ signal }) =>
			client.call(
				routes.researchCampaign,
				{ params: { id: workspaceId, campaignId }, query: {}, body: {} },
				undefined,
				signal,
			),
		refetchInterval: (query) => (query.state.data?.state === "running" || live?.running ? 3000 : false),
	});
	if (campaign.isPending && !live) return <p role="status">Reading campaign {campaignId}…</p>;
	if (campaign.error && !live)
		return (
			<InspectionError
				title="Campaign unavailable"
				error={campaign.error}
				busy={campaign.isFetching}
				retry={() => void campaign.refetch()}
			/>
		);
	const data = campaign.data;
	return (
		<article className="research-campaign" aria-label={`Campaign ${campaignId}`}>
			<header>
				<p className="eyebrow">
					CAMPAIGN {campaignId}
					{data ? ` · ${(live?.running ? "running" : data.state).toUpperCase()}` : " · OPENING"}
					{data?.stop ? ` · ${data.stop.reason.toUpperCase()}` : ""}
				</p>
				{data?.stop && (
					<p className={data.stop.reason === "error" || data.stop.reason === "noisy" ? "research-error" : ""}>
						Stopped: {data.stop.detail}
					</p>
				)}
			</header>
			{live && <LiveLog client={client} live={live} />}
			{data && <CampaignBody client={client} workspaceId={workspaceId} view={data} />}
		</article>
	);
}

function LiveLog({ client, live }: { client: Client; live: Live }) {
	const lines = live.messages.filter((message) => message.startsWith("research ")).map(logLine);
	return (
		<section className="research-live" aria-label="Live log">
			<h2>{live.running ? "Running" : "Run log"}</h2>
			<pre aria-live="polite">{lines.length > 0 ? lines.join("\n") : "Opening the campaign…"}</pre>
			{live.running && (
				<button
					type="button"
					onClick={() =>
						void client.call(routes.cancel, { params: { id: live.operationId }, query: {}, body: {} }, crypto.randomUUID())
					}
				>
					Stop campaign
				</button>
			)}
			{live.running && (
				<p className="panel-note">
					Stopping archives the current iteration as interrupted, journals the stop and removes the worktrees, the same as
					Ctrl-C in the terminal.
				</p>
			)}
			{live.status === "cancelled" && <p role="status">The campaign was stopped; its journal stays readable here.</p>}
			{live.problem && (
				<p className="research-error" role="alert">
					{live.problem.detail || live.problem.title}
				</p>
			)}
		</section>
	);
}

function CampaignBody({ client, workspaceId, view }: { client: Client; workspaceId: string; view: ResearchCampaign }) {
	const rows = iterationRows(view);
	const chart = curveChart(bestCurve(view), 560, 160);
	const regrade = useMutation({
		meta: { errorSurface: "inline" },
		mutationFn: () =>
			client.call(routes.researchReport, { params: { id: workspaceId, campaignId: view.id }, query: {}, body: {} }),
	});
	return (
		<>
			<dl className="research-facts">
				{campaignFacts(view).map((fact) => (
					<div key={fact.label}>
						<dt>{fact.label}</dt>
						<dd>{fact.value}</dd>
					</div>
				))}
			</dl>
			<p className={`research-aa${view.aa?.noisy ? " research-error" : ""}`}>{aaLine(view.aa)}</p>
			{chart && (
				<figure className="research-chart">
					<figcaption>
						Best {view.campaign.objective.metric} by iteration ({view.campaign.objective.direction} is better)
					</figcaption>
					<svg viewBox="0 0 560 160" role="img" aria-label={chart.dots.map((dot) => dot.label).join(", ")}>
						<path d={chart.path} />
						{chart.dots.map((dot) => (
							<circle
								key={dot.label}
								cx={dot.x}
								cy={dot.y}
								r={dot.ratcheted ? 4 : 2.5}
								className={dot.ratcheted ? "ratchet" : undefined}
							>
								<title>{dot.label}</title>
							</circle>
						))}
					</svg>
					<p className="panel-note">
						From {chart.dots[0]?.label.split(": ")[1]} to {chart.dots.at(-1)?.label.split(": ")[1]}; larger dots are ratchets.
					</p>
				</figure>
			)}
			<section aria-label="Iterations">
				<h2>Iterations</h2>
				{rows.length === 0 ? (
					<PanelEmpty>No iteration has started yet.</PanelEmpty>
				) : (
					<ol className="research-timeline">
						{rows.map((row) => (
							<li key={row.key} className={row.ratcheted ? "ratcheted" : undefined}>
								<p className="research-timeline__head">
									<strong>{row.label}</strong> {row.outcome}
								</p>
								<dl className="research-facts">
									<div>
										<dt>Grade</dt>
										<dd>{row.grade}</dd>
									</div>
									<div>
										<dt>Gates</dt>
										<dd>{row.gates}</dd>
									</div>
									<div>
										<dt>Commit</dt>
										<dd>{row.commit}</dd>
									</div>
									<div>
										<dt>Hypothesis</dt>
										<dd>{row.hypothesis}</dd>
									</div>
									<div>
										<dt>Changed</dt>
										<dd>{row.changed}</dd>
									</div>
									<div>
										<dt>Cost</dt>
										<dd>{row.cost}</dd>
									</div>
								</dl>
								{row.detail && <p className="panel-note">{row.detail}</p>}
							</li>
						))}
					</ol>
				)}
			</section>
			<section className="research-regrade" aria-label="Regrade">
				<h2>Regrade</h2>
				<p>Recompute every grade from the raw samples with the recorded seeds and compare it with the journal.</p>
				<button type="button" disabled={regrade.isPending} onClick={() => regrade.mutate()}>
					{regrade.isPending ? "Regrading…" : "Regrade"}
				</button>
				{regrade.error && (
					<p className="research-error" role="alert">
						{problemText(regrade.error)}
					</p>
				)}
				{regrade.data && (
					<>
						<p role="status" className={regrade.data.agrees ? "research-agrees" : "research-error"}>
							{regrade.data.agrees
								? "Every recomputed grade agrees with the journal."
								: "At least one recomputed grade DISAGREES with the journal."}
						</p>
						<ul className="research-regrade__lines">
							{regradeLines(regrade.data).map((line) => (
								<li key={line.of}>
									<strong>{line.of}</strong> {line.text} · {line.agrees ? "agrees" : "disagrees"}
								</li>
							))}
							{regrade.data.recomputed.length === 0 && <li>Nothing measured yet.</li>}
						</ul>
					</>
				)}
			</section>
		</>
	);
}

function NewCampaign({
	client,
	workspaceId,
	operationId,
	onStarted,
	onClose,
}: {
	client: Client;
	workspaceId: string;
	operationId: string | null;
	onStarted: (operationId: string) => void;
	onClose: () => void;
}) {
	const [draft, setDraft] = useState<ResearchDraft>(emptyResearchDraft);
	const operation = useOperation(client, operationId);
	const verifiers = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["library-verifiers", workspaceId],
		queryFn: ({ signal }) =>
			client.call(routes.libraryVerifiers, { params: { id: workspaceId }, query: {}, body: {} }, undefined, signal),
	});
	const targets = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["targets", workspaceId],
		queryFn: ({ signal }) =>
			client.call(routes.targetsList, { params: { id: workspaceId }, query: {}, body: {} }, undefined, signal),
	});
	const start = useMutation({
		meta: { errorSurface: "inline" },
		mutationFn: (request: ResearchStartRequest) =>
			client.call(routes.researchStart, { params: { id: workspaceId }, query: {}, body: request }, crypto.randomUUID()),
		onSuccess: (result) => onStarted(result.operationId),
	});
	const running = start.isPending || operationUnsettled(operationId, operation.data?.status);
	const outcome = researchRequest(draft);
	const checks = verifiers.data?.checks ?? [];
	const target = targets.data?.targets.find((item) => item.id === draft.target);
	const set = (patch: Partial<ResearchDraft>) => setDraft((current) => ({ ...current, ...patch }));
	return (
		<form
			className="research-new"
			aria-label="New research campaign"
			onSubmit={(event) => {
				event.preventDefault();
				if (running || "problem" in outcome) return;
				start.mutate(outcome.request);
			}}
		>
			<h2>New campaign</h2>
			{verifiers.error && <p className="research-error">Checks could not be read: {problemText(verifiers.error)}</p>}
			{verifiers.data && checks.length === 0 && (
				<p className="research-error">
					This workspace declares no checks. Add one to .clio-coder/verifiers.yaml that prints the metric as JSON.
				</p>
			)}
			<fieldset disabled={running}>
				<legend>Objective</legend>
				<div className="research-new__row">
					<label>
						Check
						<select value={draft.check} onChange={(event) => set({ check: event.target.value })}>
							<option value="">Pick a check</option>
							{checks.map((check) => (
								<option key={check.id} value={check.id}>
									{check.id}
								</option>
							))}
						</select>
					</label>
					<label>
						Metric
						<input value={draft.metric} placeholder="wall_ms" onChange={(event) => set({ metric: event.target.value })} />
					</label>
					<label>
						Direction
						<select
							value={draft.direction}
							onChange={(event) => set({ direction: event.target.value === "max" ? "max" : "min" })}
						>
							<option value="min">min (lower is better)</option>
							<option value="max">max (higher is better)</option>
						</select>
					</label>
					<label>
						Min improvement (fraction)
						<input
							type="number"
							step="0.01"
							min="0"
							value={draft.minImprovement}
							onChange={(event) => set({ minImprovement: event.target.value })}
						/>
					</label>
					<label>
						Trials (pairs)
						<input
							type="number"
							min={2}
							max={100}
							value={draft.trials}
							onChange={(event) => set({ trials: event.target.value })}
						/>
					</label>
				</div>
				{draft.check && <p className="panel-note">{checks.find((check) => check.id === draft.check)?.description}</p>}
			</fieldset>
			<fieldset disabled={running}>
				<legend>Gates and scope</legend>
				<div className="research-new__gates">
					{checks.length === 0 && <span className="panel-note">No checks to gate on.</span>}
					{checks.map((check) => (
						<label key={check.id} className="research-new__inline">
							<input
								type="checkbox"
								checked={draft.gates.includes(check.id)}
								onChange={(event) =>
									set({
										gates: event.target.checked ? [...draft.gates, check.id] : draft.gates.filter((gate) => gate !== check.id),
									})
								}
							/>
							{check.id}
						</label>
					))}
				</div>
				<label>
					Scope (globs a candidate may change, one per line; empty means any unprotected file)
					<textarea
						rows={3}
						value={draft.scope}
						placeholder={"src/**/*.{ts,tsx}\nlib/*.py"}
						onChange={(event) => set({ scope: event.target.value })}
					/>
				</label>
			</fieldset>
			<fieldset disabled={running}>
				<legend>Budget</legend>
				<div className="research-new__row">
					<label>
						Max iterations
						<input
							type="number"
							min={1}
							max={1000}
							value={draft.maxIterations}
							onChange={(event) => set({ maxIterations: event.target.value })}
						/>
					</label>
					<label>
						Max wall minutes
						<input
							type="number"
							min={0}
							value={draft.maxWallMinutes}
							onChange={(event) => set({ maxWallMinutes: event.target.value })}
						/>
					</label>
					<label>
						Max cost USD (optional)
						<input
							type="number"
							min={0}
							step="0.01"
							value={draft.maxCostUsd}
							onChange={(event) => set({ maxCostUsd: event.target.value })}
						/>
					</label>
					<label className="research-new__inline">
						<input
							type="checkbox"
							checked={draft.allowUnpriced}
							onChange={(event) => set({ allowUnpriced: event.target.checked })}
						/>
						Allow unpriced runs
					</label>
				</div>
				<p className="panel-note">
					A cost cap stops the campaign when a run's spend is unknown unless unpriced runs are allowed; the iteration and
					wall caps still bind.
				</p>
			</fieldset>
			<fieldset disabled={running}>
				<legend>Agent</legend>
				{targets.error && <p className="research-error">Targets could not be read: {problemText(targets.error)}</p>}
				<div className="research-new__row">
					<label>
						Target
						<select
							value={draft.target}
							onChange={(event) => {
								const next = targets.data?.targets.find((item) => item.id === event.target.value);
								set({ target: event.target.value, model: next?.defaultModel ?? next?.models[0] ?? "" });
							}}
						>
							<option value="">Workspace default</option>
							{targets.data?.targets.map((item) => (
								<option key={item.id} value={item.id}>
									{item.id}
								</option>
							))}
						</select>
					</label>
					<label>
						Model
						<input
							list="research-models"
							value={draft.model}
							placeholder="model id"
							onChange={(event) => set({ model: event.target.value.trim() })}
						/>
						<datalist id="research-models">
							{target?.models.map((model) => (
								<option key={model} value={model} />
							))}
						</datalist>
					</label>
				</div>
				<label>
					Goal (optional, one line of guidance for the agent)
					<input value={draft.goal} maxLength={2000} onChange={(event) => set({ goal: event.target.value })} />
				</label>
				<p className="panel-note">The agent runs at the default autonomy; research never runs it in yolo.</p>
			</fieldset>
			{"problem" in outcome && draft.check && <p className="panel-note">{outcome.problem}</p>}
			<div className="research-new__actions">
				<button type="submit" className="primary" disabled={running || "problem" in outcome}>
					{running ? "Starting…" : "Start campaign"}
				</button>
				{!running && (
					<button type="button" onClick={onClose}>
						Close
					</button>
				)}
			</div>
			{start.error && (
				<p className="research-error" role="alert">
					{problemText(start.error)}
				</p>
			)}
			{operation.data?.status === "failed" && (
				<p className="research-error" role="alert">
					{operation.data.problem.detail || operation.data.problem.title}
				</p>
			)}
		</form>
	);
}
