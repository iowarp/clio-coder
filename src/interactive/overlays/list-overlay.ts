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

	private selectIndex(index: number): void {
		this.selectedIndex = index;
		this.detailScrollOffset = 0;
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
			hintEntries.push({ key: "PgUp/PgDn", verb: "scroll detail" });
		}

		if (this.options.hints) {
			hintEntries.push(...this.options.hints);
		}

		return buildHint(this.options.mode, hintEntries);
	}

	private padLine(line: string, targetWidth: number): string {
		const w = visibleWidth(line);
		if (w >= targetWidth) return truncateToWidth(line, targetWidth, "...", true);
		return line + " ".repeat(targetWidth - w);
	}

	private renderList(
		width: number,
		listMaxLines: number,
		filteredItems: ReadonlyArray<ListOverlayItem>,
		pad: boolean,
	): string[] {
		const lines: string[] = [];
		const allItems = this.options.items;

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
			const noMatchText = theme.noMatch(`  ${this.options.emptyMessage ?? "No matches found"}`);
			lines.push(this.padLine(noMatchText, width));
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
					lines.push(this.padLine(clioTheme().fg("dim", `── ${row.groupName}`), width));
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
		const detailLines = selectedItem.detail();
		const detailMarkdown = detailLines.join("\n");
		const md = new Markdown(detailMarkdown, 0, 0, markdownTheme(clioTheme()));
		const mdLines = md.render(width);

		const maxScrollOffset = Math.max(0, mdLines.length - height);
		this.detailScrollOffset = Math.max(0, Math.min(this.detailScrollOffset, maxScrollOffset));

		const sliced = mdLines.slice(this.detailScrollOffset, this.detailScrollOffset + height);
		const padded = sliced.map((line) => {
			const w = visibleWidth(line);
			if (w >= width) return truncateToWidth(line, width, "...", true);
			return line + " ".repeat(width - w);
		});

		while (padded.length < height) {
			padded.push(" ".repeat(width));
		}
		return padded;
	}

	render(width: number): string[] {
		const allItems = this.options.items;
		const query = this.filterText.trim();
		const filteredItems = query
			? fuzzyFilter([...allItems], query, (item) => `${item.label} ${item.group ?? ""}`)
			: allItems;

		if (this.selectedIndex >= filteredItems.length) {
			this.selectIndex(Math.max(0, filteredItems.length - 1));
		}

		const lines: string[] = [];

		if (this.options.filterable) {
			this.input.focused = this.isFilterFocused;
			const inputLines = this.input.render(width);
			lines.push(...inputLines);
		}

		const selectedItem = filteredItems[this.selectedIndex];
		const hasDetail = selectedItem && !!selectedItem.detail;

		const isSplit = this.options.layout === "split" && width >= 90;

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
				lines.push(clioTheme().fg("frame", "─".repeat(width)));
				const detailLines = this.renderDetail(width, 10, selectedItem);
				lines.push(...detailLines);
			}
		}

		return lines;
	}

	private detailPaneVisible(): boolean {
		return this.options.layout === "split" || this.showDetail;
	}

	handleInput(data: string): void {
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

		const allItems = this.options.items;
		const query = this.filterText.trim();
		const filteredItems = query
			? fuzzyFilter([...allItems], query, (item) => `${item.label} ${item.group ?? ""}`)
			: allItems;

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
				if (this.filterText.length > 0) {
					this.filterText = "";
					this.input.setValue("");
					this.selectIndex(0);
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
				this.selectIndex(0);
				this.onChange();
				return;
			}

			if (this.options.filterable && data.length === 1 && !matchesKey(data, "space")) {
				this.isFilterFocused = true;
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

export function openListOverlay(tui: TUI, options: ListOverlayOptions): OverlayHandle {
	const view = new ListOverlayView(options, () => tui.requestRender());
	return showClioOverlayFrame(tui, view, {
		anchor: "center",
		width: 100,
		title: options.title,
		footerHint: () => view.getHint(),
	});
}
