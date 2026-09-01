import type { RuntimeResolutionDiagnostic } from "../domains/providers/index.js";
import {
	Box,
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type OverlayUnfocusOptions,
	type SelectListTheme,
	type SettingsListTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "../engine/tui.js";
import { enterModal, type ModalMarkerSink } from "./modal-marker.js";
import { type ClioToken, clioTheme, padAnsi, screenTitle, selectListTheme, settingsListTheme } from "./theme/index.js";

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

/**
 * The border and title token of a framed overlay.
 *
 * Every overlay used to draw the same teal frame, informational or not, so a
 * prompt that had taken the keyboard and was waiting on a decision read as one
 * more panel. A tone is the one signal that separates the two classes; the
 * overlays that carry one say so, and everything else stays on the frame token.
 */
export type OverlayTone = ClioToken | (() => ClioToken | undefined);

function resolveTone(tone: OverlayTone | undefined): ClioToken | undefined {
	return typeof tone === "function" ? tone() : tone;
}

function clioFrame(text: string, token: ClioToken = "frame"): string {
	return clioTheme().fg(token, text);
}

function clioTitle(text: string, token?: ClioToken): string {
	return token === undefined ? screenTitle(clioTheme(), text) : clioTheme().style(token, text, { bold: true });
}

export function clioError(text: string): string {
	return clioTheme().fg("error", text);
}

function brandedTopBorder(label: string, innerWidth: number, tone?: ClioToken): string {
	const frame = (text: string): string => clioFrame(text, tone ?? "frame");
	const clean = label.replace(/^[┌┐└┘├┤─│\s]+/, "").replace(/[┌┐└┘├┤─│\s]+$/, "");
	const formatted = clean.length > 0 ? `─ ${clean} ` : "─";
	const clipped = visibleWidth(formatted) > innerWidth ? truncateToWidth(formatted, innerWidth, "…", true) : formatted;
	const fill = "─".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	const cleanIndex = clipped.indexOf(clean);
	if (cleanIndex !== -1) {
		const prefix = clipped.slice(0, cleanIndex);
		const suffix = clipped.slice(cleanIndex + clean.length);
		return `${frame("┌")}${frame(prefix)}${clioTitle(clean, tone)}${frame(suffix)}${frame(fill)}${frame("┐")}`;
	}
	return `${frame("┌")}${frame(clipped)}${frame(fill)}${frame("┐")}`;
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
	/**
	 * A shorter spelling of the same action, tried before any entry is dropped.
	 * `allow once` becomes `allow` rather than vanishing.
	 */
	short?: string;
	/**
	 * Overrides `isCriticalHintKey`. A critical entry survives every narrowing
	 * pass except the last, so a surface can protect a key the default
	 * classification does not know about, or release one it does.
	 */
	critical?: boolean;
}

/**
 * The keys a footer may not silently drop.
 *
 * `elideHint` used to keep the first and last entry and splice out the middle,
 * which is a statement about position rather than value: at 40 columns a list
 * overlay kept `[↑↓] select`, which every terminal user already knows, and
 * dropped `[Enter] use`, which is the only way to commit. The commit key and
 * the way out are what a narrow footer is for.
 */
export function isCriticalHintKey(key: string): boolean {
	const canonical = canonicalizeKey(key);
	// `type` joins the commit key and the way out because on a list of a hundred
	// models, typing is how a reader reaches the row they want at all; the
	// per-row verbs beside it (refresh, favorite) are conveniences.
	return canonical === "Esc" || canonical === "Enter" || canonical === "Enter/Space" || canonical === "type";
}

function isCriticalEntry(entry: HintEntry): boolean {
	return entry.critical ?? isCriticalHintKey(entry.key);
}

function renderHintEntries(entries: ReadonlyArray<HintEntry>, short: boolean): string {
	return entries
		.map((entry) => `[${canonicalizeKey(entry.key)}] ${short ? (entry.short ?? entry.verb) : entry.verb}`)
		.join(" · ");
}

/**
 * Fit a hint to `maxWidth` by, in order: using every full label; using every
 * short label; dropping droppable entries left to right; and only then dropping
 * critical ones left to right, always keeping the last.
 *
 * Left to right is the useful direction because `buildHint` puts navigation
 * first and the commit action and Esc last, so the entries a reader can guess
 * go before the ones they cannot.
 */
export function fitHintEntries(entries: ReadonlyArray<HintEntry>, maxWidth: number): string {
	if (entries.length === 0) return "";
	for (const short of [false, true]) {
		const rendered = renderHintEntries(entries, short);
		if (visibleWidth(rendered) <= maxWidth) return rendered;
	}
	// Droppable entries go first, left to right, then critical ones by the same
	// rule. The only positional invariant left is that one entry always survives,
	// so a footer never renders empty; which one that is falls out of the
	// classification rather than out of where the caller happened to list it.
	const kept = [...entries];
	for (const criticalPass of [false, true]) {
		while (kept.length > 1) {
			const index = kept.findIndex((entry) => criticalPass || !isCriticalEntry(entry));
			if (index === -1) break;
			kept.splice(index, 1);
			const rendered = renderHintEntries(kept, true);
			if (visibleWidth(rendered) <= maxWidth) return rendered;
		}
	}
	return renderHintEntries(kept, true);
}

/**
 * The one word for narrowing a list by typing. `/help` said `filter`, `/model`
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

/**
 * Build a hint that narrows itself, for `showClioOverlayFrame`'s `footerHint`.
 *
 * The returned function takes the box's inner width, which is what the frame
 * hands a function hint, and subtracts the three columns the bottom border
 * spends on `─ ` and the trailing space.
 *
 * An overlay whose stop key must outrank its close key states that here rather
 * than hand-writing width tiers, which is what the permission overlay used to
 * do because the positional elider would eat `[s] stop turn`.
 */
export function buildResponsiveHint(
	entries: ReadonlyArray<HintEntry>,
	esc: OverlayEscVerb | HintEntry | null = "close",
): (innerWidth: number) => string {
	const escEntry: HintEntry | null = esc === null ? null : typeof esc === "string" ? { key: "Esc", verb: esc } : esc;
	const all = escEntry ? [...entries, escEntry] : [...entries];
	return (innerWidth: number): string => fitHintEntries(all, innerWidth - 3);
}

/**
 * Narrow an already-joined hint string, for the callers that pass `buildHint`'s
 * output straight through. Parsing `[Key] verb` back out is lossy about `short`
 * labels but recovers the key, which is all the critical-key classification
 * needs, so a plain-string overlay gets the same protection as a structured one.
 */
export function elideHint(hint: string, maxCleanWidth: number): string {
	const parts = hint.split(" · ");
	if (parts.length <= 2) return hint;
	const entries: HintEntry[] = parts.map((part) => {
		const match = /^\[([^\]]+)\] ([\s\S]+)$/u.exec(part);
		// A part that is not `[Key] verb` carries no key to classify, so it is
		// droppable and rendered verbatim by giving it an empty key spelling.
		if (!match) return { key: "", verb: part, critical: false };
		return { key: match[1] ?? "", verb: match[2] ?? "" };
	});
	const rendered = fitHintEntries(entries, maxCleanWidth);
	// `fitHintEntries` re-spells `[Key] verb`; an unparsed part would come back
	// as `[] text`, so those are restored to the text they arrived as.
	return rendered.replace(/\[\] /gu, "");
}

function brandedBottomBorder(innerWidth: number, hint?: string, tone?: ClioToken): string {
	const frame = (text: string): string => clioFrame(text, tone ?? "frame");
	if (!hint || hint.trim().length === 0) {
		return `${frame("└")}${frame("─".repeat(innerWidth))}${frame("┘")}`;
	}
	let clean = hint.trim();
	const maxCleanWidth = innerWidth - 3;
	if (clean.includes(" · ") && visibleWidth(`─ ${clean} `) > innerWidth) {
		clean = elideHint(clean, maxCleanWidth);
	}
	const formatted = `─ ${clean} `;
	const clipped = visibleWidth(formatted) > innerWidth ? truncateToWidth(formatted, innerWidth, "…", true) : formatted;
	const fill = "─".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	const cleanIndex = clipped.indexOf(clean);
	if (cleanIndex !== -1) {
		const prefix = clipped.slice(0, cleanIndex);
		const suffix = clipped.slice(cleanIndex + clean.length);
		return `${frame("└")}${frame(prefix)}${clioTheme().fg("dim", clean)}${frame(suffix)}${frame(fill)}${frame("┘")}`;
	}
	return `${frame("└")}${frame(clipped)}${frame(fill)}${frame("┘")}`;
}

export function brandedContentRow(text: string, contentWidth: number): string {
	// One pass, not two: padAnsi truncates to the same width with the same
	// ellipsis, so the inner call was measuring and rebuilding the row for nothing.
	return `${clioFrame("│")} ${padAnsi(text, contentWidth, "…")} ${clioFrame("│")}`;
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

	/**
	 * Last rendered box, keyed by everything that shapes it. `childLines` is
	 * compared by array identity: a child that rebuilds its rows returns a fresh
	 * array and correctly misses, and one that serves a cache returns the same
	 * array and correctly hits.
	 */
	private cachedRender:
		| {
				width: number;
				rowBudget: number;
				childLines: string[];
				title: string;
				hint: string | undefined;
				tone: ClioToken | undefined;
				lines: string[];
		  }
		| undefined;

	constructor(
		private readonly child: Component,
		private readonly title: string | (() => string),
		/**
		 * A function hint is given the box's inner width so an overlay whose keys
		 * matter can shorten its own labels rather than let `elideHint` drop the
		 * middle entry, which is how the permission overlay lost `[s] stop turn`
		 * at 40 columns while the key still worked.
		 */
		private readonly footerHint?: string | ((innerWidth: number) => string | undefined),
		/** Box width in columns. Zero fills the row it is given. */
		private readonly boxWidth = 0,
		private readonly align: FrameAlign = "center",
		/**
		 * A function tone is re-read per frame, so one overlay can carry the
		 * decision treatment only while it is actually holding a decision.
		 */
		private readonly tone?: OverlayTone,
	) {}

	setRowBudget(rows: number): void {
		this.rowBudget = Math.max(0, Math.floor(rows));
	}

	render(width: number): string[] {
		const boxWidth = Math.max(5, Math.min(this.boxWidth > 0 ? this.boxWidth : width, width));
		const contentWidth = Math.max(1, boxWidth - 4);
		const childLines = this.child.render(contentWidth);
		const titleText = typeof this.title === "function" ? this.title() : this.title;
		const hint = typeof this.footerHint === "function" ? this.footerHint(contentWidth + 2) : this.footerHint;
		const tone = resolveTone(this.tone);
		// pi-tui has no dirty-component model, so a modal re-derived both borders,
		// re-fit the hint row, and re-padded every body row on every frame for as
		// long as it stayed open: 0.4 ms at 12 rows, 1.3 ms at 40. A child that
		// returns its cached array (Text and the queue panel both do) short-circuits
		// the whole frame through the identity check.
		const cached = this.cachedRender;
		if (
			cached !== undefined &&
			cached.width === width &&
			cached.rowBudget === this.rowBudget &&
			cached.childLines === childLines &&
			cached.title === titleText &&
			cached.hint === hint &&
			cached.tone === tone
		) {
			return cached.lines;
		}
		const label = titleText.length > 0 ? `─ ${titleText} ` : "─ ";
		const side = clioFrame("│", tone ?? "frame");
		const boxLines = [
			brandedTopBorder(label, contentWidth + 2, tone),
			...fitBody(childLines, this.rowBudget, contentWidth).map((line) => `${side} ${padAnsi(line, contentWidth)} ${side}`),
			brandedBottomBorder(contentWidth + 2, hint, tone),
		];
		const slack = Math.max(0, width - boxWidth);
		const lines = ((): string[] => {
			if (slack === 0) return boxLines;
			const leading = this.align === "left" ? 0 : this.align === "right" ? slack : Math.floor(slack / 2);
			const lead = " ".repeat(leading);
			const trail = " ".repeat(slack - leading);
			return boxLines.map((line) => `${lead}${line}${trail}`);
		})();
		this.cachedRender = { width, rowBudget: this.rowBudget, childLines, title: titleText, hint, tone, lines };
		return lines;
	}

	handleInput(data: string): void {
		this.child.handleInput?.(data);
	}

	invalidate(): void {
		this.cachedRender = undefined;
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
 *
 * This is also where the modal marker is claimed and released. Every framed
 * overlay is modal and every modal is framed: the only two overlays Clio shows
 * without a frame are the context and task islands, and both pass
 * `nonCapturing: true` straight to the engine. Hanging the marker here rather
 * than on the overlay lifecycle therefore covers the nested frames the
 * lifecycle's single `OverlayState` cannot see, and it cannot drift out of
 * sync with what actually owns the keyboard, because the same call that takes
 * the screen takes the marker.
 */
export function showClioOverlayFrame(
	tui: TUI,
	child: Component,
	options: OverlayOptions & {
		title: string | (() => string);
		footerHint?: string | ((innerWidth: number) => string | undefined);
		/** Border and title token; omitted leaves the informational frame. */
		tone?: OverlayTone;
		/**
		 * Stable id for the modal marker, published on the terminal title while
		 * this overlay owns the keys. Required, and deliberately not defaulted
		 * from `title`: several titles carry a session id, a decision
		 * classification, or the active tab, and an id that moves with the
		 * content is not an identifier. Use `modalMarkerId(...)` where the title
		 * really is fixed and surface-specific.
		 */
		markerId: string;
	},
): OverlayHandle {
	const { title, footerHint, tone, width, visible, maxHeight, margin, markerId, ...overlayOptions } = options;
	const boxWidth = typeof width === "number" ? width : 0;
	const frame = new ClioOverlayFrame(child, title, footerHint, boxWidth, frameAlignForAnchor(options.anchor), tone);
	const handle = tui.showOverlay(frame, {
		...overlayOptions,
		...(margin !== undefined ? { margin } : {}),
		width: "100%",
		visible: (termWidth, termHeight) => {
			const shown = visible ? visible(termWidth, termHeight) : true;
			// A caller may update an object margin in its visibility callback to
			// follow live content geometry. Read it after that callback, every frame.
			const marginRows = typeof margin === "number" ? margin * 2 : (margin?.top ?? 0) + (margin?.bottom ?? 0);
			const available = Math.max(1, termHeight - marginRows);
			const requested = resolveRowSize(maxHeight, termHeight);
			frame.setRowBudget(requested === null ? available : Math.min(requested, available));
			return shown;
		},
	});
	const marker = enterModal(markerId, modalMarkerSink(tui));
	return {
		hide(): void {
			marker.release();
			handle.hide();
		},
		setHidden(hidden: boolean): void {
			marker.setActive(!hidden);
			handle.setHidden(hidden);
		},
		isHidden: (): boolean => handle.isHidden(),
		focus(): void {
			marker.raise();
			handle.focus();
		},
		// A pure passthrough on purpose. The engine hands focus to the next
		// visible capturing overlay, which is another modal, so the stack is
		// unchanged; the surface that gives the keyboard back to the composer
		// does it by hiding, which `setHidden` already reports.
		unfocus: (unfocusOptions?: OverlayUnfocusOptions): void =>
			unfocusOptions ? handle.unfocus(unfocusOptions) : handle.unfocus(),
		isFocused: (): boolean => handle.isFocused(),
	};
}

/**
 * The title sink behind a TUI, or null when there is none.
 *
 * The engine's `Terminal` declares `setTitle`, but the stub TUIs the overlay
 * tests mount against are structural casts that carry only what the overlay
 * under test reads. Probing for the method keeps the marker inert on those
 * rather than throwing inside a render path.
 */
function modalMarkerSink(tui: TUI): ModalMarkerSink | null {
	const terminal: Partial<ModalMarkerSink> | undefined = tui.terminal;
	return typeof terminal?.setTitle === "function" ? (terminal as ModalMarkerSink) : null;
}

/** Rows from an overlay size value, matching how the engine reads one. */
function resolveRowSize(value: OverlayOptions["maxHeight"], termHeight: number): number | null {
	if (typeof value === "number") return Math.max(1, Math.floor(value));
	if (typeof value !== "string") return null;
	const percent = /^(\d+(?:\.\d+)?)%$/u.exec(value.trim());
	if (!percent?.[1]) return null;
	return Math.max(1, Math.floor((termHeight * Number.parseFloat(percent[1])) / 100));
}
