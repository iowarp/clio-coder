/**
 * Ctrl+R over the composer: find an earlier message by what it said, the way a shell's reverse
 * search finds a command. It sits on the slash palette's sheet and owns its own field, so the
 * draft below is untouched until a match is taken. Enter or Tab takes it, Esc goes back.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { KEYBINDINGS, matchesKeybinding } from "../interaction/keybindings.js";
import { type HistoryMatch, historyExcerpt, searchHistory } from "./composer-history.js";
import "./slash-palette.css";

export function HistorySearch({
	entries,
	onAccept,
	onCancel,
}: {
	entries: readonly string[];
	onAccept: (match: HistoryMatch) => void;
	/** `refocus` is false when focus already went elsewhere, so closing must not pull it back. */
	onCancel: (refocus: boolean) => void;
}) {
	const [query, setQuery] = useState("");
	const [index, setIndex] = useState(0);
	const matches = useMemo(() => searchHistory(entries, query), [entries, query]);
	const active = Math.min(index, Math.max(0, matches.length - 1));
	const listId = useId();
	const input = useRef<HTMLInputElement>(null);
	const optionId = (row: number) => `${listId}-row-${row}`;
	useEffect(() => input.current?.focus(), []);
	useEffect(() => {
		document.getElementById(`${listId}-row-${active}`)?.scrollIntoView({ block: "nearest" });
	}, [listId, active]);
	const move = (step: number) => setIndex(Math.max(0, Math.min(matches.length - 1, active + step)));
	return (
		<div className="slash-palette history-search">
			<div className="history-search__field">
				<label className="history-search__label" htmlFor={`${listId}-query`}>
					Sent
				</label>
				<input
					ref={input}
					id={`${listId}-query`}
					className="history-search__input"
					type="text"
					role="combobox"
					aria-expanded={matches.length > 0}
					aria-controls={listId}
					aria-autocomplete="list"
					{...(matches[active] ? { "aria-activedescendant": optionId(active) } : {})}
					autoComplete="off"
					spellCheck={false}
					placeholder={entries.length > 0 ? "Type to find an earlier message" : "Nothing sent from this browser yet"}
					value={query}
					onChange={(event) => {
						setQuery(event.target.value);
						setIndex(0);
					}}
					onBlur={() => onCancel(false)}
					onKeyDown={(event) => {
						if (event.nativeEvent.isComposing) return;
						const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
						// Ctrl+R again steps to the next older match, as it does in a shell.
						if ((event.key === "ArrowDown" && plain) || matchesKeybinding(KEYBINDINGS.historySearch, event)) {
							event.preventDefault();
							move(1);
							return;
						}
						if (event.key === "ArrowUp" && plain) {
							event.preventDefault();
							move(-1);
							return;
						}
						if ((event.key === "Enter" || event.key === "Tab") && plain) {
							event.preventDefault();
							const match = matches[active];
							if (match) onAccept(match);
							else onCancel(true);
							return;
						}
						if (event.key === "Escape") {
							// The innermost layer: nothing behind it should also close or stop the turn.
							event.preventDefault();
							event.stopPropagation();
							onCancel(true);
						}
					}}
				/>
			</div>
			{matches.length > 0 ? (
				<div className="slash-palette__list" id={listId} role="listbox" aria-label="Sent messages">
					{matches.map((match, row) => {
						const excerpt = historyExcerpt(match);
						return (
							// biome-ignore lint/a11y/useKeyWithClickEvents: the search field owns every key.
							// biome-ignore lint/a11y/useFocusableInteractive: an activedescendant option must not be a tab stop.
							<div
								key={match.index}
								id={optionId(row)}
								className="slash-palette__option history-search__option"
								role="option"
								aria-selected={row === active}
								data-active={row === active}
								// Keeps focus, and so the open search, in the field.
								onMouseDown={(event) => event.preventDefault()}
								onMouseMove={() => {
									if (row !== active) setIndex(row);
								}}
								onClick={() => onAccept(match)}
							>
								<span className="history-search__text">
									{excerpt.before}
									{excerpt.hit ? <mark>{excerpt.hit}</mark> : null}
									{excerpt.after}
								</span>
								{excerpt.hiddenLines > 0 ? (
									<span className="slash-palette__summary">
										+{excerpt.hiddenLines} line{excerpt.hiddenLines === 1 ? "" : "s"}
									</span>
								) : null}
							</div>
						);
					})}
				</div>
			) : query.trim() !== "" ? (
				<p className="history-search__empty" role="status">
					No sent message contains “{query.trim()}”.
				</p>
			) : null}
			<p className="slash-palette__keys" aria-hidden="true">
				<kbd>↑</kbd>
				<kbd>↓</kbd> move · <kbd>Ctrl</kbd>+<kbd>R</kbd> older · <kbd>Enter</kbd> use · <kbd>Esc</kbd> back
			</p>
		</div>
	);
}
