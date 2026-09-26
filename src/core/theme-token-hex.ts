/** Terminal palette primitives. No renderer or website dependencies. */
export type ThemeBackground = "dark" | "light";
export type Hex = `#${string}`;

/** [unknown background, dark, light], each as [truecolor, indexed color]. */
type Projection = readonly [Hex, number];
type RampColor = readonly [Projection, Projection, Projection];

/**
 * Warm stone and ivory follow the website's paper palette. Near-white is
 * reserved for answers and entered text; cyan and copper follow the IOWarp logo.
 * Unknown-background text occupies the middle luminance band. A declared
 * surface supplies its own background and uses the corresponding projection.
 */
export const TERMINAL_PALETTE = {
	neutralSubdued: [
		["#80786d", 244],
		["#968d80", 245],
		["#716658", 242],
	],
	neutralSupporting: [
		["#898071", 244],
		["#b1a592", 144],
		["#65594b", 241],
	],
	neutralReading: [
		["#928673", 245],
		["#c2b9aa", 180],
		["#403a32", 238],
	],
	neutralFocal: [
		["#998a73", 245],
		["#d2c9b9", 187],
		["#322c24", 235],
	],
	neutralStrong: [
		["#a0917c", 245],
		["#eeeae2", 255],
		["#231f1a", 234],
	],
	ivorySupporting: [
		["#8a8070", 244],
		["#b5a58e", 144],
		["#68563f", 240],
	],
	ivoryReading: [
		["#8f8271", 245],
		["#c9b89e", 180],
		["#51412b", 237],
	],
	ivoryFocal: [
		["#948773", 245],
		["#dbccb4", 187],
		["#3e301f", 235],
	],
	ivoryStrong: [
		["#998b78", 245],
		["#eee6d9", 230],
		["#282015", 234],
	],
	cyanSupporting: [
		["#288b91", 30],
		["#65afb6", 73],
		["#326970", 23],
	],
	cyanReading: [
		["#1b929a", 30],
		["#55bec6", 80],
		["#16666d", 23],
	],
	cyanFocal: [
		["#15959e", 30],
		["#43d9dc", 80],
		["#0a666c", 23],
	],
	cyanStrong: [
		["#09969f", 30],
		["#8be9eb", 123],
		["#07565c", 23],
	],
	turquoise: [
		["#258e87", 30],
		["#58c7b5", 79],
		["#23685f", 29],
	],
	cyanDeep: [
		["#29828e", 30],
		["#509eaf", 73],
		["#326375", 24],
	],
	orangeSupporting: [
		["#a47b5b", 137],
		["#c89977", 180],
		["#805a3e", 95],
	],
	orangeReading: [
		["#b77b47", 137],
		["#e7a16a", 215],
		["#915321", 130],
	],
	orangeFocal: [
		["#c7783d", 172],
		["#ff9851", 209],
		["#9a4812", 130],
	],
	orangeStrong: [
		["#ca7b3d", 172],
		["#ffb578", 215],
		["#843d0e", 130],
	],
	successSupporting: [
		["#409075", 65],
		["#78bda1", 108],
		["#326e53", 29],
	],
	success: [
		["#2a9c5c", 65],
		["#34d399", 42],
		["#1d7440", 28],
	],
	syntaxLiteral: [
		["#158990", 30],
		["#59b9bd", 73],
		["#0a666c", 23],
	],
	warningSupporting: [
		["#a18139", 136],
		["#d3b976", 179],
		["#76602a", 94],
	],
	warning: [
		["#b08000", 136],
		["#ffd166", 221],
		["#805600", 94],
	],
	errorSupporting: [
		["#b66c6c", 131],
		["#d49393", 174],
		["#934747", 131],
	],
	error: [
		["#dd5353", 167],
		["#f87171", 210],
		["#bf3030", 124],
	],
	border: [
		["#737a80", 243],
		["#526762", 240],
		["#bbc3c8", 250],
	],
	divider: [
		["#737a80", 243],
		["#3e514c", 239],
		["#cbd1d6", 252],
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
		["#2c2521", 235],
		["#2c2521", 235],
		["#f4e5d9", 223],
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
