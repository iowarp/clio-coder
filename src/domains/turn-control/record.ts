import type { WorkflowDecision } from "./decide.js";
import type { WorkspaceFingerprint } from "./facts.js";
import type { TurnInterpretation } from "./interpretation.js";

export interface TurnControlRecord {
	readonly version: 1;
	readonly turnId: string;
	/** `system-one` when a bound turn site answered with an interpretation, otherwise null. */
	readonly producer: "system-one" | null;
	readonly interpretation: TurnInterpretation | null;
	readonly factsDigest: string;
	readonly decision: WorkflowDecision;
	readonly decisionHash: string;
	readonly orientation?: { runId: string; receiptDigest: string; fingerprint: WorkspaceFingerprint; block: string };
	readonly executed:
		| { runIds: ReadonlyArray<string>; blockChars: number; durationMs: number }
		| { refused: string; startedRunIds?: ReadonlyArray<string> }
		| null;
}
