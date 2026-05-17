import type { ModeName } from "../domains/modes/index.js";
import { AMBER, RED_CRIT, RESET } from "./palette.js";

const IDENTITY = (text: string): string => text;

export function styleForMode(mode: ModeName | string, text: string): string {
	if (mode === "advise") return `${AMBER}${text}${RESET}`;
	if (mode === "super") return `${RED_CRIT}${text}${RESET}`;
	return text;
}

export function editorBorderColorForMode(mode: ModeName | string): (text: string) => string {
	if (mode === "default") return IDENTITY;
	return (text: string) => styleForMode(mode, text);
}
