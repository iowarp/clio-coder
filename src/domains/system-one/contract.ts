/**
 * The vendor-neutral half of a decision: what a question means and what an answer's
 * number is, kept apart from how any one model is asked.
 *
 * A question carries answer semantics (one claim, an exclusive choice, an ordinal
 * level, one independent item of a filter) and the abstention every reader already
 * treats as "no answer". A renderer turns it into what one model family reads and
 * refuses rather than truncates. Nothing here claims accuracy: a readout says what a
 * number is, never how well it was measured.
 */

/**
 * Answer semantics. `independent` is a yes/no per item whose numbers do not compete
 * with each other's, which is what a filter means and what a multi-label sigmoid
 * reads; `boolean` is one claim about one state.
 */
export type SemanticKind = "boolean" | "exclusive" | "ordinal" | "independent";

/**
 * What an answer's number is. `server` is a typed wire's own value, whose meaning is
 * the serving build's; `categorical` is a label with no probability scale. The rest
 * name the readout a profile declares for its family.
 */
export type ReadoutKind =
	| "server"
	| "softmax-binary"
	| "softmax-exclusive"
	| "sigmoid-independent"
	| "ordinal-expectation"
	| "categorical";

/** How a question becomes what a model family reads. A new wording contract is a new renderer. */
export type RendererId = "systemone-v1" | "julia-compact-v1" | "gliner-label-v1" | "llm-prompt";
