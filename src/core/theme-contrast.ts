import { resolveRole, type SemanticRole, STRUCTURAL_ROLES, TEXT_ROLES } from "./theme-roles.js";
import {
	contrastRatio,
	type PaletteColor,
	type Rgb,
	TERMINAL_PALETTE,
	type ThemeBackground,
} from "./theme-token-hex.js";

/**
 * Contrast rules for the palette, solved against the background the terminal
 * reports. Each color is paired with the surfaces it is painted on and a level,
 * and takes the strictest result across them. Text needs 4.5:1 and every mark
 * without words needs 3:1, the WCAG floor for non-text contrast: a frame or
 * divider tells the operator where a card or a section ends, and a meter's
 * reserve segment is painted in the divider color. A word on a rule is painted
 * in a text role.
 *
 * A color that passes is left alone. One that fails is mixed toward white or
 * black, which keeps its hue and can only reduce its chroma, so nothing turns
 * vivid. Indexed colors stay in the 16-255 range: 0-15 belong to the terminal's
 * theme, and bright black often falls below 3:1 on a dark background.
 */
const CONTRAST_TEXT = 4.5;
const CONTRAST_UI = 3;
const CONTRAST_HAIRLINE = 3;
const HAIRLINES = new Set<PaletteColor>(["border", "divider"]);

export interface ProjectedColor {
	readonly rgb: Rgb;
	readonly xterm: number;
}

/** The terminal's own background, or a palette color painted behind this one. */
type ContrastSurface = "application" | PaletteColor;
interface ContrastRule {
	readonly level: number;
	readonly surfaces: readonly ContrastSurface[];
}

const SURFACE_TINT = {
	surface: { tint: "neutralStrong", dark: 0.07, light: 0.05 },
	selectionSurface: { tint: "cyanFocal", dark: 0.2, light: 0.12 },
	yoloSurface: { tint: "turquoise", dark: 0.16, light: 0.1 },
} as const satisfies Partial<Record<PaletteColor, { tint: PaletteColor; dark: number; light: number }>>;
const isSurface = (color: PaletteColor): color is keyof typeof SURFACE_TINT => Object.hasOwn(SURFACE_TINT, color);

const STRUCTURAL_TEXT = new Set<string>([
	"syntaxKeyword",
	"syntaxKey",
	"syntaxString",
	"syntaxLiteral",
	"syntaxComment",
]);
// The composer surface paints behind YOLO's own projections, its rail, the
// neutral facts in its strip and its outcome colors. Everything else meets the
// terminal's background alone.
const ON_COMPOSER = new Set<PaletteColor>([
	"cyanFocal",
	"orangeReading",
	"neutralSupporting",
	"neutralReading",
	"error",
	"warning",
	"success",
]);
const YOLO_CONTEXT = { surface: "composer", mode: "yolo" } as const;

function buildRules(): ReadonlyMap<PaletteColor, ContrastRule> {
	const roles = Object.keys(TEXT_ROLES) as SemanticRole[];
	for (const role of roles) {
		const projected = resolveRole(role, YOLO_CONTEXT).color;
		if (projected !== resolveRole(role).color) ON_COMPOSER.add(projected);
	}
	const rules = new Map<PaletteColor, ContrastRule>();
	const raise = (color: PaletteColor, level: number): void => {
		const surfaces: readonly ContrastSurface[] = ON_COMPOSER.has(color)
			? ["application", "yoloSurface"]
			: ["application"];
		if (level > (rules.get(color)?.level ?? 0)) rules.set(color, { level, surfaces });
	};
	for (const role of roles) {
		raise(resolveRole(role).color, CONTRAST_TEXT);
		raise(resolveRole(role, YOLO_CONTEXT).color, CONTRAST_TEXT);
	}
	for (const [role, color] of Object.entries(STRUCTURAL_ROLES) as [string, PaletteColor][]) {
		if (isSurface(color) || color === "onAccent") continue;
		raise(color, STRUCTURAL_TEXT.has(role) ? CONTRAST_TEXT : HAIRLINES.has(color) ? CONTRAST_HAIRLINE : CONTRAST_UI);
	}
	// The one inverse pair: onSelection text sits on the selection badge.
	rules.set("onAccent", { level: CONTRAST_TEXT, surfaces: ["cyanFocal"] });
	return rules;
}
const RULES = buildRules();

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

function mix(from: Rgb, to: Rgb, amount: number): Rgb {
	return [
		Math.round(from[0] + (to[0] - from[0]) * amount),
		Math.round(from[1] + (to[1] - from[1]) * amount),
		Math.round(from[2] + (to[2] - from[2]) * amount),
	];
}

function worstContrast(color: Rgb, surfaces: readonly Rgb[]): number {
	return Math.min(...surfaces.map((surface) => contrastRatio(color, surface)));
}

/** The smallest mix toward white or black that reaches `level` on every surface, or the best end when none does. */
function liftToContrast(color: Rgb, surfaces: readonly Rgb[], level: number): Rgb {
	if (worstContrast(color, surfaces) >= level) return color;
	const end = worstContrast(WHITE, surfaces) >= worstContrast(BLACK, surfaces) ? WHITE : BLACK;
	if (worstContrast(end, surfaces) < level) return end;
	let low = 0;
	let high = 1;
	for (let step = 0; step < 10; step += 1) {
		const middle = (low + high) / 2;
		if (worstContrast(mix(color, end, middle), surfaces) >= level) high = middle;
		else low = middle;
	}
	return mix(color, end, high);
}

const CUBE = [0, 95, 135, 175, 215, 255] as const;
/** The fixed xterm color at an index in 16-255. */
function xtermRgb(index: number): Rgb {
	if (index >= 232) {
		const value = 8 + (index - 232) * 10;
		return [value, value, value];
	}
	const cube = index - 16;
	return [CUBE[Math.floor(cube / 36)] ?? 0, CUBE[Math.floor(cube / 6) % 6] ?? 0, CUBE[cube % 6] ?? 0];
}
const XTERM = Array.from({ length: 240 }, (_, offset) => ({ index: offset + 16, rgb: xtermRgb(offset + 16) }));

function distance(a: Rgb, b: Rgb): number {
	return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

/** The indexed color nearest `target` that holds `level` on the surfaces; the strongest one when none does. */
function xtermForContrast(target: Rgb, surfaces: readonly Rgb[], level: number): number {
	let nearest: number | null = null;
	let nearestDistance = Number.POSITIVE_INFINITY;
	let strongest = XTERM[0]?.index ?? 16;
	let strongestContrast = 0;
	for (const { index, rgb } of XTERM) {
		const contrast = worstContrast(rgb, surfaces);
		if (contrast > strongestContrast) {
			strongest = index;
			strongestContrast = contrast;
		}
		if (contrast < level) continue;
		const away = distance(rgb, target);
		if (away < nearestDistance) {
			nearest = index;
			nearestDistance = away;
		}
	}
	return nearest ?? strongest;
}

/**
 * Re-solve a projected palette for the background the terminal reported.
 * Surfaces come first, tinted from that background so they sit on it rather than
 * punching a fixed hole in it; every foreground then lifts against them. Colors
 * in `fixed` are a skin's own choice and stay as declared.
 */
export function adaptPalette<Color extends ProjectedColor>(
	base: Readonly<Record<PaletteColor, Color>>,
	background: Rgb,
	scheme: ThemeBackground,
	fixed: ReadonlySet<PaletteColor> = new Set(),
): Record<PaletteColor, ProjectedColor> {
	const adapted = { ...base } as Record<PaletteColor, ProjectedColor>;
	for (const [color, tint] of Object.entries(SURFACE_TINT) as [
		keyof typeof SURFACE_TINT,
		(typeof SURFACE_TINT)[keyof typeof SURFACE_TINT],
	][]) {
		if (fixed.has(color)) continue;
		const rgb = mix(background, base[tint.tint].rgb, tint[scheme]);
		adapted[color] = { rgb, xterm: xtermForContrast(rgb, [], 0) };
	}
	for (const color of Object.keys(TERMINAL_PALETTE) as PaletteColor[]) {
		const rule = RULES.get(color);
		if (rule === undefined || fixed.has(color)) continue;
		const painted = (read: (surface: ProjectedColor) => Rgb): Rgb[] =>
			rule.surfaces.map((surface) => (surface === "application" ? background : read(adapted[surface])));
		const rgb = liftToContrast(
			base[color].rgb,
			painted((surface) => surface.rgb),
			rule.level,
		);
		const xtermSurfaces = painted((surface) => xtermRgb(surface.xterm));
		const xterm =
			worstContrast(xtermRgb(base[color].xterm), xtermSurfaces) >= rule.level
				? base[color].xterm
				: xtermForContrast(rgb, xtermSurfaces, rule.level);
		adapted[color] = { rgb, xterm };
	}
	return adapted;
}
