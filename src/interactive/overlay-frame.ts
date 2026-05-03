import {
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "../engine/tui.js";

const ANSI_RESET = "\u001b[0m";
const CLIO_TEAL = "\u001b[38;5;80m";
const CLIO_ORANGE = "\u001b[38;5;214m";

export function clioFrame(text: string): string {
	return `${CLIO_TEAL}${text}${ANSI_RESET}`;
}

export function clioTitle(text: string): string {
	return `${CLIO_ORANGE}${text}${ANSI_RESET}`;
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
