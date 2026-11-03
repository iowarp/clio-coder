import {
	type Component,
	fuzzyFilter,
	Input,
	Markdown,
	matchesKey,
	type OverlayHandle,
	stripTerminalSequences,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../../engine/tui.js";
import { localKey } from "../keyboard-owner.js";
import {
	buildHint,
	FILTER_HINT,
	fitHintEntries,
	fitHintEntryList,
	type HintEntry,
	type OverlayEscVerb,
	showClioOverlayFrame,
} from "../overlay-frame.js";
import {
	chipRows,
	clioTheme,
	dotSep,
	emptyState,
	errorState,
	fitUnits,
	GLYPH,
	keyCap,
	listGroupHeader,
	markdownTheme,
	padAnsi,
	positionRow,
	rule,
	selectionRow,
} from "../theme/index.js";
import { skinEpoch } from "../theme/tokens.js";

/**
 * Row width at and below which a two-column row draws `narrowLead`. It is the
 * content width of an 80-column terminal, where the help list lost every
 * description to the flags in front of it.
 */
export const NARROW_ROW_WIDTH = 76;

/** The share of a row the lead column of a two-column list may take. */
const LEAD_COLUMN_SHARE = 0.4;

/** Fewest list rows a stacked detail pane may leave, and fewest rows it needs to be drawn at all. */
const STACKED_LIST_MIN_ROWS = 3;
const STACKED_DETAIL_MIN_ROWS = 2;

/** The one key the body never repeats: a pane that overflows names it on its own position row. */
const PANE_REMINDERS = new Set(["PgUp/PgDn"]);
/** Keys the chrome may already show by their glyph alone: the compact tab bar ends in ←→. */
const NAVIGATION_KEYS = new Set(["←→", "↑↓"]);

interface RenderedRow {
	type: "group" | "item";
	groupName?: string;
	item?: ListOverlayItem;
	itemIndex?: number;
}

export interface ListOverlayCells {
	/** The first column: a usage, a key, a name. Shares one width with every other row that has cells. */
	lead: string;
	/** A shorter lead drawn at or below `NARROW_ROW_WIDTH`, so flags go before the description does. */
	narrowLead?: string;
	/** The second column, which takes the rest of the row. */
	text: string;
}

export interface ListOverlayItem {
	id: string;
	/** Left-column text, already themed by the caller. The filter matches this text. */
	label: string;
	/**
	 * Draw the row as two aligned columns instead of `label`. The lead column
	 * is as wide as the widest lead among the rows, at most two fifths of the
	 * row, so a reference list reads as a table without a fixed padding that a
	 * long usage overran and a short one left empty.
	 */
	cells?: ListOverlayCells;
	/** Optional dim right-aligned column (origin, scope, version...). */
	meta?: string;
	/** Group header this item renders under, e.g. "project", "marketplace". */
	group?: string;
	/**
	 * Lines for the detail pane, lazily computed at the pane's real width.
	 * Markdown by default; `detailFormat: "rows"` says the lines are already
	 * laid out from the design primitives and the pane only wraps a line that
	 * overruns it. Providers that laid themselves out at a guessed width had
	 * their own wrapped lines re-wrapped by the pane, which repeated the row
	 * label on every continuation line.
	 */
	detail?: (width: number) => string[];
	detailFormat?: "markdown" | "rows";
	/**
	 * Rows-mode only: how many leading rows of `detail` stay pinned while the
	 * rest scrolls, so a pane's title, status and keys are on screen at every
	 * scroll offset. Zero or absent scrolls the whole pane.
	 */
	detailHead?: (width: number) => number;
}

/**
 * One tab of a tabbed list overlay.
 *
 * A tab owns its own row set and rebuilds it on demand, so switching tabs
 * re-reads whatever the rows describe rather than serving a snapshot taken when
 * the overlay opened. The counts drawn in the tab bar come from the same call,
 * which is why an install that lands on one tab corrects every tab's count.
 */
export interface ListOverlayTab {
	id: string;
	label: string;
	items: () => ReadonlyArray<ListOverlayItem>;
	/** Optional footer count wording; defaults to the count followed by the tab label. */
	countLabel?: (count: number) => string;
}

export interface ListOverlayOptions {
	title: string;
	/** Allow long lists to use the full body budget; the outer frame keeps a fixed height. */
	fullScreen?: boolean;
	items: ReadonlyArray<ListOverlayItem>;
	/**
	 * Tabs, drawn as a bar above the filter row and switched with ←/→, which is
	 * the key vocabulary the Settings Center already uses to move between
	 * sections. Omitted leaves the overlay untabbed and every tab code path
	 * inert.
	 */
	tabs?: ReadonlyArray<ListOverlayTab>;
	/** Tab the overlay opens on; defaults to the first. */
	activeTabId?: string;
	/** Notified after ←/→ changes the active tab. */
	onTabChange?: (tabId: string) => void;
	/** Enables the type-to-filter input row. */
	filterable?: boolean;
	/** Start in the list; / enters search, whose letters and arrows belong to the input. */
	explicitSearch?: boolean;
	/** Persistent, width-aware scope/mode text, including when the selected tab is empty. */
	status?: (width: number) => string;
	/** Actions that do not require a selected row, such as scope or view mode. */
	globalActions?: Record<string, () => void>;
	globalHints?: ReadonlyArray<HintEntry>;
	/**
	 * An inner level Esc leaves before it closes the overlay, such as a package's
	 * member list. `active` is asked by the footer so the key it advertises is the
	 * key the operator gets; `back` is called only when Esc actually fires.
	 */
	onBack?: { active: () => boolean; back: () => void };
	/** Pre-applied filter text. */
	initialFilter?: string;
	/**
	 * Extra hint entries beyond movement/filter/Esc (builder appends Esc). A
	 * function is asked per frame and is handed the selected row, so a footer can
	 * advertise the keys that row actually offers rather than a fixed set.
	 */
	hints?: ReadonlyArray<HintEntry> | ((selected: ListOverlayItem | undefined) => ReadonlyArray<HintEntry>);
	/** Custom message when list is empty; a function is asked per frame. */
	emptyMessage?: string | (() => string);
	/** What would fill the list, or the key that does, under the empty message. */
	emptyRemedy?: string | (() => string);
	/** A read that failed, asked per frame; drawn as the error state in place of the empty message while it returns text. */
	emptyError?: () => string | undefined;
	/** Noun for the rows in the position line; `rows` by default. */
	unit?: string;
	/** Layout mode: stack (detail below list) or split (detail to the right). */
	layout?: "stack" | "split";
	/** Primary action; omitted means Enter toggles the detail pane. */
	onSelect?: (item: ListOverlayItem) => void;
	/** Secondary keyed actions, e.g. { i: install }. */
	actions?: Record<string, (item: ListOverlayItem) => void>;
	onClose: () => void;
}

export class ListOverlayView implements Component {
	private viewportRows = 24;
	private selectedIndex = 0;
	private filterText = "";
	private isFilterFocused = false;
	private showDetail = false;
	/**
	 * Whether the pane may take the whole body over. An opener that shows the
	 * pane by default gets it only when it stacks under the list; the takeover,
	 * which hides every row and the cursor, is for an operator who pressed the
	 * detail key and can press it again.
	 */
	private takeoverAllowed = false;
	/** The pane has the body to itself, so the detail key is the way back to the rows. */
	private detailTakeover = false;
	private listScrollOffset = 0;
	private detailScrollOffset = 0;
	/**
	 * Whether the last frame actually drew a detail pane.
	 *
	 * The split pane is gated on the render width and the stacked one on
	 * showDetail, and `getHint` is handed neither. The frame renders the child
	 * before it fits the footer, so the last frame is the one the hint describes.
	 * It starts on the router's own belief in `detailPaneVisible`, which is what
	 * the scroll keys would do before any render has corrected it.
	 */
	private detailPaneDrawn: boolean;
	/** Whether the pane on screen is the split one, which Tab cannot put away. */
	private detailPaneSplit = false;
	/** Cells the rail under this list has for keys, or zero while the composer has not said. */
	private railRoom = 0;
	/** Lines one PgUp or PgDn moves the pane by: the rows it shows, never a fixed count. */
	private detailPage = 1;
	/** Rendered rows of the pinned head the last frame drew, for the key row to check against. */
	private detailHeadText = "";
	private readonly input: Input;
	/**
	 * The live item set. Separate from `options.items` because a surface backed by
	 * data that changes under the operator (the memory bank refreshes once a
	 * second) replaces its rows without rebuilding the view, which is what keeps
	 * the selection and the detail scroll where they were left.
	 */
	private items: ReadonlyArray<ListOverlayItem>;
	/** Bumped by setItems; part of the render memo key so replaced rows never serve a stale frame. */
	private itemsEpoch = 0;
	/**
	 * Filter memo: the item set is fixed at construction, so the fuzzy pass is a
	 * pure function of the query. Re-scoring every item per frame defeated the
	 * overlay frame's identity cache, since each frame returned a fresh array.
	 */
	private filterMemo: { query: string; items: ReadonlyArray<ListOverlayItem> } | null = null;
	/** Detail pane memo: one Markdown render per (item, width), not per frame. */
	private detailMemo: { item: ListOverlayItem; width: number; epoch: number; lines: string[] } | null = null;
	/** Rendered-frame memo keyed on every render input, for frame-cache identity. */
	private renderMemo: { key: string; lines: string[] } | null = null;
	/** Bumped on every keystroke routed into the filter input; part of the memo key. */
	private inputEpoch = 0;
	/** Active tab id, or the empty string on an untabbed overlay. */
	private activeTabId = "";
	/** Row count per tab id, refreshed whenever the tab set is rebuilt. */
	private tabCounts = new Map<string, number>();

	constructor(
		private readonly options: ListOverlayOptions,
		private readonly onChange: () => void,
	) {
		this.isFilterFocused = !!options.filterable && !options.explicitSearch;
		this.filterText = options.initialFilter ?? "";
		this.items = options.items;
		this.detailPaneDrawn = options.layout === "split";
		this.input = new Input();
		if (options.initialFilter) {
			this.input.setValue(options.initialFilter);
		}
		const tabs = options.tabs;
		if (tabs && tabs.length > 0) {
			const requested = tabs.find((tab) => tab.id === options.activeTabId);
			this.activeTabId = (requested ?? tabs[0])?.id ?? "";
			this.refreshTabs();
		}
	}

	/** The tab the overlay is on, or undefined when it is untabbed. */
	activeTab(): ListOverlayTab | undefined {
		return this.options.tabs?.find((tab) => tab.id === this.activeTabId);
	}

	/**
	 * Rebuild every tab's rows, adopt the active tab's, and record each count.
	 *
	 * Every tab is rebuilt rather than only the active one because the tab bar
	 * states each tab's count, and an install performed on one tab can satisfy a
	 * requirement another tab reports. A stale count there is the same lie a
	 * stale row is.
	 */
	refreshTabs(): void {
		const tabs = this.options.tabs;
		if (!tabs || tabs.length === 0) return;
		const counts = new Map<string, number>();
		let activeItems: ReadonlyArray<ListOverlayItem> = [];
		for (const tab of tabs) {
			const rows = tab.items();
			counts.set(tab.id, rows.length);
			if (tab.id === this.activeTabId) activeItems = rows;
		}
		this.tabCounts = counts;
		this.setItems(activeItems);
	}

	/**
	 * Move the cursor onto a row by id, reporting whether that row is here.
	 *
	 * A command that names one package opens the browser on it rather than at the
	 * top of a list the operator then has to search. A miss is reported instead of
	 * silently landing on row zero, because "not found" and "found, first" are
	 * different answers.
	 */
	selectById(id: string): boolean {
		const index = this.filteredItems().findIndex((item) => item.id === id);
		if (index === -1) return false;
		this.selectIndex(index);
		this.renderMemo = null;
		return true;
	}

	/**
	 * Drop a typed filter and leave search focus, for a caller that replaces its
	 * rows with a different set: a filter typed to reach an agent's inventory
	 * hid every row of the adoption plan that took the inventory's place.
	 */
	clearFilter(): void {
		if (this.filterText.length === 0 && !this.isFilterFocused) return;
		this.filterText = "";
		this.input.setValue("");
		this.isFilterFocused = false;
		this.inputEpoch += 1;
		this.selectIndex(0);
		this.renderMemo = null;
	}

	/** Show or hide the stacked detail pane, for callers that bind their own key to it. */
	/**
	 * The detail key: it opens a pane when none is on screen and hides the one
	 * that is, judged by what was drawn rather than what was wanted, so a pane
	 * the opener asked for but the rows could not hold never makes the first
	 * press a no-op. From here on the pane may take the body over.
	 */
	private toggleDetailByKey(): void {
		this.takeoverAllowed = true;
		// Before the first frame nothing has been drawn yet, so the request is what the key inverts.
		this.showDetail = this.renderMemo ? !this.detailPaneDrawn : !this.showDetail;
		this.onChange();
	}

	toggleDetail(): void {
		this.showDetail = !this.showDetail;
		this.renderMemo = null;
	}

	/** Switch tabs and rebuild. A tab id this overlay does not carry is ignored. */
	setActiveTab(tabId: string): void {
		const tabs = this.options.tabs;
		if (!tabs?.some((tab) => tab.id === tabId)) return;
		this.activeTabId = tabId;
		this.refreshTabs();
		// After the rows, not before: setItems re-anchors the cursor on the id it
		// was on, and on a tab switch that id belongs to a list the operator has
		// left. A new tab starts at its first row.
		this.selectedIndex = 0;
		this.listScrollOffset = 0;
		this.detailScrollOffset = 0;
		this.renderMemo = null;
	}

	/**
	 * The frame title. A tabbed overlay names the tab it is on, so the border
	 * and the rows below it describe the same thing.
	 */
	title(): string {
		const tab = this.activeTab();
		return tab === undefined ? this.options.title : `${this.options.title} · ${tab.label}`;
	}

	private stepTab(delta: number): boolean {
		const tabs = this.options.tabs;
		if (!tabs || tabs.length === 0) return false;
		const current = tabs.findIndex((tab) => tab.id === this.activeTabId);
		const next = tabs[((((current === -1 ? 0 : current) + delta) % tabs.length) + tabs.length) % tabs.length];
		if (!next || next.id === this.activeTabId) return false;
		// The owner is told first: it keeps its own view state keyed on the tab, and
		// rebuilding the rows before it knew which tab they were for built one tab's
		// rows against the previous tab's subjects.
		this.options.onTabChange?.(next.id);
		this.setActiveTab(next.id);
		this.onChange();
		return true;
	}

	/** The tab bar: every tab with its count, the active one in the accent token. */
	private renderTabBar(width: number): string[] {
		const tabs = this.options.tabs;
		if (!tabs || tabs.length === 0) return [];
		const theme = clioTheme();
		const parts = tabs.map((tab) => {
			const text = `${tab.label} ${this.tabCounts.get(tab.id) ?? 0}`;
			return tab.id === this.activeTabId
				? theme.style("selectedOption", `${GLYPH.cursor} ${text}`, { bold: true })
				: theme.fg("menuOption", `  ${text}`);
		});
		const full = parts.join(theme.fg("border", " │ "));
		if (visibleWidth(full) > width) {
			const active = this.activeTab();
			if (active) {
				const position = tabs.findIndex((tab) => tab.id === active.id) + 1;
				return [
					this.padLine(
						theme.fg(
							"selectedOption",
							`${GLYPH.cursor} ${active.label} ${this.tabCounts.get(active.id) ?? 0} · ${position}/${tabs.length} ←→`,
						),
						width,
					),
				];
			}
		}
		return [this.padLine(full, width)];
	}

	/**
	 * Replace the rows, keeping the operator's place.
	 *
	 * Selection is re-anchored on the selected row's id rather than its index,
	 * because a refresh that prepends a row would otherwise slide the cursor onto
	 * a different entry. The detail scroll survives only while the same id stays
	 * selected; on any other row it is a position in a document that is gone.
	 */
	setItems(items: ReadonlyArray<ListOverlayItem>): void {
		const selectedId = this.filteredItems()[this.selectedIndex]?.id;
		this.items = items;
		this.itemsEpoch += 1;
		this.filterMemo = null;
		this.renderMemo = null;
		const nextIndex = selectedId === undefined ? -1 : this.filteredItems().findIndex((item) => item.id === selectedId);
		if (nextIndex === -1) {
			this.selectIndex(Math.max(0, Math.min(this.selectedIndex, this.filteredItems().length - 1)));
			return;
		}
		this.selectedIndex = nextIndex;
	}

	private filteredItems(): ReadonlyArray<ListOverlayItem> {
		const query = this.filterText.trim();
		if (query.length === 0) return this.items;
		if (this.filterMemo?.query === query) return this.filterMemo.items;
		const items = fuzzyFilter([...this.items], query, (item) => `${item.label} ${item.group ?? ""}`);
		this.filterMemo = { query, items };
		return items;
	}

	private selectIndex(index: number): void {
		this.selectedIndex = index;
		this.detailScrollOffset = 0;
	}

	/**
	 * Run the action bound to a key, if one is bound. Reports whether the key was
	 * claimed, so a list with rows swallows its own action keys either way rather
	 * than letting one fall through to the filter.
	 */
	private runAction(data: string, filteredItems: ReadonlyArray<ListOverlayItem>): boolean {
		const global = this.options.globalActions?.[data];
		if (global) {
			global();
			this.onChange();
			return true;
		}
		const action = this.options.actions?.[data];
		if (!action) return false;
		const selectedItem = filteredItems[this.selectedIndex];
		if (selectedItem) action(selectedItem);
		return true;
	}

	/**
	 * Esc clears a nonempty filter first. Explicit search then returns to the
	 * list before a further Esc closes the overlay.
	 */
	private clearFilterOrClose(): void {
		if (this.filterText.length > 0) {
			this.filterText = "";
			this.input.setValue("");
			this.selectIndex(0);
			this.onChange();
			return;
		}
		if (this.options.explicitSearch && this.isFilterFocused) {
			this.isFilterFocused = false;
			this.onChange();
			return;
		}
		// An inner level is left before the overlay is. Drilling into a package's
		// members and pressing Esc should return to the packages, not close the
		// Library and lose the category, mode and scope the operator set.
		if (this.options.onBack?.active()) {
			this.options.onBack.back();
			this.onChange();
			return;
		}
		this.options.onClose();
	}

	/** The verb Esc carries right now, following clearFilterOrClose exactly. */
	private escapeVerb(): OverlayEscVerb {
		if (this.filterText.length > 0) return "clear filter";
		if (this.options.onBack?.active()) return "back";
		return "close";
	}

	/**
	 * The tab entry a tabbed footer carries. The verb names the active tab and
	 * how many rows it holds, so the count a reader sees is the count of the tab
	 * they are on rather than of the overlay as a whole.
	 */
	private tabHintEntry(): HintEntry | null {
		const tab = this.activeTab();
		if (tab === undefined) return null;
		const count = this.tabCounts.get(tab.id) ?? this.items.length;
		const countLabel = tab.countLabel?.(count) ?? `${count} ${tab.label.toLowerCase()}`;
		// The tab bar itself is on screen at every width, naming ←→ when it is
		// narrow, so the footer entry is a reminder that gives way before a row's keys.
		return { key: "←→", verb: `tab · ${countLabel}`, short: "tab" };
	}

	/**
	 * The footer, fitted to the rail it is drawn on. With a width the entries
	 * narrow by the shared rule, so a key a surface marked critical outlives the
	 * conveniences; without one the full hint is returned for callers that fit
	 * it themselves.
	 */
	getHint(innerWidth?: number): string {
		const { entries, esc } = this.hintEntries();
		if (innerWidth === undefined) return buildHint(entries, esc);
		return fitHintEntries([...entries, { key: "Esc", verb: esc }], innerWidth - 3);
	}

	private hintEntries(): { entries: HintEntry[]; esc: OverlayEscVerb } {
		if (this.options.explicitSearch && this.isFilterFocused) {
			return {
				entries: [{ key: "Enter", verb: "back to list", critical: true }],
				esc: this.filterText.length > 0 ? "clear filter" : "back",
			};
		}
		const tabEntry = this.tabHintEntry();
		// A list with no rows has no row to select, invoke, or act on. Offering
		// those keys anyway is the same lie the empty state exists to stop telling.
		// A tab key is the exception: on an empty tab it is the way to a full one.
		if (this.items.length === 0)
			return { entries: [...(tabEntry ? [tabEntry] : []), ...(this.options.globalHints ?? [])], esc: this.escapeVerb() };

		const hintEntries: HintEntry[] = [];
		if (tabEntry) hintEntries.push(tabEntry);
		hintEntries.push({ key: "↑↓", verb: "select" });
		// Navigation before actions, which is the order a narrowing footer drops in:
		// droppable entries go left to right, so the last one written is the last one
		// standing. Scrolling a pane is reachable only once the pane is on screen, and
		// it is the widest entry, so it goes with the arrows: at 120 columns it used
		// to outlive every global key and leave n, b and s off the rail.
		const hasDetail = this.items.some((item) => !!item.detail);
		if (hasDetail && this.detailPaneDrawn) hintEntries.push({ key: "PgUp/PgDn", verb: "scroll detail" });
		if (this.options.filterable) {
			hintEntries.push(this.options.explicitSearch ? { key: "/", verb: "search", critical: true } : FILTER_HINT);
		}
		hintEntries.push(...(this.options.globalHints ?? []));

		// Below the split threshold the footer used to advertise the scroll keys,
		// which did nothing, and drop `Enter/Tab detail`, which was the way in.
		// While no pane is on screen this key is the only way to a row's facts,
		// so a narrow footer keeps it; once a stacked pane is drawn it is a
		// toggle. The split pane is always drawn beside the list, so there the
		// key does nothing and is not advertised. While the pane has the body
		// to itself it is the way back to the rows, so it goes after the row's
		// own keys, which the pane names, and is the last key a rail lets go.
		const detailKey: HintEntry | null =
			hasDetail && !this.detailPaneSplit
				? {
						key: this.options.onSelect ? "Tab" : "Enter/Tab",
						verb: this.detailPaneDrawn ? "hide detail" : "detail",
						short: this.detailPaneDrawn ? "list" : "detail",
						critical: !this.detailPaneDrawn || this.detailTakeover,
					}
				: null;
		if (detailKey && !this.detailTakeover) hintEntries.push(detailKey);

		const hints =
			typeof this.options.hints === "function"
				? this.options.hints(this.filteredItems()[this.selectedIndex])
				: this.options.hints;
		// A row's own keys are named in its detail pane; while no pane is drawn
		// the footer is the only place they appear, so they outlive the
		// navigation reminders there.
		if (hints) {
			hintEntries.push(
				...hints.map((hint) => (this.detailPaneDrawn ? hint : { ...hint, critical: hint.critical ?? true })),
			);
		}
		if (detailKey && this.detailTakeover) hintEntries.push(detailKey);

		// The footer follows clearFilterOrClose(). With a filter typed, Esc does
		// not close, and saying it does sent operators out of an overlay they were
		// still in and back in again to find out.
		return { entries: hintEntries, esc: this.escapeVerb() };
	}

	private padLine(line: string, targetWidth: number): string {
		const w = visibleWidth(line);
		if (w >= targetWidth) return truncateToWidth(line, targetWidth, GLYPH.ellipsis, true);
		return line + " ".repeat(targetWidth - w);
	}

	/**
	 * The lead column of a two-column list at this width: the widest lead among
	 * the rows that have one, capped so the text column always keeps most of
	 * the row. Measured over every filtered row, not the visible window, so the
	 * column does not jump while the operator scrolls.
	 */
	private leadWidth(width: number, items: ReadonlyArray<ListOverlayItem>): number {
		const narrow = width <= NARROW_ROW_WIDTH;
		let widest = 0;
		for (const item of items) {
			const cells = item.cells;
			if (!cells) continue;
			widest = Math.max(widest, visibleWidth(narrow && cells.narrowLead !== undefined ? cells.narrowLead : cells.lead));
		}
		return Math.min(widest, Math.max(8, Math.floor(width * LEAD_COLUMN_SHARE)));
	}

	/**
	 * A row's label. A plain two-column row paints its lead in the option role
	 * and its text in the description role; the focused row stays plain so the
	 * selection rule paints it whole in the accent, which is how every other
	 * list marks the cursor.
	 */
	private rowLabel(item: ListOverlayItem, focused: boolean, width: number, leadWidth: number): string {
		const cells = item.cells;
		if (!cells) return item.label;
		const theme = clioTheme();
		const narrow = width <= NARROW_ROW_WIDTH;
		const lead = narrow && cells.narrowLead !== undefined ? cells.narrowLead : cells.lead;
		const fitted = padAnsi(truncateToWidth(lead, leadWidth, GLYPH.ellipsis, false), leadWidth);
		if (focused) return `${fitted}  ${cells.text}`;
		return `${theme.fg("menuOption", fitted)}  ${theme.fg("menuDescription", cells.text)}`;
	}

	/** The list's rows in draw order: each group header, then its items. */
	private renderedRowsFor(filteredItems: ReadonlyArray<ListOverlayItem>): RenderedRow[] {
		const uniqueGroups: string[] = [];
		const seenGroups = new Set<string>();
		for (const item of this.items) {
			if (item.group && !seenGroups.has(item.group)) {
				seenGroups.add(item.group);
				uniqueGroups.push(item.group);
			}
		}

		const grouped = new Map<string | undefined, ListOverlayItem[]>();
		for (const item of filteredItems) {
			const g = item.group;
			if (!grouped.has(g)) {
				grouped.set(g, []);
			}
			grouped.get(g)?.push(item);
		}

		// Indexes come from one pass over the filtered rows; `indexOf` per row
		// made a five-thousand-row list quadratic on every keystroke.
		const indexOf = new Map<ListOverlayItem, number>();
		for (const [index, item] of filteredItems.entries()) indexOf.set(item, index);
		const renderedRows: RenderedRow[] = [];
		if (grouped.has(undefined)) {
			for (const item of grouped.get(undefined) ?? []) {
				renderedRows.push({ type: "item", item, itemIndex: indexOf.get(item) ?? -1 });
			}
		}
		for (const group of uniqueGroups) {
			if (grouped.has(group)) {
				renderedRows.push({ type: "group", groupName: group });
				for (const item of grouped.get(group) ?? []) {
					renderedRows.push({ type: "item", item, itemIndex: indexOf.get(item) ?? -1 });
				}
			}
		}
		return renderedRows;
	}

	private renderList(
		width: number,
		listMaxLines: number,
		filteredItems: ReadonlyArray<ListOverlayItem>,
		renderedRows: ReadonlyArray<RenderedRow>,
	): string[] {
		const lines: string[] = [];
		const allItems = this.items;

		if (filteredItems.length === 0) {
			// A list with nothing in it and a filter that matched nothing are
			// different states. Only the first one is the caller's empty state, and
			// it wraps rather than truncating so a remedy survives a narrow pane.
			const empty =
				typeof this.options.emptyMessage === "function" ? this.options.emptyMessage() : this.options.emptyMessage;
			const remedy =
				typeof this.options.emptyRemedy === "function" ? this.options.emptyRemedy() : this.options.emptyRemedy;
			const noMatch = allItems.length > 0;
			const error = noMatch ? undefined : this.options.emptyError?.();
			const text = noMatch ? "No matches found" : (empty ?? "No matches found");
			// A read that failed is not an empty library. It says what failed, and
			// the remedy beneath it is the key that reads again.
			const rows =
				error !== undefined
					? errorState(clioTheme(), error, Math.max(1, width - 2), { detail: remedy ?? "" })
					: emptyState(clioTheme(), text, Math.max(1, width - 2), {
							remedy: noMatch ? "Esc clears the filter" : (remedy ?? ""),
						});
			for (const wrapped of rows) {
				lines.push(this.padLine(`  ${wrapped}`, width));
			}
		} else {
			const scrollRows = renderedRows.length > listMaxLines && listMaxLines > 1 ? 1 : 0;
			const itemRows = Math.max(1, listMaxLines - scrollRows);
			const selectedRowIndex = renderedRows.findIndex(
				(row) => row.type === "item" && row.itemIndex === this.selectedIndex,
			);

			if (selectedRowIndex !== -1) {
				if (selectedRowIndex < this.listScrollOffset) {
					this.listScrollOffset = selectedRowIndex;
				} else if (selectedRowIndex >= this.listScrollOffset + itemRows) {
					this.listScrollOffset = selectedRowIndex - itemRows + 1;
				}
			}

			this.listScrollOffset = Math.max(0, Math.min(this.listScrollOffset, renderedRows.length - itemRows));

			const visibleRows = renderedRows.slice(this.listScrollOffset, this.listScrollOffset + itemRows);
			const leadWidth = this.leadWidth(width - 2, filteredItems);

			for (const row of visibleRows) {
				if (row.type === "group") {
					lines.push(this.padLine(listGroupHeader(clioTheme(), row.groupName ?? ""), width));
				} else {
					const item = row.item;
					if (!item) {
						continue;
					}
					const isSelected = row.itemIndex === this.selectedIndex;
					// The name comes first at every width. Metadata used to take whatever
					// it wanted, so at 48 columns a row of origin, scope and state left
					// the package name as a single ellipsis: a list of rows nobody could
					// identify. `selectionRow` keeps the label at least half the row and
					// compacts the metadata into what is left, for every list alike.
					lines.push(
						...selectionRow(clioTheme(), {
							focused: isSelected,
							label: this.rowLabel(item, isSelected, width - 2, leadWidth),
							...(item.meta !== undefined && item.meta.length > 0 ? { meta: item.meta } : {}),
							width,
						}),
					);
				}
			}

			if (scrollRows > 0) {
				// The position names rows of the list, headers included, because that is
				// what the window slides over; the unit says what the rows are.
				const start = this.listScrollOffset + 1;
				lines.push(
					this.padLine(
						positionRow(
							clioTheme(),
							{
								start,
								end: Math.min(renderedRows.length, start + visibleRows.length - 1),
								total: renderedRows.length,
								...(this.options.unit !== undefined ? { unit: this.options.unit } : {}),
							},
							width,
						),
						width,
					),
				);
			}
		}

		return lines;
	}

	/** The pane's lines for an item at a width, memoized per item, width and skin. */
	private detailLines(width: number, selectedItem: ListOverlayItem): string[] {
		if (
			this.detailMemo &&
			this.detailMemo.item === selectedItem &&
			this.detailMemo.width === width &&
			this.detailMemo.epoch === skinEpoch()
		) {
			return this.detailMemo.lines;
		}
		const detailLines = selectedItem.detail?.(width) ?? [];
		let lines: string[];
		if (selectedItem.detailFormat === "rows") {
			// Rows laid out from the primitives already fit; only prose that was
			// handed over unwrapped folds here, at the pane's real width.
			lines = detailLines.flatMap((line) =>
				visibleWidth(line) <= width ? [line] : wrapTextWithAnsi(line, Math.max(1, width)),
			);
		} else {
			const md = new Markdown(detailLines.join("\n"), 0, 0, markdownTheme(clioTheme()));
			lines = md.render(width);
		}
		this.detailMemo = { item: selectedItem, width, epoch: skinEpoch(), lines };
		return lines;
	}

	/**
	 * The pane at `height` rows: a pinned head when the item names one and the
	 * rows leave room to scroll under it, then the window over the rest, then
	 * the position row while more remain. The page the position row counts is
	 * the page PgUp and PgDn move by, so no row is ever skipped.
	 */
	private renderDetail(width: number, height: number, selectedItem: ListOverlayItem | undefined): string[] {
		this.detailHeadText = "";
		if (!selectedItem?.detail || height <= 0) {
			return [];
		}
		const all = this.detailLines(width, selectedItem);
		const fit = (line: string): string => {
			const w = visibleWidth(line);
			if (w >= width) return truncateToWidth(line, width, GLYPH.ellipsis, true);
			return line + " ".repeat(width - w);
		};
		if (all.length <= height) {
			this.detailScrollOffset = 0;
			this.detailPage = Math.max(1, height);
			return all.map(fit);
		}
		// A pinned head keeps the title, status and keys on screen; it gives way
		// when it would leave fewer than two rows to scroll, because a pane that
		// cannot move is worse than one whose keys scroll. A one-row pane has no
		// room for its position either and shows the row alone.
		const wanted =
			selectedItem.detailFormat === "rows" ? Math.max(0, Math.floor(selectedItem.detailHead?.(width) ?? 0)) : 0;
		const head = height > 1 && wanted > 0 && height - wanted - 1 >= 2 ? Math.min(wanted, all.length) : 0;
		const scrollable = all.slice(head);
		const withPosition = height - head >= 2;
		const page = withPosition ? height - head - 1 : Math.max(1, height - head);
		const maxScrollOffset = Math.max(0, scrollable.length - page);
		this.detailScrollOffset = Math.max(0, Math.min(this.detailScrollOffset, maxScrollOffset));
		this.detailPage = page;
		const headRows = all.slice(0, head).map(fit);
		this.detailHeadText = stripTerminalSequences(headRows.join("\n"));
		const window = scrollable.slice(this.detailScrollOffset, this.detailScrollOffset + page).map(fit);
		if (!withPosition) return [...headRows, ...window];
		const position = this.padLine(
			positionRow(
				clioTheme(),
				{
					start: head + this.detailScrollOffset + 1,
					end: head + this.detailScrollOffset + window.length,
					total: all.length,
					keys: ["PgUp/PgDn scroll"],
				},
				width,
			),
			width,
		);
		return [...headRows, ...window, position];
	}

	setBodyRows(rows: number): void {
		if (rows > 0) this.setViewportRows(rows + 2);
	}

	/** The rail's room for keys; every entry it would drop is drawn in the body instead. */
	setRailRoom(cells: number): void {
		this.railRoom = Math.max(0, Math.floor(cells));
	}

	/** Called by the mounted overlay's visibility callback before each render. */
	setViewportRows(rows: number): void {
		this.viewportRows = Math.max(1, Math.floor(rows));
	}

	/**
	 * The entries the rail drops that nothing else on screen names: the arrow
	 * reminder is left out because the pane's own position row names it, and a
	 * key already drawn in the chrome (the status row's b, s and n, the compact
	 * tab bar's ←→) or in the pinned pane head is not repeated. Shedding a
	 * chrome row therefore brings the key it carried into the body.
	 */
	private droppedKeys(entries: ReadonlyArray<HintEntry>, esc: OverlayEscVerb, shownText: string): HintEntry[] {
		if (this.railRoom <= 0) return [];
		const all: HintEntry[] = [...entries, { key: "Esc", verb: esc }];
		const { kept } = fitHintEntryList(all, this.railRoom);
		const shown = (entry: HintEntry): boolean =>
			shownText.includes(`[${entry.key}]`) || (NAVIGATION_KEYS.has(entry.key) && shownText.includes(entry.key));
		return all.filter((entry) => !kept.includes(entry) && !PANE_REMINDERS.has(entry.key) && !shown(entry));
	}

	/** Dropped keys as key caps with their verbs, wrapped so none is lost. */
	private keyRows(width: number, dropped: ReadonlyArray<HintEntry>): string[] {
		if (dropped.length === 0) return [];
		const theme = clioTheme();
		const rows = (label: (entry: HintEntry) => string): string[] =>
			chipRows(
				theme,
				dropped.map((entry) => `${keyCap(theme, entry.key)} ${theme.fg("menuDescription", label(entry))}`),
				width,
			).map((row) => this.padLine(row, width));
		const full = rows((entry) => entry.verb);
		if (full.length <= 1) return full;
		// More than one row of keys: the short verbs, the way the rail shortens
		// its labels before it drops any, so the pane and the list keep their rows.
		return rows((entry) => entry.short ?? entry.verb);
	}

	render(width: number): string[] {
		const filteredItems = this.filteredItems();
		const status = this.options.status?.(width);

		if (this.selectedIndex >= filteredItems.length) {
			this.selectIndex(Math.max(0, filteredItems.length - 1));
		}

		const selectedItem = filteredItems[this.selectedIndex];
		const hasDetail = !!selectedItem?.detail;
		const isSplit = this.options.layout === "split" && width >= 90;
		// Frame memo: identical inputs return the identical array, which lets the
		// overlay frame's childLines identity cache short-circuit the whole frame.
		const memoKey = [
			skinEpoch(),
			width,
			this.viewportRows,
			this.railRoom,
			this.filterText,
			this.selectedIndex,
			this.isFilterFocused,
			this.showDetail,
			this.takeoverAllowed,
			this.listScrollOffset,
			this.detailScrollOffset,
			this.inputEpoch,
			this.itemsEpoch,
			this.activeTabId,
			status,
		].join("|");
		if (this.renderMemo?.key === memoKey) return this.renderMemo.lines;
		const theme = clioTheme();

		let tabRows = this.renderTabBar(width);
		let statusRows = status !== undefined ? [this.padLine(status, width)] : [];
		let filterRows: string[] = [];
		if (this.options.filterable) {
			this.input.focused = this.isFilterFocused;
			filterRows = this.input.render(width).map((line) => theme.base("searchQuery", line));
		}
		// The dock's rows are the budget. When they would leave no row for the
		// cursor, the chrome gives way: an empty, unfocused filter first, then the
		// tab bar, whose tab the title already names, then the status row.
		const bodyRows = Math.max(1, this.viewportRows - 2);
		const chromeRows = (): number => tabRows.length + statusRows.length + filterRows.length;
		const filterSheddable = (): boolean => filterRows.length > 0 && this.filterText.length === 0 && !this.isFilterFocused;
		if (bodyRows - chromeRows() < 1 && filterSheddable()) filterRows = [];
		if (bodyRows - chromeRows() < 1) tabRows = [];
		if (bodyRows - chromeRows() < 1) statusRows = [];

		// Every list is docked now and the dock's rows are the budget, so a list
		// fills them rather than stopping at the twelve rows a floating box kept.
		const renderedRows = this.renderedRowsFor(filteredItems);
		const paneWanted = hasDetail && (isSplit || this.showDetail);

		interface Layout {
			lines: string[];
			headText: string;
			drawn: boolean;
			/** The pane took the body over; no list row is on screen. */
			takeover: boolean;
			/** Rows the pane got, position row included; 0 when it is not drawn. */
			paneRows: number;
		}
		interface Composition {
			chrome: string[];
			final: Layout;
			/** Rows of keys the cap left no room for; those keys sit behind the dim marker. */
			overflow: number;
		}
		// One composition of the body under one chrome and one assumption about
		// whether the pane is drawn. The hints read that assumption, so the key
		// rows and the Tab verb describe the frame they sit in.
		const compose = (assumeDrawn: boolean): Composition => {
			const chrome = [...tabRows, ...statusRows, ...filterRows];
			const chromeText = stripTerminalSequences(chrome.join("\n"));
			const availableRows = Math.max(1, bodyRows - chrome.length);
			this.detailPaneDrawn = assumeDrawn;
			this.detailPaneSplit = isSplit && hasDetail && assumeDrawn;
			const { entries, esc } = this.hintEntries();
			let overflow = 0;

			const layout = (keyLines: ReadonlyArray<string>): Layout => {
				const avail = Math.max(1, availableRows - keyLines.length);
				const lines: string[] = [];
				if (isSplit && hasDetail) {
					const detailWidth = Math.max(32, Math.floor(width * 0.45));
					const listWidth = width - detailWidth - 1;
					const listLines = this.renderList(listWidth, avail, filteredItems, renderedRows);
					const detailLines = this.renderDetail(detailWidth, avail, selectedItem);
					const rows = Math.min(avail, Math.max(listLines.length, detailLines.length));
					const separator = theme.fg("border", "│");
					for (let i = 0; i < rows; i++) {
						lines.push(`${listLines[i] ?? " ".repeat(listWidth)}${separator}${detailLines[i] ?? " ".repeat(detailWidth)}`);
					}
					lines.push(...keyLines);
					return { lines, headText: this.detailHeadText, drawn: true, takeover: false, paneRows: rows };
				}
				if (paneWanted) {
					// A stacked pane takes at most half the rows, or more when the list is
					// shorter than its half, and only what its own lines need; the list
					// keeps three rows so the cursor can move. When even two pane rows
					// cannot be stacked under three list rows, the pane takes the body
					// over instead, titled by the row it describes, so the detail key is
					// never dead while two rows exist, and Tab brings the list back.
					const listFloor = Math.min(STACKED_LIST_MIN_ROWS, avail);
					const listShare = Math.max(listFloor, Math.min(renderedRows.length, Math.floor((avail - 1) / 2)));
					const detailCeiling = avail - 1 - listShare;
					if (detailCeiling >= STACKED_DETAIL_MIN_ROWS) {
						const detailLines = this.renderDetail(width, detailCeiling, selectedItem);
						const listMaxLines = Math.max(listFloor, avail - 1 - detailLines.length);
						lines.push(...this.renderList(width, listMaxLines, filteredItems, renderedRows));
						lines.push(...keyLines);
						lines.push(rule(theme, width));
						lines.push(...detailLines);
						return {
							lines,
							headText: this.detailHeadText,
							drawn: true,
							takeover: false,
							paneRows: detailLines.length,
						};
					}
					if (avail >= STACKED_DETAIL_MIN_ROWS && this.takeoverAllowed) {
						lines.push(...keyLines);
						const detailLines = this.renderDetail(width, avail, selectedItem);
						lines.push(...detailLines);
						return { lines, headText: this.detailHeadText, drawn: true, takeover: true, paneRows: detailLines.length };
					}
				}
				this.detailHeadText = "";
				lines.push(...this.renderList(width, avail, filteredItems, renderedRows));
				lines.push(...keyLines);
				return { lines, headText: "", drawn: false, takeover: false, paneRows: 0 };
			};

			// The key rows depend on what the pinned pane head shows, and the pane's
			// height on how many key rows there are; one pass with every dropped key
			// finds the head, the second lays out with the keys the head leaves. Keys
			// leave the cursor its row, or a wanted pane its two, and with eight rows
			// or more take at most half; past that, the rows they do get are whole
			// and the last one is fitted, with the dim marker for what it still holds.
			const cap = (dropped: ReadonlyArray<HintEntry>): string[] => {
				const rows = this.keyRows(width, dropped);
				// A pane that may take the body over keeps its two rows from the keys; a
				// pane that only stacks is already behind the list's three.
				const reserve = paneWanted && !isSplit && this.takeoverAllowed ? STACKED_DETAIL_MIN_ROWS : 1;
				const most = availableRows >= 8 ? Math.floor(availableRows / 2) : Math.max(0, availableRows - reserve);
				if (rows.length <= most) return rows;
				overflow = rows.length - most;
				// No row to spare: the keys stay on the rail and the cursor keeps its row.
				if (most < 1 || dropped.length === 0) return [];
				const separator = dotSep(theme);
				let rest = dropped.map(
					(entry) => `${keyCap(theme, entry.key)} ${theme.fg("menuDescription", entry.short ?? entry.verb)}`,
				);
				const kept: string[] = [];
				while (kept.length < most - 1 && rest.length > 0) {
					let take = rest.length;
					while (take > 1 && visibleWidth(rest.slice(0, take).join(separator)) > width) take -= 1;
					kept.push(this.padLine(rest.slice(0, take).join(separator), width));
					rest = rest.slice(take);
				}
				if (rest.length > 0) kept.push(this.padLine(fitUnits(theme, "", rest, width), width));
				return kept;
			};
			const first = layout(cap(this.droppedKeys(entries, esc, chromeText)));
			overflow = 0;
			const final = layout(cap(this.droppedKeys(entries, esc, `${chromeText}\n${first.headText}`)));
			return { chrome, final, overflow };
		};

		// The chrome gives way a second time when it would buy the operator a
		// key or the pane: an empty, unfocused filter row is shed when the key
		// rows are cut or a stacked pane is down to a row or two of facts, since
		// `/` is in the keys and a pane that pages one row at a time reads
		// nothing; the tab bar, whose ←→ then moves into the keys, goes next for
		// the same reasons, and the status row only when the pane still cannot
		// get its two rows. A row is shed only if the frame without it is better:
		// fewer keys behind the marker, a pane that now draws, or a thin pane
		// that grew. Otherwise it stays, because what it said is not elsewhere.
		let composed = compose(paneWanted);
		const thin = (): boolean =>
			paneWanted && (!composed.final.drawn || composed.final.paneRows < STACKED_DETAIL_MIN_ROWS + 2);
		const wantsRoom = (): boolean => composed.overflow > 0 || thin();
		const better = (next: Composition, prev: Composition): boolean =>
			next.overflow < prev.overflow ||
			(paneWanted && !prev.final.drawn && next.final.drawn) ||
			(paneWanted &&
				prev.final.drawn &&
				prev.final.paneRows < STACKED_DETAIL_MIN_ROWS + 2 &&
				next.final.paneRows > prev.final.paneRows &&
				next.overflow <= prev.overflow);
		const tryShed = (shed: () => void, restore: () => void): void => {
			shed();
			const next = compose(paneWanted);
			if (better(next, composed)) composed = next;
			else restore();
		};
		if (wantsRoom() && filterSheddable()) {
			const kept = filterRows;
			tryShed(
				() => {
					filterRows = [];
				},
				() => {
					filterRows = kept;
				},
			);
		}
		if (wantsRoom() && tabRows.length > 0) {
			const kept = tabRows;
			tryShed(
				() => {
					tabRows = [];
				},
				() => {
					tabRows = kept;
				},
			);
		}
		if (paneWanted && !isSplit && !composed.final.drawn && statusRows.length > 0) {
			const kept = statusRows;
			tryShed(
				() => {
					statusRows = [];
				},
				() => {
					statusRows = kept;
				},
			);
		}
		// The hints assumed the pane state; when the layout decided otherwise the
		// frame is composed again under the real one, so the Tab verb and the key
		// rows never describe a pane that is not there, and the key that brings
		// the rows back outranks the rest while the pane has the body to itself.
		for (
			let pass = 0;
			pass < 2 && (composed.final.drawn !== this.detailPaneDrawn || composed.final.takeover !== this.detailTakeover);
			pass += 1
		) {
			this.detailTakeover = composed.final.takeover;
			composed = compose(composed.final.drawn);
		}
		this.detailTakeover = composed.final.takeover;
		this.detailPaneDrawn = composed.final.drawn;
		this.detailPaneSplit = composed.final.drawn && isSplit;
		const lines = [...composed.chrome, ...composed.final.lines];

		this.renderMemo = { key: memoKey, lines };
		return lines;
	}

	private detailPaneVisible(): boolean {
		return this.detailPaneDrawn;
	}

	get keyboardScope(): "edit" | "browse" {
		return this.isFilterFocused ? "edit" : "browse";
	}
	undoInput(): boolean {
		if (!this.isFilterFocused) return false;
		this.input.applyEdit("undo");
		this.filterText = this.input.getValue();
		this.inputEpoch += 1;
		this.selectIndex(0);
		this.onChange();
		return true;
	}
	handleInput(data: string): void {
		data = localKey(data);
		if (matchesKey(data, "escape")) {
			this.clearFilterOrClose();
			return;
		}
		if (this.options.filterable && this.options.explicitSearch && !this.isFilterFocused && data === "/") {
			this.isFilterFocused = true;
			this.onChange();
			return;
		}
		// Explicit search owns its cursor arrows. Otherwise ←/→ switch tabs,
		// matching the Settings Center's section navigation.
		if (this.options.tabs && this.options.tabs.length > 0 && !(this.options.explicitSearch && this.isFilterFocused)) {
			if (matchesKey(data, "left")) {
				this.stepTab(-1);
				return;
			}
			if (matchesKey(data, "right")) {
				this.stepTab(1);
				return;
			}
		}

		// PgDn / Ctrl+D and PgUp / Ctrl+U scroll the detail pane, but only
		// while one is visible; otherwise the keys fall through untouched.
		if (this.detailPaneVisible() && !(this.options.explicitSearch && this.isFilterFocused)) {
			if (data === "\x1b[6~" || data === "\x04") {
				this.detailScrollOffset += this.detailPage;
				this.onChange();
				return;
			}
			if (data === "\x1b[5~" || data === "\x15") {
				this.detailScrollOffset = Math.max(0, this.detailScrollOffset - this.detailPage);
				this.onChange();
				return;
			}
		}

		const filteredItems = this.filteredItems();

		if (this.isFilterFocused) {
			if (matchesKey(data, "up")) {
				if (filteredItems.length > 0) {
					this.selectIndex(this.selectedIndex === 0 ? filteredItems.length - 1 : this.selectedIndex - 1);
				}
				this.isFilterFocused = false;
				this.onChange();
				return;
			}
			if (matchesKey(data, "down")) {
				if (filteredItems.length > 0) {
					this.selectIndex(this.selectedIndex === filteredItems.length - 1 ? 0 : this.selectedIndex + 1);
				}
				this.isFilterFocused = false;
				this.onChange();
				return;
			}
			if (matchesKey(data, "enter") || data === "\n") {
				if (this.options.explicitSearch) {
					this.isFilterFocused = false;
					this.onChange();
					return;
				}
				if (this.options.onSelect) {
					const selectedItem = filteredItems[this.selectedIndex];
					if (selectedItem) {
						this.options.onSelect(selectedItem);
					}
				} else {
					this.toggleDetailByKey();
				}
				return;
			}
			if (matchesKey(data, "tab")) {
				this.toggleDetailByKey();
				return;
			}
			if (matchesKey(data, "esc")) {
				this.clearFilterOrClose();
				return;
			}

			this.inputEpoch += 1;
			this.input.handleInput(data);
			const next = this.input.getValue();
			if (next !== this.filterText) {
				this.filterText = next;
				this.selectIndex(0);
			}
			this.onChange();
		} else {
			if (matchesKey(data, "up") || data === "k") {
				if (filteredItems.length > 0) {
					this.selectIndex(this.selectedIndex === 0 ? filteredItems.length - 1 : this.selectedIndex - 1);
				}
				this.onChange();
				return;
			}
			if (matchesKey(data, "down") || data === "j") {
				if (filteredItems.length > 0) {
					this.selectIndex(this.selectedIndex === filteredItems.length - 1 ? 0 : this.selectedIndex + 1);
				}
				this.onChange();
				return;
			}
			if (matchesKey(data, "enter") || data === "\n") {
				if (this.options.onSelect) {
					const selectedItem = filteredItems[this.selectedIndex];
					if (selectedItem) {
						this.options.onSelect(selectedItem);
					}
				} else {
					this.toggleDetailByKey();
				}
				return;
			}
			if (matchesKey(data, "tab")) {
				this.toggleDetailByKey();
				return;
			}
			if (matchesKey(data, "esc")) {
				this.clearFilterOrClose();
				return;
			}

			if (this.runAction(data, filteredItems)) return;

			if (this.options.filterable && !this.options.explicitSearch && matchesKey(data, "backspace")) {
				this.isFilterFocused = true;
				this.inputEpoch += 1;
				this.input.handleInput(data);
				this.filterText = this.input.getValue();
				this.selectIndex(0);
				this.onChange();
				return;
			}

			if (this.options.filterable && !this.options.explicitSearch && data.length === 1 && !matchesKey(data, "space")) {
				this.isFilterFocused = true;
				this.inputEpoch += 1;
				this.input.handleInput(data);
				this.filterText = this.input.getValue();
				this.selectIndex(0);
				this.onChange();
				return;
			}
		}
	}

	invalidate(): void {
		this.input.invalidate();
	}
}

/** A rows-mode pane in two parts: the head the engine pins while the rest scrolls. */
export interface DetailParts {
	head: string[];
	rest: string[];
}

/**
 * The detail fields of a rows-mode item from a builder that separates the
 * pinned head from the rest. Built once per width and skin, and served to both
 * the rows and the head count.
 */
export function detailWithHead(
	build: (width: number) => DetailParts,
): Pick<ListOverlayItem, "detail" | "detailHead" | "detailFormat"> {
	let memo: { width: number; epoch: number; parts: DetailParts } | null = null;
	const parts = (width: number): DetailParts => {
		if (memo && memo.width === width && memo.epoch === skinEpoch()) return memo.parts;
		memo = { width, epoch: skinEpoch(), parts: build(width) };
		return memo.parts;
	};
	return {
		detailFormat: "rows",
		detail: (width) => {
			const built = parts(width);
			return [...built.head, ...built.rest];
		},
		detailHead: (width) => parts(width).head.length,
	};
}

/**
 * Prose under a rows-mode detail: Markdown rendered at the pane's width, so a
 * description's code spans, emphasis and links keep their styling beneath the
 * fact table instead of showing their markup.
 */
export function markdownRows(text: string, width: number): string[] {
	return new Markdown(text, 0, 0, markdownTheme(clioTheme())).render(Math.max(1, Math.floor(width)));
}

export interface ListOverlayHandle extends OverlayHandle {
	/**
	 * Replace the rows and repaint. The view memoizes its whole frame on a row-set
	 * epoch only this bumps, so a caller that mutates the array it handed in draws
	 * the frame from before its own change until some other key moves the memo key.
	 */
	setItems(items: ReadonlyArray<ListOverlayItem>): void;
	/**
	 * Rebuild every tab's rows in place, keeping the active tab and the
	 * operator's place in it. Inert on an untabbed overlay.
	 */
	refreshTabs(): void;
	/** Switch tabs programmatically. An id this overlay does not carry is ignored. */
	setActiveTab(tabId: string): void;
	/** The active tab's id, or the empty string on an untabbed overlay. */
	activeTabId(): string;
	/** Move the cursor onto a row by id; false when this view has no such row. */
	selectById(id: string): boolean;
	/** Show or hide the stacked detail pane. */
	toggleDetail(): void;
	/** Drop a typed filter and leave search focus. */
	clearFilter(): void;
}

/**
 * The marker id rides on the opener rather than on `ListOverlayOptions` because
 * it belongs to the mounted modal, not to the view: the view renders the same
 * rows whether it is a modal or a body inside something else. It is named by
 * the surface rather than derived from `title`, because a tabbed overlay's
 * rendered title names the active tab while the modal holding the keyboard has
 * not changed hands.
 */
export function openListOverlay(tui: TUI, options: ListOverlayOptions & { markerId: string }): ListOverlayHandle {
	const view = new ListOverlayView(options, () => tui.requestRender());
	const handle = showClioOverlayFrame(tui, view, {
		anchor: "center",
		width: options.fullScreen ? "100%" : 100,
		...(options.fullScreen
			? {
					margin: 0,
					maxHeight: "100%" as const,
					visible: (_width: number, rows: number) => {
						view.setViewportRows(rows);
						return true;
					},
				}
			: {}),
		markerId: options.markerId,
		// A function, not the string: on a tabbed overlay the title names the tab
		// and must be re-read after every switch.
		title: () => view.title(),
		footerHint: (innerWidth) => view.getHint(innerWidth),
	});
	return Object.assign(handle, {
		setItems(items: ReadonlyArray<ListOverlayItem>): void {
			view.setItems(items);
			tui.requestRender();
		},
		refreshTabs(): void {
			view.refreshTabs();
			tui.requestRender();
		},
		setActiveTab(tabId: string): void {
			view.setActiveTab(tabId);
			tui.requestRender();
		},
		activeTabId(): string {
			return view.activeTab()?.id ?? "";
		},
		selectById(id: string): boolean {
			const found = view.selectById(id);
			if (found) tui.requestRender();
			return found;
		},
		toggleDetail(): void {
			view.toggleDetail();
			tui.requestRender();
		},
		clearFilter(): void {
			view.clearFilter();
			tui.requestRender();
		},
	});
}
