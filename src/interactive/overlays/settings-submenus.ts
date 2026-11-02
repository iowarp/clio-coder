import type { Component } from "../../engine/tui.js";
import { getKeybindings, Input, isKeyRelease, matchesKey, wrapTextWithAnsi } from "../../engine/tui.js";
import { localKey } from "../keyboard-owner.js";
import { buildHint, type RowBudgetedBody } from "../overlay-frame.js";
import { clioTheme, errorState, GLYPH, positionRow, selectionRow, titleRow } from "../theme/index.js";

/**
 * The detail pages the settings center opens inside its own lane: a value
 * picker, a scope decision, a text or number editor, a refused change. They
 * share one wrapper so every page names itself the same way, explains itself
 * in the same dim note, and ends on the same key legend.
 */

export interface ChoiceItem {
	value: string;
	label: string;
	/** What choosing it does, in one sentence under the label. */
	description?: string;
	/** Dim right-aligned column: a time, a kind. */
	meta?: string;
	/** A mark in the cursor column while the row is not focused: the current value, a check. */
	mark?: string;
	disabled?: boolean;
}

export interface ChoiceListOptions {
	/** Rows the list may take; zero lays every row out. The owner usually sets this through `setBodyRows`. */
	rows?: number;
	/** `all` keeps every description on screen while they fit; `focused` shows only the focused row's. */
	descriptions?: "all" | "focused";
}

function isRowBudgeted(child: Component): child is Component & RowBudgetedBody {
	return typeof (child as Partial<RowBudgetedBody>).setBodyRows === "function";
}

/**
 * A cursor list of choices drawn with the shared selection row, so a value
 * picker and a scope decision look like every other list in the product. The
 * descriptions stay on screen while the rows fit the budget; when they do not,
 * only the focused row keeps its sentence, and the window scrolls to keep the
 * focused row whole. Up and down wrap, as pi-tui's own list does, and j/k are
 * the same keys as the rows that opened the list.
 */
export class ChoiceList implements Component, RowBudgetedBody {
	private selectedIndex = 0;
	private rows: number;
	onSelect: ((item: ChoiceItem) => void) | undefined;
	onCancel: (() => void) | undefined;

	constructor(
		private readonly items: ReadonlyArray<ChoiceItem>,
		private readonly options: ChoiceListOptions = {},
	) {
		this.rows = Math.max(0, Math.floor(options.rows ?? 0));
	}

	setBodyRows(rows: number): void {
		this.rows = Math.max(0, Math.floor(rows));
	}

	setSelectedIndex(index: number): void {
		this.selectedIndex = Math.max(0, Math.min(Math.floor(index), Math.max(0, this.items.length - 1)));
	}

	getSelectedItem(): ChoiceItem | null {
		return this.items[this.selectedIndex] ?? null;
	}

	render(width: number): string[] {
		const theme = clioTheme();
		if (this.items.length === 0) return [];
		const budget = this.rows > 0 ? this.rows : Number.POSITIVE_INFINITY;
		const lay = (describeAll: boolean): string[][] =>
			this.items.map((item, index) => {
				const focused = index === this.selectedIndex;
				const description = describeAll || focused ? item.description : undefined;
				return selectionRow(theme, {
					focused,
					label: item.label,
					...(description === undefined ? {} : { description }),
					...(item.meta === undefined ? {} : { meta: item.meta }),
					...(item.mark === undefined ? {} : { mark: item.mark }),
					...(item.disabled === undefined ? {} : { disabled: item.disabled }),
					width,
				});
			});
		const total = (blocks: string[][]): number => blocks.reduce((sum, block) => sum + block.length, 0);
		let blocks = lay((this.options.descriptions ?? "all") === "all");
		if (total(blocks) > budget) blocks = lay(false);
		const lines = blocks.flat();
		if (lines.length <= budget) return lines;
		// Window the flat lines so the focused block is whole and near the middle.
		const starts: number[] = [];
		let at = 0;
		for (const block of blocks) {
			starts.push(at);
			at += block.length;
		}
		const focusedStart = starts[this.selectedIndex] ?? 0;
		const focusedHeight = blocks[this.selectedIndex]?.length ?? 1;
		const visible = Math.max(1, Math.floor(budget));
		const start = Math.max(0, Math.min(focusedStart - Math.floor((visible - focusedHeight) / 2), lines.length - visible));
		const window = lines.slice(start, start + visible);
		if (visible >= 3) {
			window[visible - 1] = positionRow(
				theme,
				{ start: start + 1, end: start + visible - 1, total: lines.length, unit: "rows" },
				width,
			);
		}
		return window;
	}

	handleInput(data: string): void {
		data = localKey(data);
		if (isKeyRelease(data)) return;
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up") || data === "k") {
			this.move(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down") || data === "j") {
			this.move(1);
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || matchesKey(data, "enter")) {
			const item = this.getSelectedItem();
			if (item) this.onSelect?.(item);
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) this.onCancel?.();
	}

	invalidate(): void {}

	private move(delta: -1 | 1): void {
		const count = this.items.length;
		if (count === 0) return;
		this.selectedIndex = (this.selectedIndex + delta + count) % count;
	}
}

export type SubmenuTitle = string | ((width: number) => string);

/**
 * One detail page: a title row, the dim note that explains the decision, the
 * page's own body, the reason a submission was refused when there is one, and
 * the key legend. The body is given the rows the page does not spend on its
 * own chrome, so a long picker windows itself instead of being cut.
 */
export class SubmenuWrapper implements Component, RowBudgetedBody {
	/**
	 * Why the last submission was refused, or null while nothing is wrong. The
	 * editor sets it instead of closing, so the operator corrects the value with
	 * the reason on screen rather than back at the row list with no reason.
	 */
	private problem: string | null = null;
	private rows = 0;

	constructor(
		private readonly title: SubmenuTitle,
		private readonly child: Component,
		private readonly hint: string = buildHint([{ key: "Enter", verb: "confirm" }], "back"),
		private readonly note?: string,
	) {}

	setProblem(problem: string | null): void {
		this.problem = problem;
	}

	setBodyRows(rows: number): void {
		this.rows = Math.max(0, Math.floor(rows));
	}

	render(width: number): string[] {
		const theme = clioTheme();
		const safe = Math.max(1, width);
		const title = typeof this.title === "function" ? this.title(safe) : this.title;
		const head = [titleRow(theme, title, safe)];
		if (this.note) {
			// The note explains the page; the body is the page. A long note keeps
			// at most what leaves the body six rows, and says where it was cut.
			const wrapped = wrapTextWithAnsi(theme.fg("annotation", this.note), safe);
			const budget = this.rows > 0 ? Math.max(2, this.rows - 7) : wrapped.length;
			const kept = wrapped.slice(0, budget);
			const last = kept.at(-1);
			head.push(
				...(wrapped.length > kept.length && last !== undefined ? [...kept.slice(0, -1), `${last}${GLYPH.ellipsis}`] : kept),
			);
		}
		head.push("");
		const problem = this.problem === null ? [] : errorState(theme, this.problem, safe);
		const tail = ["", theme.fg("keyboardHint", this.hint)];
		if (this.rows > 0 && isRowBudgeted(this.child)) {
			this.child.setBodyRows(Math.max(1, this.rows - head.length - problem.length - tail.length));
		}
		const body = this.child
			.render(safe)
			.map((line) => theme.base(this.child instanceof Input ? "inputText" : "menuOption", line));
		return [...head, ...body, ...problem, ...tail];
	}

	handleInput(data: string): void {
		data = localKey(data);
		this.child.handleInput?.(data);
	}

	invalidate(): void {
		this.child.invalidate?.();
	}
}
