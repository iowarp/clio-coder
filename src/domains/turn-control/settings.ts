export const TURN_CONTROL_WORKFLOWS = ["orientation", "direction", "ledger-facts", "detached-collection"] as const;
export type TurnControlWorkflow = (typeof TURN_CONTROL_WORKFLOWS)[number];

export interface TurnControlSettings {
	workflows: TurnControlWorkflow[];
	orientation: { maxSplit: 1 | 2 | 3 | 4; maxCostUsdPerTurn: number | null };
}
