import type {
	NumericFailureReason,
	NumericNonFinitePolicy,
	NumericTolerance,
	NumericToleranceCombine,
} from "../../tools/verify/numeric.js";
import type { ReproduceConditions, ReproduceMetricFailure, ReproduceReport } from "../../tools/verify/reproduce.js";

/**
 * A claim is what one judged check concluded, bound to the conditions it ran under (#406). It states agreement or
 * disagreement within the tolerance the check declared, and nothing more: a payload within tolerance of its reference
 * says nothing about whether the reference is right.
 */
export const CLAIM_RECORD_VERSION = 1;

/** The declared check kinds whose judgement becomes a claim. Command and perf-budget checks carry no tolerance. */
export type ClaimKind = "reproduce" | "numeric-compare";

export const CLAIM_KINDS: ReadonlyArray<ClaimKind> = ["reproduce", "numeric-compare"];

/** Whether the judged payloads agreed within the declared tolerance. Never a verdict on truth. */
export type ClaimVerdict = "agrees" | "disagrees";

/** Structural anchors a later reader matches on: the check id, its canonical argv, and the files it judged. */
export interface ClaimKeys {
	check: string;
	command: string[];
	/** Project-relative where the path lies inside the project, else absolute. */
	paths: string[];
}

/** A judged file's identity: path when the check named one, and the digest of the exact bytes judged. */
export interface ClaimDigestRef {
	path?: string;
	sha256: string;
	bytes: number;
}

export interface ReproduceClaimConditions extends ReproduceConditions {
	kind: "reproduce";
	compare: ReproduceReport["compare"];
	/** The tolerance exactly as declared. */
	tolerance: NumericTolerance;
	rule: string;
	reference?: ClaimDigestRef;
	/** SHA-256 of each run's metrics payload, in run order. */
	payloads: string[];
	metrics: Array<{ metric: string; passed: boolean; failed: ReproduceMetricFailure[] }>;
}

/** Per-key verdicts kept on a numeric-compare claim; the rest are counted in `keysOmitted`. */
export const NUMERIC_CLAIM_KEY_LIMIT = 256;

export interface NumericClaimConditions {
	kind: "numeric-compare";
	/** The tolerance exactly as declared. */
	tolerance: NumericTolerance;
	combine: NumericToleranceCombine;
	nonFinite: NumericNonFinitePolicy;
	rule: string;
	reference?: ClaimDigestRef;
	actual?: { sha256: string; bytes: number };
	argv: string[];
	/**
	 * HEAD of the checkout the check judged, from host verification's sealed tree. Null when the channel recorded no
	 * tree: a main-thread numeric-compare result names no commit, and the claim must not invent one.
	 */
	commit: string | null;
	/** Host verification's digest of HEAD plus the working-tree content the check saw. */
	treeFingerprint?: string;
	keys: Array<{ key: string; passed: boolean; failed: NumericFailureReason[] }>;
	keysOmitted: number;
}

export type ClaimConditions = ReproduceClaimConditions | NumericClaimConditions;

/**
 * Where the judgement came from. Both channels are Clio's own execution of a declared check, never text a model
 * wrote, which is why every claim here is `grounded`.
 */
export type ClaimSource =
	| {
			channel: "verify";
			sessionId: string | null;
			toolCallId: string | null;
			/** `harness` when Clio itself issued the call, `model` when the agent did. */
			requestedBy: "model" | "harness";
	  }
	| { channel: "host-verification"; runId: string; receiptDigest: string };

export interface ClaimRecordV1 {
	v: typeof CLAIM_RECORD_VERSION;
	type: "claim";
	/** SHA-256 of the record's canonical JSON without `id`. */
	id: string;
	/** ISO time the claim was captured. */
	at: string;
	/** Realpath of the project root the claim is scoped to; the log file is keyed by its digest. */
	project: string;
	kind: ClaimKind;
	verdict: ClaimVerdict;
	/** One sentence that never states more than the conditions below. */
	text: string;
	/**
	 * Identity of what was judged: kind, check id and the digests of every judged payload and input. The same check
	 * judging the same bytes again has the same subject, so a later phase can find agreement or contradiction by it.
	 */
	subject: string;
	keys: ClaimKeys;
	conditions: ClaimConditions;
	source: ClaimSource;
	evidence: "grounded";
	/** Set when the text, which carries catalog-authored ids and paths, trips the instruction-marker screen. */
	flagged?: "instruction-markers";
}

export type ClaimRecord = ClaimRecordV1;
