export interface DecisionSelection {
	interviewId: string;
	key: string;
	label: string;
	value: string;
}

/** The operator-authored turn that makes a durable correction visible to the model. */
export function formatDecisionCorrectionTurn(selection: DecisionSelection, correction: string): string {
	return `Decision "${selection.label}" (previously: ${selection.value}) is superseded by the operator. New direction: ${correction}. Acknowledge and adjust the plan.`;
}
