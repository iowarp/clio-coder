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
} from "../../engine/tui.js";
import { buildHint, type HintEntry, showClioOverlayFrame } from "../overlay-frame.js";
import { clioTheme, markdownTheme, selectListTheme } from "../theme/index.js";

export interface ListOverlayItem {
	id: string;
	/** Left-column text, already themed by the caller. */
	label: string;
	/** Optional dim right-aligned column (origin, scope, version...). */
	meta?: string;
	/** Group header this item renders under, e.g. "project", "marketplace". */
	group?: string;
	/** Lines for the detail pane, lazily computed. May contain markdown. */
	detail?: () => string[];
}

export interface ListOverlayOptions {
	title: string;
	mode: "browse" | "commit";
	items: ReadonlyArray<ListOverlayItem>;
	/** Enables the type-to-filter input row. */
	filterable?: boolean;
	/** Pre-applied filter text (e.g. /skill <query> in milestone 04). */
	initialFilter?: string;
	/** Extra hint entries beyond movement/filter/Esc (builder appends Esc). */
	hints?: ReadonlyArray<{ key: string; verb: string }>;
	/** Custom message when list is empty. */
	emptyMessage?: string;
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
	private readonly input: Input;

	constructor(
		private readonly options: ListOverlayOptions,
		private readonly onChange: () => void,
	) {
		this.isFilterFocused = !!options.filterable;
		this.filterText = options.initialFilter ?? "";
		this.input = new Input();
		if (options.initialFilter) {
			this.input.setValue(options.initialFilter);
		}
	}

	getHint(): string {
		const hintEntries: HintEntry[] = [];
		hintEntries.push({ key: "↑↓", verb: "select" });
		if (this.options.filterable) {
			hintEntries.push({ key: "type", verb: "filter" });
		}

		const hasDetail = this.options.items.some((item) => !!item.detail);
		if (hasDetail) {
			if (!this.options.onSelect) {
				hintEntries.push({ key: "Enter/Tab", verb: "detail" });
			} else {
				hintEntries.push({ key: "Tab", verb: "detail" });
			}
		}

		if (this.options.hints) {
			hintEntries.push(...this.options.hints);
		}

		return buildHint(this.options.mode, hintEntries);
	}

	render(width: number): string[] {
		const allItems = this.options.items;
		const query = this.filterText.trim();
		const filteredItems = query
			? fuzzyFilter([...allItems], query, (item) => `${item.label} ${item.group ?? ""}`)
			: allItems;

		if (this.selectedIndex >= filteredItems.length) {
			this.selectedIndex = Math.max(0, filteredItems.length - 1);
		}

		const lines: string[] = [];

		if (this.options.filterable) {
			this.input.focused = this.isFilterFocused;
			const inputLines = this.input.render(width);
			lines.push(...inputLines);
		}

		const selectedItem = filteredItems[this.selectedIndex];
		const hasDetail = selectedItem && !!selectedItem.detail;
		const listMaxLines = this.showDetail && hasDetail ? 6 : 12;

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
			const theme = selectListTheme(clioTheme());
			lines.push(theme.noMatch(`  ${this.options.emptyMessage ?? "No matches found"}`));
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
					lines.push(clioTheme().fg("dim", `── ${row.groupName}`));
				} else {
					const item = row.item;
					if (!item) {
						continue;
					}
					const isSelected = row.itemIndex === this.selectedIndex;

					const prefix = isSelected ? theme.selectedPrefix("→ ") : "  ";
					const prefixLen = 2;
					const availableWidth = width - prefixLen;
					const metaStr = item.meta ?? "";
					const metaLen = metaStr ? visibleWidth(metaStr) : 0;

					const maxLabelWidth = availableWidth - (metaLen > 0 ? metaLen + 2 : 0);
					const truncatedLabel = truncateToWidth(item.label, maxLabelWidth, "...", true);
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

					lines.push(`${prefix}${labelPart}${spacing}${metaPart}`);
				}
			}

			if (renderedRows.length > listMaxLines) {
				const scrollText = `  (${this.selectedIndex + 1}/${filteredItems.length})`;
				lines.push(theme.scrollInfo(truncateToWidth(scrollText, width - 2, "")));
			}
		}

		if (this.showDetail && hasDetail) {
			lines.push(clioTheme().fg("frame", "─".repeat(width)));

			const detailLines = selectedItem.detail ? selectedItem.detail() : [];
			const detailMarkdown = detailLines.join("\n");
			const md = new Markdown(detailMarkdown, 0, 0, markdownTheme(clioTheme()));
			const mdLines = md.render(width);

			const visibleDetailLines = mdLines.slice(0, 10);
			lines.push(...visibleDetailLines);
		}

		return lines;
	}

	handleInput(data: string): void {
		const allItems = this.options.items;
		const query = this.filterText.trim();
		const filteredItems = query
			? fuzzyFilter([...allItems], query, (item) => `${item.label} ${item.group ?? ""}`)
			: allItems;

		if (this.isFilterFocused) {
			if (matchesKey(data, "up")) {
				if (filteredItems.length > 0) {
					this.selectedIndex = this.selectedIndex === 0 ? filteredItems.length - 1 : this.selectedIndex - 1;
				}
				this.isFilterFocused = false;
				this.onChange();
				return;
			}
			if (matchesKey(data, "down")) {
				if (filteredItems.length > 0) {
					this.selectedIndex = this.selectedIndex === filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
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
				if (this.filterText.length > 0) {
					this.filterText = "";
					this.input.setValue("");
					this.selectedIndex = 0;
					this.onChange();
				} else {
					this.options.onClose();
				}
				return;
			}

			this.input.handleInput(data);
			const next = this.input.getValue();
			if (next !== this.filterText) {
				this.filterText = next;
				this.selectedIndex = 0;
				this.onChange();
			}
		} else {
			if (matchesKey(data, "up") || data === "k") {
				if (filteredItems.length > 0) {
					this.selectedIndex = this.selectedIndex === 0 ? filteredItems.length - 1 : this.selectedIndex - 1;
				}
				this.onChange();
				return;
			}
			if (matchesKey(data, "down") || data === "j") {
				if (filteredItems.length > 0) {
					this.selectedIndex = this.selectedIndex === filteredItems.length - 1 ? 0 : this.selectedIndex + 1;
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
				this.options.onClose();
				return;
			}

			if (this.options.actions) {
				const action = this.options.actions[data];
				if (action) {
					const selectedItem = filteredItems[this.selectedIndex];
					if (selectedItem) {
						action(selectedItem);
					}
					return;
				}
			}

			if (this.options.filterable && matchesKey(data, "backspace")) {
				this.isFilterFocused = true;
				this.input.handleInput(data);
				this.filterText = this.input.getValue();
				this.selectedIndex = 0;
				this.onChange();
				return;
			}

			if (this.options.filterable && data.length === 1 && !matchesKey(data, "space")) {
				this.isFilterFocused = true;
				this.input.handleInput(data);
				this.filterText = this.input.getValue();
				this.selectedIndex = 0;
				this.onChange();
				return;
			}
		}
	}

	invalidate(): void {
		this.input.invalidate();
	}
}

export function openListOverlay(tui: TUI, options: ListOverlayOptions): OverlayHandle {
	const view = new ListOverlayView(options, () => tui.requestRender());
	return showClioOverlayFrame(tui, view, {
		anchor: "center",
		width: 100,
		title: options.title,
		footerHint: () => view.getHint(),
	});
}
