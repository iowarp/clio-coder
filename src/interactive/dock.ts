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

/** What the composer knows and a title may use: the columns the rail has and who is asking. */
export interface DockTitleContext {
	room: number;
	actor: string;
}

export interface DockFrame {
	/** Body rows fitted to `bodyRows`, each exactly `contentWidth` wide. */
	renderDockBody(contentWidth: number, bodyRows: number): string[];
	dockTitle(context?: DockTitleContext): string;
	dockHint(width: number): string | undefined;
	dockTone(): import("./theme/index.js").ClioToken | undefined;
	/** A decision needs the operator's answer, rather than an ordinary open menu. */
	dockAwaitingInput?(): boolean;
	invalidate(): void;
}

export interface DockEntry {
	frame: DockFrame;
	hidden: boolean;
	order: number;
	/**
	 * Keep the composer's draft editable inside the same rails, beneath the body.
	 * The permission card does, because a steer typed while a call is parked is
	 * what the CONFIRM rail exists for.
	 */
	keepComposer: boolean;
	/**
	 * The surface sizes itself to its content between the compact floor and
	 * `dockGrowthRows`, instead of always taking `dockBodyRows`. Opt-in, so no
	 * other menu changes height.
	 */
	adaptive?: boolean;
	/** An approval owns the editor: the rails take the attention tone until it resolves. */
	approval?: boolean;
}

/** Every open menu shares this body height while the terminal has room. */
export const DOCK_BODY_ROWS_MAX = 16;
/** Two rails and a sliver of transcript, in addition to the current footer. */
const DOCK_RESERVED_ROWS = 5;
const DOCK_BODY_ROWS_MIN = 3;
const DEFAULT_TERMINAL_ROWS = 24;

const registries = new WeakMap<object, DockEntry[]>();
const footerHeights = new WeakMap<object, number>();
let orderCounter = 0;

function entriesFor(tui: object): DockEntry[] {
	let entries = registries.get(tui);
	if (!entries) {
		entries = [];
		registries.set(tui, entries);
	}
	return entries;
}

export function dockMount(
	tui: object,
	frame: DockFrame,
	keepComposer: boolean,
	adaptive = false,
	approval = false,
): DockEntry {
	const entry: DockEntry = {
		frame,
		hidden: false,
		order: ++orderCounter,
		keepComposer,
		...(adaptive ? { adaptive } : {}),
		...(approval ? { approval } : {}),
	};
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
	return Math.max(
		DOCK_BODY_ROWS_MIN,
		Math.min(DOCK_BODY_ROWS_MAX, terminalRows(tui) - DOCK_RESERVED_ROWS - (footerHeights.get(tui) ?? 2)),
	);
}

/** Rows an adaptive surface keeps when its content is small, so one or two options never leave a tall empty dock. */
export const DOCK_COMPACT_ROWS = 6;

/**
 * The most rows an adaptive surface may take: half the terminal when that is
 * more than the shared budget, never more than the terminal can hold, and never
 * less than what every other menu already gets.
 */
export function dockGrowthRows(tui: object): number {
	const rows = terminalRows(tui);
	const shared = dockBodyRows(tui);
	const available = Math.max(DOCK_BODY_ROWS_MIN, rows - DOCK_RESERVED_ROWS - (footerHeights.get(tui) ?? 2));
	return Math.max(shared, Math.min(Math.floor(rows / 2), available));
}

/** An adaptive body's height for `wanted` content rows. */
export function dockAdaptiveRows(tui: object, wanted: number): number {
	const ceiling = dockGrowthRows(tui);
	return Math.max(Math.min(DOCK_COMPACT_ROWS, ceiling), Math.min(ceiling, Math.floor(wanted)));
}

export function setDockFooterRows(tui: object, rows: number): boolean {
	const height = Math.max(0, Math.floor(rows));
	if (footerHeights.get(tui) === height) return false;
	footerHeights.set(tui, height);
	return true;
}

/**
 * The terminal height a body that lays itself out from the screen should use:
 * the dock's rows plus the two rails, so a body that subtracts its frame rows
 * lands exactly on the dock budget.
 */
export function dockViewportRows(tui: object): number {
	return dockBodyRows(tui) + 2;
}
