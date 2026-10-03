import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { Icon } from "../design/icons.js";
import "./artifacts.css";

export function ArtifactsPanel({
	client,
	sessionId,
	open,
	capabilities,
	settled,
}: {
	client: Client;
	sessionId: string;
	open: boolean;
	capabilities: AgentCapabilities | undefined;
	settled: number;
}) {
	const [selected, select] = useState<string | null>(null);
	const [offsets, setOffsets] = useState([0]);
	const [details, setDetails] = useState(false);
	const [filter, setFilter] = useState("");
	const title = useRef<HTMLHeadingElement>(null);
	const supported = !!capabilities?.artifacts;
	const list = useQuery({
		queryKey: ["session-artifacts", sessionId, settled],
		queryFn: () => client.call(routes.sessionArtifacts, { params: { id: sessionId }, query: {}, body: {} }),
		enabled: open && supported,
		retry: false,
	});
	const offset = offsets.at(-1) ?? 0;
	const page = useQuery({
		queryKey: ["session-artifact", sessionId, selected, offset, details, settled],
		queryFn: () =>
			client.call(routes.sessionArtifact, {
				params: { id: sessionId },
				query: {},
				body: { id: selected ?? "", offset, limit: 500, details },
			}),
		enabled: open && supported && selected !== null,
		retry: false,
	});
	const pageId = page.data?.id;
	useEffect(() => {
		if (pageId && selected && offset >= 0) title.current?.focus();
	}, [pageId, selected, offset]);
	const rows = list.data?.artifacts.filter((row) => !filter || row.category === filter) ?? [];
	const error = selected ? page.error : list.error;
	return (
		<div className="pane-drill artifacts">
			{!open ? (
				<p className="pane-empty">Open this task to read its artifacts.</p>
			) : !supported ? (
				<p className="pane-empty">Clio does not report artifacts for this task.</p>
			) : selected ? (
				<>
					<button
						type="button"
						className="artifacts__back"
						onClick={() => {
							const id = `${sessionId}-artifact-${encodeURIComponent(selected)}`;
							select(null);
							requestAnimationFrame(() => document.getElementById(id)?.focus());
						}}
					>
						<Icon name="arrowLeft" /> All artifacts
					</button>
					{page.isPending ? <p className="pane-empty">Reading artifact…</p> : null}
					{page.data ? (
						<>
							<h3 className="artifacts__title" tabIndex={-1} ref={title}>
								{page.data.title}
							</h3>
							{page.data.refused ? (
								<p className="artifacts__refusal" role="status">
									{page.data.refused.reason}
								</p>
							) : null}
							{page.data.details || details ? (
								<button
									type="button"
									className="artifacts__back"
									onClick={() => {
										setDetails(!details);
										setOffsets([0]);
									}}
								>
									{details ? "Show content" : "Show details"}
								</button>
							) : null}
							{/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users scroll the artifact independently. */}
							<section className="artifacts__content" tabIndex={0} aria-label={`${page.data.title}, ${page.data.format}`}>
								<pre>
									<code>{page.data.lines.join("\n")}</code>
								</pre>
							</section>
							{page.data.clippedLines ? (
								<p className="pane-hint">{page.data.clippedLines} oversized lines were shortened by Clio.</p>
							) : null}
							<div className="artifacts__paging">
								<button type="button" disabled={offsets.length === 1} onClick={() => setOffsets(offsets.slice(0, -1))}>
									Previous
								</button>
								<span>
									{page.data.totalLines === 0
										? "Empty artifact"
										: `Lines ${page.data.offset + 1}–${page.data.offset + page.data.lines.length} of ${page.data.totalLines}`}
								</span>
								<button
									type="button"
									disabled={page.data.nextOffset === null}
									onClick={() => {
										if (page.data.nextOffset !== null) setOffsets([...offsets, page.data.nextOffset]);
									}}
								>
									Next
								</button>
							</div>
						</>
					) : null}
				</>
			) : (
				<>
					<div className="artifacts__controls">
						<label>
							Kind
							<select value={filter} onChange={(event) => setFilter(event.target.value)}>
								<option value="">All artifacts</option>
								{(capabilities?.artifacts?.categories ?? []).map((category) => (
									<option key={category} value={category}>
										{category.replaceAll("-", " ")}
									</option>
								))}
							</select>
						</label>
						<button
							type="button"
							className="artifacts__refresh"
							aria-label="Refresh artifacts"
							disabled={list.isFetching}
							onClick={() => void list.refetch()}
						>
							Refresh
						</button>
					</div>
					{list.isPending ? <p className="pane-empty">Reading artifacts…</p> : null}
					{list.data && rows.length === 0 ? <p className="pane-empty">No artifacts in this view yet.</p> : null}
					<ul className="artifacts__list">
						{rows.map((row) => (
							<li key={row.id}>
								<button
									type="button"
									id={`${sessionId}-artifact-${encodeURIComponent(row.id)}`}
									onClick={() => {
										select(row.id);
										setDetails(false);
										setOffsets([0]);
									}}
								>
									<span>
										<strong>{row.title}</strong>
										{row.subtitle ? <small>{row.subtitle}</small> : null}
										<small>
											{row.category.replaceAll("-", " ")}
											{row.protected ? " · Protected" : ""}
										</small>
									</span>
									<Icon name="chevronRight" />
								</button>
							</li>
						))}
					</ul>
					{list.data?.truncated ? (
						<p className="pane-hint">Showing the newest {capabilities?.artifacts?.perCategory} artifacts in each category.</p>
					) : null}
				</>
			)}
			{error ? (
				<p role="alert" className="pane-empty">
					{error.message}{" "}
					<button type="button" onClick={() => void (selected ? page.refetch() : list.refetch())}>
						Retry
					</button>
				</p>
			) : null}
		</div>
	);
}
