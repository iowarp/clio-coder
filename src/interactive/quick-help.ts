import { CLIO_APP_KEYBINDING_IDS, type ClioKeybinding } from "../domains/config/keybindings.js";
import type { Component, Keybinding, OverlayHandle, TUI } from "../engine/tui.js";
import { formatKeyLabel } from "./keybinding-manager.js";
import { fitRow, showClioOverlayFrame } from "./overlay-frame.js";
import { clioTheme, fitUnits, GLYPH, padAnsi } from "./theme/index.js";

/**
 * `?` on an empty composer: the keys an operator reaches for, on one card.
 *
 * The full `/help` lists every binding, pi's editor primitives included, which
 * is the wrong answer to "what can I press right now". This card is curated:
 * the composer prefixes and the empty-composer keys on the left, Clio's own
 * actions on the right, each spelled the one way the footer and welcome spell
 * it (`Alt+M`, or `Ctrl+G Y` for an action with no direct key), read live from
 * the keybinding manager. The header states the rule that makes the right
 * column memorable: every letter there also works after the action menu key.
 * The card is not modal: the next key closes it, the way a glance ends.
 */

export interface QuickHelpKeys {
	readonly generation?: number;
	getKeys?(id: Keybinding): ReadonlyArray<string>;
	getDescription?(id: Keybinding): string;
	getLabel?(id: Keybinding): string;
	/** The one spelling hints use; absent, the card spells the first direct key. */
	actionLabel?(id: Keybinding): string;
	leaderTargets?(): ReadonlyArray<{ id?: Keybinding | undefined }>;
}

interface QuickHelpRow {
	key: string;
	verb: string;
}

/** Not lessons: the menu key heads the card, and exit and suspend are terminal habits. */
const OFF_CARD: ReadonlySet<ClioKeybinding> = new Set([
	"clio-coder.leader",
	"clio-coder.exit",
	"clio-coder.suspend",
	"clio-coder.message.dequeue",
	"clio-coder.model.cycleForward",
	"clio-coder.model.cycleBackward",
]);

function composerRows(menuKey: string | null): QuickHelpRow[] {
	return [
		{ key: "/", verb: "commands" },
		{ key: "!", verb: "run a shell command" },
		{ key: "!!", verb: "shell, output kept from Clio" },
		{ key: "@", verb: "mention a file" },
		{ key: "←", verb: "workers" },
		{ key: GLYPH.down, verb: "tasks" },
		...(menuKey ? [{ key: menuKey, verb: "actions menu, by letter" }] : []),
		{ key: "Esc", verb: "stops a run" },
		{ key: "Ctrl+C ×2", verb: "exit" },
	];
}

function actionRows(bindings: QuickHelpKeys): QuickHelpRow[] {
	const menu = new Set((bindings.leaderTargets?.() ?? []).map((target) => target.id));
	return CLIO_APP_KEYBINDING_IDS.flatMap((id) => {
		if (OFF_CARD.has(id)) return [];
		const keys = bindings.getKeys?.(id) ?? [];
		if (keys.length === 0 && !menu.has(id)) return [];
		const verb = bindings.getLabel?.(id) ?? bindings.getDescription?.(id) ?? "";
		const key = bindings.actionLabel?.(id) ?? formatKeyLabel(keys[0], "");
		return verb.length > 0 && key.length > 0 ? [{ key, verb }] : [];
	});
}

/** The two-column body, or one column below 84 cells, the documented stacking width. */
function quickHelpRows(width: number, bindings: QuickHelpKeys): string[] {
	const theme = clioTheme();
	const leader = bindings.getKeys?.("clio-coder.leader")[0];
	const menuKey = leader ? formatKeyLabel(leader) : null;
	const header = menuKey
		? fitRow(theme.fg("annotation", `Alt+letter runs an action · ${menuKey} then the same letter works anywhere`), width)
		: null;
	const left = composerRows(menuKey);
	const right = actionRows(bindings);
	const column = (rows: ReadonlyArray<QuickHelpRow>, cells: number): string[] => {
		const keyWidth = Math.min(16, Math.max(0, ...rows.map((row) => row.key.length)));
		return rows.map((row) =>
			fitUnits(theme, `${theme.style("guidance", padAnsi(row.key, keyWidth), { bold: true })}  `, [row.verb], cells),
		);
	};
	const lead = header ? [header, ""] : [];
	if (width < 84) return [...lead, ...column(left, width), "", ...column(right, width)];
	const gap = 3;
	const leftWidth = Math.floor((width - gap) * 0.42);
	const rightWidth = width - gap - leftWidth;
	const leftLines = column(left, leftWidth);
	const rightLines = column(right, rightWidth);
	const rows: string[] = [...lead];
	for (let index = 0; index < Math.max(leftLines.length, rightLines.length); index += 1) {
		rows.push(`${padAnsi(leftLines[index] ?? "", leftWidth)}${" ".repeat(gap)}${rightLines[index] ?? ""}`);
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
	let cached: { width: number; generation: number | undefined; lines: string[] } | null = null;
	let bodyRows = 0;
	const component: Component & { setBodyRows(rows: number): void } = {
		setBodyRows(rows: number) {
			bodyRows = Math.max(0, Math.floor(rows));
		},
		render(width) {
			if (cached?.width !== width || cached.generation !== bindings.generation)
				cached = { width, generation: bindings.generation, lines: quickHelpRows(width, bindings) };
			const lines = cached.lines;
			if (bodyRows <= 1 || lines.length <= bodyRows) return lines;
			// Any key closes this card, so rows it cannot show are named with where they live, not offered as a scroll.
			const hidden = lines.length - (bodyRows - 1);
			return [
				...lines.slice(0, bodyRows - 1),
				fitRow(clioTheme().fg("annotation", `${GLYPH.ellipsis} ${hidden} more in /help`), width),
			];
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
