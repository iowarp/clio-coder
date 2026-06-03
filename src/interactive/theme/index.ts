import { type ClioTheme, createClioTheme } from "./tokens.js";

let sharedTheme: ClioTheme | null = null;

export function clioTheme(): ClioTheme {
	sharedTheme ??= createClioTheme();
	return sharedTheme;
}

export * from "./components.js";
export * from "./glyphs.js";
export * from "./labels.js";
export * from "./rules.js";
export * from "./tokens.js";
