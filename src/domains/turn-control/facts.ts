import { canonicalDigest } from "./canonical-json.js";

export interface WorkspaceFingerprint {
	readonly cwd: string;
	readonly gitHead: string | null;
	readonly dirtyTreeHash: string | null;
	readonly codemapHash: string | null;
}

export interface TurnFacts {
	/** Raw operator text, whitespace collapsed and bounded to 300 code points by the runner. */
	readonly operatorText: string;
	readonly turnIndex: number;
	readonly continuation: boolean;
	readonly explicitConstraints: boolean;
	readonly taskEstablished: boolean;
	readonly clarificationStreak: number;
	readonly workspace: WorkspaceFingerprint;
	readonly capabilities: { dispatch: boolean; scoutRecipeId: string | null; readOnlyGit: boolean; monitor: boolean };
	readonly priorOrientation: { runId: string; receiptDigest: string; fingerprint: WorkspaceFingerprint } | null;
	readonly finishedDetachedBatchIds: ReadonlyArray<string>;
	readonly autonomy: "default" | "yolo";
}

export function fingerprintEquals(a: WorkspaceFingerprint, b: WorkspaceFingerprint): boolean {
	return (
		a.cwd === b.cwd && a.gitHead === b.gitHead && a.dirtyTreeHash === b.dirtyTreeHash && a.codemapHash === b.codemapHash
	);
}

export function factsDigest(facts: TurnFacts): string {
	return canonicalDigest(facts);
}
