import { type Component, truncateToWidth } from "../engine/tui.js";
import type { QueuedChatMessage } from "./chat-loop.js";
import { clioTheme } from "./theme/index.js";

export interface FollowUpQueuePanel extends Component {
	setMessages(messages: ReadonlyArray<QueuedChatMessage>): void;
}

export interface FollowUpQueuePanelOptions {
	getDequeueKey?: () => string | undefined;
}

function leftCell(text: string, width: number): string {
	const w = Math.max(0, width);
	if (text.length <= w) return text.padEnd(w);
	if (w <= 3) return text.slice(0, w);
	return `${text.slice(0, w - 3)}...`;
}

export function createFollowUpQueuePanel(options: FollowUpQueuePanelOptions = {}): FollowUpQueuePanel {
	let messages: QueuedChatMessage[] = [];
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

		const bodyWidth = Math.max(12, width - 4);
		const lines: string[] = [];
		for (const message of messages) {
			const preview = truncateToWidth(message.text.replace(/\s+/g, " "), Math.max(12, bodyWidth - 8), "...", false);
			lines.push(`${message.kind === "steer" ? "steer" : "queued"}: ${preview}`);
		}
		const restoreKey = key && key.length > 0 ? key : "alt+up";
		lines.push(`[${restoreKey}] restores to editor`);

		const theme = clioTheme();
		const titleStr = "Steering Queue";
		const top = `${theme.fg("frame", "┌─")}${theme.style("title", titleStr, { bold: true })}${theme.fg("frame", "─".repeat(Math.max(0, bodyWidth - titleStr.length)))}${theme.fg("frame", "┐")}`;
		const body = lines.map((line) => `${theme.fg("frame", "│")} ${leftCell(line, bodyWidth)} ${theme.fg("frame", "│")}`);
		const bottom = `${theme.fg("frame", "└")}${theme.fg("frame", "─".repeat(bodyWidth + 2))}${theme.fg("frame", "┘")}`;

		cachedLines = [top, ...body, bottom];
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
