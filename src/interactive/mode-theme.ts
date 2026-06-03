import type { ModeName } from "../domains/modes/index.js";
import { AMBER, RED_CRIT, RESET } from "./palette.js";

export function styleForMode(mode: ModeName | string, text: string): string {
	if (mode === "advise") return `${AMBER}${text}${RESET}`;
	if (mode === "super") return `${RED_CRIT}${text}${RESET}`;
	return text;
}
