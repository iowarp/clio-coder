/**
 * What the turn controller needs to know about a request: the workflow it asks
 * for, whether it asks for an orientation or for direction, and how broad the
 * orientation is.
 *
 * These are decisions, not probabilities. A System One site reads the request
 * under cuts fitted to the build that answered, and a build nobody fitted
 * yields `false` for both acts, so the controller never learns which producer
 * answered or how sure it was. The numbers stay in the decision record. The one
 * exception is the pair `orientation.probability` and `dispatch.probability`:
 * both acts can fire on one turn, and the controller needs to know which the
 * request asks for more.
 */

/** The workflow a request asks for. `unknown` means the answer was undecided. */
export type HarnessIntent = "answer" | "inspect" | "plan" | "implement" | "interview" | "continue" | "unknown";

export interface TurnInterpretation {
	readonly intent: HarnessIntent;
	readonly orientation: {
		readonly wanted: boolean;
		/** Only `repository` and `area` can start an orientation; `focused` is a single fact. */
		readonly breadth: "repository" | "area" | "focused" | null;
		/** The probability the orientation question read, for comparison with the dispatch one. Absent means the producer did not say. */
		readonly probability?: number;
	};
	readonly direction: { readonly requested: boolean };
	/**
	 * True when the turn site's fitted dispatch cut fired: the model is about to
	 * dispatch on its own, so a harness orientation scout would be redundant
	 * worker spend, unless the request reads more as an orientation than as a
	 * dispatch. Absent means the producer did not say.
	 */
	readonly dispatch?: {
		readonly expected: boolean;
		/** The probability the dispatch question read. Absent means the producer did not say. */
		readonly probability?: number;
	};
}
