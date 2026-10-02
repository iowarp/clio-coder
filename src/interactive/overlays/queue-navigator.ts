/**
 * The queue navigator: the steering queue as a list the operator can work on.
 *
 * Enter during a run queues a message; this overlay is where a queued message
 * can still be reordered, moved to the other slot, pulled back into the
 * editor, removed, or sent now. It reads the live queue on every render, so a
 * message the engine takes mid-view simply leaves the list.
 */

import type { Component, OverlayHandle, TUI } from "../../engine/tui.js";
import { isKeyRelease, matchesKey, truncateToWidth } from "../../engine/tui.js";
import type { QueuedChatMessage } from "../chat-loop.js";
import { buildHint, fitRow, selectionLabel, selectionMark, showClioOverlayFrame } from "../overlay-frame.js";
import { clioTheme, GLYPH } from "../theme/index.js";

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

class QueueNavigatorBody implements Component {
	private selected = 0;

	constructor(private readonly deps: QueueNavigatorDeps) {}

	render(width: number): string[] {
		const theme = clioTheme();
		const safeWidth = Math.max(20, Math.floor(width));
		const entries = this.deps.entries();
		if (entries.length === 0) {
			return [fitRow(theme.fg("annotation", "nothing queued; Enter during a run queues a message"), safeWidth)];
		}
		this.selected = Math.min(this.selected, entries.length - 1);
		const now = (this.deps.now ?? Date.now)();
		const rows: string[] = [];
		for (const [index, entry] of entries.entries()) {
			const focused = index === this.selected;
			const slot = queueSlotWord(entry);
			const marks = queueEntryMarks(entry);
			const slotText = `${slot}${marks}`.padEnd(8);
			const slotPainted = slot === "steer" ? theme.fg("attention", slotText) : theme.fg("body", slotText);
			const age = theme.fg("annotation", formatQueueAge(now - entry.enqueuedAt).padStart(4));
			const head = `${selectionMark(focused)} ${String(index + 1).padStart(2)}  `;
			// 2 mark, 1 space, 2 index, 2 spaces, 8 slot, 1 space, 4 age, 2 spaces.
			const previewWidth = Math.max(8, safeWidth - 22);
			const preview = truncateToWidth(entry.text.replace(/\s+/g, " "), previewWidth, GLYPH.ellipsis, false);
			rows.push(
				fitRow(`${head}${slotPainted} ${selectionLabel(focused, preview.padEnd(previewWidth))}  ${age}`, safeWidth),
			);
		}
		const selected = entries[this.selected];
		if (selected) {
			rows.push("");
			rows.push(fitRow(theme.fg("sectionHeading", `Message ${this.selected + 1}`), safeWidth));
			for (const line of selected.text.split("\n").slice(0, 6)) rows.push(fitRow(theme.fg("body", line), safeWidth));
			if (selected.text.split("\n").length > 6) rows.push(fitRow(theme.fg("annotation", GLYPH.ellipsis), safeWidth));
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
