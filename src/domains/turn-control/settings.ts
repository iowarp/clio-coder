import type { TurnControlCutOverrides } from "./calibration.js";

export const TURN_CONTROL_WORKFLOWS = ["orientation", "direction", "ledger-facts", "detached-collection"] as const;
export type TurnControlWorkflow = (typeof TURN_CONTROL_WORKFLOWS)[number];

export interface TurnControlSettings {
	workflows: TurnControlWorkflow[];
	interpretation: {
		fallback: "none" | "main-model";
		/**
		 * Cuts for an answering build the code has not fitted, keyed by the build
		 * the ledger names (a System One build such as `jev-1.13.0`, or the chat
		 * model id for the main-model fallback). Without one, that build's
		 * interpretation is recorded and not acted on.
		 */
		thresholds?: TurnControlCutOverrides;
	};
	orientation: { maxSplit: 1 | 2 | 3 | 4; maxCostUsdPerTurn: number | null };
}
