import type { Component } from "../../engine/tui.js";
import {
	getKeybindings,
	Input,
	isKeyRelease,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "../../engine/tui.js";
import { localKey } from "../keyboard-owner.js";
import type { HintEntry, RowBudgetedBody } from "../overlay-frame.js";
import { clioTheme, errorState, GLYPH, positionRow, selectionRow, titleRow } from "../theme/index.js";

/**
 * The detail pages the settings center opens inside its own lane: a value
 * picker, a scope decision, a text or number editor, a refused change. They
 * share one wrapper so every page names itself the same way and explains
 * itself in the same dim note; its keys ride the dock rail with Esc.
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
				{ start: start + 1, end: start + visible - 1, total: lines.length, unit: "lines" },
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
 * What the settings center reads from an open page to route Esc and draw the
 * rail. A single page is a SubmenuWrapper; a guided flow of several pages (the
 * SSH node setup) implements the same three members, so its steps back out one
 * at a time under the shared Esc rule instead of dropping to the list.
 */
export interface SubmenuSurface {
	/** Where Esc lands when it is not the list behind this page; null means back to the list. */
	readonly escape: { verb: string; short?: string; back: () => void } | null;
	/** A text editor, whose Esc keeps what was typed for the next visit. */
	readonly editsText: boolean;
	/** The keys this page acts on, other than Esc, for the rail. */
	railKeys(): ReadonlyArray<HintEntry>;
}

export function isSubmenuSurface(component: unknown): component is Component & SubmenuSurface {
	if (component instanceof SubmenuWrapper) return true;
	if (typeof component !== "object" || component === null) return false;
	const candidate = component as Partial<SubmenuSurface>;
	return "escape" in candidate && "editsText" in candidate && typeof candidate.railKeys === "function";
}

/**
 * One detail page: a title row, the dim note that explains the decision, the
 * page's own body, and the reason a submission was refused when there is one.
 * The page's keys are not drawn here: they ride the dock rail beside Esc, so
 * the commit key and the way out are read from one place at every width, and
 * the two rows a legend took go to the choices on a short terminal.
 */
export class SubmenuWrapper implements Component, RowBudgetedBody, SubmenuSurface {
	/**
	 * Why the last submission was refused, or null while nothing is wrong. The
	 * editor sets it instead of closing, so the operator corrects the value with
	 * the reason on screen rather than back at the row list with no reason.
	 */
	private problem: string | null = null;
	private rows = 0;
	/**
	 * Where Esc lands when it is not the list behind this page: the scope card
	 * goes back to the value it was opened from, so a typed value survives the
	 * press. Null means back to the list.
	 */
	escape: { verb: string; short?: string; back: () => void } | null = null;

	constructor(
		private readonly title: SubmenuTitle,
		private readonly child: Component,
		private readonly keys: ReadonlyArray<HintEntry> = [{ key: "Enter", verb: "confirm" }],
		private readonly note?: string,
	) {}

	setProblem(problem: string | null): void {
		this.problem = problem;
	}

	/** The keys this page acts on, other than Esc, for the rail. */
	railKeys(): ReadonlyArray<HintEntry> {
		return this.keys;
	}

	/** A text editor, whose Esc keeps what was typed for the next visit. */
	get editsText(): boolean {
		return this.child instanceof Input;
	}

	setBodyRows(rows: number): void {
		this.rows = Math.max(0, Math.floor(rows));
	}

	/**
	 * Rows go, in order, to the title, the refusal, the body's first rows, one
	 * row of the note, the rest of the body, the rest of the note, and last the
	 * blank row between note and body. A short terminal loses the explanation's
	 * tail, never the choices or the reason a value was refused.
	 */
	render(width: number): string[] {
		const theme = clioTheme();
		const safe = Math.max(1, width);
		const title = typeof this.title === "function" ? this.title(safe) : this.title;
		const head = titleRow(theme, title, safe);
		const note = this.note ? wrapTextWithAnsi(theme.fg("annotation", this.note), safe) : [];
		const problem = this.problem === null ? [] : errorState(theme, this.problem, safe);
		const child = this.child;
		const budget = (rows: number): void => {
			if (isRowBudgeted(child)) child.setBodyRows(rows);
		};
		const style = (lines: string[]): string[] =>
			lines.map((line) => theme.base(child instanceof Input ? "inputText" : "menuOption", line));
		budget(0);
		if (this.rows <= 0)
			return [head, ...note, ...(note.length > 0 ? [""] : []), ...style(child.render(safe)), ...problem];
		const natural = child.render(safe).length;
		let left = Math.max(0, this.rows - 1 - problem.length);
		const bodyFloor = Math.min(natural, left, 3);
		left -= bodyFloor;
		const noteFloor = Math.min(note.length, left, 1);
		left -= noteFloor;
		const bodyRows = bodyFloor + Math.min(natural - bodyFloor, left);
		left -= bodyRows - bodyFloor;
		const noteRows = noteFloor + Math.min(note.length - noteFloor, left);
		left -= noteRows - noteFloor;
		const spacer = noteRows > 0 && left > 0 ? [""] : [];
		budget(Math.max(1, bodyRows));
		const keptNote = note.slice(0, noteRows);
		const last = keptNote.at(-1);
		if (noteRows < note.length && last !== undefined) {
			keptNote[keptNote.length - 1] = `${truncateToWidth(last, Math.max(1, safe - 1), "", false)}${GLYPH.ellipsis}`;
		}
		const body = style(child.render(safe)).slice(0, Math.max(1, bodyRows));
		return [head, ...keptNote, ...spacer, ...body, ...problem];
	}

	handleInput(data: string): void {
		data = localKey(data);
		this.child.handleInput?.(data);
	}

	invalidate(): void {
		this.child.invalidate?.();
	}
}
