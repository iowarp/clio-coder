import { type Component, matchesKey, type OverlayHandle, type TUI, truncateToWidth } from "../../engine/tui.js";
import type { ClioKeybindingManager, PlatformKeybindingWarning } from "../keybinding-manager.js";
import { brandedBottomBorder, brandedContentRow, brandedTopBorder } from "../overlay-frame.js";
import { formatKeybindingDetailLines } from "./keybinding-detail.js";

export const HOTKEYS_OVERLAY_WIDTH = 74;

export interface HotkeyEntry {
	keys: string;
	action: string;
	scope: "global" | "overlay" | "editor";
	id?: string;
	source?: "default" | "user";
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
	{ keys: "Tab", action: "Complete selected slash-command suggestion", scope: "editor" },
	{ keys: "!cmd", action: "Run local bash and include output as context", scope: "editor" },
	{ keys: "!!cmd", action: "Run local bash without adding output to context", scope: "editor" },
	{ keys: "/hotkeys", action: "Show this reference", scope: "editor" },
	{ keys: "/thinking", action: "Open thinking selector", scope: "editor" },
	{ keys: "/model [pattern[:thinking]]", action: "Open or set model", scope: "editor" },
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
	{ keys: "/receipts [verify <runId>]", action: "Browse or verify receipts", scope: "editor" },
	{ keys: "/run [--worker <profile>|--runtime <id>] <agent> <task>", action: "Dispatch agent", scope: "editor" },
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
		id: row.id,
		keys: formatKey(row.keys),
		action: row.description,
		scope: "global" as const,
		source: row.source,
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
	options: { selectedIndex?: number; warnings?: ReadonlyArray<PlatformKeybindingWarning> } = {},
): string[] {
	const keysCol = 24;
	const actionCol = Math.max(10, contentWidth - keysCol - 5);
	const lines: string[] = [];
	lines.push(brandedTopBorder(" Hotkeys ", contentWidth + 2));
	for (const warning of options.warnings ?? []) {
		const keys = warning.keys.map(formatKey).join(" / ");
		lines.push(
			brandedContentRow(pad(`! ${warning.id}: ${keys} needs CSI-u (${warning.terminal})`, contentWidth), contentWidth),
		);
	}
	if ((options.warnings ?? []).length > 0) {
		lines.push(brandedContentRow(pad("", contentWidth), contentWidth));
	}
	let lastScope: string | null = null;
	entries.forEach((hk, index) => {
		if (hk.scope !== lastScope) {
			lastScope = hk.scope;
			lines.push(brandedContentRow(pad(`── ${hk.scope.toUpperCase()}`, contentWidth), contentWidth));
		}
		const marker = index === options.selectedIndex ? ">" : " ";
		const row = `${marker} ${pad(hk.keys, keysCol)}  ${pad(hk.action, actionCol)}`;
		lines.push(brandedContentRow(pad(row, contentWidth), contentWidth));
	});
	lines.push(brandedContentRow(pad("[Up/Down] select  [E] details  [Esc] close", contentWidth), contentWidth));
	lines.push(brandedBottomBorder(contentWidth + 2));
	return lines;
}

class HotkeysView implements Component {
	private selectedIndex = 0;
	private detailEntry: HotkeyEntry | null = null;

	constructor(
		private readonly entries: ReadonlyArray<HotkeyEntry>,
		private readonly warnings: ReadonlyArray<PlatformKeybindingWarning>,
		private readonly onChange: () => void,
	) {}

	render(width: number): string[] {
		const contentWidth = Math.max(10, width - 4);
		if (this.detailEntry) {
			const warnings = this.warnings
				.filter((warning) => warning.id === this.detailEntry?.id)
				.map((warning) => `${warning.keys.map(formatKey).join(" / ")} may not fire: ${warning.reason}`);
			const detail = {
				id: this.detailEntry.id ?? this.detailEntry.keys,
				keys: this.detailEntry.keys,
				action: this.detailEntry.action,
				warnings,
			};
			return formatKeybindingDetailLines(
				this.detailEntry.source ? { ...detail, source: this.detailEntry.source } : detail,
				contentWidth,
			);
		}
		return formatHotkeysLines(this.entries, contentWidth, {
			selectedIndex: this.selectedIndex,
			warnings: this.warnings,
		});
	}

	handleInput(data: string): void {
		if (this.detailEntry) {
			if (matchesKey(data, "backspace") || data === "q") {
				this.detailEntry = null;
				this.onChange();
			}
			return;
		}
		if (matchesKey(data, "up")) {
			this.selectedIndex = this.selectedIndex === 0 ? this.entries.length - 1 : this.selectedIndex - 1;
			this.onChange();
			return;
		}
		if (matchesKey(data, "down")) {
			this.selectedIndex = this.selectedIndex === this.entries.length - 1 ? 0 : this.selectedIndex + 1;
			this.onChange();
			return;
		}
		if (data.toLowerCase() === "e" || matchesKey(data, "enter")) {
			this.detailEntry = this.entries[this.selectedIndex] ?? null;
			this.onChange();
		}
	}

	invalidate(): void {}
}

export function openHotkeysOverlay(tui: TUI, manager: ClioKeybindingManager): OverlayHandle {
	return tui.showOverlay(
		new HotkeysView(buildHotkeyEntries(manager), manager.platformWarnings(), () => tui.requestRender()),
		{
			anchor: "center",
			width: HOTKEYS_OVERLAY_WIDTH,
		},
	);
}
