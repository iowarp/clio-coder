import { type Component, truncateToWidth } from "../engine/tui.js";
import type { QueuedChatMessage } from "./chat-loop.js";
import { clioTheme, frame, GLYPH } from "./theme/index.js";

export interface FollowUpQueuePanel extends Component {
	setMessages(messages: ReadonlyArray<QueuedChatMessage>): void;
}

export interface FollowUpQueuePanelOptions {
	getDequeueKey?: () => string | undefined;
}

/**
 * Keybindings are stored lowercase (`alt+up`), but the hint vocabulary spells
 * modifiers and keys in title case (`[Alt+Up]`). Format the bound key for
 * display so the panel reads the same whether or not the binding is customized.
 */
function displayKey(key: string): string {
	return key
		.split("+")
		.map((part) => (part.length > 0 ? `${part[0]?.toUpperCase()}${part.slice(1)}` : part))
		.join("+");
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
			const preview = truncateToWidth(message.text.replace(/\s+/g, " "), Math.max(12, bodyWidth - 9), "…", false);
			// A steer is the user's voice redirecting the live turn, so it carries
			// the user glyph painted in the action color. The tool ledger keeps
			// exclusive ownership of the toolHeader glyph.
			const marker =
				message.kind === "steer" ? theme.fg("action", `${GLYPH.user} steer`) : theme.fg("muted", `${GLYPH.queued} queued`);
			lines.push(`${marker} ${theme.fg("muted", preview)}`);
		}
		const restoreKey = key && key.length > 0 ? displayKey(key) : "Alt+Up";
		lines.push(theme.fg("dim", `[${restoreKey}] restore to editor`));

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
