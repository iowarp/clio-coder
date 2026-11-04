import { canonicalDigest } from "./canonical-json.js";

export interface TurnFacts {
	readonly explicitConstraints: boolean;
	readonly finishedDetachedBatchIds: ReadonlyArray<string>;
}

export function factsDigest(facts: TurnFacts): string {
	return canonicalDigest(facts);
}
