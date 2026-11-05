/** Terminal palette primitives. No renderer or website dependencies. */
export type ThemeBackground = "dark" | "light";
export type Hex = `#${string}`;
export type Rgb = readonly [number, number, number];

/** WCAG relative luminance of an sRGB color. */
export function relativeLuminance(rgb: Rgb): number {
	const channel = (value: number): number => {
		const unit = value / 255;
		return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** WCAG contrast ratio between two colors, from 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
	const x = relativeLuminance(a);
	const y = relativeLuminance(b);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** [unknown background, dark, light], each as [truecolor, indexed color]. */
type Projection = readonly [Hex, number];
type RampColor = readonly [Projection, Projection, Projection];

/**
 * Warm stone and ivory follow the website's paper palette. Near-white is
 * reserved for answers and entered text; cyan and copper follow the IOWarp logo.
 * Unknown-background colors occupy the narrow luminance band that holds 4.5:1 on
 * both black and white. The dark and light projections hold 4.5:1 for text and
 * 3:1 for rules on typical backgrounds and on the composer surface; see
 * theme-contrast.ts for how they lift further on a reported background. A declared
 * surface supplies its own background and uses the corresponding projection.
 */
export const TERMINAL_PALETTE = {
	neutralSubdued: [
		["#7d756b", 243],
		["#978e81", 246],
		["#716658", 242],
	],
	neutralSupporting: [
		["#7e7568", 243],
		["#b1a592", 144],
		["#65594b", 241],
	],
	neutralReading: [
		["#807565", 243],
		["#c2b9aa", 180],
		["#403a32", 238],
	],
	neutralFocal: [
		["#998a73", 245],
		["#d2c9b9", 187],
		["#322c24", 235],
	],
	neutralStrong: [
		["#817564", 243],
		["#eeeae2", 255],
		["#231f1a", 234],
	],
	ivorySubdued: [
		["#807360", 243],
		["#9c8d77", 144],
		["#7a6850", 242],
	],
	ivorySupporting: [
		["#7f7567", 243],
		["#b5a58e", 144],
		["#68563f", 240],
	],
	ivoryReading: [
		["#807566", 243],
		["#c9b89e", 180],
		["#51412b", 237],
	],
	ivoryFocal: [
		["#817564", 243],
		["#dbccb4", 187],
		["#3e301f", 235],
	],
	ivoryStrong: [
		["#817565", 243],
		["#eee6d9", 230],
		["#282015", 234],
	],
	cyanSupporting: [
		["#268288", 30],
		["#65afb6", 73],
		["#326970", 23],
	],
	cyanReading: [
		["#18838b", 30],
		["#55bec6", 80],
		["#16666d", 23],
	],
	cyanFocal: [
		["#13838b", 30],
		["#43d9dc", 80],
		["#0a666c", 23],
	],
	cyanStrong: [
		["#08838b", 30],
		["#8be9eb", 123],
		["#07565c", 23],
	],
	turquoise: [
		["#22847d", 30],
		["#58c7b5", 79],
		["#23685f", 23],
	],
	cyanDeep: [
		["#29828e", 30],
		["#509eaf", 73],
		["#326375", 24],
	],
	orangeSupporting: [
		["#946f52", 130],
		["#c89977", 180],
		["#805a3e", 95],
	],
	orangeReading: [
		["#9f6b3e", 130],
		["#e7a16a", 215],
		["#915321", 94],
	],
	orangeFocal: [
		["#aa6634", 130],
		["#ff9851", 209],
		["#9a4812", 94],
	],
	orangeStrong: [
		["#a86733", 130],
		["#ffb578", 215],
		["#843d0e", 94],
	],
	successSupporting: [
		["#409075", 65],
		["#78bda1", 108],
		["#326e53", 29],
	],
	success: [
		["#248750", 29],
		["#34d399", 42],
		["#1d7440", 22],
	],
	syntaxLiteral: [
		["#14838a", 30],
		["#59b9bd", 73],
		["#0a666c", 23],
	],
	warningSupporting: [
		["#a18139", 136],
		["#d3b976", 179],
		["#76602a", 94],
	],
	warning: [
		["#996f00", 100],
		["#ffd166", 221],
		["#805600", 58],
	],
	errorSupporting: [
		["#b66c6c", 131],
		["#d49393", 174],
		["#934747", 131],
	],
	error: [
		["#ca4c4c", 131],
		["#f87171", 210],
		["#bf3030", 124],
	],
	border: [
		["#737a80", 243],
		["#6c7e79", 244],
		["#7c8185", 244],
	],
	divider: [
		["#737a80", 243],
		["#657571", 243],
		["#868a8e", 102],
	],
	surface: [
		["#151412", 233],
		["#151412", 233],
		["#f3eee4", 255],
	],
	selectionSurface: [
		["#052629", 234],
		["#052629", 234],
		["#e3f2f3", 195],
	],
	yoloSurface: [
		["#1d2b2a", 235],
		["#1d2b2a", 235],
		["#e8f2ef", 255],
	],
	onAccent: [
		["#10191b", 233],
		["#10191b", 233],
		["#faf7f2", 255],
	],
} as const satisfies Record<string, RampColor>;

export type PaletteColor = keyof typeof TERMINAL_PALETTE;

export function paletteProjection(color: PaletteColor, background: ThemeBackground | null = null): Projection {
	return TERMINAL_PALETTE[color][background === "dark" ? 1 : background === "light" ? 2 : 0];
}

/** Compatibility vocabulary for external profiles and configured roster colors. */
export const LEGACY_TOKEN_COLOR = {
	editor: "cyanFocal",
	editorDanger: "error",
	editorAction: "orangeFocal",
	editorYoloBackground: "yoloSurface",
	editorYoloText: "ivoryFocal",
	accent: "cyanFocal",
	accentDeep: "cyanReading",
	action: "orangeFocal",
	emphasis: "neutralFocal",
	tool: "neutralReading",
	agent: "turquoise",
	success: "success",
	warning: "warning",
	error: "error",
	info: "cyanSupporting",
	reason: "neutralSupporting",
	dim: "neutralSupporting",
	muted: "neutralReading",
	title: "neutralStrong",
	frame: "border",
	frameStrong: "cyanReading",
} as const satisfies Record<string, PaletteColor>;

export type ClioToken = keyof typeof LEGACY_TOKEN_COLOR;

/** Legacy token projection; new terminal consumers request semantic roles. */
export function tokenHex(token: ClioToken, background: ThemeBackground | null = null): Hex {
	return paletteProjection(LEGACY_TOKEN_COLOR[token], background)[0];
}
