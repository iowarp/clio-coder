/**
 * The queue navigator: the steering queue as a list the operator can work on.
 *
 * Enter during a run queues a message; this overlay is where a queued message
 * can still be reordered, moved to the other slot, pulled back into the
 * editor, removed, or sent now. It reads the live queue on every render, so a
 * message the engine takes mid-view simply leaves the list.
 */

import type { Component, OverlayHandle, TUI } from "../../engine/tui.js";
import { isKeyRelease, matchesKey, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import type { QueuedChatMessage } from "../../session-control/chat-loop.js";
import {
	centeredWindow,
	fitHintEntries,
	fitHintEntryList,
	type HintEntry,
	type RailAwareBody,
	type RowBudgetedBody,
	showClioOverlayFrame,
} from "../overlay-frame.js";
import {
	chip,
	chipRow,
	chipRows,
	clioTheme,
	emptyState,
	GLYPH,
	keyCap,
	positionRow,
	sectionRule,
	selectionRow,
} from "../theme/index.js";

export const QUEUE_NAVIGATOR_OVERLAY_WIDTH = 88;

export interface QueueNavigatorDeps {
	entries(): ReadonlyArray<QueuedChatMessage>;
	/** No run is going to take the queue, so no slot is coming for it (#447). */
	isHeld?(): boolean;
	/** A run is live, so sending now has to stop it first. */
	isRunning?(): boolean;
	/** Why a run refuses to be interrupted right now; the entry then goes to the head of the next slot. */
	interruptRefusal?(): string | null;
	remove(id: string): void;
	move(id: string, delta: -1 | 1): boolean;
	/** Flip one entry between the next slot and the end of the turn. */
	toggleKind(entry: QueuedChatMessage): void;
	/** Take the entry out of the queue and put its text in the editor. */
	toEditor(entry: QueuedChatMessage): void;
	/** Take the entry out of the queue and deliver it as a fresh prompt, or at the next slot if the run refuses; the rest stay queued. */
	sendNow(entry: QueuedChatMessage): void;
	/** Everything back to the editor, the Alt+Q behaviour. */
	restoreAll(): void;
	/** The restore-all key as the live binding manager spells it. */
	restoreAllLabel(): string;
	matchesRestoreAll(data: string): boolean;
	onClose(): void;
	requestRender(): void;
	now?: () => number;
}

/** `12s`, `4m`, `2h`: how long an entry has been waiting. */
export function formatQueueAge(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h`;
}

/** The slot word a row shows for an entry: `steer` lands at the next slot, `later` at the end of the turn. */
export function queueSlotWord(entry: Pick<QueuedChatMessage, "kind">): "steer" | "later" {
	return entry.kind === "steer" ? "steer" : "later";
}

/**
 * Advisory marks after the slot word: `!` when a producer read the entry as
 * urgent, `·t` when triage relabeled it. Pure, so the panel shares it.
 */
export function queueEntryMarks(entry: Pick<QueuedChatMessage, "labels" | "pinned">): string {
	let marks = "";
	if (entry.labels?.urgency === "now") marks += "!";
	if (entry.labels?.producer === "triage" && entry.pinned !== true) marks += "·t";
	return marks;
}

/** Rows the message under the cursor may take beneath the list: its rule and six lines of text. */
const QUEUE_DETAIL_ROWS = 7;
const QUEUE_MIN_LIST_ROWS = 3;

/**
 * The queue as selection rows: the position and the first line of the
 * message, with the slot and the wait at the right. The slot reads in the
 * attention tone when it lands at the next slot, because that is the one
 * that interrupts. The message under the cursor is written out under a rule,
 * and the list windows itself so both fit the dock.
 */
class QueueNavigatorBody implements Component, RowBudgetedBody, RailAwareBody {
	private selected = 0;
	/**
	 * The entry the cursor is on, by id. The queue drains under the view whenever
	 * the run reaches a slot, and an index alone then pointed at the next message,
	 * so an `x` meant for a message Clio had just taken removed the one after it.
	 */
	private selectedId: string | null = null;
	/** The message the cursor was on went to Clio; the next acting key only re-aims. */
	private taken: { position: number } | null = null;
	/** Entries the operator removed here, which leave the queue on purpose rather than to Clio. */
	private readonly removed = new Set<string>();
	private rows = 0;
	private railRoom = 0;

	constructor(private readonly deps: QueueNavigatorDeps) {}

	setBodyRows(rows: number): void {
		this.rows = Math.max(0, Math.floor(rows));
	}

	setRailRoom(cells: number): void {
		this.railRoom = Math.max(0, Math.floor(cells));
	}

	/** Re-find the cursor's entry in the live queue, and notice when Clio took it. */
	private sync(entries: ReadonlyArray<QueuedChatMessage>): void {
		if (this.selectedId !== null) {
			const at = entries.findIndex((entry) => entry.id === this.selectedId);
			if (at >= 0) this.selected = at;
			else if (this.removed.has(this.selectedId)) this.aimAt(entries);
			else if (this.taken === null) this.taken = { position: this.selected + 1 };
		}
		this.selected = Math.max(0, Math.min(this.selected, entries.length - 1));
		if (this.taken === null) this.selectedId = entries[this.selected]?.id ?? null;
		if (entries.length > 0) this.lastSeen = entries.map((entry) => entry.id);
	}

	/** The ids on screen before the queue emptied, so the empty view can say who emptied it. */
	private lastSeen: string[] = [];

	/** Point at the entry under the index again, after a key or a drained selection. */
	private aimAt(entries: ReadonlyArray<QueuedChatMessage>): void {
		this.taken = null;
		this.selected = Math.max(0, Math.min(this.selected, entries.length - 1));
		this.selectedId = entries[this.selected]?.id ?? null;
	}

	render(width: number): string[] {
		const theme = clioTheme();
		const safeWidth = Math.max(20, Math.floor(width));
		const entries = this.deps.entries();
		this.sync(entries);
		if (entries.length === 0) {
			// The view stays open when the run drains the queue under it, so a key
			// meant for a message lands here, where it does nothing, rather than in
			// the composer behind a view that vanished.
			const removedLast = this.lastSeen.length > 0 && this.lastSeen.every((id) => this.removed.has(id));
			return emptyState(
				theme,
				removedLast ? "You removed the last queued message." : "Clio took the rest of the queue at its slot.",
				safeWidth,
				{ remedy: "Nothing is queued now. Esc closes this view; Enter during a run queues another message." },
			);
		}
		const now = (this.deps.now ?? Date.now)();
		const slotChip = (entry: QueuedChatMessage): string => {
			const slot = queueSlotWord(entry);
			return chip(theme, `${slot}${queueEntryMarks(entry)}`, slot === "steer" ? "action" : "neutral");
		};
		// The verbs the rail cannot carry at this width, so reorder and restore stay findable at 60 columns.
		const keyRows = chipRows(
			theme,
			this.droppedKeys().map((entry) => `${keyCap(theme, entry.key)} ${theme.fg("menuDescription", entry.verb)}`),
			safeWidth,
		);
		const takenRows =
			this.taken === null
				? []
				: wrapTextWithAnsi(
						theme.fg(
							"warning",
							`${GLYPH.warn} Message ${this.taken.position} went to Clio at its slot while you were on it. The next key only selects; press it again to act.`,
						),
						safeWidth,
					);
		const bodyRows = this.rows > 0 ? Math.max(1, this.rows - keyRows.length - takenRows.length) : 0;
		const listBudget = bodyRows > 0 ? Math.max(QUEUE_MIN_LIST_ROWS, bodyRows - QUEUE_DETAIL_ROWS) : entries.length;
		const visible = Math.min(entries.length, listBudget);
		const windowed = visible < entries.length;
		const [start, end] = centeredWindow(entries.length, this.selected, windowed ? Math.max(1, visible - 1) : visible);
		const rows: string[] = [...takenRows];
		for (let index = start; index < end; index += 1) {
			const entry = entries[index];
			if (!entry) continue;
			rows.push(
				...selectionRow(theme, {
					focused: index === this.selected,
					label: `${String(index + 1).padStart(2)}  ${entry.text.replace(/\s+/g, " ")}`,
					meta: chipRow(theme, [slotChip(entry), chip(theme, formatQueueAge(now - entry.enqueuedAt), "muted")], safeWidth),
					width: safeWidth,
				}),
			);
		}
		if (windowed)
			rows.push(positionRow(theme, { start: start + 1, end, total: entries.length, unit: "messages" }, safeWidth));
		const selected = entries[this.selected];
		if (selected) {
			const detailBudget = bodyRows > 0 ? Math.max(2, bodyRows + takenRows.length - rows.length) : QUEUE_DETAIL_ROWS;
			const slot = queueSlotWord(selected);
			// The row's own word leads, so `later` in the list and the slot it means read as one thing.
			const slotSentence =
				this.deps.isHeld?.() === true
					? "held"
					: slot === "steer"
						? "steer, Clio reads it at its next step"
						: "later, Clio reads it when the turn ends";
			const waiting = `waiting ${formatQueueAge(now - selected.enqueuedAt)}`;
			const label = `Message ${this.selected + 1}`;
			// A narrow rule cut the sentence mid-clause with no mark; it then takes its own wrapped row under the rule.
			const inline = visibleWidth(label) + visibleWidth(slotSentence) + visibleWidth(waiting) + 12 <= safeWidth;
			rows.push(sectionRule(theme, safeWidth, label, { meta: inline ? `${slotSentence} · ${waiting}` : waiting }));
			const slotRows = inline ? [] : wrapTextWithAnsi(theme.fg("annotation", slotSentence), safeWidth);
			rows.push(...slotRows);
			const notice = this.sendNotice(selected).flatMap((line) =>
				wrapTextWithAnsi(theme.fg("annotation", line), safeWidth),
			);
			rows.push(...notice);
			const text = selected.text.split("\n").flatMap((line) => wrapTextWithAnsi(theme.fg("body", line), safeWidth));
			const kept = text.slice(0, Math.max(1, detailBudget - 1 - slotRows.length - notice.length));
			const last = kept.at(-1);
			rows.push(
				...(text.length > kept.length && last !== undefined ? [...kept.slice(0, -1), `${last}${GLYPH.ellipsis}`] : kept),
			);
		}
		rows.push(...keyRows);
		return rows;
	}

	/** What Enter does to this entry, as the rail says it: only held entries send without a cost. */
	private sendEntry(entry: QueuedChatMessage | undefined): HintEntry | null {
		if (entry === undefined || entry.origin !== undefined) return null;
		if (this.deps.interruptRefusal?.() != null) return { key: "Enter", verb: "send at next slot", short: "next slot" };
		if (this.deps.isRunning?.() === true) return { key: "Enter", verb: "stop run and send", short: "send now" };
		return { key: "Enter", verb: "send now" };
	}

	/** Lines above the message when Enter cannot do what the verb usually means. */
	private sendNotice(entry: QueuedChatMessage): string[] {
		if (entry.origin !== undefined) return ["A peer queued this, so it cannot be sent as yours or moved to the editor."];
		const refusal = this.deps.interruptRefusal?.() ?? null;
		return refusal === null ? [] : [`The run cannot be stopped: ${refusal}.`];
	}

	/**
	 * Send now leads because it is the verb that costs something; a narrowing rail
	 * drops from the left of the rest, so the arrows go first and the per-message
	 * verbs last. A drained queue offers only the way out, and a selection Clio
	 * took offers re-aiming, because no other key acts until the cursor is placed.
	 */
	private railEntries(): HintEntry[] {
		const entries = this.deps.entries();
		const esc: HintEntry = { key: "Esc", verb: "close" };
		if (entries.length === 0) return [esc];
		if (this.taken !== null) return [{ key: "any key", verb: "select again", critical: true }, esc];
		const selected = entries[this.selected];
		const send = this.sendEntry(selected);
		return [
			...(send ? [send] : []),
			{ key: "↑↓", verb: "select" },
			{ key: this.deps.restoreAllLabel().split(" · ")[0] ?? "", verb: "all to editor" },
			{ key: "Shift+↑↓", verb: "move" },
			{ key: "t", verb: "steer/later" },
			{ key: "x", verb: "remove" },
			...(selected?.origin === undefined ? [{ key: "e", verb: "to editor" }] : []),
			esc,
		];
	}

	/** The keys the rail drops at this room, fitted by the same call the rail makes, so the two never disagree. */
	private droppedKeys(): HintEntry[] {
		if (this.railRoom <= 0) return [];
		const all = this.railEntries();
		const { kept } = fitHintEntryList(all, this.railRoom);
		return all.filter((entry) => !kept.includes(entry) && entry.key !== "↑↓");
	}

	footerHint(innerWidth: number): string {
		return fitHintEntries(this.railEntries(), innerWidth - 3);
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (matchesKey(data, "escape")) {
			this.deps.onClose();
			return;
		}
		const entries = this.deps.entries();
		this.sync(entries);
		if (entries.length === 0) return;
		if (this.taken !== null) {
			// The cursor's message is gone; whatever the key meant, it meant for that message.
			this.aimAt(entries);
			this.deps.requestRender();
			return;
		}
		if (this.deps.matchesRestoreAll(data)) {
			this.deps.restoreAll();
			this.deps.onClose();
			return;
		}
		const entry = entries[this.selected];
		if (!entry) return;
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.selected = Math.max(0, this.selected - 1);
		} else if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.selected = Math.min(entries.length - 1, this.selected + 1);
		} else if (matchesKey(data, "shift+up")) {
			if (this.deps.move(entry.id, -1)) this.selected -= 1;
		} else if (matchesKey(data, "shift+down")) {
			if (this.deps.move(entry.id, 1)) this.selected += 1;
		} else if (matchesKey(data, "x")) {
			this.removed.add(entry.id);
			this.deps.remove(entry.id);
		} else if (matchesKey(data, "t")) {
			this.deps.toggleKind(entry);
		} else if (matchesKey(data, "e")) {
			if (entry.origin !== undefined) return;
			this.deps.toEditor(entry);
			this.deps.onClose();
			return;
		} else if (matchesKey(data, "enter")) {
			if (entry.origin !== undefined) return;
			this.deps.sendNow(entry);
			this.deps.onClose();
			return;
		} else {
			return;
		}
		// A removed entry leaves the cursor where it stood, on the message that moved up into its place.
		const after = this.deps.entries().filter((queued) => !this.removed.has(queued.id));
		this.aimAt(after);
		this.deps.requestRender();
	}

	invalidate(): void {}
}

export function openQueueNavigatorOverlay(tui: TUI, deps: QueueNavigatorDeps): OverlayHandle {
	const body = new QueueNavigatorBody(deps);
	return showClioOverlayFrame(tui, body, {
		anchor: "center",
		width: QUEUE_NAVIGATOR_OVERLAY_WIDTH,
		markerId: "queue-navigator",
		title: () => {
			const count = deps.entries().length;
			return `Steering Queue (${count})${count > 0 && deps.isHeld?.() === true ? " · held, nothing sent" : ""}`;
		},
		footerHint: (innerWidth) => body.footerHint(innerWidth),
	});
}
