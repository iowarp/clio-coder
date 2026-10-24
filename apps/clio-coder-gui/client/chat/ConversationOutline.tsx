import { useDeferredValue, useId, useMemo, useRef, useState } from "react";
import type { Turn } from "../../contracts/sessions.js";
import { formatTime } from "../api/clock.js";
import { Icon } from "../design/icons.js";
import { Dialog } from "../interaction/Dialog.js";
import {
	type ConversationEntry,
	conversationEntries,
	conversationExcerpt,
	findConversation,
} from "./conversation-outline-model.js";
import type { ChatTurn } from "./turns.js";
import "./conversation-outline.css";

/** Mounted only when opened: a streamed token never builds an index for a closed finder. */
export function ConversationOutline({
	turns,
	rows,
	truncated,
	onClose,
	onSelect,
}: {
	turns: readonly ChatTurn[];
	rows: ReadonlyMap<string, Turn>;
	truncated: boolean;
	onClose: () => void;
	onSelect: (turnId: string) => void;
}) {
	const [query, setQuery] = useState("");
	const deferredQuery = useDeferredValue(query);
	const field = useRef<HTMLInputElement>(null);
	const id = useId();
	const previous = useRef<readonly ConversationEntry[]>([]);
	const entries = useMemo(() => {
		const next = conversationEntries(turns, rows, previous.current);
		previous.current = next;
		return next;
	}, [turns, rows]);
	const found = useMemo(() => findConversation(entries, deferredQuery), [entries, deferredQuery]);
	return (
		<Dialog
			title="Find in conversation"
			eyebrow="Your research thread"
			size="wide"
			initialFocus={field}
			onClose={onClose}
		>
			<div className="conversation-finder">
				<label className="conversation-finder__search">
					<Icon name="search" />
					<span className="sr-only">Search requests and responses</span>
					<input
						ref={field}
						type="search"
						value={query}
						maxLength={256}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="Find a request, result or phrase…"
						aria-controls={id}
					/>
				</label>
				<p className="conversation-finder__scope" role="status">
					{found.total} {found.query ? "matching" : "loaded"} {found.total === 1 ? "exchange" : "exchanges"}
					{found.rows.length < found.total ? ` · first ${found.rows.length} shown; refine your search` : ""}.
					{truncated
						? " Searches retained requests and responses; older exchanges omitted by Clio are not included."
						: " Searches every request and response, including earlier turns."}
				</p>
				<ol
					className="conversation-finder__list"
					id={id}
					aria-label="Conversation exchanges"
					aria-busy={query !== deferredQuery}
				>
					{found.rows.map((entry) => (
						<li key={entry.id}>
							<button
								type="button"
								className="conversation-finder__entry"
								aria-label={`Jump to exchange ${entry.number}: ${entry.title}`}
								onClick={() => onSelect(entry.id)}
							>
								<span className="conversation-finder__number" aria-hidden="true">
									{String(entry.number).padStart(2, "0")}
								</span>
								<span className="conversation-finder__body">
									<strong>{entry.title}</strong>
									{found.query && entry.request.replace(/\s+/g, " ").toLocaleLowerCase().includes(found.query) ? (
										<span>Request: {conversationExcerpt(entry.request, found.query)}</span>
									) : entry.response ? (
										<span>{conversationExcerpt(entry.response, found.query)}</span>
									) : (
										<span>No response text recorded.</span>
									)}
									<small>
										{entry.status} · {formatTime(entry.startedAt)}
									</small>
								</span>
								<Icon name="arrowDown" />
							</button>
						</li>
					))}
				</ol>
				{found.total === 0 ? (
					<div className="conversation-finder__empty">
						<p>{query ? "No exchanges match that phrase." : "This conversation has no exchanges yet."}</p>
						{query ? (
							<button
								type="button"
								onClick={() => {
									setQuery("");
									field.current?.focus();
								}}
							>
								Clear search
							</button>
						) : null}
					</div>
				) : null}
			</div>
		</Dialog>
	);
}
