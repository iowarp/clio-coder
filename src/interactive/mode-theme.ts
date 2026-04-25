import type { ModeName } from "../domains/modes/index.js";

const RESET = "\u001b[0m";
const ADVISE = "\u001b[38;5;214m";
const SUPER = "\u001b[38;5;203m";

const IDENTITY = (text: string): string => text;

export function styleForMode(mode: ModeName | string, text: string): string {
	if (mode === "advise") return `${ADVISE}${text}${RESET}`;
	if (mode === "super") return `${SUPER}${text}${RESET}`;
	return text;
}

export function editorBorderColorForMode(mode: ModeName | string): (text: string) => string {
	if (mode === "default") return IDENTITY;
	return (text: string) => styleForMode(mode, text);
}
