import type { RuntimeResolutionDiagnostic } from "../domains/providers/index.js";
import {
	Box,
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type SelectListTheme,
	type SettingsListTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "../engine/tui.js";
import { type ClioToken, clioTheme, selectListTheme, settingsListTheme } from "./theme/index.js";

export const IDENTITY = (text: string): string => text;

export const DEFAULT_SELECT_THEME: SelectListTheme = selectListTheme(clioTheme());

export const DEFAULT_SETTINGS_THEME: SettingsListTheme = settingsListTheme(clioTheme());

interface InputTarget {
	handleInput?: (data: string) => void;
}

export interface FocusBoxOptions {
	x?: number;
	y?: number;
	inputTarget?: InputTarget | null;
	onInput?: (data: string) => void;
}

export class FocusBox extends Box {
	private readonly inputTarget: InputTarget | null;
	private readonly onInput: ((data: string) => void) | undefined;

	constructor(children: Component | readonly Component[], options?: FocusBoxOptions) {
		super(options?.x ?? 1, options?.y ?? 0);
		const childList = Array.isArray(children) ? children : [children];
		for (const child of childList) this.addChild(child);
		this.inputTarget = options?.inputTarget === undefined ? (childList[0] ?? null) : options.inputTarget;
		this.onInput = options?.onInput;
	}

	handleInput(data: string): void {
		if (this.onInput) {
			this.onInput(data);
			return;
		}
		this.inputTarget?.handleInput?.(data);
	}
}

function clioFrame(text: string): string {
	return clioTheme().fg("frame", text);
}

function clioTitle(text: string): string {
	return clioTheme().style("title", text, { bold: true });
}

export function clioError(text: string): string {
	return clioTheme().fg("error", text);
}

function padAnsi(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "", true);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function brandedTopBorder(label: string, innerWidth: number): string {
	const clean = label.replace(/^[┌┐└┘├┤─│\s]+/, "").replace(/[┌┐└┘├┤─│\s]+$/, "");
	const formatted = clean.length > 0 ? `─ ${clean} ` : "─";
	const clipped = visibleWidth(formatted) > innerWidth ? truncateToWidth(formatted, innerWidth, "...", true) : formatted;
	const fill = "─".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	const cleanIndex = clipped.indexOf(clean);
	if (cleanIndex !== -1) {
		const prefix = clipped.slice(0, cleanIndex);
		const suffix = clipped.slice(cleanIndex + clean.length);
		return `${clioFrame("┌")}${clioFrame(prefix)}${clioTitle(clean)}${clioFrame(suffix)}${clioFrame(fill)}${clioFrame("┐")}`;
	}
	return `${clioFrame("┌")}${clioFrame(clipped)}${clioFrame(fill)}${clioFrame("┐")}`;
}

/**
 * What Esc does from where the overlay is right now.
 *
 * This used to be derived from whether the overlay committed anything, which
 * produced `cancel` on half the overlays and `close` on the other half while
 * neither word described what the key would do. Worse, every list overlay
 * clears a typed filter on the first Esc and closes on the second, and the
 * footer said `close` through both. The caller states the action because the
 * caller is the only thing that knows it.
 *
 * `back` is for a submode that returns to the surface that opened it: a
 * settings submenu, the `/tree` label editor.
 */
export type OverlayEscVerb = "close" | "clear filter" | "back";

export interface HintEntry {
	key: string;
	verb: string;
}

/**
 * The one word for narrowing a list by typing. `/help` said `filter`, `/models`
 * and `/resume` said `search`, and they are the same gesture, so a reader who
 * learned one had to relearn it in the next overlay.
 */
export const FILTER_HINT: HintEntry = { key: "type", verb: "filter" };

export function canonicalizeKey(key: string): string {
	const trimmed = key.trim();
	if (trimmed === "R") return "R";
	const lower = trimmed.toLowerCase();
	if (lower === "up/down" || lower === "updown" || lower === "↑/↓" || lower === "up/down/j/k" || lower === "↑↓")
		return "↑↓";
	if (lower === "enter/space") return "Enter/Space";
	if (lower === "enter") return "Enter";
	if (lower === "esc" || lower === "escape") return "Esc";
	if (lower === "space") return "Space";
	if (lower === "tab") return "Tab";
	if (lower === "r") return "r";
	if (lower === "type") return "type";
	return trimmed;
}

export function buildHint(entries: ReadonlyArray<HintEntry>, esc: OverlayEscVerb = "close"): string {
	const finalEntries = [
		...entries.map((e) => ({ key: canonicalizeKey(e.key), verb: e.verb })),
		{ key: "Esc", verb: esc },
	];
	return finalEntries.map((e) => `[${e.key}] ${e.verb}`).join(" · ");
}

export function elideHint(hint: string, maxCleanWidth: number): string {
	const parts = hint.split(" · ");
	if (parts.length <= 2) return hint;

	const keepIndices = Array.from({ length: parts.length }, (_, i) => i);

	while (keepIndices.length > 2) {
		const currentHint = keepIndices.map((i) => parts[i]).join(" · ");
		if (visibleWidth(currentHint) <= maxCleanWidth) {
			return currentHint;
		}
		const midIdxInMiddle = Math.floor((keepIndices.length - 2) / 2) + 1;
		keepIndices.splice(midIdxInMiddle, 1);
	}

	return keepIndices.map((i) => parts[i]).join(" · ");
}

function brandedBottomBorder(innerWidth: number, hint?: string): string {
	if (!hint || hint.trim().length === 0) {
		return `${clioFrame("└")}${clioFrame("─".repeat(innerWidth))}${clioFrame("┘")}`;
	}
	let clean = hint.trim();
	const maxCleanWidth = innerWidth - 3;
	if (clean.includes(" · ") && visibleWidth(`─ ${clean} `) > innerWidth) {
		clean = elideHint(clean, maxCleanWidth);
	}
	const formatted = `─ ${clean} `;
	const clipped = visibleWidth(formatted) > innerWidth ? truncateToWidth(formatted, innerWidth, "...", true) : formatted;
	const fill = "─".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	const cleanIndex = clipped.indexOf(clean);
	if (cleanIndex !== -1) {
		const prefix = clipped.slice(0, cleanIndex);
		const suffix = clipped.slice(cleanIndex + clean.length);
		return `${clioFrame("└")}${clioFrame(prefix)}${clioTheme().fg("dim", clean)}${clioFrame(suffix)}${clioFrame(fill)}${clioFrame("┘")}`;
	}
	return `${clioFrame("└")}${clioFrame(clipped)}${clioFrame(fill)}${clioFrame("┘")}`;
}

export function brandedContentRow(text: string, contentWidth: number): string {
	return `${clioFrame("│")} ${padAnsi(truncateToWidth(text, contentWidth, "...", true), contentWidth)} ${clioFrame("│")}`;
}

export function formatRuntimeResolutionDiagnostic(diagnostic: RuntimeResolutionDiagnostic): string {
	return `${diagnostic.severity}: ${diagnostic.code}: ${diagnostic.message}`;
}

/**
 * Map a diagnostic's severity to its semantic token so a warning renders amber
 * and only a true error renders red. Shared by the model overlay's detail rows
 * and the targets hub's error rail so both surfaces color severity identically.
 */
export function diagnosticSeverityToken(severity: RuntimeResolutionDiagnostic["severity"]): ClioToken {
	return severity === "error" ? "error" : severity === "warning" ? "warning" : "muted";
}

export function runtimeResolutionDiagnosticLine(diagnostic: RuntimeResolutionDiagnostic, width: number): string {
	return clioTheme().fg(diagnosticSeverityToken(diagnostic.severity), fitDiagnosticLine(diagnostic, width));
}

function fitDiagnosticLine(diagnostic: RuntimeResolutionDiagnostic, width: number): string {
	return padAnsi(formatRuntimeResolutionDiagnostic(diagnostic), Math.max(1, width));
}

export type FrameAlign = "left" | "center" | "right";

/**
 * Horizontal half of an overlay anchor. The terminal engine composites an
 * overlay only across the columns it declares, so the frame claims the whole
 * row and places the box itself; this is what the box would have been anchored
 * to if the engine were still doing the placing.
 */
export function frameAlignForAnchor(anchor: OverlayOptions["anchor"]): FrameAlign {
	if (anchor === undefined) return "center";
	if (anchor === "left-center" || anchor.endsWith("-left")) return "left";
	if (anchor === "right-center" || anchor.endsWith("-right")) return "right";
	return "center";
}

/**
 * Trim a body to the rows the box has, keeping the count of what was dropped.
 *
 * A box taller than the terminal used to be cut off at the bottom by the
 * engine, which takes the top of an overlay and discards the rest. At 40x12 the
 * memory overlay is nineteen rows, so what went missing was the bottom border
 * and the `[Esc] close` hint: the one row that tells an operator how to get out
 * of a modal that has taken their keyboard. Losing body rows instead keeps the
 * way out on screen.
 */
function fitBody(lines: ReadonlyArray<string>, rowBudget: number, contentWidth: number): ReadonlyArray<string> {
	if (rowBudget <= 0) return lines;
	const bodyBudget = Math.max(1, rowBudget - 2);
	if (lines.length <= bodyBudget) return lines;
	const kept = lines.slice(0, bodyBudget - 1);
	const hidden = lines.length - kept.length;
	return [...kept, clioTheme().fg("dim", truncateToWidth(`… ${hidden} more rows`, contentWidth, "", true))];
}

export class ClioOverlayFrame implements Component {
	/**
	 * Rows the box may occupy, or zero while unknown.
	 *
	 * `Component.render` is handed a width and nothing else, so the frame learns
	 * its height budget from the engine's `visible` predicate, which is called
	 * with the live terminal size immediately before the render pass that
	 * composites this overlay.
	 */
	private rowBudget = 0;

	constructor(
		private readonly child: Component,
		private readonly title: string | (() => string),
		private readonly footerHint?: string | (() => string | undefined),
		/** Box width in columns. Zero fills the row it is given. */
		private readonly boxWidth = 0,
		private readonly align: FrameAlign = "center",
	) {}

	setRowBudget(rows: number): void {
		this.rowBudget = Math.max(0, Math.floor(rows));
	}

	render(width: number): string[] {
		const boxWidth = Math.max(5, Math.min(this.boxWidth > 0 ? this.boxWidth : width, width));
		const contentWidth = Math.max(1, boxWidth - 4);
		const childLines = this.child.render(contentWidth);
		const titleText = typeof this.title === "function" ? this.title() : this.title;
		const label = titleText.length > 0 ? `─ ${titleText} ` : "─ ";
		const hint = typeof this.footerHint === "function" ? this.footerHint() : this.footerHint;
		const boxLines = [
			brandedTopBorder(label, contentWidth + 2),
			...fitBody(childLines, this.rowBudget, contentWidth).map(
				(line) => `${clioFrame("│")} ${padAnsi(line, contentWidth)} ${clioFrame("│")}`,
			),
			brandedBottomBorder(contentWidth + 2, hint),
		];
		const slack = Math.max(0, width - boxWidth);
		if (slack === 0) return boxLines;
		const leading = this.align === "left" ? 0 : this.align === "right" ? slack : Math.floor(slack / 2);
		const lead = " ".repeat(leading);
		const trail = " ".repeat(slack - leading);
		return boxLines.map((line) => `${lead}${line}${trail}`);
	}

	handleInput(data: string): void {
		this.child.handleInput?.(data);
	}

	invalidate(): void {
		this.child.invalidate?.();
	}
}

/**
 * Show a framed overlay that owns every row it covers.
 *
 * The overlay used to declare only the box's own width, and the terminal engine
 * composites an overlay across exactly the columns it declares, so the
 * transcript stayed on both sides of the border. On a 193-column terminal a
 * write-approval modal landed inside a sentence and the row read "None of these
 * skills directly match the task \"escape works" on the left of the box and
 * "test message, possibly checking that the escape sequence or" on the right,
 * which is a sentence the model never wrote.
 *
 * The frame now claims the full row and blanks the columns beside the box, so
 * a modal reads as a modal. The caller's width becomes the box width and the
 * anchor's horizontal half becomes the box's alignment inside the row; margins
 * and vertical anchoring are still the engine's.
 *
 * The frame also fits itself to the rows available rather than letting the
 * engine cut its bottom off, which is what kept the `[Esc] close` hint on
 * screen at 40x12. It learns the terminal height through the `visible`
 * predicate, which the engine evaluates with the live dimensions in the same
 * pass that renders the overlay.
 */
export function showClioOverlayFrame(
	tui: TUI,
	child: Component,
	options: OverlayOptions & { title: string | (() => string); footerHint?: string | (() => string | undefined) },
): OverlayHandle {
	const { title, footerHint, width, visible, maxHeight, margin, ...overlayOptions } = options;
	const boxWidth = typeof width === "number" ? width : 0;
	const frame = new ClioOverlayFrame(child, title, footerHint, boxWidth, frameAlignForAnchor(options.anchor));
	const marginRows = typeof margin === "number" ? margin * 2 : (margin?.top ?? 0) + (margin?.bottom ?? 0);
	return tui.showOverlay(frame, {
		...overlayOptions,
		...(margin !== undefined ? { margin } : {}),
		width: "100%",
		visible: (termWidth, termHeight) => {
			const available = Math.max(1, termHeight - marginRows);
			const requested = resolveRowSize(maxHeight, termHeight);
			frame.setRowBudget(requested === null ? available : Math.min(requested, available));
			return visible ? visible(termWidth, termHeight) : true;
		},
	});
}

/** Rows from an overlay size value, matching how the engine reads one. */
function resolveRowSize(value: OverlayOptions["maxHeight"], termHeight: number): number | null {
	if (typeof value === "number") return Math.max(1, Math.floor(value));
	if (typeof value !== "string") return null;
	const percent = /^(\d+(?:\.\d+)?)%$/u.exec(value.trim());
	if (!percent?.[1]) return null;
	return Math.max(1, Math.floor((termHeight * Number.parseFloat(percent[1])) / 100));
}
