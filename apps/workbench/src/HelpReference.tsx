import { useId, useState } from "react";
import { searchHelp } from "./help-reference.ts";

/**
 * The body of the "How this app works" dialog. The caller wraps it in the
 * shell's `Modal`, which owns focus containment, Escape, and focus return, so
 * this component owns only the filter and the reference itself. It needs no
 * project and no connection, and must render the same with both absent.
 */
export function HelpReferenceBody() {
	const [query, setQuery] = useState("");
	const inputId = useId();
	const matches = searchHelp(query);
	const entryCount = matches.reduce((total, match) => total + match.entries.length, 0);
	return (
		<div className="help-reference">
			<div className="help-reference__query">
				<label htmlFor={inputId}>Filter this reference</label>
				<div>
					<span aria-hidden="true">⌕</span>
					<input
						id={inputId}
						type="search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="A view, a key, or a word the app uses"
						autoComplete="off"
					/>
					{query.length > 0 && (
						<button type="button" onClick={() => setQuery("")} aria-label="Clear reference filter">
							×
						</button>
					)}
				</div>
				<small role="status">
					{query.trim().length === 0
						? "The whole reference"
						: matches.length === 0
						? "Nothing in the reference matches."
						: `${entryCount} matching ${entryCount === 1 ? "entry" : "entries"} in ${matches.length} ${
							matches.length === 1 ? "section" : "sections"
						}`}
				</small>
			</div>
			{matches.length === 0
				? (
					<p className="help-reference__empty">
						Nothing in the reference matches. Try a view name, a key such as Alt, or a word such as receipt.
					</p>
				)
				: (
					<div className="help-reference__sections">
						{matches.map(({ section, entries }) => (
							<section
								key={section.id}
								className={`help-reference__section${section.reserved !== undefined ? " is-reserved" : ""}`}
								aria-labelledby={`help-${section.id}`}
							>
								<div className="help-reference__heading">
									<h3 id={`help-${section.id}`}>{section.title}</h3>
									<p>{section.lede}</p>
								</div>
								{section.reserved !== undefined && (
									<p className="help-reference__reserved">
										<span className="eyebrow">NOT IN THIS BUILD</span>
										{section.reserved}
									</p>
								)}
								{entries.length > 0 && (
									<dl className="help-reference__entries">
										{entries.map((entry) => (
											<div key={entry.term}>
												<dt>{section.id === "keyboard" ? <kbd>{entry.term}</kbd> : entry.term}</dt>
												<dd>{entry.meaning}</dd>
											</div>
										))}
									</dl>
								)}
							</section>
						))}
					</div>
				)}
		</div>
	);
}
