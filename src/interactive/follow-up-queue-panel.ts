import { type Component, truncateToWidth, visibleWidth } from "../engine/tui.js";
import type { QueuedChatMessage } from "./chat-loop.js";
import { clioTheme, GLYPH } from "./theme/index.js";

export interface FollowUpQueuePanel extends Component {
	setMessages(messages: ReadonlyArray<QueuedChatMessage>): void;
}

export interface FollowUpQueuePanelOptions {
	getDequeueKey?: () => string | undefined;
}

/** ANSI-aware left cell: pad or truncate styled text to an exact width. */
function leftCell(text: string, width: number): string {
	const w = Math.max(0, width);
	const clipped = truncateToWidth(text, w, "...", true);
	return `${clipped}${" ".repeat(Math.max(0, w - visibleWidth(clipped)))}`;
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

		const theme = clioTheme();
		const bodyWidth = Math.max(12, width - 4);
		const lines: string[] = [];
		for (const message of messages) {
			const preview = truncateToWidth(message.text.replace(/\s+/g, " "), Math.max(12, bodyWidth - 9), "...", false);
			// Steering redirects the live turn: that is a Clio-signature action,
			// so the steer marker carries the highlight color.
			const marker =
				message.kind === "steer"
					? theme.fg("highlight", `${GLYPH.toolHeader} steer`)
					: theme.fg("muted", `${GLYPH.queued} queued`);
			lines.push(`${marker} ${theme.fg("muted", preview)}`);
		}
		const restoreKey = key && key.length > 0 ? key : "alt+up";
		lines.push(theme.fg("dim", `[${restoreKey}] restores to editor`));

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
