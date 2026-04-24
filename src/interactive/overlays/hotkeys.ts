import { Box, type Component, type OverlayHandle, type TUI, truncateToWidth } from "../../engine/tui.js";
import type { ClioKeybindingManager } from "../keybinding-manager.js";

export const HOTKEYS_OVERLAY_WIDTH = 74;

export interface HotkeyEntry {
	keys: string;
	action: string;
	scope: "global" | "overlay" | "editor";
}

/**
 * Slash-command rows. These are rendered verbatim because they're discovered
 * from `src/interactive/slash-commands.ts`, not from the keybinding manager.
 * Global-scope hotkeys are built dynamically from the manager so user
 * overrides show up in /hotkeys without a second edit.
 */
const SLASH_HOTKEYS: ReadonlyArray<HotkeyEntry> = [
	{ keys: "Ctrl+C", action: "Cancel stream, clear input, or press twice to exit", scope: "global" },
	{ keys: "Esc", action: "Cancel stream or close overlay", scope: "global" },
	{ keys: "/help", action: "List commands", scope: "editor" },
	{ keys: "/hotkeys", action: "Show this reference", scope: "editor" },
	{ keys: "/thinking", action: "Open thinking selector", scope: "editor" },
	{ keys: "/model /models", action: "Open model selector", scope: "editor" },
	{ keys: "/scoped-models", action: "Edit Ctrl+P cycle set", scope: "editor" },
	{ keys: "/settings", action: "Open settings", scope: "editor" },
	{ keys: "/resume", action: "Open session picker", scope: "editor" },
	{ keys: "/new", action: "Start a new session", scope: "editor" },
	{ keys: "/tree", action: "Open session tree navigator", scope: "editor" },
	{ keys: "/fork", action: "Fork from a past assistant turn", scope: "editor" },
	{ keys: "/compact [instructions]", action: "Summarize earlier context", scope: "editor" },
	{ keys: "/targets", action: "Open targets overlay", scope: "editor" },
	{ keys: "/connect [target]", action: "Connect to a target", scope: "editor" },
	{ keys: "/disconnect [target]", action: "Disconnect a target", scope: "editor" },
	{ keys: "/cost", action: "Open cost overlay", scope: "editor" },
	{ keys: "/receipts", action: "Open receipts overlay", scope: "editor" },
	{ keys: "/receipt verify <runId>", action: "Verify a receipt file", scope: "editor" },
	{ keys: "/run <agent> <task>", action: "Dispatch agent", scope: "editor" },
	{ keys: "/quit", action: "Exit", scope: "editor" },
];

/**
 * Human-readable KeyId mapping for display. pi-tui stores `shift+tab`,
 * `ctrl+b`, `alt+m` etc.; the overlay shows `Shift+Tab`, `Ctrl+B`, `Alt+M`.
 * The helper is intentionally naïve: it title-cases each modifier and the
 * final key while preserving the separator. `(unbound)` falls through.
 */
function formatKey(raw: string): string {
	if (raw === "(unbound)") return raw;
	return raw
		.split(" / ")
		.map((single) =>
			single
				.split("+")
				.map((segment) => {
					const head = segment.charAt(0);
					return head.length === 0 ? segment : head.toUpperCase() + segment.slice(1);
				})
				.join("+"),
		)
		.join(" / ");
}

export function buildHotkeyEntries(manager: ClioKeybindingManager): ReadonlyArray<HotkeyEntry> {
	const dynamic: HotkeyEntry[] = manager.hotkeyEntries().map((row) => ({
		keys: formatKey(row.keys),
		action: row.description,
		scope: "global" as const,
	}));
	return [...dynamic, ...SLASH_HOTKEYS];
}

function pad(text: string, width: number): string {
	if (text.length >= width) return truncateToWidth(text, width, "", true);
	return text.padEnd(width);
}

export function formatHotkeysLines(
	entries: ReadonlyArray<HotkeyEntry>,
	contentWidth: number = HOTKEYS_OVERLAY_WIDTH - 4,
): string[] {
	const keysCol = 26;
	const actionCol = Math.max(10, contentWidth - keysCol - 2);
	const lines: string[] = [];
	lines.push(`┌${" Hotkeys ".padEnd(contentWidth + 2, "─")}┐`);
	let lastScope: string | null = null;
	for (const hk of entries) {
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
	constructor(private readonly entries: ReadonlyArray<HotkeyEntry>) {}

	render(width: number): string[] {
		return formatHotkeysLines(this.entries, Math.max(10, width - 4));
	}

	invalidate(): void {}
}

export function openHotkeysOverlay(tui: TUI, manager: ClioKeybindingManager): OverlayHandle {
	const box = new Box(0, 0);
	box.addChild(new HotkeysView(buildHotkeyEntries(manager)));
	return tui.showOverlay(box, { anchor: "center", width: HOTKEYS_OVERLAY_WIDTH });
}
