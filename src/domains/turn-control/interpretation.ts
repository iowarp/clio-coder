import type { DispatchShape, HarnessIntent } from "../providers/index.js";

export type { DispatchShape, HarnessIntent } from "../providers/index.js";
export const TURN_INTERPRETATION_VERSION = "turn-interpretation-v1";

export interface TurnInterpretation {
	readonly version: "turn-interpretation-v1";
	readonly intent: HarnessIntent;
	readonly intentCertainty: number;
	readonly orientation: {
		readonly wanted: number;
		readonly breadth: "repository" | "area" | "focused" | null;
		readonly subject: string | null;
	};
	readonly direction: { readonly requested: number };
	readonly shape: DispatchShape | null;
}
