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
import { clioTheme, selectListTheme, settingsListTheme } from "./theme/index.js";

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

export function clioFrame(text: string): string {
	return clioTheme().fg("frame", text);
}

export function clioTitle(text: string): string {
	return clioTheme().style("title", text, { bold: true });
}

export function clioError(text: string): string {
	return clioTheme().fg("error", text);
}

function padAnsi(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "", true);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

export function brandedTopBorder(label: string, innerWidth: number): string {
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

export type OverlayMode = "browse" | "commit";
export interface HintEntry {
	key: string;
	verb: string;
}

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

export function buildHint(mode: OverlayMode, entries: ReadonlyArray<HintEntry>): string {
	const escVerb = mode === "browse" ? "close" : "cancel";
	const finalEntries = [
		...entries.map((e) => ({ key: canonicalizeKey(e.key), verb: e.verb })),
		{ key: "Esc", verb: escVerb },
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

export function brandedBottomBorder(innerWidth: number, hint?: string): string {
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

export function runtimeResolutionDiagnosticLine(diagnostic: RuntimeResolutionDiagnostic, width: number): string {
	return clioError(fitDiagnosticLine(diagnostic, width));
}

function fitDiagnosticLine(diagnostic: RuntimeResolutionDiagnostic, width: number): string {
	return padAnsi(formatRuntimeResolutionDiagnostic(diagnostic), Math.max(1, width));
}

export class ClioOverlayFrame implements Component {
	constructor(
		private readonly child: Component,
		private readonly title: string | (() => string),
		private readonly footerHint?: string | (() => string | undefined),
	) {}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - 4);
		const childLines = this.child.render(contentWidth);
		const titleText = typeof this.title === "function" ? this.title() : this.title;
		const label = titleText.length > 0 ? `─ ${titleText} ` : "─ ";
		const hint = typeof this.footerHint === "function" ? this.footerHint() : this.footerHint;
		return [
			brandedTopBorder(label, contentWidth + 2),
			...childLines.map((line) => `${clioFrame("│")} ${padAnsi(line, contentWidth)} ${clioFrame("│")}`),
			brandedBottomBorder(contentWidth + 2, hint),
		];
	}

	handleInput(data: string): void {
		this.child.handleInput?.(data);
	}

	invalidate(): void {
		this.child.invalidate?.();
	}
}

export function showClioOverlayFrame(
	tui: TUI,
	child: Component,
	options: OverlayOptions & { title: string | (() => string); footerHint?: string | (() => string | undefined) },
): OverlayHandle {
	const { title, footerHint, ...overlayOptions } = options;
	return tui.showOverlay(new ClioOverlayFrame(child, title, footerHint), overlayOptions);
}
