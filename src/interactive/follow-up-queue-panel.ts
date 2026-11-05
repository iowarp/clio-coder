import type { Component } from "../engine/tui.js";
import { truncateToWidth, visibleWidth } from "../engine/tui.js";
import type { QueuedChatMessage } from "../session-control/chat-loop.js";
import { formatQueueAge, queueEntryMarks, queueSlotWord } from "./overlays/queue-navigator.js";
import { clioTheme, frame, GLYPH } from "./theme/index.js";
import { skinEpoch } from "./theme/tokens.js";

export interface FollowUpQueuePanel extends Component {
	setMessages(messages: ReadonlyArray<QueuedChatMessage>): void;
}

export interface FollowUpQueuePanelOptions {
	/** Action labels already formatted from the live binding manager. */
	getDequeueKey?: () => string | undefined;
	getNavigateKey?: () => string | undefined;
	getSendNowKey?: () => string | undefined;
	/** The overlay holding the keyboard, `closed` when the composer has it. */
	getOverlayState?: () => string;
	/** No run is going to take the queue, so it waits for the operator (#447). */
	isHeld?: () => boolean;
	now?: () => number;
}

export function createFollowUpQueuePanel(options: FollowUpQueuePanelOptions = {}): FollowUpQueuePanel {
	let messages: QueuedChatMessage[] = [];
	let dirty = true;
	let cachedWidth = 0;
	let cachedKey: string | undefined;
	let cachedLines: string[] = [];

	const render = (width: number): string[] => {
		const overlay = options.getOverlayState?.() ?? "closed";
		const now = (options.now ?? Date.now)();
		const held = options.isHeld?.() === true;
		// The waits are part of the key: a cache over the last queue change froze them at the age they had then.
		const key = [
			skinEpoch(),
			overlay,
			held,
			options.getDequeueKey?.(),
			options.getNavigateKey?.(),
			options.getSendNowKey?.(),
			...messages.map((message) => formatQueueAge(now - message.enqueuedAt)),
		].join("|");
		if (!dirty && cachedWidth === width && cachedKey === key) return cachedLines;
		// The navigator is this list with its keys, so the dock would only repeat it.
		if (messages.length === 0 || overlay === "queue-navigator") {
			cachedLines = [];
			cachedWidth = width;
			cachedKey = key;
			dirty = false;
			return cachedLines;
		}

		const theme = clioTheme();
		const bodyWidth = Math.max(12, width - 4);
		const lines: string[] = [];
		for (const message of messages) {
			const slot = queueSlotWord(message);
			const marks = queueEntryMarks(message);
			// A steer is the user's voice redirecting the live turn, so it carries
			// the user glyph painted in the action color. The tool ledger keeps
			// exclusive ownership of the toolHeader glyph.
			const marker =
				slot === "steer"
					? theme.fg("attention", `${GLYPH.user} steer${marks}`)
					: theme.fg("body", `${GLYPH.queued} later${marks}`);
			const age = formatQueueAge(now - message.enqueuedAt);
			const preview = truncateToWidth(
				message.text.replace(/\s+/g, " "),
				Math.max(12, bodyWidth - 12 - marks.length - age.length),
				"…",
				false,
			);
			lines.push(`${marker} ${theme.fg("body", preview)} ${theme.fg("annotation", age)}`);
		}
		// These are composer keys, so they say nothing while an overlay owns the keyboard.
		if (overlay === "closed") {
			const hintRow = (spell: (label: string) => string): string => {
				const hints: string[] = [];
				const navigate = options.getNavigateKey?.();
				if (navigate && navigate.length > 0) hints.push(`[${spell(navigate)}] navigate`);
				const sendNow = options.getSendNowKey?.();
				if (sendNow && sendNow.length > 0) hints.push(`[${spell(sendNow)}] send now`);
				const dequeue = options.getDequeueKey?.();
				hints.push(`[${dequeue && dequeue.length > 0 ? spell(dequeue) : "see /help"}] restore to editor`);
				return hints.join(" · ");
			};
			// A narrow dock keeps every verb by giving up the second spelling of each key.
			const full = hintRow((label) => label);
			const row = visibleWidth(full) <= bodyWidth ? full : hintRow((label) => label.split(" · ")[0] ?? label);
			lines.push(truncateToWidth(theme.fg("annotation", row), bodyWidth, "…", false));
		}

		cachedLines = frame(theme, held ? "Steering Queue · held, nothing sent" : "Steering Queue", lines, bodyWidth + 4);
		cachedWidth = width;
		cachedKey = key;
		dirty = false;
		return cachedLines;
	};

	return {
		setMessages(nextMessages): void {
			messages = [...nextMessages];
			dirty = true;
		},
		render,
		invalidate(): void {
			dirty = true;
		},
	};
}
