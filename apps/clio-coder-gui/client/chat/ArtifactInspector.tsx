import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { memo, useCallback, useMemo, useState } from "react";
import { Link } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot, TimelineItem } from "../../contracts/sessions.js";
import { type Client, emptyInput } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { Icon } from "../design/icons.js";
import { StatusMark, type StatusTone } from "../design/status.js";
import {
	ARTIFACT_MAX_PAGES,
	ARTIFACT_PAGE_SIZE,
	admittedPages,
	retainedLinksLive,
} from "../pages/artifact-pagination.js";
import { MarkdownContent } from "../render/Markdown.js";
import { workerLabel } from "./activity.js";
import { ToolCard } from "./tool-cards.js";
import { basename, presentable } from "./tool-presentation.js";
import "./ArtifactInspector.css";

const RECORD_BATCH = 20;
export type ArtifactSession = Pick<SessionSnapshot, "id" | "fleet" | "timelineTruncated"> & {
	readonly tools: readonly TimelineItem[];
};

/** Text deltas leave the inspector's recorded tools and evidence projection unchanged. */
export function selectArtifactSession(session: SessionSnapshot): ArtifactSession {
	return {
		id: session.id,
		fleet: session.fleet,
		timelineTruncated: session.timelineTruncated,
		tools: session.timeline.filter((item) => item.kind === "tool").reverse(),
	};
}

export type InspectorSelection = {
	view: "files" | "results" | "evidence";
	selectedFile: string | null;
	filter: string;
};

const RecordedTools = memo(function RecordedTools({
	items,
	workspaceRoot,
}: {
	items: readonly TimelineItem[];
	workspaceRoot: string | undefined;
}) {
	const [visible, setVisible] = useState(RECORD_BATCH);
	const options = useMemo(() => (workspaceRoot === undefined ? {} : { workspaceRoot }), [workspaceRoot]);
	return (
		<>
			{items.slice(0, visible).map((item) => (
				<ToolCard key={item.id} item={item} options={options} agent={workerLabel(item.provenance)} />
			))}
			{items.length > visible && (
				<button
					type="button"
					className="artifact-inspector__more"
					onClick={() => setVisible((count) => count + RECORD_BATCH)}
				>
					Show older recorded calls · {items.length - visible} remaining
				</button>
			)}
		</>
	);
});

function LatestResponse({ client, sessionId }: { client: Client; sessionId: string }) {
	const [expanded, setExpanded] = useState(false);
	const select = useCallback(
		(session: SessionSnapshot) => {
			const turn = session.turns.at(-1);
			const source =
				expanded && turn
					? session.timeline
							.filter((item) => item.turnId === turn.id && item.kind === "text")
							.map((item) => item.text)
							.join("\n\n")
					: "";
			return {
				present:
					turn !== undefined &&
					session.timeline.some((item) => item.turnId === turn.id && item.kind === "text" && item.text.length > 0),
				running: turn?.status === "running",
				source,
			};
		},
		[expanded],
	);
	const response = useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => client.call(routes.session, { params: { id: sessionId }, query: {}, body: {} }),
		enabled: false,
		select,
	}).data;
	if (!response?.present) return null;
	return (
		<details
			className="artifact-inspector__response"
			open={expanded}
			onToggle={(event) => setExpanded(event.currentTarget.open)}
		>
			<summary>Latest recorded response{response.running ? " · streaming" : ""}</summary>
			{expanded ? <MarkdownContent source={response.source} complete={!response.running} deferDiagrams /> : null}
		</details>
	);
}

function RelatedEvidence({ client, session }: { client: Client; session: ArtifactSession }) {
	const runIds = new Set(
		session.fleet.flatMap((item) =>
			"runId" in item.fact.payload && item.fact.payload.runId.trim() ? [item.fact.payload.runId] : [],
		),
	);
	const announced = session.fleet.filter((item) => item.fact.type === "evidence.ready").length;
	const inventory = useInfiniteQuery({
		queryKey: ["evidence"],
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) =>
			client.call(routes.evidenceList, {
				...emptyInput,
				query: { limit: ARTIFACT_PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) },
			}),
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		maxPages: ARTIFACT_MAX_PAGES,
	});
	const items = admittedPages(inventory)
		.flatMap((page) => page.items)
		.filter(
			({ overview }) =>
				overview.sessionId === session.id ||
				(overview.source.kind === "session" && overview.source.sessionId === session.id) ||
				(overview.source.kind === "run" && runIds.has(overview.source.runId)) ||
				overview.runIds.some((id) => runIds.has(id)),
		);
	const live = retainedLinksLive(inventory);
	const tones: Record<string, StatusTone> = {
		compromised: "fail",
		unverified: "unverified",
		unknown: "unverified",
		grounded: "neutral",
		reviewed: "neutral",
	};
	return (
		<>
			<p className="artifact-inspector__scope">Bundles linked to this conversation or its recorded dispatch runs.</p>
			{inventory.isPending && <p role="status">Reading evidence inventory…</p>}
			{inventory.error && (
				<div className="artifact-inspector__problem" role="alert">
					<p>{inventory.error.message}</p>
					<button type="button" disabled={inventory.isFetching} onClick={() => void inventory.refetch()}>
						Refresh evidence
					</button>
				</div>
			)}
			{inventory.isRefetching && (
				<p role="status">Refreshing admitted bundles. Viewer links return when the read finishes.</p>
			)}
			{!inventory.isPending && !inventory.error && !items.length && (
				<p className="artifact-inspector__empty">
					{inventory.data?.pages[0]?.present === false
						? "No evidence inventory is available yet."
						: announced
							? "This conversation recorded an evidence-ready event, but no linked bundle is in the loaded inventory window."
							: "No linked evidence bundles are in the loaded inventory window. A conversation turn does not automatically create a bundle."}
				</p>
			)}
			{items.map(({ overview, verdict }) => (
				<details className="artifact-inspector__bundle" key={overview.evidenceId}>
					<summary>
						<strong>{overview.tasks[0] || overview.evidenceId}</strong>
						<StatusMark tone={tones[verdict] ?? "unverified"} label={verdict} />
					</summary>
					<dl>
						<dt>Bundle</dt>
						<dd>
							<code>{overview.evidenceId}</code>
						</dd>
						<dt>Collected</dt>
						<dd>{formatTime(overview.generatedAt)}</dd>
						<dt>Recorded source</dt>
						<dd>
							<code>{overview.source.kind === "session" ? overview.source.sessionId : overview.source.runId}</code>
						</dd>
						<dt>Runs / receipts</dt>
						<dd>
							{overview.totals.runs} / {overview.totals.receipts}
						</dd>
					</dl>
					<p className="artifact-inspector__scope">
						The verdict is the recorded summary. The viewer separates receipt integrity, validation, and independent review.
					</p>
					{live ? (
						<Link to={`/evidence/${encodeURIComponent(overview.evidenceId)}`}>
							Open evidence viewer <span aria-hidden="true">↗</span>
						</Link>
					) : (
						<span aria-disabled="true">Viewer link paused during refresh</span>
					)}
				</details>
			))}
			{inventory.hasNextPage && !inventory.isRefetchError && (
				<button
					type="button"
					className="artifact-inspector__more"
					disabled={inventory.isFetching}
					onClick={() => void inventory.fetchNextPage()}
				>
					{inventory.isFetchingNextPage ? "Reading older bundles…" : "Load older inventory page"}
				</button>
			)}
			{inventory.data && (
				<p className="artifact-inspector__scope">
					{inventory.data.pages.length} retained inventory {inventory.data.pages.length === 1 ? "page" : "pages"} · at most{" "}
					{ARTIFACT_MAX_PAGES}. Older pages replace the oldest retained page.
				</p>
			)}
		</>
	);
}

export const ArtifactInspector = memo(function ArtifactInspector({
	client,
	session,
	workspaceRoot,
	onClose,
	selection,
	onSelectionChange,
}: {
	client: Client;
	session: ArtifactSession;
	workspaceRoot?: string | undefined;
	onClose: () => void;
	selection?: InspectorSelection | undefined;
	onSelectionChange?: ((selection: InspectorSelection) => void) | undefined;
}) {
	const [localSelection, setLocalSelection] = useState<InspectorSelection>({
		view: "files",
		selectedFile: null,
		filter: "",
	});
	const currentSelection = selection ?? localSelection;
	const { view, selectedFile, filter } = currentSelection;
	function updateSelection(patch: Partial<InspectorSelection>) {
		const nextSelection = { ...currentSelection, ...patch };
		setLocalSelection(nextSelection);
		onSelectionChange?.(nextSelection);
	}
	const tools = session.tools;
	const files = useMemo(() => {
		const byPath = new Map<string, TimelineItem[]>();
		for (const tool of tools)
			for (const location of tool.locations ?? []) {
				if (!location.path.trim()) continue;
				const entries = byPath.get(location.path) ?? [];
				if (!entries.some((entry) => entry.id === tool.id)) entries.push(tool);
				byPath.set(location.path, entries);
			}
		return byPath;
	}, [tools]);
	const needle = filter.trim().toLocaleLowerCase();
	const matchingFiles = [...files.entries()].filter(([path]) => path.toLocaleLowerCase().includes(needle));
	const selected = selectedFile === null ? undefined : files.get(selectedFile);
	return (
		<aside className="artifact-inspector" aria-label="Conversation artifacts">
			<header className="artifact-inspector__header">
				<h2>Artifacts</h2>
				<button type="button" aria-label="Close artifacts" title="Close artifacts" onClick={onClose}>
					<Icon name="close" />
				</button>
			</header>
			<fieldset className="artifact-inspector__views">
				<legend className="sr-only">Artifact views</legend>
				{(["files", "results", "evidence"] as const).map((name) => (
					<button key={name} type="button" aria-pressed={view === name} onClick={() => updateSelection({ view: name })}>
						{name === "files" ? "Files" : name === "results" ? "Results" : "Evidence"}
					</button>
				))}
			</fieldset>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: this independent artifact region needs keyboard scrolling. */}
			<section className="artifact-inspector__scroll" aria-label={`${view} artifacts`} tabIndex={0}>
				{session.timelineTruncated && (
					<p className="artifact-inspector__scope">Earlier records are not included in this conversation snapshot.</p>
				)}
				{view === "files" && (
					<>
						<p className="artifact-inspector__scope">
							Paths reported by tools in the conversation. Contents and changes are recorded snapshots.
						</p>
						<label className="artifact-inspector__filter">
							Find a recorded path
							<input
								type="search"
								value={filter}
								onChange={(event) => updateSelection({ filter: event.target.value })}
								placeholder="Filename or path"
							/>
						</label>
						{matchingFiles.length > 0 ? (
							<ul className="artifact-inspector__files">
								{matchingFiles.map(([path, calls]) => (
									<li key={path}>
										<button
											type="button"
											aria-pressed={selectedFile === path}
											onClick={() => updateSelection({ selectedFile: selectedFile === path ? null : path })}
											title={presentable(path, workspaceRoot)}
										>
											<Icon name="folder" />
											<span>
												<strong>{basename(path)}</strong>
												<small>{presentable(path, workspaceRoot)}</small>
											</span>
											<span className="artifact-inspector__count">{calls.length}</span>
										</button>
									</li>
								))}
							</ul>
						) : (
							<p className="artifact-inspector__empty">
								{files.size ? "No recorded paths match." : "No tool calls have reported file locations yet."}
							</p>
						)}
						{selectedFile && selected && (
							<section className="artifact-inspector__selected" aria-label="Selected file records">
								<div className="artifact-inspector__selected-heading">
									<h3>{basename(selectedFile)}</h3>
									<button type="button" onClick={() => updateSelection({ selectedFile: null })}>
										Clear selection
									</button>
								</div>
								<p className="artifact-inspector__scope">
									{selected.length} associated recorded {selected.length === 1 ? "call" : "calls"}. Expand a call to inspect its
									output or diff.
								</p>
								<RecordedTools key={selectedFile} items={selected} workspaceRoot={workspaceRoot} />
							</section>
						)}
						{selectedFile && !selected && <p role="status">The selected path is no longer in the retained snapshot.</p>}
					</>
				)}
				{view === "results" && (
					<>
						<LatestResponse client={client} sessionId={session.id} />
						<h3>
							Recorded tool activity <span className="artifact-inspector__count">{tools.length}</span>
						</h3>
						{tools.length ? (
							<RecordedTools items={tools} workspaceRoot={workspaceRoot} />
						) : (
							<p className="artifact-inspector__empty">No tool outputs have been recorded in this conversation snapshot.</p>
						)}
					</>
				)}
				{view === "evidence" && <RelatedEvidence client={client} session={session} />}
			</section>
		</aside>
	);
});
