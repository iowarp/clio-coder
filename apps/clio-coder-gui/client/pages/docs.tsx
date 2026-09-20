import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { MarkdownContent } from "../render/Markdown.js";
import "./docs.css";

function docsRoute(path: string, hash = ""): string {
	return `/docs/${path.split("/").map(encodeURIComponent).join("/")}${hash}`;
}

export function Docs({ client }: { client: Client }) {
	const path = useParams()["*"] || "README.md";
	const location = useLocation();
	const navigate = useNavigate();
	const [query, setQuery] = useState("");
	const [search, setSearch] = useState("");
	const [browse, setBrowse] = useState(() => window.matchMedia("(min-width: 1100px)").matches);
	const tree = useQuery({
		queryKey: ["docs-tree"],
		queryFn: () => client.call(routes.docsTree, emptyInput),
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
	const openDocument = useCallback((href: string) => void navigate(href), [navigate]);
	const openPage = () => {
		setSearch("");
		if (!window.matchMedia("(min-width: 1100px)").matches) setBrowse(false);
	};
	useEffect(() => {
		const media = window.matchMedia("(min-width: 1100px)");
		const update = () => setBrowse(media.matches);
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);
	useEffect(() => {
		if (!page.data) return;
		let id: string;
		try {
			id = decodeURIComponent(location.hash.slice(1));
		} catch {
			return;
		}
		const frame = requestAnimationFrame(() => {
			if (id) document.getElementById(id)?.scrollIntoView();
			else document.querySelector(".docs-page")?.scrollIntoView({ block: "start" });
		});
		return () => cancelAnimationFrame(frame);
	}, [page.data, location.hash]);
	const headings = page.data?.headings.filter((row) => row.depth === 2 || row.depth === 3) ?? [];
	return (
		<section className="docs">
			<header className="docs-heading">
				<div>
					<p className="eyebrow">Clio Coder / Reference</p>
					<h1>Documentation</h1>
				</div>
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
							placeholder="Find a guide, command, or setting…"
							value={query}
							maxLength={200}
							onChange={(event) => setQuery(event.target.value)}
						/>
						<button type="submit">Search docs</button>
					</div>
				</form>
			</header>
			{search && (
				<section className="docs-results" aria-label="Search results">
					<div className="actions">
						<h2>Results for “{search}”</h2>
						<button type="button" onClick={() => setSearch("")}>
							Close search
						</button>
					</div>
					{results.isPending ? (
						<p role="status">Searching…</p>
					) : results.error ? (
						<p role="alert">{results.error.message}</p>
					) : !results.data.length ? (
						<p>No matching documents. Try a command or a shorter phrase.</p>
					) : (
						<ul>
							{results.data.map((row) => (
								<li key={row.path}>
									<Link onClick={openPage} to={docsRoute(row.path)}>
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
					<details open={browse} onToggle={(event) => setBrowse(event.currentTarget.open)}>
						<summary>Browse documentation</summary>
						<Link
							className="docs-home"
							aria-current={path === "README.md" ? "page" : undefined}
							onClick={openPage}
							to="/docs"
						>
							Start here
						</Link>
						{tree.error ? (
							<p role="alert">{tree.error.message}</p>
						) : tree.data ? (
							<>
								{tree.data.groups.map((group) => (
									<details key={group.title} open={group.pages.some((row) => row.path === path)}>
										<summary>{group.title}</summary>
										<ul>
											{group.pages.map((row) => (
												<li key={row.path}>
													<Link aria-current={row.path === path ? "page" : undefined} onClick={openPage} to={docsRoute(row.path)}>
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
												<Link aria-current={row.path === path ? "page" : undefined} onClick={openPage} to={docsRoute(row.path)}>
													{row.title}
												</Link>
											</li>
										))}
									</ul>
								</details>
							</>
						) : (
							<p role="status">Reading the documentation map…</p>
						)}
					</details>
				</aside>
				<article className="docs-page" aria-label={page.data?.title ?? "Document"}>
					{page.isPending ? (
						<p role="status">Reading document…</p>
					) : page.error ? (
						<div role="alert">
							<h2>Document unavailable</h2>
							<p>{page.error.message}</p>
							<div className="actions">
								<button type="button" onClick={() => void page.refetch()}>
									Try again
								</button>
								<Link to="/docs">Browse documentation</Link>
							</div>
						</div>
					) : (
						<>
							<p className="docs-path">{page.data.path}</p>
							{headings.length > 0 && (
								<nav className="docs-outline" aria-label="On this page">
									<details>
										<summary>On this page</summary>
										<ol>
											{headings.map((row) => (
												<li key={row.id} data-depth={row.depth}>
													<Link to={docsRoute(path, `#${encodeURIComponent(row.id)}`)}>{row.title}</Link>
												</li>
											))}
										</ol>
									</details>
								</nav>
							)}
							<MarkdownContent
								key={path}
								source={page.data.markdown}
								complete
								documentLinks={page.data.links}
								onDocumentNavigate={openDocument}
							/>
						</>
					)}
				</article>
			</div>
		</section>
	);
}
