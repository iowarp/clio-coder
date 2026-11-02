import {
	type Component,
	fuzzyFilter,
	Input,
	Markdown,
	matchesKey,
	type OverlayHandle,
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
	type HintEntry,
	type OverlayEscVerb,
	showClioOverlayFrame,
} from "../overlay-frame.js";
import {
	clioTheme,
	emptyState,
	errorState,
	GLYPH,
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
		if (hasDetail) {
			// While no pane is on screen this key is the only way to a row's facts,
			// so a narrow footer keeps it; once a stacked pane is drawn it is a
			// toggle. The split pane is always drawn beside the list, so there the
			// key does nothing and is not advertised.
			if (!this.detailPaneSplit)
				hintEntries.push({
					key: this.options.onSelect ? "Tab" : "Enter/Tab",
					verb: "detail",
					critical: !this.detailPaneDrawn,
				});
		}

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

		const renderedRows: RenderedRow[] = [];
		if (grouped.has(undefined)) {
			for (const item of grouped.get(undefined) ?? []) {
				renderedRows.push({ type: "item", item, itemIndex: filteredItems.indexOf(item) });
			}
		}
		for (const group of uniqueGroups) {
			if (grouped.has(group)) {
				renderedRows.push({ type: "group", groupName: group });
				for (const item of grouped.get(group) ?? []) {
					renderedRows.push({ type: "item", item, itemIndex: filteredItems.indexOf(item) });
				}
			}
		}
		return renderedRows;
	}

	private renderList(width: number, listMaxLines: number, filteredItems: ReadonlyArray<ListOverlayItem>): string[] {
		const lines: string[] = [];
		const allItems = this.items;
		const renderedRows = this.renderedRowsFor(filteredItems);

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

	private renderDetail(width: number, height: number, selectedItem: ListOverlayItem | undefined): string[] {
		if (!selectedItem?.detail) {
			return [];
		}
		let mdLines: string[];
		if (
			this.detailMemo &&
			this.detailMemo.item === selectedItem &&
			this.detailMemo.width === width &&
			this.detailMemo.epoch === skinEpoch()
		) {
			mdLines = this.detailMemo.lines;
		} else {
			const detailLines = selectedItem.detail(width);
			if (selectedItem.detailFormat === "rows") {
				// Rows laid out from the primitives already fit; only prose that was
				// handed over unwrapped folds here, at the pane's real width.
				mdLines = detailLines.flatMap((line) =>
					visibleWidth(line) <= width ? [line] : wrapTextWithAnsi(line, Math.max(1, width)),
				);
			} else {
				const md = new Markdown(detailLines.join("\n"), 0, 0, markdownTheme(clioTheme()));
				mdLines = md.render(width);
			}
			this.detailMemo = { item: selectedItem, width, epoch: skinEpoch(), lines: mdLines };
		}

		// A pane that holds more than it shows keeps one row for its position, so
		// a scrolled fact table is never mistaken for the whole of it.
		const scrollable = mdLines.length > height && height > 1;
		const page = scrollable ? height - 1 : height;
		const maxScrollOffset = Math.max(0, mdLines.length - page);
		this.detailScrollOffset = Math.max(0, Math.min(this.detailScrollOffset, maxScrollOffset));

		const sliced = mdLines.slice(this.detailScrollOffset, this.detailScrollOffset + page);
		const padded = sliced.map((line) => {
			const w = visibleWidth(line);
			if (w >= width) return truncateToWidth(line, width, GLYPH.ellipsis, true);
			return line + " ".repeat(width - w);
		});
		if (scrollable) {
			padded.push(
				this.padLine(
					positionRow(
						clioTheme(),
						{
							start: this.detailScrollOffset + 1,
							end: this.detailScrollOffset + sliced.length,
							total: mdLines.length,
							keys: ["PgUp/PgDn scroll"],
						},
						width,
					),
					width,
				),
			);
		}

		return padded;
	}

	setBodyRows(rows: number): void {
		if (rows > 0) this.setViewportRows(rows + 2);
	}

	/** Called by the mounted overlay's visibility callback before each render. */
	setViewportRows(rows: number): void {
		this.viewportRows = Math.max(1, Math.floor(rows));
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
			this.filterText,
			this.selectedIndex,
			this.isFilterFocused,
			this.showDetail,
			this.listScrollOffset,
			this.detailScrollOffset,
			this.inputEpoch,
			this.itemsEpoch,
			this.activeTabId,
			status,
		].join("|");
		if (this.renderMemo?.key === memoKey) return this.renderMemo.lines;
		// A cached frame retains the same detail visibility and keyboard hints.
		this.detailPaneDrawn = isSplit && hasDetail;
		this.detailPaneSplit = isSplit && hasDetail;

		const lines: string[] = [];

		lines.push(...this.renderTabBar(width));
		if (status !== undefined) lines.push(this.padLine(status, width));

		if (this.options.filterable) {
			this.input.focused = this.isFilterFocused;
			const inputLines = this.input.render(width).map((line) => clioTheme().base("searchQuery", line));
			lines.push(...inputLines);
		}

		// Every list is docked now and the dock's rows are the budget, so a list
		// fills them rather than stopping at the twelve rows a floating box kept.
		const availableRows = Math.max(1, this.viewportRows - 2 - lines.length);
		if (isSplit) {
			const listMaxLines = availableRows;
			const detailWidth = Math.max(32, Math.floor(width * 0.45));
			const listWidth = width - detailWidth - 1;

			const listLines = this.renderList(listWidth, listMaxLines, filteredItems);
			const detailLines = this.renderDetail(detailWidth, listMaxLines, selectedItem);

			const bodyRows = Math.min(listMaxLines, Math.max(listLines.length, detailLines.length));
			for (let i = 0; i < bodyRows; i++) {
				const left = listLines[i] ?? " ".repeat(listWidth);
				const right = detailLines[i] ?? " ".repeat(detailWidth);
				const separator = clioTheme().fg("border", "│");
				lines.push(`${left}${separator}${right}`);
			}
		} else {
			const showDetail = this.showDetail && hasDetail;
			// A stacked detail takes at most half the rows, or more when the list
			// is shorter than its half, and only what its own lines need, so a
			// short page hands the rest back to the list. The list keeps three rows
			// so the cursor can move, and a pane that would get fewer than two rows
			// is not drawn: on a 14-row terminal the Library used to leave one list
			// row under a two-row detail nobody could read.
			const listFloor = Math.min(STACKED_LIST_MIN_ROWS, availableRows);
			const listNatural = this.renderedRowsFor(filteredItems).length;
			const listShare = Math.max(listFloor, Math.min(listNatural, Math.floor((availableRows - 1) / 2)));
			const detailCeiling = Math.max(0, availableRows - 1 - listShare);
			const detailLines =
				showDetail && detailCeiling >= STACKED_DETAIL_MIN_ROWS ? this.renderDetail(width, detailCeiling, selectedItem) : [];
			this.detailPaneDrawn = detailLines.length > 0;
			const listMaxLines = this.detailPaneDrawn
				? Math.max(listFloor, availableRows - 1 - detailLines.length)
				: availableRows;
			lines.push(...this.renderList(width, listMaxLines, filteredItems));
			if (this.detailPaneDrawn) {
				lines.push(rule(clioTheme(), width));
				lines.push(...detailLines);
			}
		}

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
				this.detailScrollOffset += 5;
				this.onChange();
				return;
			}
			if (data === "\x1b[5~" || data === "\x15") {
				this.detailScrollOffset = Math.max(0, this.detailScrollOffset - 5);
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
					this.showDetail = !this.showDetail;
					this.onChange();
				}
				return;
			}
			if (matchesKey(data, "tab")) {
				this.showDetail = !this.showDetail;
				this.onChange();
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
					this.showDetail = !this.showDetail;
					this.onChange();
				}
				return;
			}
			if (matchesKey(data, "tab")) {
				this.showDetail = !this.showDetail;
				this.onChange();
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
