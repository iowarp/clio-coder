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
	 * HEAD of the checkout the check judged: the verify result's checkout state on the main thread, host verification's
	 * sealed tree for a worker run. Null outside a repository or when the channel recorded neither; never invented.
	 */
	commit: string | null;
	/** Whether tracked files matched `commit` when the check ran; absent where the channel recorded a fingerprint instead. */
	trackedTreeClean?: boolean;
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

/**
 * A typed relation between two claims of one check, derived when the later claim is appended (#406). Edges are their
 * own lines in the log, so a claim is never rewritten.
 *
 * - `contradicts`: the later claim reached the opposite verdict under equal pinned conditions (`claimConditionsKey`);
 *   a numeric-compare check's working-tree state is not pinned, so an uncommitted edit at the same commit still counts.
 * - `supersedes`: the later claim judged the same check under changed conditions, such as a new commit or new input
 *   digests, and replaces the earlier verdict.
 *
 * Both sides are Clio's own grounded executions and the rule is deterministic, so an edge carries no suggested state.
 */
export type ClaimEdgeKind = "contradicts" | "supersedes";

export interface ClaimEdgeRecordV1 {
	v: typeof CLAIM_RECORD_VERSION;
	type: "edge";
	/** SHA-256 of the record's canonical JSON without `id`. */
	id: string;
	at: string;
	project: string;
	kind: ClaimEdgeKind;
	/** The later claim. */
	from: string;
	/** The earlier claim. */
	to: string;
	check: string;
}

/**
 * What a contradiction did to memory: the memory records, backed by an agreeing claim the contradiction overturned,
 * that received a regression. An empty `memory` says no record cited those claims, so none changed.
 */
export interface ClaimRegressionRecordV1 {
	v: typeof CLAIM_RECORD_VERSION;
	type: "regression";
	id: string;
	at: string;
	project: string;
	/** The `contradicts` edge this regression follows from. */
	edge: string;
	/** The disagreeing claim. */
	from: string;
	/** The agreeing claims with equal pinned conditions that it overturned. */
	backing: string[];
	memory: string[];
}

export type ClaimEdgeRecord = ClaimEdgeRecordV1;
export type ClaimRegressionRecord = ClaimRegressionRecordV1;

/**
 * Where a claim stands after its edges: `superseded` once a later claim replaced it under changed conditions,
 * `contested` while a claim with equal pinned conditions disagrees with it, else `standing`.
 */
export type ClaimStatus = "standing" | "contested" | "superseded";

/**
 * The schema a hypothesis-workflow slate declares (`library/plugins/literature/skills/hypothesis-workflow`). The slate
 * holds every hypothesis at `proposed`; this ledger is where a hypothesis moves to tested, supported or refuted.
 */
export const HYPOTHESIS_SLATE_SCHEMA = "clio-coder.hypothesis-slate.v1";

/**
 * Where a hypothesis stands: `proposed` until the check its success criterion names runs, `tested` once it ran without
 * a judged claim (a command check, a crash, a timeout, a payload that could not be judged), then `supported` or
 * `refuted` by the latest claim that check recorded for it. A judged claim is the only thing that supports or refutes.
 */
export type HypothesisStatus = "proposed" | "tested" | "supported" | "refuted";

/**
 * One hypothesis of a slate the main session wrote, or a worker wrote and the host accepted into the project (#406).
 * Unlike a claim this is model-authored text, so it is
 * never `grounded`: it records what was proposed and the check that would judge it, nothing more. A later version of
 * the same slate entry with changed content is a new record that `revises` the earlier one; neither is rewritten.
 */
/**
 * How a slate reached the log: written by a main-session tool call, or landed in the project by a worker run the host
 * accepted (a merged task worktree, or a run in the checkout that settled succeeded). Either way the host read the
 * file from the project; nothing a worker reported about it is recorded.
 */
export type HypothesisSource =
	| { channel: "slate"; sessionId: string | null; toolCallId: string | null; slateSha256: string }
	| { channel: "worker-slate"; runId: string; receiptDigest: string; slateSha256: string };

export interface HypothesisRecordV1 {
	v: typeof CLAIM_RECORD_VERSION;
	type: "hypothesis";
	/** SHA-256 of the record's canonical JSON without `id`. */
	id: string;
	at: string;
	project: string;
	/** Project-relative path of the slate, else absolute. */
	slate: string;
	/** The slate's hypothesis id, such as `H1`. */
	hypothesis: string;
	statement: string;
	prediction: string;
	/** The success criterion as the slate drafted it; `check` is its `verifyId`, the declared check that judges it. */
	criterion: { kind: string; check?: string; statement?: string };
	/** Digest of slate path, hypothesis id, statement, prediction and criterion: the same entry rewritten is one subject. */
	subject: string;
	/** The record of the same slate entry this one replaces, which was current when this one was appended. */
	revises?: string;
	source: HypothesisSource;
	evidence: "proposed";
	flagged?: "instruction-markers";
}

/**
 * A run of the check a hypothesis names (#406). `claim` is set exactly when the run was judged into a claim, and then
 * `outcome` follows its verdict: `agrees` supports, `disagrees` refutes. A run with no claim is `tested`.
 */
export interface HypothesisTestRecordV1 {
	v: typeof CLAIM_RECORD_VERSION;
	type: "hypothesis-test";
	id: string;
	at: string;
	project: string;
	/** The hypothesis record tested: a revision that was current when the check started, bound then. */
	hypothesis: string;
	check: string;
	outcome: Exclude<HypothesisStatus, "proposed">;
	claim?: string;
	/** How the run ended, as the channel recorded it (`succeeded`, `failed`, `timed-out`, ...). */
	execution: string;
	source: ClaimSource;
}

export type HypothesisRecord = HypothesisRecordV1;
export type HypothesisTestRecord = HypothesisTestRecordV1;
