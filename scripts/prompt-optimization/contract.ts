/**
 * Versioned contracts for the Dynamo prompt A/B harness.
 *
 * This file is the only place a schema string, an enum, or a record shape is
 * declared. Everything else in `evals/prompt-ab/` reads these types, so a
 * change to what a trial record means has exactly one edit site and one
 * version constant to bump. The harness stays outside `src/` because it is a
 * source-checkout experiment driver, not a shipped runtime, but it reuses the
 * eval domain's serving and execution-envelope contracts rather than inventing
 * a second vocabulary for the same facts.
 */
import type { EvalServingConfigurationV1 } from "../../src/domains/eval/schema/serving.js";

export const PROMPT_AB_HARNESS_VERSION = 1;
export const PROMPT_AB_CONFIG_SCHEMA_V1 = "clio.eval.prompt-ab.config.v1";
export const PROMPT_AB_MANIFEST_SCHEMA_V1 = "clio.eval.prompt-ab.manifest.v1";
export const PROMPT_AB_TRIAL_SCHEMA_V1 = "clio.eval.prompt-ab.trial.v1";
export const PROMPT_AB_FREEZE_SCHEMA_V1 = "clio.eval.prompt-ab.freeze.v1";
export const PROMPT_AB_SCENARIO_SCHEMA_V1 = "clio.eval.prompt-ab.scenario.v1";

/** Arms the audit report defines. B2 exists so a later run can name it without a schema change. */
export type PromptAbArmId = "A" | "B" | "B2";

/**
 * Cache strata are measured separately and never pooled. A cold trial is the
 * first request after a controlled backend-cache reset; a warm trial repeats a
 * fixed conversation prefix and varies only the final user turn. Comparing one
 * against the other measures the reset, not the prompt.
 */
export type PromptAbStratum = "cold" | "warm";

export type PromptAbCorpusId = "development" | "holdout";

/**
 * Tuning may read the development corpus. Holdouts unlock only in `frozen`
 * phase, and only against an arm whose build and prompt hashes match a freeze
 * record, which is what makes "no post-hoc prompt edits" checkable rather than
 * promised.
 */
export type PromptAbPhase = "tuning" | "frozen";

export type PromptAbAssertionOp = "lt" | "lte" | "gt" | "gte" | "eq" | "neq";

export type PromptAbInvariantSeverity = "hard" | "observational";

export type PromptAbMetricValue = number | string | boolean;

/**
 * A declarative expectation over observable trial facts.
 *
 * Every variant reads a bounded observation, never free prose judgement: the
 * blind-review export carries the questions a human has to answer. Keeping the
 * hard gates declarative is what lets the corpus be hashed, frozen, and
 * reviewed as data.
 */
/**
 * Which side of a dispatch a tool call came from.
 *
 * Write ownership is the reason this exists: "the parent did not edit a file it
 * assigned to a worker" is a different claim from "nobody edited it", and only
 * the first one is what the delegation contract promises.
 */
export type PromptAbCallOrigin = "parent" | "worker" | "any";

export type PromptAbInvariantSpec =
	| { kind: "exit-code"; op: PromptAbAssertionOp; value: number }
	| { kind: "metric"; metric: string; op: PromptAbAssertionOp; value: PromptAbMetricValue }
	| { kind: "tool-calls"; tool: string; origin: PromptAbCallOrigin; op: PromptAbAssertionOp; value: number }
	| {
			kind: "tool-call-budget";
			tools: readonly string[];
			origin: PromptAbCallOrigin;
			op: PromptAbAssertionOp;
			value: number;
	  }
	| { kind: "tool-blocked"; tool: string; origin: PromptAbCallOrigin; op: PromptAbAssertionOp; value: number }
	| { kind: "tool-order"; before: readonly string[]; after: string }
	| { kind: "tool-path-scope"; tools: readonly string[]; origin: PromptAbCallOrigin; forbidden: readonly string[] }
	| { kind: "repeated-rejected-call"; op: PromptAbAssertionOp; value: number }
	| { kind: "workspace-mutations"; op: PromptAbAssertionOp; value: number }
	| { kind: "mutation-paths-within"; allowed: readonly string[] }
	| { kind: "foreign-state"; op: PromptAbAssertionOp; value: number }
	| { kind: "answer-matches"; pattern: string }
	| { kind: "answer-omits"; pattern: string }
	| { kind: "invented-capabilities"; op: PromptAbAssertionOp; value: number }
	| { kind: "skills-loaded"; expected: readonly string[] }
	| { kind: "skills-match-recipe-bound" }
	| { kind: "skills-suggested"; op: PromptAbAssertionOp; value: number }
	| { kind: "marketplace-offers"; op: PromptAbAssertionOp; value: number }
	| { kind: "skill-install-attempts"; op: PromptAbAssertionOp; value: number }
	| { kind: "receipt"; field: PromptAbReceiptField; op: PromptAbAssertionOp; value: PromptAbMetricValue };

export type PromptAbReceiptField =
	| "count"
	| "sealed"
	| "integrityValid"
	| "evidenceStatus"
	| "claimedVerifiedWithoutEvidence"
	| "parentSpotChecks"
	| "resultContractValid";

export interface PromptAbInvariant {
	/** Stable within a scenario; it is the identity a gate failure is reported under. */
	id: string;
	severity: PromptAbInvariantSeverity;
	/** What the audit report expects, in one sentence, for the blind reviewer and the failure line. */
	expectation: string;
	spec: PromptAbInvariantSpec;
}

export interface PromptAbRunnerSpec {
	prompt: string;
	autonomy: "read-only" | "suggest" | "auto-edit" | "full-auto";
	/** Fleet recipe id when the scenario dispatches a worker directly; null runs the main agent. */
	agent: string | null;
	/** Explicit skills for the run; an empty list means ordinary discovery. */
	skills: readonly string[];
	/** True when the scenario needs skill discovery disabled to isolate the behavior it measures. */
	noSkills: boolean;
	/**
	 * Skills that must be installed into the trial's fresh home for the scenario
	 * to be answerable at all. A fresh Clio home ships none, so a scenario that
	 * names a skill without listing it here measures the empty sandbox.
	 */
	requiredSkills: readonly string[];
}

/**
 * The seeded fixture a trial runs against. `foreign` marks the scenarios whose
 * point is that Clio is asked about itself from a directory that is not its
 * own checkout.
 */
export interface PromptAbWorkspaceSpec {
	kind: "fixture" | "foreign";
	/** Files written into the fresh workspace, POSIX-relative, before the trial starts. */
	files: ReadonlyArray<{ path: string; content: string }>;
	/** Paths a trial is permitted to mutate; anything else is an unauthorized mutation. */
	writable: readonly string[];
	/** Paths that must never gain state, checked after the trial. */
	forbidState: readonly string[];
}

export interface PromptAbScenario {
	schema: typeof PROMPT_AB_SCENARIO_SCHEMA_V1;
	id: string;
	corpus: PromptAbCorpusId;
	/** Family name as written in the audit report, so a result traces back to its source. */
	family: string;
	title: string;
	/** Where in `/tmp/clio-prompt-code-audit.md` this scenario comes from. */
	source: string;
	runner: PromptAbRunnerSpec;
	workspace: PromptAbWorkspaceSpec;
	invariants: readonly PromptAbInvariant[];
	/** Questions the blind reviewer answers; deterministic gates never read prose quality. */
	reviewQuestions: readonly string[];
	timeoutMs: number;
}

export interface PromptAbToolCallObservation {
	tool: string;
	outcome: "ok" | "error" | "blocked";
	/** Whether the parent session or a dispatched worker made the call. */
	origin: "parent" | "worker";
	/** Normalized POSIX-relative path argument when the call carried one. */
	path: string | null;
	/**
	 * Identity of the call shape: tool name plus a digest of normalized
	 * arguments. Two calls with the same key are the same request, which is how
	 * a blind identical retry is separated from a corrected one.
	 */
	shapeKey: string;
}

export interface PromptAbReceiptObservation {
	count: number;
	sealed: boolean;
	integrityValid: boolean;
	evidenceStatus: "verified" | "unverified" | "absent";
	/** True when a completion, test, or file-change claim was made with no observed run behind it. */
	claimedVerifiedWithoutEvidence: boolean;
	parentSpotChecks: number;
	resultContractValid: boolean;
}

export interface PromptAbSkillObservation {
	loaded: readonly string[];
	suggested: readonly string[];
	marketplaceOffers: number;
	installAttempts: number;
	/**
	 * Skills the dispatched recipe binds, read from that arm's own recipe file.
	 *
	 * A literal expectation in the corpus was wrong about this and stayed wrong
	 * for six trials: it named `clio-coder-dev` while the `coder` recipe binds
	 * `fix-issue` and `ship`, so a worker that loaded exactly its bound skills
	 * failed the gate that exists to check precisely that. The expectation has
	 * to come from the arm, both because that is where the truth is and because
	 * recipe descriptors are themselves under test. Null when the recipe could
	 * not be read, which makes the gate unresolved rather than inventing one.
	 */
	recipeBound: readonly string[] | null;
}

/**
 * Everything a deterministic gate is allowed to read from one trial.
 *
 * The live executor derives this from the arm's `--json` stream, its sealed
 * receipt, and the isolated workspace; the offline executor supplies it
 * directly. Scoring is a pure function of this record, which is what makes the
 * offline tests real tests of the scoring rules rather than of a mock.
 */
export interface PromptAbTrialObservation {
	exitCode: number;
	timedOut: boolean;
	wallTimeMs: number;
	metrics: Readonly<Record<string, PromptAbMetricValue>>;
	toolCalls: readonly PromptAbToolCallObservation[];
	/** Final operator-facing answer. The only prose a hard gate may pattern-match. */
	answerText: string;
	/** Workspace paths that differ from the seeded baseline, POSIX-relative and sorted. */
	workspaceMutations: readonly string[];
	/** State that appeared under a `forbidState` path, sorted. */
	foreignStatePaths: readonly string[];
	/** Tool or capability names the answer asserted exist but the arm's inventory does not have. */
	inventedCapabilities: readonly string[];
	skills: PromptAbSkillObservation;
	receipt: PromptAbReceiptObservation | null;
	serving: EvalServingConfigurationV1;
	/** Verbatim transcript retained for blind review; never read by a gate. */
	transcript: string;
}

export interface PromptAbInvariantOutcome {
	id: string;
	severity: PromptAbInvariantSeverity;
	expectation: string;
	pass: boolean;
	/** True when the observation carries no reading for this invariant; always a hard failure. */
	unresolved: boolean;
	actual: PromptAbMetricValue | null;
	detail: string;
}

export interface PromptAbHardGate {
	pass: boolean;
	failed: readonly string[];
	unresolved: readonly string[];
}

export type PromptAbTrialStatus = "passed" | "failed" | "error";

export type PromptAbFailureClass =
	| "hard_gate_failed"
	| "executor_error"
	| "timeout"
	| "isolation_violated"
	| "serving_drift"
	| "arm_identity_mismatch";

/**
 * Build identity of one arm.
 *
 * `buildHash` covers the arm's compiled entry and every file the build
 * produced, so two arms built from the same source at different times still
 * compare equal, and two arms that differ by one prompt fragment never do.
 * `promptFragmentsHash` and `toolCatalogHash` are read from source so a
 * comparison can say *which* of the two changed.
 */
export interface PromptAbArmIdentity {
	id: PromptAbArmId;
	label: string;
	checkout: string;
	entry: string;
	commit: string | null;
	dirty: boolean;
	buildHash: string;
	promptFragmentsHash: string;
	toolCatalogHash: string;
}

export interface PromptAbSamplingPins {
	temperature: number;
	topP: number;
	topK: number;
	minP: number;
	repeatPenalty: number;
	presencePenalty: number;
	frequencyPenalty: number;
}

/**
 * Every knob that must be identical across arms for a comparison to mean
 * anything. A trial record carries this verbatim, and the comparison refuses
 * to run when two records disagree on any of it.
 */
export interface PromptAbPinnedConfig {
	target: string;
	model: string;
	runtime: string;
	thinking: string;
	autonomy: string;
	toolProfile: string | null;
	maxContextTokens: number;
	kvCacheMode: string | null;
	sampling: PromptAbSamplingPins;
	/** Recorded, not enforced: a server that changed its slot count changed the experiment. */
	serverConcurrency: number;
	/** Base URL of the pinned inference endpoint, written into each trial's isolated settings. */
	targetUrl: string;
}

export interface PromptAbTrialRecordV1 {
	schema: typeof PROMPT_AB_TRIAL_SCHEMA_V1;
	harnessVersion: number;
	trialId: string;
	experimentId: string;
	/** Identity of the whole experiment configuration; a resume into a different one is refused. */
	experimentHash: string;
	blockId: string;
	/** Execution position of this arm inside its AB/BA block: 0 first, 1 second. */
	pairIndex: number;
	repetition: number;
	corpus: PromptAbCorpusId;
	scenarioId: string;
	scenarioHash: string;
	stratum: PromptAbStratum;
	armId: PromptAbArmId;
	startedAt: string;
	endedAt: string;
	wallTimeMs: number;
	status: PromptAbTrialStatus;
	failureClass: PromptAbFailureClass | null;
	arm: PromptAbArmIdentity;
	pinned: PromptAbPinnedConfig;
	serving: EvalServingConfigurationV1;
	metrics: Readonly<Record<string, PromptAbMetricValue>>;
	invariants: readonly PromptAbInvariantOutcome[];
	hardGate: PromptAbHardGate;
	/** Path of the retained transcript, relative to the run directory; null when nothing was retained. */
	transcriptRef: string | null;
	error: { message: string } | null;
}

/**
 * The record that unlocks the holdout corpus.
 *
 * It pins the exact arm identities the holdouts are allowed to run against.
 * Running holdouts against an arm whose hashes moved is a post-hoc prompt
 * edit, and the loader refuses it.
 */
export interface PromptAbFreezeRecordV1 {
	schema: typeof PROMPT_AB_FREEZE_SCHEMA_V1;
	harnessVersion: number;
	experimentId: string;
	frozenAt: string;
	/** Hash of the frozen development corpus and scoring, so tuning cannot move after the freeze. */
	developmentCorpusHash: string;
	holdoutCorpusHash: string;
	arms: readonly PromptAbArmIdentity[];
	/** Human-readable reason the freeze was taken, carried into the promotion report. */
	note: string;
}

export interface PromptAbManifestV1 {
	schema: typeof PROMPT_AB_MANIFEST_SCHEMA_V1;
	harnessVersion: number;
	experimentId: string;
	experimentHash: string;
	corpus: PromptAbCorpusId;
	corpusHash: string;
	phase: PromptAbPhase;
	seed: number;
	repetitions: number;
	strata: readonly PromptAbStratum[];
	arms: readonly PromptAbArmIdentity[];
	pinned: PromptAbPinnedConfig;
	createdAt: string;
	/** Total trials the plan contains, so a resumed run can report its own completeness. */
	plannedTrials: number;
}
