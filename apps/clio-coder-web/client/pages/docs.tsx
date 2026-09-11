import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { MarkdownContent } from "../render/Markdown.js";
import { BlueprintFrame, blueprintRoute } from "./docs-blueprint.js";
import "./docs.css";

type BlueprintItem = { topic: string; title: string; file: string; documentPath?: string };
/** Readers choose a reading view: the Guide is the Markdown page, the Blueprint its handmade visual counterpart. */
type View = "guide" | "blueprint";

/** Blueprint metadata names sources as `docs/<path>.md`; the docs tree keys pages by `<path>.md`. */
function documentKey(documentPath: string | undefined): string | null {
	if (!documentPath) return null;
	const trimmed = documentPath.replace(/^\/+/, "").replace(/^docs\//, "");
	return trimmed || null;
}

function docsRoute(path: string, hash = ""): string {
	return `/docs/${path.split("/").map(encodeURIComponent).join("/")}${hash}`;
}

export function Docs({ client }: { client: Client }) {
	const wildcard = useParams()["*"] ?? "";
	const location = useLocation();
	const navigate = useNavigate();
	const [query, setQuery] = useState("");
	const [search, setSearch] = useState("");
	const blueprintFile = wildcard.startsWith("blueprints/") ? wildcard.slice("blueprints/".length) : null;
	const view: View = blueprintFile !== null ? "blueprint" : "guide";
	const path = blueprintFile === null ? wildcard || "README.md" : null;
	const [frameTitle, setFrameTitle] = useState<string | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: The announced title belongs to one file; a new file starts without one.
	useEffect(() => setFrameTitle(null), [blueprintFile]);
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
		queryFn: () => client.call(routes.docsPage, { ...emptyInput, query: { path: path ?? "README.md" } }),
		enabled: path !== null,
	});
	const results = useQuery({
		queryKey: ["docs-search", search],
		queryFn: () => client.call(routes.docsSearch, { ...emptyInput, query: { q: search } }),
		enabled: !!search,
	});
	const catalog = useMemo(() => {
		const byFile = new Map<string, BlueprintItem>();
		const byDocument = new Map<string, BlueprintItem>();
		const items: BlueprintItem[] = blueprints.data?.available ? blueprints.data.items : [];
		for (const item of items) {
			byFile.set(item.file, item);
			const key = documentKey(item.documentPath);
			if (key && !byDocument.has(key)) byDocument.set(key, item);
		}
		return { byFile, byDocument, items };
	}, [blueprints.data]);
	const pages = useMemo(() => new Set(tree.data?.pages.map((row) => row.path) ?? []), [tree.data]);
	const currentBlueprint = blueprintFile !== null ? catalog.byFile.get(blueprintFile) : undefined;
	const pairedBlueprint = path !== null ? catalog.byDocument.get(path) : currentBlueprint;
	const pairedDocument = currentBlueprint ? documentKey(currentBlueprint.documentPath) : path;
	const pairedDocumentExists = pairedDocument !== null && pages.has(pairedDocument);
	const unpaired = catalog.items.filter((item) => {
		const key = documentKey(item.documentPath);
		return key === null || !pages.has(key);
	});
	// Keep the reader's chosen view while browsing: a page opened from a blueprint opens its own blueprint when one exists.
	const linkTo = (rowPath: string) => {
		const blueprint = view === "blueprint" ? catalog.byDocument.get(rowPath) : undefined;
		return blueprint ? blueprintRoute(blueprint.file) : docsRoute(rowPath);
	};
	const openDocument = useCallback((href: string) => void navigate(href), [navigate]);
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
	if (blueprintFile !== null && /^index\.html?$/i.test(blueprintFile)) return <Navigate to="/docs" replace />;
	const blueprintTitle = currentBlueprint?.title ?? frameTitle ?? blueprintFile ?? "";
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
									<Link onClick={() => setSearch("")} to={linkTo(row.path)}>
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
													<Link
														aria-current={row.path === path || row.path === pairedDocument ? "page" : undefined}
														to={linkTo(row.path)}
													>
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
												<Link onClick={() => setSearch("")} to={linkTo(row.path)}>
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
						{blueprints.error ? (
							<p role="alert">{blueprints.error.message}</p>
						) : unpaired.length > 0 ? (
							<details>
								<summary>Blueprints without a guide · {unpaired.length}</summary>
								<ul>
									{unpaired.map((row) => (
										<li key={row.file}>
											<Link aria-current={row.file === blueprintFile ? "page" : undefined} to={blueprintRoute(row.file)}>
												{row.title}
											</Link>
										</li>
									))}
								</ul>
							</details>
						) : null}
					</details>
				</aside>
				{blueprintFile !== null ? (
					<article className="docs-page docs-page--blueprint" aria-label={`${blueprintTitle} blueprint`}>
						<div className="docs-toolbar">
							<p className="docs-path">{pairedDocument ?? blueprintFile}</p>
							<ViewSwitch
								view="blueprint"
								guideTo={pairedDocumentExists && pairedDocument ? docsRoute(pairedDocument) : null}
								blueprintTo={blueprintRoute(blueprintFile)}
								guideNote={
									pairedDocument === null
										? "This blueprint has no guide page."
										: pairedDocumentExists
											? undefined
											: `The guide page ${pairedDocument} is missing from this installation.`
								}
							/>
						</div>
						<h2 className="docs-title">{blueprintTitle}</h2>
						{blueprints.data && !blueprints.data.available ? (
							<div role="alert">
								<h3>Blueprints are missing</h3>
								<p>
									This installation is incomplete: its documentation blueprints were not installed. The{" "}
									<Link to="/docs">guides</Link> remain available.
								</p>
							</div>
						) : (
							<BlueprintFrame file={blueprintFile} hash={location.hash} title={blueprintTitle} onTitle={setFrameTitle} />
						)}
					</article>
				) : (
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
								<div className="docs-toolbar">
									<p className="docs-path">{page.data.path}</p>
									{pairedBlueprint && (
										<ViewSwitch
											view="guide"
											guideTo={docsRoute(page.data.path)}
											blueprintTo={blueprintRoute(pairedBlueprint.file)}
										/>
									)}
								</div>
								<MarkdownContent
									key={path}
									source={page.data.markdown}
									complete
									documentLinks={page.data.links}
									onDocumentNavigate={openDocument}
								/>
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
				)}
			</div>
		</section>
	);
}

function ViewSwitch({
	view,
	guideTo,
	blueprintTo,
	guideNote,
}: {
	view: View;
	guideTo: string | null;
	blueprintTo: string;
	guideNote?: string | undefined;
}) {
	return (
		<nav className="docs-view" aria-label="Reading view">
			{guideTo ? (
				<Link to={guideTo} aria-current={view === "guide" ? "page" : undefined}>
					Guide
				</Link>
			) : (
				<span aria-disabled="true" title={guideNote}>
					Guide
				</span>
			)}
			<Link to={blueprintTo} aria-current={view === "blueprint" ? "page" : undefined}>
				Blueprint
			</Link>
			{guideNote && <p className="docs-view__note">{guideNote}</p>}
		</nav>
	);
}
