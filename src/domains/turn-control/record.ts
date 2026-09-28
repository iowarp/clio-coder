import type { WorkflowDecision } from "./decide.js";
import type { WorkspaceFingerprint } from "./facts.js";
import type { TurnInterpretation } from "./interpretation.js";

export interface TurnControlRecord {
	readonly version: 1;
	readonly turnId: string;
	readonly producer: "decision-site" | "main-model" | null;
	readonly interpretation: TurnInterpretation | null;
	/**
	 * An interpretation that arrived from a build with no fitted cuts and was
	 * therefore not acted on. The site's own answer is on the ledger already;
	 * this keeps the main-model fallback's, which is recorded nowhere else.
	 */
	readonly shadow?: { readonly build: string | null; readonly interpretation: TurnInterpretation };
	readonly factsDigest: string;
	readonly decision: WorkflowDecision;
	readonly decisionHash: string;
	readonly orientation?: { runId: string; receiptDigest: string; fingerprint: WorkspaceFingerprint; block: string };
	readonly executed:
		| { runIds: ReadonlyArray<string>; blockChars: number; durationMs: number }
		| { refused: string }
		| null;
}
