/**
 * Intent detector stub. Real implementation lands in v0.2; for v0.1 the
 * detector stays off and always returns an empty observation set.
 */

import type { IntentObservation } from "./contracts.js";

export interface IntentDetector {
	start(): void;
	stop(): void;
	latest(): ReadonlyArray<IntentObservation>;
}

export function createIntentDetectorStub(): IntentDetector {
	return {
		start() {
			/* no-op until v0.2 */
		},
		stop() {
			/* no-op */
		},
		latest() {
			return [];
		},
	};
}
