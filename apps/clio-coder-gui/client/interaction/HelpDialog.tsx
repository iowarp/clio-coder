import type { RefObject } from "react";
import { useId, useRef, useState } from "react";
import { Icon } from "../design/icons.js";
import { Dialog } from "./Dialog.js";
import type { HelpView } from "./help-model.js";
import { HELP_VIEWS, helpContent } from "./help-model.js";
import type { HelpMatch } from "./help-reference.js";
import type { Keybinding } from "./keybindings.js";
import { formatKeybinding } from "./keybindings.js";
import { PUBLIC_HELP } from "./public-help.js";
import "./help.css";

function ShortcutKeys({ binding }: { binding: Keybinding }) {
	const chord = formatKeybinding(binding);
	return (
		<span className="help-keys" role="img" aria-label={chord}>
			{chord.split(" + ").map((key) => (
				<kbd key={key}>{key.replace("Ctrl or Cmd", "Ctrl/Cmd")}</kbd>
			))}
		</span>
	);
}

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
									<code>{bundledDocsPath ?? "docs/ in the Clio Coder package"}</code>
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
}: {
	bundledDocsPath?: string | undefined;
	searchRef?: RefObject<HTMLInputElement | null>;
}) {
	const [query, setQuery] = useState("");
	const [view, setView] = useState<HelpView>("shortcuts");
	const inputId = useId();
	const contentId = useId();
	const content = helpContent(query, view);
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
				<nav className="help-nav" aria-label="Help topics">
					{HELP_VIEWS.map((item) => (
						<button
							key={item.id}
							type="button"
							aria-pressed={!content.searching && view === item.id}
							aria-controls={contentId}
							onClick={() => {
								setQuery("");
								setView(item.id);
							}}
						>
							{item.title}
						</button>
					))}
				</nav>
			</div>
			<section
				className="help-content"
				id={contentId}
				key={content.searching ? "search" : view}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need to focus this region to scroll inside the dialog trap.
				tabIndex={0}
				aria-label="Help content"
			>
				<p className="help-context" role="status">
					{content.searching
						? `${content.count} ${content.count === 1 ? "result" : "results"} across shortcuts and help`
						: view === "shortcuts"
							? "Ctrl on Windows / Linux · Cmd on Mac. Tab moves between controls."
							: view === "guide"
								? "A quick guide to working with Clio."
								: "Read online or use the reference installed on this machine."}
				</p>
				{content.searching && content.count === 0 ? (
					<div className="help-empty">
						<h3>No matches</h3>
						<p>Try an action like “send”, a chord like “Ctrl+K”, or a topic like “autonomy”.</p>
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
												<ShortcutKeys binding={binding} />
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
								<h3>{match.section.title}</h3>
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

export function HelpDialog({
	open,
	onClose,
	bundledDocsPath,
}: {
	open: boolean;
	onClose: () => void;
	bundledDocsPath?: string | undefined;
}) {
	const searchRef = useRef<HTMLInputElement>(null);
	if (!open) return null;
	return (
		<Dialog
			title="Shortcuts & help"
			eyebrow="CLIO CODER"
			size="wide"
			className="help-dialog"
			initialFocus={searchRef}
			onClose={onClose}
		>
			<HelpReferenceBody bundledDocsPath={bundledDocsPath} searchRef={searchRef} />
		</Dialog>
	);
}
