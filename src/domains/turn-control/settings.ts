export const TURN_CONTROL_WORKFLOWS = ["detached-collection"] as const;
export type TurnControlWorkflow = (typeof TURN_CONTROL_WORKFLOWS)[number];

export interface TurnControlSettings {
	workflows: TurnControlWorkflow[];
}
