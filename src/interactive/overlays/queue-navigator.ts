/**
 * The queue navigator: the steering queue as a list the operator can work on.
 *
 * Enter during a run queues a message; this overlay is where a queued message
 * can still be reordered, moved to the other slot, pulled back into the
 * editor, removed, or sent now. It reads the live queue on every render, so a
 * message the engine takes mid-view simply leaves the list.
 */

import type { Component, OverlayHandle, TUI } from "../../engine/tui.js";
import { isKeyRelease, matchesKey, wrapTextWithAnsi } from "../../engine/tui.js";
import type { QueuedChatMessage } from "../../session-control/chat-loop.js";
import { buildHint, centeredWindow, type RowBudgetedBody, showClioOverlayFrame } from "../overlay-frame.js";
import { chip, chipRow, clioTheme, emptyState, GLYPH, positionRow, sectionRule, selectionRow } from "../theme/index.js";

export const QUEUE_NAVIGATOR_OVERLAY_WIDTH = 88;

export interface QueueNavigatorDeps {
	entries(): ReadonlyArray<QueuedChatMessage>;
	remove(id: string): void;
	move(id: string, delta: -1 | 1): boolean;
	/** Flip one entry between the next slot and the end of the turn. */
	toggleKind(entry: QueuedChatMessage): void;
	/** Take the entry out of the queue and put its text in the editor. */
	toEditor(entry: QueuedChatMessage): void;
	/** Take the entry out of the queue and deliver it now; the rest stay queued. */
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
class QueueNavigatorBody implements Component, RowBudgetedBody {
	private selected = 0;
	private rows = 0;

	constructor(private readonly deps: QueueNavigatorDeps) {}

	setBodyRows(rows: number): void {
		this.rows = Math.max(0, Math.floor(rows));
	}

	render(width: number): string[] {
		const theme = clioTheme();
		const safeWidth = Math.max(20, Math.floor(width));
		const entries = this.deps.entries();
		if (entries.length === 0) {
			return emptyState(theme, "Nothing queued.", safeWidth, { remedy: "Enter during a run queues a message" });
		}
		this.selected = Math.min(this.selected, entries.length - 1);
		const now = (this.deps.now ?? Date.now)();
		const slotChip = (entry: QueuedChatMessage): string => {
			const slot = queueSlotWord(entry);
			return chip(theme, `${slot}${queueEntryMarks(entry)}`, slot === "steer" ? "action" : "neutral");
		};
		const listBudget = this.rows > 0 ? Math.max(QUEUE_MIN_LIST_ROWS, this.rows - QUEUE_DETAIL_ROWS) : entries.length;
		const visible = Math.min(entries.length, listBudget);
		const windowed = visible < entries.length;
		const [start, end] = centeredWindow(entries.length, this.selected, windowed ? Math.max(1, visible - 1) : visible);
		const rows: string[] = [];
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
			const detailBudget = this.rows > 0 ? Math.max(2, this.rows - rows.length) : QUEUE_DETAIL_ROWS;
			const slot = queueSlotWord(selected);
			rows.push(
				sectionRule(theme, safeWidth, `Message ${this.selected + 1}`, {
					meta: `${slot === "steer" ? "next slot" : "end of turn"} · waiting ${formatQueueAge(now - selected.enqueuedAt)}`,
				}),
			);
			const text = selected.text.split("\n").flatMap((line) => wrapTextWithAnsi(theme.fg("body", line), safeWidth));
			const kept = text.slice(0, Math.max(1, detailBudget - 1));
			const last = kept.at(-1);
			rows.push(
				...(text.length > kept.length && last !== undefined ? [...kept.slice(0, -1), `${last}${GLYPH.ellipsis}`] : kept),
			);
		}
		return rows;
	}

	footerHint(): string {
		if (this.deps.entries().length === 0) return buildHint([]);
		return buildHint([
			{ key: "↑↓", verb: "select" },
			{ key: "⇧↑↓", verb: "move" },
			{ key: "e", verb: "to editor" },
			{ key: "x", verb: "remove" },
			{ key: "t", verb: "slot" },
			{ key: "Enter", verb: "send now" },
			{ key: this.deps.restoreAllLabel(), verb: "all to editor" },
		]);
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (matchesKey(data, "escape")) {
			this.deps.onClose();
			return;
		}
		if (this.deps.matchesRestoreAll(data)) {
			this.deps.restoreAll();
			this.deps.onClose();
			return;
		}
		const entries = this.deps.entries();
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
			this.deps.remove(entry.id);
		} else if (matchesKey(data, "t")) {
			this.deps.toggleKind(entry);
		} else if (matchesKey(data, "e")) {
			this.deps.toEditor(entry);
			this.deps.onClose();
			return;
		} else if (matchesKey(data, "enter")) {
			this.deps.sendNow(entry);
			this.deps.onClose();
			return;
		} else {
			return;
		}
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
		title: () => `Steering Queue (${deps.entries().length})`,
		footerHint: () => body.footerHint(),
	});
}
