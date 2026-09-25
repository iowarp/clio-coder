import type { TUI } from "../engine/tui.js";

/**
 * The dock: the composer's own slot, where every modal surface now lives.
 *
 * A picker, a settings inspector or a permission card used to float over the
 * transcript through the engine's overlay compositor, anchored at the center
 * or a corner, covering whatever was there and stealing the rows from mouse
 * selection. The engine still keeps one overlay per frame so focus and input
 * routing are unchanged, but that overlay paints nothing: the frame registers
 * here and the composer draws it in normal flow between its rails, the way a
 * slash autocomplete already draws. The transcript stays where it was, keeps
 * its scrollback, and stays selectable.
 */

export interface DockFrame {
	/** Body rows fitted to `bodyRows`, each exactly `contentWidth` wide. */
	renderDockBody(contentWidth: number, bodyRows: number): string[];
	dockTitle(): string;
	dockHint(width: number): string | undefined;
	dockTone(): import("./theme/index.js").ClioToken | undefined;
	invalidate(): void;
}

export interface DockEntry {
	frame: DockFrame;
	hidden: boolean;
	order: number;
	/**
	 * Draw the composer's own text beneath the body. The permission card keeps
	 * the composer because a steer typed while a call is parked is what the
	 * CONFIRM rail exists for.
	 */
	keepComposer: boolean;
}

/** Body rows a dock may draw. Fixed, so a picker is the same instrument at every window height. */
export const DOCK_BODY_ROWS_MAX = 16;
/** Rows the dock leaves for the footer, the two rails and a sliver of transcript. */
const DOCK_RESERVED_ROWS = 7;
const DOCK_BODY_ROWS_MIN = 3;
const DEFAULT_TERMINAL_ROWS = 24;

const registries = new WeakMap<object, DockEntry[]>();
let orderCounter = 0;

function entriesFor(tui: object): DockEntry[] {
	let entries = registries.get(tui);
	if (!entries) {
		entries = [];
		registries.set(tui, entries);
	}
	return entries;
}

export function dockMount(tui: object, frame: DockFrame, keepComposer: boolean): DockEntry {
	const entry: DockEntry = { frame, hidden: false, order: ++orderCounter, keepComposer };
	entriesFor(tui).push(entry);
	return entry;
}

export function dockRaise(tui: object, entry: DockEntry): void {
	if (entriesFor(tui).includes(entry)) entry.order = ++orderCounter;
}

export function dockUnmount(tui: object, entry: DockEntry): void {
	const entries = entriesFor(tui);
	const index = entries.indexOf(entry);
	if (index !== -1) entries.splice(index, 1);
}

/** The frame the composer draws: the most recently shown or raised one that is not hidden. */
export function dockTop(tui: object): DockEntry | null {
	const entries = registries.get(tui);
	if (!entries || entries.length === 0) return null;
	let top: DockEntry | null = null;
	for (const entry of entries) {
		if (entry.hidden) continue;
		if (top === null || entry.order > top.order) top = entry;
	}
	return top;
}

function terminalRows(tui: object): number {
	const rows = (tui as Partial<Pick<TUI, "terminal">>).terminal?.rows;
	return typeof rows === "number" && Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : DEFAULT_TERMINAL_ROWS;
}

/** Body rows the dock draws on this terminal. */
export function dockBodyRows(tui: object): number {
	return Math.max(DOCK_BODY_ROWS_MIN, Math.min(DOCK_BODY_ROWS_MAX, terminalRows(tui) - DOCK_RESERVED_ROWS));
}

/**
 * The terminal height a body that lays itself out from the screen should use:
 * the dock's rows plus the two rails, so a body that subtracts its frame rows
 * lands exactly on the dock budget.
 */
export function dockViewportRows(tui: object): number {
	return dockBodyRows(tui) + 2;
}
