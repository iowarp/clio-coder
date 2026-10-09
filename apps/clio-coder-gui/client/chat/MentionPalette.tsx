/**
 * The list that opens over the composer for a typed `@` (this workspace's files and folders, and the
 * running agents a message can steer) and for the next word of a `/command` line. It shares the
 * slash palette's sheet and rows, and like it only renders; the textarea owns
 * every key.
 */

import { useEffect } from "react";
import { Icon, type IconName } from "../design/icons.js";
import "./slash-palette.css";

export interface SuggestionRow {
	readonly id: string;
	readonly label: string;
	/** Trails the row, muted: the folder a file sits in, or what a word means. */
	readonly summary: string;
	readonly icon?: IconName;
	/** A path summary keeps its end in view; prose keeps its start. */
	readonly path?: boolean;
}

export function suggestionOptionId(listId: string, index: number): string {
	return `${listId}-row-${index}`;
}

export function SuggestionPalette({
	listId,
	label,
	rows,
	activeIndex,
	keys,
	onActivate,
	onPick,
}: {
	listId: string;
	label: string;
	rows: readonly SuggestionRow[];
	activeIndex: number;
	/** What follows "move ·" in the key line, already worded for the active row. */
	keys: React.ReactNode;
	onActivate: (index: number) => void;
	onPick: (index: number) => void;
}) {
	useEffect(() => {
		document.getElementById(suggestionOptionId(listId, activeIndex))?.scrollIntoView({ block: "nearest" });
	}, [listId, activeIndex]);
	return (
		<div className="slash-palette">
			<div className="slash-palette__list" id={listId} role="listbox" aria-label={label} tabIndex={0}>
				{rows.map((row, index) => (
					// biome-ignore lint/a11y/useKeyWithClickEvents: the textarea owns every key.
					// biome-ignore lint/a11y/useFocusableInteractive: an activedescendant option must not be a tab stop.
					<div
						key={row.id}
						id={suggestionOptionId(listId, index)}
						className={`slash-palette__option suggestion-option${row.path ? " suggestion-option--path" : ""}`}
						role="option"
						aria-selected={index === activeIndex}
						data-active={index === activeIndex}
						// A pressed row would otherwise take focus from the textarea and lose the caret.
						onMouseDown={(event) => event.preventDefault()}
						onMouseMove={() => {
							if (index !== activeIndex) onActivate(index);
						}}
						onClick={() => onPick(index)}
					>
						<span className="slash-palette__name">
							{row.icon ? <Icon name={row.icon} /> : null}
							{row.label}
						</span>
						<span className="slash-palette__summary" title={row.summary}>
							{row.summary}
						</span>
					</div>
				))}
			</div>
			<p className="slash-palette__keys" aria-hidden="true">
				<kbd>↑</kbd>
				<kbd>↓</kbd> move · {keys}
			</p>
		</div>
	);
}
