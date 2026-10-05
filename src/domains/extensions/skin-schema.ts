import type { SemanticRole } from "../../core/theme-roles.js";
import { resolveRole } from "../../core/theme-roles.js";
import type { PaletteColor, ThemeBackground } from "../../core/theme-token-hex.js";
import { paletteProjection, TERMINAL_PALETTE } from "../../core/theme-token-hex.js";
import type { ExtensionSkin } from "./public-api-v2.js";
import { extensionPlainText } from "./runtime-schema.js";

// Include the supporting command hint on yolo surfaces as well as normal outcomes and approval rails.
const SAFETY_ROLES: SemanticRole[] = [
	"error",
	"warning",
	"success",
	"attention",
	"attentionRail",
	"yoloLabel",
	"composerSurface",
];
export const SKIN_LOCKED_PALETTE: ReadonlyArray<PaletteColor> = Object.freeze([
	...new Set([
		...SAFETY_ROLES.map((role) => resolveRole(role).color),
		resolveRole("commandHint", { surface: "composer", mode: "yolo" }).color,
	]),
]);

type Validation = { ok: true; skin: ExtensionSkin } | { ok: false; path: string; reason: string };
class InvalidSkin extends Error {
	constructor(
		readonly path: string,
		reason: string,
	) {
		super(reason);
	}
}
function reject(path: string, reason: string): never {
	throw new InvalidSkin(path || "/", reason);
}
function child(path: string, key: PropertyKey): string {
	return `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}
function record(value: unknown, path: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) reject(path, "expected an object");
	return value as Record<string, unknown>;
}
function closed(value: unknown, path: string, fields: readonly string[]): Record<string, unknown> {
	const raw = record(value, path);
	for (const key of Reflect.ownKeys(raw))
		if (typeof key !== "string" || !fields.includes(key)) reject(child(path, key), "unknown field");
	return raw;
}
function label(value: unknown, path: string, max: number): string {
	if (typeof value !== "string") reject(path, "expected a string");
	const text = extensionPlainText(value).replaceAll("\n", "").replaceAll("\t", "");
	if (Array.from(text).length > max) reject(path, `exceeds ${max} characters`);
	return text;
}
function hex(value: unknown, path: string): string {
	if (typeof value !== "string" || !/^#[0-9a-f]{6}$/iu.test(value)) reject(path, "expected #rrggbb");
	return value.toLowerCase();
}
function luminance(hex: string): number {
	const channels = [1, 3, 5].map((at) => {
		const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
		return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}
function contrast(a: string, b: string): number {
	const x = luminance(a),
		y = luminance(b);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

export function validateSkin(value: unknown): Validation {
	try {
		const raw = closed(value, "", ["palette", "glyphs", "agents"]);
		const skin: ExtensionSkin = {};
		if (Object.hasOwn(raw, "palette")) {
			const overrides = record(raw.palette, "/palette");
			skin.palette = {};
			for (const key of Reflect.ownKeys(overrides)) {
				const path = child("/palette", key);
				if (typeof key !== "string" || !Object.hasOwn(TERMINAL_PALETTE, key)) reject(path, "unknown palette color");
				if (SKIN_LOCKED_PALETTE.includes(key as PaletteColor)) reject(path, "locked safety color");
				const pair = closed(overrides[key], path, ["dark", "light"]);
				skin.palette[key] = { dark: hex(pair.dark, child(path, "dark")), light: hex(pair.light, child(path, "light")) };
			}
			const effective = (color: PaletteColor, background: ThemeBackground): string =>
				skin.palette?.[color]?.[background] ?? paletteProjection(color, background)[0];
			for (const [name, pair] of Object.entries(skin.palette)) {
				for (const background of ["dark", "light"] as const) {
					const reference =
						name === "surface"
							? effective("neutralReading", background)
							: name === "selectionSurface"
								? effective("ivoryReading", background)
								: name === "onAccent"
									? effective("cyanFocal", background)
									: paletteProjection("surface", background)[0];
					if (contrast(pair[background], reference) < 4.5)
						reject(child(child("/palette", name), background), "contrast ratio must be at least 4.5");
				}
			}
		}
		if (Object.hasOwn(raw, "glyphs")) {
			const glyphs = closed(raw.glyphs, "/glyphs", ["brand"]);
			skin.glyphs = Object.hasOwn(glyphs, "brand") ? { brand: label(glyphs.brand, "/glyphs/brand", 2) } : {};
		}
		if (Object.hasOwn(raw, "agents")) {
			const agents = record(raw.agents, "/agents");
			if (Reflect.ownKeys(agents).length > 32) reject("/agents", "exceeds 32 entries");
			skin.agents = {};
			for (const key of Reflect.ownKeys(agents)) {
				const path = child("/agents", key);
				if (typeof key !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/u.test(key)) reject(path, "invalid agent key");
				const agent = closed(agents[key], path, ["label", "glyph"]);
				skin.agents[key] = {
					...(Object.hasOwn(agent, "label") ? { label: label(agent.label, child(path, "label"), 24) } : {}),
					...(Object.hasOwn(agent, "glyph") ? { glyph: label(agent.glyph, child(path, "glyph"), 2) } : {}),
				};
			}
		}
		return { ok: true, skin };
	} catch (error) {
		return {
			ok: false,
			path: error instanceof InvalidSkin ? error.path : "/",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}
