// The command palette. It is data-free: the shell composes the command list from navigation, the
// open session and the app actions, and hands it in. Focus never leaves the input; the arrow keys
// move `aria-activedescendant` only.

import { Fragment, useId, useMemo, useRef, useState } from "react";
import { Dialog } from "./Dialog.js";
import { formatKeybinding, KEYBINDINGS, type KeybindingId } from "./keybindings.js";
import { prefixScore } from "./prefix-score.js";
import { useListNavigation } from "./use-list-navigation.js";
import "./interaction.css";

export interface Command {
	readonly id: string;
	readonly title: string;
	/** Short noun for the group heading: "Go to", "Session", "Run". */
	readonly group: string;
	/** Extra words the matcher searches but does not print. */
	readonly keywords?: readonly string[];
	/** A declared keybinding id, printed as a trailing chord. */
	readonly binding?: KeybindingId;
	/** False hides the row entirely; a command that cannot run is never shown greyed. */
	readonly available: boolean;
	run(): void;
}

/**
 * Prefix-by-word rather than the reference's substring rule, because a palette must feel like a
 * launcher. Ties break on the order the caller composed, then alphabetically, so the ranking is
 * stable between keystrokes.
 */
export function rankCommands(commands: readonly Command[], query: string): Command[] {
	const needle = query.trim();
	return commands
		.filter((command) => command.available)
		.map((command, index) => ({
			command,
			index,
			score: prefixScore([command.title, command.group, ...(command.keywords ?? [])], needle),
		}))
		.filter((scored) => scored.score > 0)
		.sort(
			(left, right) =>
				right.score - left.score ||
				left.index - right.index ||
				left.command.title.localeCompare(right.command.title, "en-US"),
		)
		.map((scored) => scored.command);
}

export function CommandPalette({
	open,
	commands,
	onClose,
}: {
	open: boolean;
	commands: readonly Command[];
	onClose: () => void;
}) {
	if (!open) return null;
	return <PaletteBody commands={commands} onClose={onClose} />;
}

function PaletteBody({ commands, onClose }: { commands: readonly Command[]; onClose: () => void }) {
	// The query starts empty on every open because the palette mounts fresh, which is deliberate: a
	// stale filter is the most common way a launcher runs the wrong thing.
	const [query, setQuery] = useState("");
	const input = useRef<HTMLInputElement>(null);
	const listId = useId();
	const results = useMemo(() => rankCommands(commands, query), [commands, query]);
	const run = (command: Command) => {
		onClose();
		command.run();
	};
	const { activeIndex, setActiveIndex, activeId, onKeyDown, itemProps } = useListNavigation({
		items: results,
		getId: (command) => `${listId}-${command.id}`,
		label: "Commands",
		mode: "activedescendant",
		vimKeys: false,
		wrap: true,
		onChoose: run,
	});
	const total = commands.filter((command) => command.available).length;
	const rows = results.map((command, index) => ({
		command,
		index,
		heading: index === 0 || results[index - 1]?.group !== command.group ? command.group : null,
	}));
	return (
		<Dialog title="Run a command" eyebrow="COMMAND PALETTE" onClose={onClose} initialFocus={input}>
			<div className="palette">
				<div className="filter__field">
					<span aria-hidden="true">⌕</span>
					<input
						ref={input}
						type="text"
						role="combobox"
						aria-expanded="true"
						aria-controls={listId}
						aria-autocomplete="list"
						aria-activedescendant={activeId}
						aria-label="Run a command"
						placeholder="A view, a session, or an action"
						autoComplete="off"
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							setActiveIndex(0);
						}}
						onKeyDown={onKeyDown}
					/>
				</div>
				<small role="status">{query.trim().length === 0 ? "" : `${results.length} of ${total} commands`}</small>
				{results.length === 0 ? (
					<p className="palette__empty">No command matches. Type a view name such as traces, or an action such as cancel.</p>
				) : (
					<div className="palette__list" id={listId} role="listbox" aria-label="Commands">
						{rows.map(({ command, index, heading }) => (
							<Fragment key={command.id}>
								{heading === null ? null : (
									<div className="palette__group" role="presentation">
										{heading}
									</div>
								)}
								{/* The row is the option: focus stays in the input, so a nested button would add a
								    tab stop the combobox pattern forbids. Enter on the input runs it. */}
								{/* biome-ignore lint/a11y/useKeyWithClickEvents: the combobox input owns every key. */}
								{/* biome-ignore lint/a11y/useFocusableInteractive: an activedescendant option must not be a tab stop. */}
								<div
									className="palette__option"
									role="option"
									aria-label={`${command.group}: ${command.title}`}
									onMouseMove={() => setActiveIndex(index)}
									onClick={() => run(command)}
									{...itemProps(index)}
									data-active={index === activeIndex}
								>
									<span>{command.title}</span>
									{command.binding ? <kbd>{formatKeybinding(KEYBINDINGS[command.binding])}</kbd> : null}
								</div>
							</Fragment>
						))}
					</div>
				)}
			</div>
		</Dialog>
	);
}
