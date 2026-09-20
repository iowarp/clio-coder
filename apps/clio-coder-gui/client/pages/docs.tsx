import { useQuery } from "@tanstack/react-query";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { Boundary, PanelHeading } from "../design/panel.js";
import { PANELS } from "../design/panel-model.js";
import { openEnclosingDetails } from "../render/details.js";
import { MarkdownContent } from "../render/Markdown.js";
import "./docs.css";

function docsRoute(path: string, hash = ""): string {
	return `/docs/${path.split("/").map(encodeURIComponent).join("/")}${hash}`;
}

const WIDE_RAIL = "(min-width: 1600px)";
const SEARCH_DELAY_MS = 250;

/** Wraps each matched query term so a result shows why it matched. */
function Highlighted({ text, terms }: { text: string; terms: readonly string[] }) {
	if (!terms.length) return <>{text}</>;
	const pattern = new RegExp(`\\b(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
	let offset = 0;
	// split() with one capture group puts every match at an odd index; the running offset is a stable key.
	const parts = text.split(pattern).map((part, index) => {
		const piece = { part, hit: index % 2 === 1, at: offset };
		offset += part.length;
		return piece;
	});
	return (
		<>
			{parts.map(({ part, hit, at }) =>
				hit ? <mark key={`hit${at}`}>{part}</mark> : <Fragment key={`text${at}`}>{part}</Fragment>,
			)}
		</>
	);
}

export function Docs({ client }: { client: Client }) {
	const path = useParams()["*"] || "README.md";
	const location = useLocation();
	const navigate = useNavigate();
	const [query, setQuery] = useState("");
	const [search, setSearch] = useState("");
	const [browse, setBrowse] = useState(() => window.matchMedia("(min-width: 1100px)").matches);
	const [rail, setRail] = useState(() => window.matchMedia(WIDE_RAIL).matches);
	const searchInput = useRef<HTMLInputElement>(null);
	const article = useRef<HTMLElement>(null);
	const [expanded, setExpanded] = useState(false);
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
		const media = window.matchMedia(WIDE_RAIL);
		const update = () => setRail(media.matches);
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);
	// Typing searches after a short pause; Enter and the button search at once.
	useEffect(() => {
		const text = query.trim();
		if (text.length < 2) {
			if (!text) setSearch("");
			return;
		}
		const timer = setTimeout(() => setSearch(text), SEARCH_DELAY_MS);
		return () => clearTimeout(timer);
	}, [query]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new document starts with its sections as authored.
	useEffect(() => setExpanded(false), [path]);
	useEffect(() => {
		const focusSearch = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
			if (target?.closest("input, textarea, select, [contenteditable]")) return;
			event.preventDefault();
			searchInput.current?.focus();
			searchInput.current?.select();
		};
		window.addEventListener("keydown", focusSearch);
		return () => window.removeEventListener("keydown", focusSearch);
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a link to the current hash after its section was closed again is a new navigation with a new key.
	useEffect(() => {
		if (!page.data) return;
		let id: string;
		try {
			id = decodeURIComponent(location.hash.slice(1));
		} catch {
			return;
		}
		const frame = requestAnimationFrame(() => {
			// A heading inside a collapsed section cannot be scrolled to until its sections are open.
			const target = id ? document.getElementById(id) : null;
			openEnclosingDetails(target);
			if (target) target.scrollIntoView();
			else document.querySelector(".docs-heading")?.scrollIntoView({ block: "start" });
		});
		return () => cancelAnimationFrame(frame);
	}, [page.data, location.hash, location.key]);
	const headings = page.data?.headings.filter((row) => row.depth === 2 || row.depth === 3) ?? [];
	const terms = useMemo(() => [...new Set(search.toLowerCase().split(/\s+/).filter(Boolean))], [search]);
	// Reading order is the curated map, so previous and next follow it.
	const sequence = useMemo(() => {
		const seen = new Map<string, string>();
		for (const group of tree.data?.groups ?? []) for (const row of group.pages) seen.set(row.path, row.title);
		return [...seen].map(([entryPath, title]) => ({ path: entryPath, title }));
	}, [tree.data]);
	const position = sequence.findIndex((row) => row.path === path);
	const previous = position > 0 ? sequence[position - 1] : undefined;
	const next = position >= 0 ? sequence[position + 1] : undefined;
	return (
		<section className="docs">
			<header className="docs-heading">
				<PanelHeading panel={PANELS.docs} level={1} />
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
							ref={searchInput}
							placeholder="Guide, command, or setting…"
							aria-keyshortcuts="/"
							value={query}
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									setQuery("");
									setSearch("");
								}
							}}
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
						<h2>
							Results for “{search}”{results.data ? <span className="docs-result-count"> · {results.data.length}</span> : null}
						</h2>
						<button
							type="button"
							onClick={() => {
								setQuery("");
								setSearch("");
							}}
						>
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
										<Highlighted text={row.title} terms={terms} />
									</Link>
									<span className="docs-result-path">{row.path}</span>
									<p>
										<Highlighted text={row.excerpt} terms={terms} />
									</p>
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
							Documentation map
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
				<article className="docs-page" ref={article} aria-label={page.data?.title ?? "Document"}>
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
							<div className="docs-meta">
								<p className="docs-path">{page.data.path}</p>
								{/<details[\s>]/i.test(page.data.markdown) && (
									<button
										type="button"
										className="docs-expand"
										aria-pressed={expanded}
										onClick={() => {
											const next = !expanded;
											setExpanded(next);
											for (const section of article.current?.querySelectorAll<HTMLDetailsElement>("details.md-details") ?? [])
												section.open = next;
										}}
									>
										{expanded ? "Collapse all sections" : "Expand all sections"}
									</button>
								)}
							</div>
							{headings.length > 0 && (
								<nav className="docs-outline" aria-label="On this page">
									<details open={rail || undefined} key={`${path}:${rail}`}>
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
							{(previous || next) && (
								<nav className="docs-pager" aria-label="Previous and next document">
									{previous ? (
										<Link rel="prev" to={docsRoute(previous.path)}>
											<span>Previous</span>
											{previous.title}
										</Link>
									) : (
										<span />
									)}
									{next && (
										<Link rel="next" to={docsRoute(next.path)}>
											<span>Next</span>
											{next.title}
										</Link>
									)}
								</nav>
							)}
						</>
					)}
				</article>
			</div>
			<Boundary panel={PANELS.docs} />
		</section>
	);
}
