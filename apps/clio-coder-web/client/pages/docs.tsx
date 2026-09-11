import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { MarkdownContent } from "../render/Markdown.js";
import "./docs.css";

export function Docs({ client }: { client: Client }) {
	const path = useParams()["*"] || "README.md";
	const location = useLocation();
	const [query, setQuery] = useState("");
	const [search, setSearch] = useState("");
	const tree = useQuery({
		queryKey: ["docs-tree"],
		queryFn: () => client.call(routes.docsTree, emptyInput),
		staleTime: Infinity,
	});
	const blueprints = useQuery({
		queryKey: ["docs-blueprints"],
		queryFn: () => client.call(routes.docsBlueprints, emptyInput),
		staleTime: Infinity,
	});
	const page = useQuery({
		queryKey: ["docs-page", path],
		queryFn: () => client.call(routes.docsPage, { ...emptyInput, query: { path } }),
	});
	const results = useQuery({
		queryKey: ["docs-search", search],
		queryFn: () => client.call(routes.docsSearch, { ...emptyInput, query: { q: search } }),
		enabled: !!search,
	});
	useEffect(() => {
		if (!page.data || !location.hash) return;
		let hash: string;
		try {
			hash = decodeURIComponent(location.hash.slice(1));
		} catch {
			return;
		}
		const frame = requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView());
		return () => cancelAnimationFrame(frame);
	}, [page.data, location.hash]);
	return (
		<section className="docs">
			<p className="eyebrow">Reference / Clio Coder</p>
			<h1>Documentation</h1>
			<form
				className="docs-search"
				onSubmit={(event) => {
					event.preventDefault();
					setSearch(query.trim());
				}}
			>
				<label htmlFor="docs-query">Search the documentation</label>
				<div className="actions">
					<input
						id="docs-query"
						type="search"
						value={query}
						maxLength={200}
						onChange={(event) => setQuery(event.target.value)}
					/>
					<button type="submit">Search docs</button>
				</div>
			</form>
			{search && (
				<section className="trace-panel" aria-label="Search results">
					<h2>Results for “{search}”</h2>
					{results.isPending ? (
						<p>Searching…</p>
					) : results.error ? (
						<p role="alert">{results.error.message}</p>
					) : !results.data.length ? (
						<p>No matching documents.</p>
					) : (
						<ul className="docs-results">
							{results.data.map((row) => (
								<li key={row.path}>
									<Link onClick={() => setSearch("")} to={`/docs/${row.path}`}>
										{row.title}
									</Link>
									<p>{row.excerpt}</p>
								</li>
							))}
						</ul>
					)}
				</section>
			)}
			<div className="docs-layout">
				<aside className="docs-navigation" aria-label="Documentation navigation">
					<details>
						<summary>Browse documentation{tree.data ? ` · ${tree.data.pages.length} pages` : ""}</summary>
						<Link to="/docs">Documentation map</Link>
						{tree.error ? (
							<p role="alert">{tree.error.message}</p>
						) : tree.data ? (
							<>
								{tree.data.groups.map((group) => (
									<details key={group.title}>
										<summary>{group.title}</summary>
										<ul>
											{group.pages.map((row) => (
												<li key={row.path}>
													<Link aria-current={row.path === path ? "page" : undefined} to={`/docs/${row.path}`}>
														{row.title}
													</Link>
												</li>
											))}
										</ul>
									</details>
								))}
								<details>
									<summary>All documents · {tree.data.pages.length}</summary>
									<ul>
										{tree.data.pages.map((row) => (
											<li key={row.path}>
												<Link onClick={() => setSearch("")} to={`/docs/${row.path}`}>
													{row.title}
												</Link>
											</li>
										))}
									</ul>
								</details>
							</>
						) : (
							<p>Reading the documentation map…</p>
						)}
						<details>
							<summary>Visual blueprints</summary>
							{blueprints.error ? (
								<p role="alert">{blueprints.error.message}</p>
							) : blueprints.data?.available ? (
								<ul>
									{blueprints.data.items.map((row) => (
										<li key={row.file}>
											<a href={`/docs-html/${encodeURIComponent(row.file)}`} target="_blank" rel="noopener noreferrer">
												{row.title}
											</a>
										</li>
									))}
								</ul>
							) : (
								<p>Blueprints are available in the source checkout. The packaged Markdown reference is available here.</p>
							)}
						</details>
					</details>
				</aside>
				<article className="docs-page" aria-label={page.data?.title ?? "Document"}>
					{page.isPending ? (
						<p>Reading document…</p>
					) : page.error ? (
						<div role="alert">
							<h2>Document unavailable</h2>
							<p>{page.error.message}</p>
						</div>
					) : (
						<>
							<p className="docs-path">{page.data.path}</p>
							<MarkdownContent key={path} source={page.data.markdown} complete documentLinks={page.data.links} />
							{page.data.unavailableLinks.length > 0 && (
								<details className="trace-panel">
									<summary>Unavailable references in this source · {page.data.unavailableLinks.length}</summary>
									<p>These destinations are unavailable in this installation and appear as text above.</p>
									<ul>
										{page.data.unavailableLinks.map((href) => (
											<li key={href}>
												<code>{href}</code>
											</li>
										))}
									</ul>
								</details>
							)}
						</>
					)}
				</article>
			</div>
		</section>
	);
}
