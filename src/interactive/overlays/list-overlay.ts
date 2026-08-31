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
import { buildHint, FILTER_HINT, type HintEntry, showClioOverlayFrame } from "../overlay-frame.js";
import { clioTheme, GLYPH, listGroupHeader, markdownTheme, rule, selectListTheme } from "../theme/index.js";

const ELLIPSIS = "…";

export interface ListOverlayItem {
	id: string;
	/** Left-column text, already themed by the caller. */
	label: string;
	/** Optional dim right-aligned column (origin, scope, version...). */
	meta?: string;
	/** Group header this item renders under, e.g. "project", "marketplace". */
	group?: string;
	/**
	 * Lines for the detail pane, lazily computed at the pane's real width. May
	 * contain markdown. Providers that laid themselves out at a guessed width had
	 * their own wrapped lines re-wrapped by the pane, which repeated the row
	 * label on every continuation line.
	 */
	detail?: (width: number) => string[];
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
}

export interface ListOverlayOptions {
	title: string;
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
	/** Pre-applied filter text (e.g. /skill <query> in milestone 04). */
	initialFilter?: string;
	/** Extra hint entries beyond movement/filter/Esc (builder appends Esc). */
	hints?: ReadonlyArray<{ key: string; verb: string }>;
	/** Custom message when list is empty. */
	emptyMessage?: string;
	/** Layout mode: stack (detail below list) or split (detail to the right). */
	layout?: "stack" | "split";
	/** Primary action; omitted means Enter toggles the detail pane. */
	onSelect?: (item: ListOverlayItem) => void;
	/** Secondary keyed actions, e.g. { i: install }. */
	actions?: Record<string, (item: ListOverlayItem) => void>;
	onClose: () => void;
}

export class ListOverlayView implements Component {
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
	private detailMemo: { item: ListOverlayItem; width: number; lines: string[] } | null = null;
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
		this.isFilterFocused = !!options.filterable;
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
		this.setActiveTab(next.id);
		this.options.onTabChange?.(next.id);
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
				? theme.style("accent", `${GLYPH.cursor} ${text}`, { bold: true })
				: theme.fg("dim", `  ${text}`);
		});
		return [this.padLine(parts.join(theme.fg("frame", " │ ")), width)];
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
		const action = this.options.actions?.[data];
		if (!action) return false;
		const selectedItem = filteredItems[this.selectedIndex];
		if (selectedItem) action(selectedItem);
		return true;
	}

	/**
	 * Esc semantics shared by every list overlay regardless of which pane has
	 * focus: first Esc clears a nonempty filter, second Esc closes.
	 */
	private clearFilterOrClose(): void {
		if (this.filterText.length > 0) {
			this.filterText = "";
			this.input.setValue("");
			this.selectIndex(0);
			this.onChange();
			return;
		}
		this.options.onClose();
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
		return { key: "←→", verb: `tab · ${count} ${tab.label.toLowerCase()}`, short: "tab", critical: true };
	}

	getHint(): string {
		const tabEntry = this.tabHintEntry();
		// A list with no rows has no row to select, invoke, or act on. Offering
		// those keys anyway is the same lie the empty state exists to stop telling.
		// A tab key is the exception: on an empty tab it is the way to a full one.
		if (this.items.length === 0) return buildHint(tabEntry ? [tabEntry] : [], "close");

		const hintEntries: HintEntry[] = [];
		if (tabEntry) hintEntries.push(tabEntry);
		hintEntries.push({ key: "↑↓", verb: "select" });
		if (this.options.filterable) {
			hintEntries.push(FILTER_HINT);
		}

		// Navigation before actions, which is the order a narrowing footer drops in:
		// droppable entries go left to right, so the last one written is the last one
		// standing. Scrolling a pane is reachable only once the pane is on screen, and
		// the key that puts it there is the one worth keeping at 73 columns. Below the
		// split threshold the footer used to advertise the scroll keys, which did
		// nothing, and drop `Enter/Tab detail`, which was the way in.
		const hasDetail = this.items.some((item) => !!item.detail);
		if (hasDetail) {
			if (this.detailPaneDrawn) {
				hintEntries.push({ key: "PgUp/PgDn", verb: "scroll detail" });
			}
			hintEntries.push({ key: this.options.onSelect ? "Tab" : "Enter/Tab", verb: "detail" });
		}

		if (this.options.hints) {
			hintEntries.push(...this.options.hints);
		}

		// The footer follows clearFilterOrClose(). With a filter typed, Esc does
		// not close, and saying it does sent operators out of an overlay they were
		// still in and back in again to find out.
		return buildHint(hintEntries, this.filterText.length > 0 ? "clear filter" : "close");
	}

	private padLine(line: string, targetWidth: number): string {
		const w = visibleWidth(line);
		if (w >= targetWidth) return truncateToWidth(line, targetWidth, ELLIPSIS, true);
		return line + " ".repeat(targetWidth - w);
	}

	private renderList(
		width: number,
		listMaxLines: number,
		filteredItems: ReadonlyArray<ListOverlayItem>,
		pad: boolean,
	): string[] {
		const lines: string[] = [];
		const allItems = this.items;

		const uniqueGroups: string[] = [];
		const seenGroups = new Set<string>();
		for (const item of allItems) {
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

		interface RenderedRow {
			type: "group" | "item";
			groupName?: string;
			item?: ListOverlayItem;
			itemIndex?: number;
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

		if (filteredItems.length === 0) {
			// A list with nothing in it and a filter that matched nothing are
			// different states. Only the first one is the caller's empty state, and
			// it wraps rather than truncating so a remedy survives a narrow pane.
			const text = allItems.length === 0 ? (this.options.emptyMessage ?? "No matches found") : "No matches found";
			for (const wrapped of wrapTextWithAnsi(text, Math.max(1, width - 2))) {
				lines.push(this.padLine(clioTheme().fg("muted", `  ${wrapped}`), width));
			}
		} else {
			const selectedRowIndex = renderedRows.findIndex(
				(row) => row.type === "item" && row.itemIndex === this.selectedIndex,
			);

			if (selectedRowIndex !== -1) {
				if (selectedRowIndex < this.listScrollOffset) {
					this.listScrollOffset = selectedRowIndex;
				} else if (selectedRowIndex >= this.listScrollOffset + listMaxLines) {
					this.listScrollOffset = selectedRowIndex - listMaxLines + 1;
				}
			}

			this.listScrollOffset = Math.max(0, Math.min(this.listScrollOffset, renderedRows.length - listMaxLines));

			const visibleRows = renderedRows.slice(this.listScrollOffset, this.listScrollOffset + listMaxLines);
			const theme = selectListTheme(clioTheme());

			for (const row of visibleRows) {
				if (row.type === "group") {
					lines.push(this.padLine(listGroupHeader(clioTheme(), row.groupName ?? ""), width));
				} else {
					const item = row.item;
					if (!item) {
						continue;
					}
					const isSelected = row.itemIndex === this.selectedIndex;

					const prefix = isSelected ? theme.selectedPrefix(`${GLYPH.cursor} `) : "  ";
					const prefixLen = 2;
					const availableWidth = width - prefixLen;
					const metaStr = item.meta ?? "";
					const metaLen = metaStr ? visibleWidth(metaStr) : 0;

					const maxLabelWidth = Math.max(1, availableWidth - (metaLen > 0 ? metaLen + 2 : 0));
					const truncatedLabel = truncateToWidth(item.label, maxLabelWidth, ELLIPSIS, true);
					const actualLabelWidth = visibleWidth(truncatedLabel);

					const spacing = " ".repeat(Math.max(1, availableWidth - actualLabelWidth - metaLen));

					let labelPart = truncatedLabel;
					let metaPart = metaStr;

					if (isSelected) {
						labelPart = theme.selectedText(truncatedLabel);
						if (metaStr) {
							metaPart = theme.selectedText(metaStr);
						}
					} else {
						if (metaStr) {
							metaPart = metaStr.includes("\x1b") || metaStr.includes("\x1B") ? metaStr : clioTheme().fg("dim", metaStr);
						}
					}

					lines.push(this.padLine(`${prefix}${labelPart}${spacing}${metaPart}`, width));
				}
			}

			if (renderedRows.length > listMaxLines) {
				const scrollText = `  (${this.selectedIndex + 1}/${filteredItems.length})`;
				lines.push(this.padLine(theme.scrollInfo(truncateToWidth(scrollText, width - 2, "")), width));
			}
		}

		if (pad) {
			while (lines.length < listMaxLines) {
				lines.push(" ".repeat(width));
			}
		}
		return lines;
	}

	private renderDetail(width: number, height: number, selectedItem: ListOverlayItem | undefined): string[] {
		if (!selectedItem?.detail) {
			return Array.from({ length: height }, () => " ".repeat(width));
		}
		let mdLines: string[];
		if (this.detailMemo && this.detailMemo.item === selectedItem && this.detailMemo.width === width) {
			mdLines = this.detailMemo.lines;
		} else {
			const detailLines = selectedItem.detail(width);
			const md = new Markdown(detailLines.join("\n"), 0, 0, markdownTheme(clioTheme()));
			mdLines = md.render(width);
			this.detailMemo = { item: selectedItem, width, lines: mdLines };
		}

		const maxScrollOffset = Math.max(0, mdLines.length - height);
		this.detailScrollOffset = Math.max(0, Math.min(this.detailScrollOffset, maxScrollOffset));

		const sliced = mdLines.slice(this.detailScrollOffset, this.detailScrollOffset + height);
		const padded = sliced.map((line) => {
			const w = visibleWidth(line);
			if (w >= width) return truncateToWidth(line, width, ELLIPSIS, true);
			return line + " ".repeat(width - w);
		});

		while (padded.length < height) {
			padded.push(" ".repeat(width));
		}
		return padded;
	}

	render(width: number): string[] {
		const filteredItems = this.filteredItems();

		if (this.selectedIndex >= filteredItems.length) {
			this.selectIndex(Math.max(0, filteredItems.length - 1));
		}

		const selectedItem = filteredItems[this.selectedIndex];
		const hasDetail = !!selectedItem?.detail;
		const isSplit = this.options.layout === "split" && width >= 90;
		// Recorded before the memo returns, so a cached frame still leaves the footer
		// describing the pane this width draws.
		this.detailPaneDrawn = isSplit || (this.showDetail && hasDetail);

		// Frame memo: identical inputs return the identical array, which lets the
		// overlay frame's childLines identity cache short-circuit the whole frame.
		const memoKey = [
			width,
			this.filterText,
			this.selectedIndex,
			this.isFilterFocused,
			this.showDetail,
			this.listScrollOffset,
			this.detailScrollOffset,
			this.inputEpoch,
			this.itemsEpoch,
			this.activeTabId,
		].join("|");
		if (this.renderMemo?.key === memoKey) return this.renderMemo.lines;

		const lines: string[] = [];

		lines.push(...this.renderTabBar(width));

		if (this.options.filterable) {
			this.input.focused = this.isFilterFocused;
			const inputLines = this.input.render(width);
			lines.push(...inputLines);
		}

		if (isSplit) {
			const listMaxLines = 14;
			const detailWidth = Math.max(32, Math.floor(width * 0.45));
			const listWidth = width - detailWidth - 1;

			const listLines = this.renderList(listWidth, listMaxLines, filteredItems, true);
			const detailLines = this.renderDetail(detailWidth, listMaxLines, selectedItem);

			for (let i = 0; i < listMaxLines; i++) {
				const left = listLines[i] ?? " ".repeat(listWidth);
				const right = detailLines[i] ?? " ".repeat(detailWidth);
				const separator = clioTheme().fg("frame", "│");
				lines.push(`${left}${separator}${right}`);
			}
		} else {
			const listMaxLines = this.showDetail && hasDetail ? 6 : 12;
			const listLines = this.renderList(width, listMaxLines, filteredItems, false);
			lines.push(...listLines);

			if (this.showDetail && hasDetail) {
				lines.push(rule(clioTheme(), width));
				const detailLines = this.renderDetail(width, 10, selectedItem);
				lines.push(...detailLines);
			}
		}

		this.renderMemo = { key: memoKey, lines };
		return lines;
	}

	private detailPaneVisible(): boolean {
		return this.options.layout === "split" || this.showDetail;
	}

	handleInput(data: string): void {
		// ←/→ switch tabs from either pane, ahead of the filter input, which is
		// the arrangement the Settings Center already uses to move between
		// sections. On an untabbed overlay both keys fall through untouched.
		if (this.options.tabs && this.options.tabs.length > 0) {
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
		if (this.detailPaneVisible()) {
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

			// The footer advertises the action keys from the moment the overlay opens
			// and the filter input holds focus then, so the first `d` an operator
			// pressed in /interop landed in the filter box instead of declining the
			// selected row. An empty query has nothing to narrow, so a bound key acts
			// on the selection. Once a query is typed the letters belong to it, and
			// ↑/↓ hands focus back to the list where the same keys act again.
			if (this.filterText.length === 0 && data.length === 1 && this.runAction(data, filteredItems)) return;

			this.inputEpoch += 1;
			this.input.handleInput(data);
			const next = this.input.getValue();
			if (next !== this.filterText) {
				this.filterText = next;
				this.selectIndex(0);
				this.onChange();
			}
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

			if (this.options.filterable && matchesKey(data, "backspace")) {
				this.isFilterFocused = true;
				this.inputEpoch += 1;
				this.input.handleInput(data);
				this.filterText = this.input.getValue();
				this.selectIndex(0);
				this.onChange();
				return;
			}

			if (this.options.filterable && data.length === 1 && !matchesKey(data, "space")) {
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
		width: 100,
		markerId: options.markerId,
		// A function, not the string: on a tabbed overlay the title names the tab
		// and must be re-read after every switch.
		title: () => view.title(),
		footerHint: () => view.getHint(),
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
	});
}
