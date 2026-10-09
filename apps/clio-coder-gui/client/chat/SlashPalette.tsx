/**
 * The composer's slash palette and the dialog its session actions open in. Every decision lives in
 * `slash-model.ts`; the keyboard is owned by the composer's textarea, so the
 * list here only renders and answers the mouse.
 */

import { type RefObject, useEffect, useMemo, useRef } from "react";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import type { Client } from "../api/client.js";
import { Dialog } from "../interaction/Dialog.js";
import { FOCUSABLE_SELECTOR } from "../interaction/use-focus-trap.js";
import { AsidePanel } from "./AsidePanel.js";
import { BranchPanel } from "./BranchPanel.js";
import { ExtensionsPanel } from "./ExtensionsPanel.js";
import { FleetRunPanel } from "./FleetRunPanel.js";
import { HandoffPanel } from "./HandoffPanel.js";
import type { SlashAction, SlashEntry } from "./slash-model.js";
import "./slash-palette.css";

export function slashOptionId(listId: string, entry: SlashEntry): string {
	return `${listId}-${entry.id.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
}

export function SlashPalette({
	listId,
	entries,
	activeIndex,
	onActivate,
	onPick,
}: {
	listId: string;
	entries: readonly SlashEntry[];
	activeIndex: number;
	onActivate: (index: number) => void;
	onPick: (entry: SlashEntry) => void;
}) {
	const activeId = entries[activeIndex] ? slashOptionId(listId, entries[activeIndex]) : null;
	useEffect(() => {
		if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
	}, [activeId]);
	return (
		<div className="slash-palette">
			<div className="slash-palette__list" id={listId} role="listbox" aria-label="Slash commands" tabIndex={0}>
				{entries.map((entry, index) => {
					const heading = index === 0 || entries[index - 1]?.group !== entry.group ? entry.group : null;
					return (
						<div key={entry.id} role="presentation">
							{heading ? (
								<div className="slash-palette__group" role="presentation">
									{heading}
								</div>
							) : null}
							{/* The textarea keeps focus and owns every key; the row is an activedescendant option. */}
							{/* biome-ignore lint/a11y/useKeyWithClickEvents: the textarea owns every key. */}
							{/* biome-ignore lint/a11y/useFocusableInteractive: an activedescendant option must not be a tab stop. */}
							<div
								id={slashOptionId(listId, entry)}
								className="slash-palette__option"
								role="option"
								aria-selected={index === activeIndex}
								data-active={index === activeIndex}
								// A pressed row would otherwise take focus from the textarea and lose the caret.
								onMouseDown={(event) => event.preventDefault()}
								onMouseMove={() => {
									if (index !== activeIndex) onActivate(index);
								}}
								onClick={() => onPick(entry)}
							>
								<span className="slash-palette__name">
									/{entry.name}
									{entry.hint ? <span className="slash-palette__hint"> {entry.hint}</span> : null}
								</span>
								<span className="slash-palette__summary">
									{entry.kind === "action" ? `${entry.title}. ${entry.summary}` : entry.summary}
								</span>
							</div>
						</div>
					);
				})}
			</div>
			<p className="slash-palette__keys" aria-hidden="true">
				<kbd>↑</kbd>
				<kbd>↓</kbd> move · <kbd>Enter</kbd> or <kbd>Tab</kbd> pick · <kbd>Esc</kbd> close
			</p>
		</div>
	);
}

const DIALOG_COPY: Readonly<Record<SlashAction, { title: string; eyebrow: string }>> = {
	tree: { title: "Branches", eyebrow: "/tree" },
	fork: { title: "Fork the conversation", eyebrow: "/fork" },
	handoff: { title: "Hand off to a new conversation", eyebrow: "/handoff" },
	btw: { title: "Side question", eyebrow: "/btw" },
	draft: { title: "Drafts", eyebrow: "/draft" },
	extensions: { title: "Extensions", eyebrow: "/extensions" },
	"fleet-run": { title: "Run a playbook", eyebrow: "/fleet run" },
};

/**
 * One session action in a modal over the conversation, each panel in its dialog form. The focus trap returns focus to the composer
 * that opened it.
 */
export function SlashActionDialog({
	action,
	client,
	sessionId,
	sessionOpen,
	capabilities,
	running,
	settledTurns,
	onClose,
}: {
	action: SlashAction;
	client: Client;
	sessionId: string;
	sessionOpen: boolean;
	capabilities: AgentCapabilities | undefined;
	running: boolean;
	settledTurns: number;
	onClose: () => void;
}) {
	const body = useRef<HTMLDivElement>(null);
	// The dialog's trap reads this once, after the panel has committed: a panel marks its primary
	// control `data-autofocus`, and otherwise its first control takes focus instead of the close button.
	const landing = useMemo<RefObject<HTMLElement | null>>(
		() => ({
			get current() {
				const root = body.current;
				if (!root) return null;
				// /fork means a turn to fork from; a panel still reading has nothing to land on yet, and the
				// content itself is a better start than the close button.
				return (
					(action === "fork" ? root.querySelector<HTMLElement>("button[data-fork]:not(:disabled)") : null) ??
					root.querySelector<HTMLElement>("[data-autofocus]") ??
					root.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ??
					root
				);
			},
		}),
		[action],
	);
	const facts = { client, sessionId, sessionOpen, capabilities, running } as const;
	const copy = DIALOG_COPY[action];
	return (
		<Dialog title={copy.title} eyebrow={copy.eyebrow} onClose={onClose} size="wide" initialFocus={landing}>
			<div className="slash-dialog" ref={body} tabIndex={-1}>
				{action === "tree" || action === "fork" ? (
					<BranchPanel {...facts} settledTurns={settledTurns} />
				) : action === "handoff" ? (
					<HandoffPanel {...facts} />
				) : action === "btw" || action === "draft" ? (
					<AsidePanel {...facts} only={action === "btw" ? "question" : "draft"} />
				) : action === "extensions" ? (
					<ExtensionsPanel {...facts} />
				) : (
					<FleetRunPanel {...facts} variant="dialog" />
				)}
			</div>
		</Dialog>
	);
}
