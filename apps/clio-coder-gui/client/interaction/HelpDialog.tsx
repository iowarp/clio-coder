// The body of Shortcuts & help. The dialog around it is eager (`LazyDialogs.tsx`), so the keys typed
// while this chunk loads land in the search field rather than the message box behind it.

import type { RefObject } from "react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../design/icons.js";
import { inspectionTabIndex } from "../design/run-inspection-model.js";
import type { HelpView } from "./help-model.js";
import { HELP_VIEWS, helpContent } from "./help-model.js";
import type { HelpMatch } from "./help-reference.js";
import { Keycaps } from "./Keycaps.js";
import { PUBLIC_HELP } from "./public-help.js";
import "./help.css";

export function HelpEntries({ match, bundledDocsPath }: { match: HelpMatch; bundledDocsPath?: string | undefined }) {
	return (
		<dl className="help-entries">
			{match.entries.map((entry) => (
				<div key={entry.term}>
					<dt>{entry.term}</dt>
					<dd>
						<p>{entry.meaning}</p>
						{match.section.id === "documentation" ? (
							entry.term === "Public documentation" ? (
								<a href={PUBLIC_HELP} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
									Open public documentation ↗
								</a>
							) : (
								<p className="help-docs-path">
									<span>Installed location</span>
									<code>{bundledDocsPath ?? "docs/ in the CLIO Coder package"}</code>
								</p>
							)
						) : null}
					</dd>
				</div>
			))}
		</dl>
	);
}

export function HelpReferenceBody({
	bundledDocsPath,
	searchRef,
	initialQuery = "",
	claimFocus = false,
}: {
	bundledDocsPath?: string | undefined;
	searchRef?: RefObject<HTMLInputElement | null>;
	/** What was typed into the loading shell before this body arrived. */
	initialQuery?: string;
	/** Take focus on mount, caret at the end: the shell that held it has just been replaced. */
	claimFocus?: boolean;
}) {
	const [query, setQuery] = useState(initialQuery);
	const [view, setView] = useState<HelpView>("guide");
	const inputId = useId();
	const contentId = useId();
	const tabsId = useId();
	const tabs = useRef<(HTMLButtonElement | null)[]>([]);
	const claim = useRef(claimFocus);
	useLayoutEffect(() => {
		if (!claim.current) return;
		claim.current = false;
		const input = searchRef?.current;
		input?.focus();
		input?.setSelectionRange(input.value.length, input.value.length);
	}, [searchRef]);
	const content = helpContent(query, view);
	// A view whose only section shares the tab's name would print that name twice; the tab already says it.
	const viewTitle = HELP_VIEWS.find((item) => item.id === view)?.title;
	const soleSectionNamed =
		!content.searching && content.sections.length === 1 && content.sections[0]?.section.title === viewTitle;
	return (
		<div className="help-reference">
			<div className="help-toolbar">
				<label className="sr-only" htmlFor={inputId}>
					Search shortcuts and help
				</label>
				<div className="help-search">
					<Icon name="search" />
					<input
						ref={searchRef}
						id={inputId}
						type="search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Search actions, keys or help…"
						autoComplete="off"
						aria-controls={contentId}
					/>
					{query.length > 0 ? (
						<button
							type="button"
							onClick={() => {
								setQuery("");
								searchRef?.current?.focus();
							}}
							aria-label="Clear search"
						>
							<Icon name="close" />
						</button>
					) : null}
				</div>
				{/* Topics are tabs: one tab stop, Left and Right move between them, Home and End jump. */}
				<div className="help-nav" role="tablist" aria-label="Help topics">
					{HELP_VIEWS.map((item, index) => (
						<button
							key={item.id}
							ref={(element) => {
								tabs.current[index] = element;
							}}
							id={`${tabsId}-${item.id}`}
							type="button"
							role="tab"
							aria-selected={!content.searching && view === item.id}
							aria-controls={contentId}
							tabIndex={view === item.id ? 0 : -1}
							onClick={() => {
								setQuery("");
								setView(item.id);
							}}
							onKeyDown={(event) => {
								const next = inspectionTabIndex(event.key, index, HELP_VIEWS.length);
								const target = HELP_VIEWS[next];
								if (!target) return;
								event.preventDefault();
								setQuery("");
								setView(target.id);
								tabs.current[next]?.focus();
							}}
						>
							{item.title}
						</button>
					))}
				</div>
			</div>
			<section
				className="help-content"
				id={contentId}
				key={content.searching ? "search" : view}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to focus this region to scroll inside the dialog trap.
				tabIndex={0}
				{...(content.searching
					? { "aria-label": "Help content" }
					: { role: "tabpanel", "aria-labelledby": `${tabsId}-${view}` })}
			>
				<p className="help-context" role="status">
					{content.searching
						? `${content.count} ${content.count === 1 ? "result" : "results"} across shortcuts and help`
						: view === "shortcuts"
							? "Ctrl on Windows / Linux · Cmd on Mac. Tab moves between controls."
							: view === "guide"
								? "A quick guide to working with CLIO Coder."
								: "Read online or use the reference installed on this machine."}
				</p>
				{content.searching && content.count === 0 ? (
					<div className="help-empty">
						<h3>No matches</h3>
						<p>Try an action like “send”, a key like “Ctrl/Cmd + K”, or a topic like “autonomy”.</p>
					</div>
				) : null}
				{content.shortcuts.length > 0 ? (
					<div className="help-shortcuts">
						{content.shortcuts.map((group) => (
							<section key={group.id} aria-label={group.title}>
								<h3>{group.title}</h3>
								<dl>
									{group.bindings.map((binding) => (
										<div className="help-shortcut" key={binding.id}>
											<dt>
												{binding.action}
												<span>{binding.where}</span>
											</dt>
											<dd>
												<Keycaps className="help-keys" chord={binding.keys} />
											</dd>
										</div>
									))}
								</dl>
							</section>
						))}
					</div>
				) : null}
				<div className="help-topics">
					{content.sections.map((match) =>
						content.searching || match.section.id === "documentation" ? (
							<section className="help-topic" key={match.section.id} aria-label={match.section.title}>
								{soleSectionNamed ? null : <h3>{match.section.title}</h3>}
								<p>{match.section.lede}</p>
								<HelpEntries match={match} bundledDocsPath={bundledDocsPath} />
							</section>
						) : (
							<details className="help-topic" key={match.section.id}>
								<summary tabIndex={0}>{match.section.title}</summary>
								<p>{match.section.lede}</p>
								<HelpEntries match={match} bundledDocsPath={bundledDocsPath} />
							</details>
						),
					)}
				</div>
			</section>
		</div>
	);
}
