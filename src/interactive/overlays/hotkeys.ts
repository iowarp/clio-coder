import { Box, type Component, type OverlayHandle, type TUI, truncateToWidth } from "../../engine/tui.js";

export const HOTKEYS_OVERLAY_WIDTH = 74;

export interface HotkeyEntry {
	keys: string;
	action: string;
	scope: "global" | "overlay" | "editor";
}

/**
 * Every line of this table must correspond to live Phase 11 behavior. When a
 * binding or slash command changes, update this list at the same time —
 * /hotkeys is the authoritative help shown to users.
 */
export const HOTKEYS: ReadonlyArray<HotkeyEntry> = [
	{ keys: "Shift+Tab", action: "Cycle thinking level", scope: "global" },
	{ keys: "Alt+M", action: "Cycle mode (default / advise)", scope: "global" },
	{ keys: "Alt+S", action: "Enter super mode (confirmation)", scope: "global" },
	{ keys: "Alt+T", action: "Open /tree navigator", scope: "global" },
	{ keys: "Ctrl+L", action: "Open model selector", scope: "global" },
	{ keys: "Ctrl+P / Shift+Ctrl+P", action: "Cycle scoped models forward / back", scope: "global" },
	{ keys: "Ctrl+B", action: "Toggle dispatch board", scope: "global" },
	{ keys: "Ctrl+D", action: "Exit", scope: "global" },
	{ keys: "Esc", action: "Cancel stream or close overlay", scope: "global" },
	{ keys: "/help", action: "List commands", scope: "editor" },
	{ keys: "/hotkeys", action: "Show this reference", scope: "editor" },
	{ keys: "/thinking", action: "Open thinking selector", scope: "editor" },
	{ keys: "/model", action: "Open model selector", scope: "editor" },
	{ keys: "/scoped-models", action: "Edit Ctrl+P cycle set", scope: "editor" },
	{ keys: "/settings", action: "Open settings", scope: "editor" },
	{ keys: "/resume", action: "Open session picker", scope: "editor" },
	{ keys: "/new", action: "Start a new session", scope: "editor" },
	{ keys: "/tree", action: "Open session tree navigator", scope: "editor" },
	{ keys: "/providers", action: "Open providers overlay", scope: "editor" },
	{ keys: "/cost", action: "Open cost overlay", scope: "editor" },
	{ keys: "/receipts", action: "Open receipts overlay", scope: "editor" },
	{ keys: "/receipt verify <runId>", action: "Verify a receipt file", scope: "editor" },
	{ keys: "/run <agent> <task>", action: "Dispatch agent", scope: "editor" },
	{ keys: "/quit", action: "Exit", scope: "editor" },
];

function pad(text: string, width: number): string {
	if (text.length >= width) return truncateToWidth(text, width, "", true);
	return text.padEnd(width);
}

export function formatHotkeysLines(contentWidth: number = HOTKEYS_OVERLAY_WIDTH - 4): string[] {
	const keysCol = 26;
	const actionCol = Math.max(10, contentWidth - keysCol - 2);
	const lines: string[] = [];
	lines.push(`┌${" Hotkeys ".padEnd(contentWidth + 2, "─")}┐`);
	let lastScope: string | null = null;
	for (const hk of HOTKEYS) {
		if (hk.scope !== lastScope) {
			lastScope = hk.scope;
			lines.push(`│ ${pad(`── ${hk.scope.toUpperCase()}`, contentWidth)} │`);
		}
		const row = `${pad(hk.keys, keysCol)}  ${pad(hk.action, actionCol)}`;
		lines.push(`│ ${pad(row, contentWidth)} │`);
	}
	lines.push(`│ ${pad("[Esc] close", contentWidth)} │`);
	lines.push(`└${"─".repeat(contentWidth + 2)}┘`);
	return lines;
}

class HotkeysView implements Component {
	render(width: number): string[] {
		return formatHotkeysLines(Math.max(10, width - 4));
	}

	invalidate(): void {}
}

export function openHotkeysOverlay(tui: TUI): OverlayHandle {
	const box = new Box(0, 0);
	box.addChild(new HotkeysView());
	return tui.showOverlay(box, { anchor: "center", width: HOTKEYS_OVERLAY_WIDTH });
}
