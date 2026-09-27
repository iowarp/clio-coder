import { CLIO_APP_KEYBINDING_IDS } from "../domains/config/keybindings.js";
import type { Component, Keybinding, OverlayHandle, TUI } from "../engine/tui.js";
import { formatKeyLabel } from "./keybinding-manager.js";
import { showClioOverlayFrame } from "./overlay-frame.js";
import { clioTheme, fitUnits, GLYPH, padAnsi } from "./theme/index.js";

/**
 * `?` on an empty composer: the keys an operator reaches for, on one card.
 *
 * The full `/help` lists every binding, pi's editor primitives included, which
 * is the wrong answer to "what can I press right now". This card is curated:
 * the composer prefixes and the empty-composer keys on the left, Clio's own
 * actions on the right, read live from the keybinding manager so a rebound key
 * shows its real spelling. The card is not modal: the composer keeps the
 * keyboard, and the next key closes it, the way a glance at a cheat sheet ends.
 */

export interface QuickHelpKeys {
	getKeys?(id: Keybinding): ReadonlyArray<string>;
	getDescription?(id: Keybinding): string;
}

interface QuickHelpRow {
	key: string;
	verb: string;
}

const COMPOSER_ROWS: ReadonlyArray<QuickHelpRow> = [
	{ key: "/", verb: "commands" },
	{ key: "!", verb: "run a shell command" },
	{ key: "@", verb: "mention a file" },
	{ key: "?", verb: "this card" },
	{ key: "←", verb: "workers" },
	{ key: GLYPH.down, verb: "tasks" },
	{ key: "Esc", verb: "cancel the run" },
	{ key: "Ctrl+C ×2", verb: "exit" },
];

/** Two keys at most: a third spelling is noise on a glance card. */
function keyLabel(keys: ReadonlyArray<string>): string {
	return keys
		.slice(0, 2)
		.map((key) => formatKeyLabel(key))
		.join(" / ");
}

/** The two-column body, or one column below 84 cells, the documented stacking width. */
function quickHelpRows(width: number, bindings: QuickHelpKeys): string[] {
	const theme = clioTheme();
	const actionRows: QuickHelpRow[] = [];
	for (const id of CLIO_APP_KEYBINDING_IDS) {
		const keys = bindings.getKeys?.(id) ?? [];
		const verb = bindings.getDescription?.(id) ?? "";
		if (keys.length === 0 || verb.length === 0) continue;
		actionRows.push({ key: keyLabel(keys), verb });
	}
	const column = (rows: ReadonlyArray<QuickHelpRow>, cells: number): string[] => {
		const keyWidth = Math.min(16, Math.max(0, ...rows.map((row) => row.key.length)));
		return rows.map((row) =>
			fitUnits(theme, `${theme.style("guidance", padAnsi(row.key, keyWidth), { bold: true })}  `, [row.verb], cells),
		);
	};
	if (width < 84) return [...column(COMPOSER_ROWS, width), "", ...column(actionRows, width)];
	const gap = 3;
	const leftWidth = Math.floor((width - gap) * 0.42);
	const rightWidth = width - gap - leftWidth;
	const left = column(COMPOSER_ROWS, leftWidth);
	const right = column(actionRows, rightWidth);
	const rows: string[] = [];
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		rows.push(`${padAnsi(left[index] ?? "", leftWidth)}${" ".repeat(gap)}${right[index] ?? ""}`);
	}
	return rows;
}

export interface QuickHelp {
	isOpen(): boolean;
	open(): void;
	close(): void;
}

export function createQuickHelp(tui: TUI, bindings: QuickHelpKeys): QuickHelp {
	let handle: OverlayHandle | null = null;
	let cached: { width: number; lines: string[] } | null = null;
	const component: Component = {
		render(width) {
			if (cached?.width !== width) cached = { width, lines: quickHelpRows(width, bindings) };
			return cached.lines;
		},
		invalidate() {
			cached = null;
		},
	};
	return {
		isOpen: () => handle !== null,
		open() {
			if (handle !== null) return;
			handle = showClioOverlayFrame(tui, component, {
				title: "Keys",
				markerId: "quick-help",
				nonCapturing: true,
				footerHint: "any key closes",
			});
			tui.requestRender();
		},
		close() {
			handle?.hide();
			handle = null;
			tui.requestRender();
		},
	};
}
