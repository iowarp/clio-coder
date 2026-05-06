import { type Component, truncateToWidth, wrapTextWithAnsi } from "../engine/tui.js";

const ANSI_DIM = "\u001b[2m";
const ANSI_RESET = "\u001b[0m";

export interface FollowUpQueuePanel extends Component {
	setMessages(messages: ReadonlyArray<string>): void;
}

export interface FollowUpQueuePanelOptions {
	getDequeueKey?: () => string | undefined;
}

function dim(text: string): string {
	return `${ANSI_DIM}${text}${ANSI_RESET}`;
}

export function createFollowUpQueuePanel(options: FollowUpQueuePanelOptions = {}): FollowUpQueuePanel {
	let messages: string[] = [];
	let dirty = true;
	let cachedWidth = 0;
	let cachedKey: string | undefined;
	let cachedLines: string[] = [];

	const render = (width: number): string[] => {
		const key = options.getDequeueKey?.();
		if (!dirty && cachedWidth === width && cachedKey === key) return cachedLines;
		if (messages.length === 0) {
			cachedLines = [];
			cachedWidth = width;
			cachedKey = key;
			dirty = false;
			return cachedLines;
		}

		const bodyWidth = Math.max(1, width);
		const lines: string[] = [];
		for (const message of messages) {
			const preview = truncateToWidth(message.replace(/\s+/g, " "), Math.max(12, bodyWidth - 18), "...", false);
			lines.push(...wrapTextWithAnsi(dim(`follow-up queued: ${preview}`), bodyWidth));
		}
		const restoreKey = key && key.length > 0 ? key : "alt+up";
		lines.push(...wrapTextWithAnsi(dim(`${restoreKey} restores queued follow-ups to the editor`), bodyWidth));

		cachedLines = lines;
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
