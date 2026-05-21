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

const ANSI_RESET = "\u001b[0m";
const CLIO_TEAL = "\u001b[38;5;80m";
const CLIO_ORANGE = "\u001b[38;5;214m";
const CLIO_ERROR = "\u001b[38;5;196m";

export const IDENTITY = (text: string): string => text;

export const DEFAULT_SELECT_THEME: SelectListTheme = {
	selectedPrefix: IDENTITY,
	selectedText: IDENTITY,
	description: IDENTITY,
	scrollInfo: IDENTITY,
	noMatch: IDENTITY,
};

export const DEFAULT_SETTINGS_THEME: SettingsListTheme = {
	label: IDENTITY,
	value: IDENTITY,
	description: IDENTITY,
	cursor: "▸",
	hint: IDENTITY,
};

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
	return `${CLIO_TEAL}${text}${ANSI_RESET}`;
}

export function clioTitle(text: string): string {
	return `${CLIO_ORANGE}${text}${ANSI_RESET}`;
}

export function clioError(text: string): string {
	return `${CLIO_ERROR}${text}${ANSI_RESET}`;
}

function padAnsi(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "", true);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

export function brandedTopBorder(label: string, innerWidth: number): string {
	const clipped = visibleWidth(label) > innerWidth ? truncateToWidth(label, innerWidth, "...", true) : label;
	const fill = "─".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	return `${clioFrame("┌")}${clioTitle(clipped)}${clioFrame(fill)}${clioFrame("┐")}`;
}

export function brandedBottomBorder(innerWidth: number): string {
	return `${clioFrame("└")}${clioFrame("─".repeat(innerWidth))}${clioFrame("┘")}`;
}

export function brandedDividerRow(contentWidth: number): string {
	return `${clioFrame("│")} ${clioFrame("─".repeat(contentWidth))} ${clioFrame("│")}`;
}

export function brandedContentRow(text: string, contentWidth: number): string {
	return `${clioFrame("│")} ${padAnsi(truncateToWidth(text, contentWidth, "...", true), contentWidth)} ${clioFrame("│")}`;
}

export function brandedTextRow(text: string, contentWidth: number): string {
	return brandedContentRow(text, contentWidth);
}

export function brandedErrorRow(text: string, contentWidth: number): string {
	return brandedContentRow(clioError(text), contentWidth);
}

export function formatRuntimeResolutionDiagnostic(diagnostic: RuntimeResolutionDiagnostic): string {
	return `${diagnostic.severity}: ${diagnostic.code}: ${diagnostic.message}`;
}

export function runtimeResolutionDiagnosticLine(diagnostic: RuntimeResolutionDiagnostic, width: number): string {
	return clioError(fitDiagnosticLine(diagnostic, width));
}

export function brandedRuntimeResolutionDiagnosticRow(
	diagnostic: RuntimeResolutionDiagnostic,
	contentWidth: number,
): string {
	return brandedErrorRow(formatRuntimeResolutionDiagnostic(diagnostic), contentWidth);
}

function fitDiagnosticLine(diagnostic: RuntimeResolutionDiagnostic, width: number): string {
	return padAnsi(formatRuntimeResolutionDiagnostic(diagnostic), Math.max(1, width));
}

export function brandedAsciiTopBorder(label: string, innerWidth: number): string {
	const clipped = visibleWidth(label) > innerWidth ? truncateToWidth(label, innerWidth, "...", true) : label;
	const fill = "-".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
	return `${clioFrame("+")}${clioTitle(clipped)}${clioFrame(fill)}${clioFrame("+")}`;
}

export function brandedAsciiBottomBorder(innerWidth: number): string {
	return `${clioFrame("+")}${clioFrame("-".repeat(innerWidth))}${clioFrame("+")}`;
}

export function brandedAsciiContentRow(text: string, contentWidth: number): string {
	return `${clioFrame("|")} ${padAnsi(text, contentWidth)} ${clioFrame("|")}`;
}

export class ClioOverlayFrame implements Component {
	constructor(
		private readonly child: Component,
		private readonly title: string,
	) {}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - 4);
		const childLines = this.child.render(contentWidth);
		const label = this.title.length > 0 ? `─ ${this.title} ` : "─ ";
		return [
			brandedTopBorder(label, contentWidth + 2),
			...childLines.map((line) => `${clioFrame("│")} ${padAnsi(line, contentWidth)} ${clioFrame("│")}`),
			brandedBottomBorder(contentWidth + 2),
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
	options: OverlayOptions & { title: string },
): OverlayHandle {
	const { title, ...overlayOptions } = options;
	return tui.showOverlay(new ClioOverlayFrame(child, title), overlayOptions);
}
