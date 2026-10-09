/**
 * The `@` file list and message recall for a plain message field, the new-task box. The conversation
 * composer wires the same models itself because its list also carries commands and running agents;
 * a field that only starts a task needs just these two, and gets them from one hook.
 */

import { useQuery } from "@tanstack/react-query";
import { type KeyboardEvent, type ReactNode, type RefObject, useId, useRef, useState } from "react";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { type HistoryBrowse, readHistory, stepHistory } from "./composer-history.js";
import { SuggestionPalette, suggestionOptionId } from "./MentionPalette.js";
import { applyMention, mentionQuery } from "./mention-model.js";

export interface FieldAssist {
	/** The list to render inside the field's box, or null while it is closed. */
	readonly palette: ReactNode;
	/** Spread onto the textarea beside its own props. */
	readonly fieldProps: {
		readonly "aria-autocomplete": "list";
		readonly "aria-controls"?: string;
		readonly "aria-activedescendant"?: string;
		readonly onSelect: (event: { currentTarget: HTMLTextAreaElement }) => void;
	};
	/** Call from `onChange` with the field. */
	readonly changed: (element: HTMLTextAreaElement) => void;
	/** Call first from `onKeyDown`; true means the key was taken. */
	readonly keyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

export function useFieldAssist({
	client,
	workspaceId,
	text,
	setText,
	field,
}: {
	client: Client;
	workspaceId: string | null;
	text: string;
	setText: (text: string) => void;
	field: RefObject<HTMLTextAreaElement | null>;
}): FieldAssist {
	const listId = useId();
	const [caret, setCaret] = useState(0);
	const [index, setIndex] = useState(0);
	const [dismissed, setDismissed] = useState<string | null>(null);
	const browse = useRef<(HistoryBrowse & { readonly text: string }) | null>(null);
	const mention = workspaceId !== null && text.includes("@") ? mentionQuery(text, caret) : null;
	const key = mention === null ? null : `${mention.start}:${mention.path}`;
	const files = useQuery({
		queryKey: ["workspace-files", workspaceId, mention?.path ?? ""],
		queryFn: () =>
			client.call(routes.workspaceFiles, {
				params: { id: workspaceId ?? "" },
				query: { input: mention?.path ?? "" },
				body: {},
			}),
		enabled: mention !== null,
		staleTime: 4_000,
		retry: false,
		placeholderData: (previous) => previous,
	});
	const matches = mention === null ? [] : (files.data?.matches ?? []);
	const open = matches.length > 0 && dismissed !== key;
	const active = Math.min(index, Math.max(0, matches.length - 1));
	const place = (at: number | null) =>
		requestAnimationFrame(() => {
			const element = field.current;
			if (!element) return;
			element.focus();
			const position = at ?? element.value.length;
			element.setSelectionRange(position, position);
			setCaret(position);
		});
	const pick = (at: number) => {
		const match = matches[at];
		if (!match || mention === null) return;
		const edit = applyMention(text, caret, mention, match.path, match.directory);
		setIndex(0);
		setText(edit.text);
		place(edit.caret);
	};
	return {
		palette: open ? (
			<SuggestionPalette
				listId={listId}
				label="Files in this workspace"
				rows={matches.map((match) => ({
					id: match.path,
					label: `${match.name}${match.directory ? "/" : ""}`,
					summary: match.path.slice(0, match.path.length - match.name.length - (match.directory ? 1 : 0)),
					icon: match.directory ? ("folder" as const) : ("artifacts" as const),
					path: true,
				}))}
				activeIndex={active}
				onActivate={setIndex}
				onPick={pick}
				keys={
					<>
						<kbd>Enter</kbd> or <kbd>Tab</kbd> {matches[active]?.directory ? "open" : "add"} · <kbd>Esc</kbd> close
						{files.data?.truncated ? " · keep typing to narrow" : ""}
					</>
				}
			/>
		) : null,
		fieldProps: {
			"aria-autocomplete": "list",
			...(open ? { "aria-controls": listId, "aria-activedescendant": suggestionOptionId(listId, active) } : {}),
			onSelect: (event) => setCaret(event.currentTarget.selectionStart),
		},
		changed: (element) => {
			setCaret(element.selectionStart);
			setIndex(0);
			setDismissed(null);
			browse.current = null;
		},
		keyDown: (event) => {
			if (event.nativeEvent.isComposing) return false;
			const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
			if (open) {
				if (event.key === "ArrowDown" || event.key === "ArrowUp") {
					event.preventDefault();
					setIndex((active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
					return true;
				}
				if ((event.key === "Enter" || event.key === "Tab") && plain) {
					event.preventDefault();
					pick(active);
					return true;
				}
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					setDismissed(key);
					return true;
				}
			}
			if ((event.key === "ArrowUp" || event.key === "ArrowDown") && plain) {
				const element = event.currentTarget;
				const browsing = browse.current !== null && browse.current.text === text ? browse.current : null;
				const offered =
					event.key === "ArrowUp"
						? browsing !== null || (element.selectionStart === 0 && element.selectionEnd === 0)
						: browsing !== null;
				const step = offered
					? stepHistory(readHistory(), browsing, event.key === "ArrowUp" ? "older" : "newer", text)
					: null;
				if (step !== null) {
					event.preventDefault();
					setText(step.text);
					browse.current = step.browse === null ? null : { ...step.browse, text: step.text };
					place(null);
					return true;
				}
			}
			return false;
		},
	};
}
