import type { Component } from "../engine/tui.js";
import { truncateToWidth } from "../engine/tui.js";
import type { QueuedChatMessage } from "./chat-loop.js";
import { formatQueueAge, queueEntryMarks, queueSlotWord } from "./overlays/queue-navigator.js";
import { clioTheme, frame, GLYPH } from "./theme/index.js";

export interface FollowUpQueuePanel extends Component {
	setMessages(messages: ReadonlyArray<QueuedChatMessage>): void;
}

export interface FollowUpQueuePanelOptions {
	/** Action labels already formatted from the live binding manager. */
	getDequeueKey?: () => string | undefined;
	getNavigateKey?: () => string | undefined;
	getSendNowKey?: () => string | undefined;
	now?: () => number;
}

export function createFollowUpQueuePanel(options: FollowUpQueuePanelOptions = {}): FollowUpQueuePanel {
	let messages: QueuedChatMessage[] = [];
	let dirty = true;
	let cachedWidth = 0;
	let cachedKey: string | undefined;
	let cachedLines: string[] = [];

	const render = (width: number): string[] => {
		const key = [options.getDequeueKey?.(), options.getNavigateKey?.(), options.getSendNowKey?.()].join("|");
		if (!dirty && cachedWidth === width && cachedKey === key) return cachedLines;
		if (messages.length === 0) {
			cachedLines = [];
			cachedWidth = width;
			cachedKey = key;
			dirty = false;
			return cachedLines;
		}

		const theme = clioTheme();
		const bodyWidth = Math.max(12, width - 4);
		const now = (options.now ?? Date.now)();
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
		const hints: string[] = [];
		const navigate = options.getNavigateKey?.();
		if (navigate && navigate.length > 0) hints.push(`[${navigate}] navigate`);
		const sendNow = options.getSendNowKey?.();
		if (sendNow && sendNow.length > 0) hints.push(`[${sendNow}] send now`);
		const dequeue = options.getDequeueKey?.();
		hints.push(`[${dequeue && dequeue.length > 0 ? dequeue : "see /help"}] restore to editor`);
		lines.push(theme.fg("annotation", hints.join(" · ")));

		cachedLines = frame(theme, "Steering Queue", lines, bodyWidth + 4);
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
