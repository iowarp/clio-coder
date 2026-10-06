/**
 * Model-keyed prompt fragments. A vendor-published behavior note for one model
 * family rides in the session prompt as a fragment, chosen from the wire model
 * id alone so every transport that serves the model gets it. The id is a
 * session constant, so the note changes the prompt only when the model changes.
 */

/**
 * `claude-<tier>-<major>[-.]<minor>` in any transport spelling (Anthropic,
 * OpenRouter, Bedrock, Vertex). A dated snapshot suffix is not a minor version,
 * hence the two-digit cap and the trailing digit guard. Same shape as the
 * sampler check in src/session-control/drafts.ts.
 */
const CLAUDE_GENERATION = /claude-(?:opus|sonnet|haiku)-(\d+)(?:[-.](\d{1,2}))?(?!\d)/u;

export const ANTHROPIC_5_5_FRAGMENT_ID = "model.anthropic-5-5";

/** The model fragment id for a wire model id, or null when none applies. */
export function modelGuidanceFragmentId(modelId: string | null | undefined): string | null {
	if (!modelId) return null;
	const match = CLAUDE_GENERATION.exec(modelId.toLowerCase());
	if (!match) return null;
	return Number(match[1]) === 5 && Number(match[2] ?? 0) === 5 ? ANTHROPIC_5_5_FRAGMENT_ID : null;
}
