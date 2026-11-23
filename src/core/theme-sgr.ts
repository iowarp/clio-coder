import type { ColorDepth } from "./terminal-preferences.js";
import { ANSI16, type PaletteColor, paletteProjection, type Rgb, type ThemeBackground } from "./theme-token-hex.js";

/**
 * The one place palette colors become SGR parameters. A paint request is a pair, a foreground, a background, either
 * or both, and its answer carries the exact parameters that close it, so a span ends what it opened instead of a full
 * reset that would strip the color from the rest of a row.
 */
export interface SgrColor {
	/** The palette family, which picks the depth 16 entry; absent for an operator's own `#rrggbb`. */
	readonly name?: PaletteColor;
	readonly rgb: Rgb;
	readonly xterm: number;
	/** Primary text on an unknown background is the terminal's own foreground, the one color certain to read. */
	readonly terminalForeground?: boolean;
}
export interface SgrPair {
	readonly fg?: PaletteColor | SgrColor;
	readonly bg?: PaletteColor | SgrColor;
}
/** SGR parameters without the `ESC [` and `m`; empty when the pair paints nothing at this depth. */
export interface Sgr {
	readonly open: string;
	readonly close: string;
}

/**
 * With no background reported, primary text is the terminal's own default foreground. Secondary text and accents
 * stay in the mid-luminance band so the hierarchy survives.
 */
export const TERMINAL_FOREGROUND_ON_UNKNOWN: ReadonlySet<PaletteColor> = new Set<PaletteColor>([
	"neutralReading",
	"neutralFocal",
	"neutralStrong",
	"ivoryReading",
	"ivoryFocal",
	"ivoryStrong",
]);

/** Backgrounds CLIO Coder paints behind text. Any other background in a pair is the selection badge's inverse pair. */
export const OWNED_BACKGROUNDS: ReadonlySet<PaletteColor> = new Set<PaletteColor>([
	"surface",
	"selectionSurface",
	"yoloSurface",
]);

// The cube's levels are not evenly spaced, so rounding on a linear scale lands a shade lighter and can lose the contrast
// the color was chosen to hold.
const XTERM_CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;
/** The nearest entry of the 6x6x6 xterm cube. */
export function rgbXterm(rgb: Rgb): number {
	const cube = (channel: number): number => {
		let nearest = 0;
		let best = Number.POSITIVE_INFINITY;
		for (const [index, level] of XTERM_CUBE_LEVELS.entries()) {
			const away = Math.abs(level - channel);
			if (away < best) {
				best = away;
				nearest = index;
			}
		}
		return nearest;
	};
	return 16 + 36 * cube(rgb[0]) + 6 * cube(rgb[1]) + cube(rgb[2]);
}

export function hexRgb(hex: string): Rgb {
	return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as unknown as Rgb;
}

function project(color: PaletteColor | SgrColor, background: ThemeBackground | null): SgrColor {
	if (typeof color !== "string") return color;
	const [hex, xterm] = paletteProjection(color, background);
	return {
		name: color,
		rgb: hexRgb(hex),
		xterm,
		terminalForeground: background === null && TERMINAL_FOREGROUND_ON_UNKNOWN.has(color),
	};
}

/** An operator's own color at depth 16: the nearest ANSI hue, or the terminal foreground when it has little hue. */
function ansiHue([red, green, blue]: Rgb): string {
	const max = Math.max(red, green, blue);
	const min = Math.min(red, green, blue);
	if (max === 0 || (max - min) / max < 0.25) return "39";
	const span = max - min;
	const hue =
		max === red
			? (((green - blue) / span) * 60 + 360) % 360
			: max === green
				? ((blue - red) / span) * 60 + 120
				: ((red - green) / span) * 60 + 240;
	if (hue < 20 || hue >= 330) return "31";
	if (hue < 70) return "33";
	if (hue < 160) return "32";
	if (hue < 200) return "36";
	if (hue < 260) return "34";
	return "35";
}

function foreground(color: SgrColor, depth: ColorDepth): Sgr {
	if (depth === "none") return { open: "", close: "" };
	if (color.terminalForeground === true) return { open: "39", close: "39" };
	if (depth === "16") {
		const sgr = color.name === undefined ? ansiHue(color.rgb) : ANSI16[color.name].sgr;
		return { open: sgr, close: sgr.endsWith(";2") ? "22;39" : "39" };
	}
	return {
		open: depth === "truecolor" ? `38;2;${color.rgb[0]};${color.rgb[1]};${color.rgb[2]}` : `38;5;${color.xterm}`,
		close: "39",
	};
}

function backgroundSgr(color: SgrColor, depth: ColorDepth): Sgr {
	// Contrast cannot be measured without a palette, so the selection band becomes an underline and the other owned
	// surfaces paint nothing; the composer keeps its rail and label.
	if (depth === "none" || depth === "16") {
		return color.name === "selectionSurface" ? { open: "4", close: "24" } : { open: "", close: "" };
	}
	return {
		open: depth === "truecolor" ? `48;2;${color.rgb[0]};${color.rgb[1]};${color.rgb[2]}` : `48;5;${color.xterm}`,
		close: "49",
	};
}

/**
 * Opening and closing parameters for one paint request at one depth. `background` is the terminal background the
 * palette is projected for (`null` when unknown). The badge pair (`onSelection` on `selectionBadge`) is inverse with
 * bold at depth 16, at depth none and on an unknown background, where its ink measured 3.95:1.
 */
export function sgrFor(pair: SgrPair, depth: ColorDepth, background: ThemeBackground | null): Sgr {
	const bg = pair.bg === undefined ? undefined : project(pair.bg, background);
	if (bg !== undefined && (bg.name === undefined || !OWNED_BACKGROUNDS.has(bg.name))) {
		if (depth === "none") return { open: "1;7", close: "22;27" };
		if (depth === "16" || background === null) return { open: "1;7", close: "27;22" };
	}
	const parts = [
		...(pair.fg === undefined ? [] : [foreground(project(pair.fg, background), depth)]),
		...(bg === undefined ? [] : [backgroundSgr(bg, depth)]),
	].filter((part) => part.open.length > 0);
	return { open: parts.map((part) => part.open).join(";"), close: parts.map((part) => part.close).join(";") };
}
