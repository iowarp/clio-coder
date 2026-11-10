// Enums, isolatedModules re-exports and unused locals/parameters.
export enum Level {
	Low = 1,
	High = 2,
}
export const level: Level = 3 as const;
export type { Options } from "./lib/public-api.js";
export { Mode } from "./lib/public-api.js";
export function unused(kept: number, dropped: number): number {
	const stale = kept * 2;
	return kept;
}
