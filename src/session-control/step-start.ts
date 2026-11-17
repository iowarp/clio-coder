import type { ModelTier } from "../core/model-tier.js";
import type { TurnConstraints } from "../core/turn-constraints.js";

/**
 * Compact start for step turns (WTF-P 0.8.3 C5). Under a template's
 * `turnPolicy: step`, each turn runs one step and ends on a state summary. On
 * a route whose model is small, or that does not cache prompts, resending the
 * whole conversation for every step costs the most and helps the least, so
 * each step turn after the first starts from a step-boundary checkpoint
 * instead: the previous step's final summary and the template body, with the
 * extension pinned blocks re-sent in the tail once the checkpoint drops their
 * earlier copy. Cached standard and frontier routes keep the full history.
 */

/** What the session route reports about itself, from its runtime resolution (WTF-P 0.8.3 C1). */
export interface StepStartRoute {
	modelTier?: ModelTier;
	promptCaching?: boolean;
}

/** A small model, or a route that does not cache prompts, starts each later step turn from a compact state. */
export function compactStepStartDue(route: StepStartRoute): boolean {
	return route.modelTier === "small" || route.promptCaching === false;
}

interface StepChain {
	template: string;
	stepTool: string;
	/** The expanded template text of the operator turn that started the chain. */
	body: string;
	/** The last settled step turn's final text; absent until one settles cleanly. */
	finalText?: string;
}

export interface StepStartTracker {
	/**
	 * A step turn is starting. Returns the checkpoint lead when this turn
	 * follows a settled step turn of the same template and step tool, and null
	 * otherwise. A continuation reuses the chain's template body; an operator
	 * turn's own text is the body, so its lead leaves the body out.
	 */
	begin(constraints: TurnConstraints | undefined, text: string, continuation: boolean): string | null;
	/** The turn settled: keep its final text for the next step, or drop the chain when it ended badly. */
	settle(constraints: TurnConstraints | undefined, finalText: string, clean: boolean): void;
}

export function createStepStartTracker(): StepStartTracker {
	let chain: StepChain | null = null;
	return {
		begin(constraints, text, continuation) {
			const policy = constraints?.turnPolicy;
			if (policy === undefined) {
				chain = null;
				return null;
			}
			const template = policy.template ?? "";
			const same = chain !== null && chain.template === template && chain.stepTool === policy.stepTool;
			const previous = same ? chain : null;
			const body = continuation && previous !== null ? previous.body : text;
			chain = { template, stepTool: policy.stepTool, body };
			if (previous?.finalText === undefined) return null;
			return stepCheckpointLead(template, policy.stepTool, previous.finalText, continuation ? body : null);
		},
		settle(constraints, finalText, clean) {
			const policy = constraints?.turnPolicy;
			if (chain === null || policy === undefined || chain.stepTool !== policy.stepTool) {
				chain = null;
				return;
			}
			const summary = finalText.trim();
			if (!clean || summary.length === 0) {
				chain = null;
				return;
			}
			chain.finalText = summary;
		},
	};
}

/** The compact state a later step turn starts from, as the checkpoint summary's lead. */
function stepCheckpointLead(template: string, stepTool: string, finalText: string, body: string | null): string {
	const name = template.length > 0 ? `Prompt template "${template}"` : "This turn's template";
	return [
		`Step checkpoint. ${name} runs one ${stepTool} step per turn, and this turn starts the next step from this compact state. The earlier step turns' messages and tool results are kept in the session ledger, not in this context; recall one with context(scope="recall") when a step needs it.`,
		`Previous step's final summary:\n${finalText}`,
		...(body === null ? [] : [`Template instructions for this step (verbatim):\n${body}`]),
	].join("\n\n");
}
