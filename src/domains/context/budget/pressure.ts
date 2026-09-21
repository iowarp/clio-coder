/**
 * Pure context-pressure policy (shadow mode).
 *
 * One function decides, from explicitly supplied accounting facts, which
 * pressure phase a session is in, whether the next request can be admitted, and
 * whether an advisory should be shown to the agent. It performs no I/O, issues
 * no model call, triggers no reduction, and changes no existing auto-compaction
 * behavior: callers in shadow mode record the verdict and act on nothing.
 *
 * The policy deliberately takes facts rather than a `ContextSnapshot`:
 *   - `ContextSnapshot.categories.reserve` is compaction headroom, not
 *     necessarily the model's actual output reserve, so the caller must supply
 *     the real reserve it will ask the provider for.
 *   - `snapshotId` is not a trustworthy live revision after tool-schema or
 *     working-set growth, so the caller supplies the revision identity it
 *     considers material.
 *
 * The 0.8 default mirrors `DEFAULT_COMPACTION_THRESHOLD`
 * (src/domains/session/compaction/auto.ts:23). It is duplicated rather than
 * imported to keep this module free of session-domain dependencies; the live
 * adapter passes the configured threshold explicitly.
 */

export type PressurePhase = "normal" | "notice" | "prepare" | "reduce" | "recover";

/** Phases that can produce an agent-visible advisory. */
export type AdvisoryPhase = "normal" | "notice" | "prepare";

export type AdmissionResult = "admit" | "reduce-first" | "unsafe" | "unknown";

export type AdmissionReason =
	| "fits"
	| "pressure-at-reduce-threshold"
	| "exceeds-window"
	| "exceeds-window-no-material"
	| "input-unknown"
	| "window-unknown";

export type AdvisorySuppression =
	| "not-crossed"
	| "already-announced"
	| "no-useful-cut-unchanged-revision"
	| "measurement-unknown";

/** Identity the caller considers material for re-arming. */
export interface ContextRevision {
	sessionId: string;
	branchAnchorTurnId: string | null;
	/** Changes whenever context content materially changed. */
	revisionId: string;
}

export type ReductionAvailability = "available" | "no-useful-cut" | "unknown";

/**
 * Material context identity for advisory re-arming.
 *
 * Ordinary appended content changes `revisionId` on almost every tool call and
 * must stay quiet while the same advisory phase holds. A change here is a
 * different budget basis — another model, target, system prompt, or tool
 * surface — and re-arms the advisory. `epoch` lets a caller declare a material
 * change directly. All fields are optional so an omitted identity keeps the
 * previous behavior.
 */
export interface AdvisoryContextIdentity {
	targetId?: string | null;
	modelId?: string | null;
	promptFingerprint?: string | null;
	toolSignature?: string | null;
	epoch?: string | number | null;
}

export interface PressureFacts {
	revision: ContextRevision;
	/** Complete prompt-side input. `null` when not measured; never coerced to 0. */
	inputTokens: number | null;
	/**
	 * Where `inputTokens` came from. It is a provenance label only: a `trusted`
	 * reading does not change any arithmetic here, and `measured: true` never
	 * means the figure is provider-exact.
	 */
	inputSource: "estimated" | "trusted";
	/** `null` when the effective window is unresolved. */
	effectiveContextWindow: number | null;
	/** Tokens actually reserved for model output on the next request. */
	outputReserveTokens: number;
	/**
	 * Incremental tokens **not already counted in `inputTokens`**, priced exactly
	 * once by the caller. When the adapter's live input figure already includes
	 * pending user input, tool schemas, and injected guidance — as the
	 * authoritative reading normally does — this is 0. It exists for a caller
	 * that knows of an addition the reading predates.
	 */
	pendingRequestOverheadTokens: number;
	reduction: ReductionAvailability;
	contextIdentity?: AdvisoryContextIdentity;
}

export interface PressurePolicyInput {
	reduceThreshold?: number;
	workingSetTarget?: number;
	/** Supply both or neither; omitted advisories are derived from `reduceThreshold`. */
	noticeThreshold?: number;
	prepareThreshold?: number;
}

export interface ResolvedPressurePolicy {
	notice: number;
	prepare: number;
	reduce: number;
	target: number;
	/** True when notice/prepare were derived rather than configured. */
	derived: boolean;
}

export type PolicyRejection =
	| "reduce-threshold-out-of-range"
	| "target-out-of-range"
	| "advisory-thresholds-incomplete"
	| "advisory-thresholds-out-of-order";

export type PolicyResolution = { ok: true; policy: ResolvedPressurePolicy } | { ok: false; reason: PolicyRejection };

/** Prior advisory state; `INITIAL_ADVISORY_MEMORY` starts a session. */
export interface AdvisoryMemory {
	announcedPhase: AdvisoryPhase;
	/** Advisory identity the announcement was made against; null before anything is armed. */
	advisoryKey: string | null;
	/**
	 * Complete request identity (advisory identity plus revision) for which
	 * reduction reported no useful cut. Scoped this tightly so a refusal cannot
	 * leak into another session, branch, window, policy, or model.
	 */
	noCutKey: string | null;
}

export interface RequestAdmission {
	result: AdmissionResult;
	reason: AdmissionReason;
	/** Complete input plus output reserve, or null when unmeasured. */
	requiredTokens: number | null;
}

export interface AdvisoryDecision {
	emit: boolean;
	phase: AdvisoryPhase;
	suppressedBy: AdvisorySuppression | null;
}

export interface PressureDecision {
	phase: PressurePhase;
	/** `completeInput / window`, or null when unmeasured. */
	pressure: number | null;
	/** `window - (completeInput + outputReserve)`; negative means overflow. */
	headroomTokens: number | null;
	/**
	 * True when a usable numeric reading existed. It says nothing about
	 * accuracy: an estimated input yields `measured: true` with
	 * `inputSource: "estimated"`.
	 */
	measured: boolean;
	/** Provenance of the input figure this decision used. */
	inputSource: "estimated" | "trusted";
	completeInputTokens: number | null;
	admission: RequestAdmission;
	advisory: AdvisoryDecision;
	/** Immutable next advisory state; pass back on the following call. */
	memory: AdvisoryMemory;
	policy: ResolvedPressurePolicy;
}

export const DEFAULT_REDUCE_THRESHOLD = 0.8;
export const DEFAULT_WORKING_SET_TARGET = 0.6;

/**
 * Candidate advisory levels are 0.65 and 0.72 against the default 0.8 reduce
 * threshold, expressed as proportions so a configured lower threshold scales
 * deterministically instead of producing an advisory above its own reduce point.
 */
export const NOTICE_PROPORTION = 0.65 / 0.8;
export const PREPARE_PROPORTION = 0.72 / 0.8;

/** An announcement clears once pressure falls this far below the notice level. */
export const ADVISORY_RESET_BAND = 0.05;

export const INITIAL_ADVISORY_MEMORY: AdvisoryMemory = Object.freeze({
	announcedPhase: "normal" as AdvisoryPhase,
	advisoryKey: null,
	noCutKey: null,
});

const ADVISORY_RANK: Record<AdvisoryPhase, number> = { normal: 0, notice: 1, prepare: 2 };

function isPositiveFinite(value: number | null | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: number | null | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Resolve and validate a policy. Explicit advisory thresholds are rejected when
 * they are incomplete or not strictly ordered; omitted ones are derived from the
 * configured reduce threshold.
 */
export function resolvePressurePolicy(input: PressurePolicyInput = {}): PolicyResolution {
	const reduce = input.reduceThreshold ?? DEFAULT_REDUCE_THRESHOLD;
	const target = input.workingSetTarget ?? DEFAULT_WORKING_SET_TARGET;
	if (!Number.isFinite(reduce) || reduce <= 0 || reduce > 1) {
		return { ok: false, reason: "reduce-threshold-out-of-range" };
	}
	if (!Number.isFinite(target) || target <= 0 || target >= reduce) {
		return { ok: false, reason: "target-out-of-range" };
	}

	const hasNotice = input.noticeThreshold !== undefined;
	const hasPrepare = input.prepareThreshold !== undefined;
	if (hasNotice !== hasPrepare) return { ok: false, reason: "advisory-thresholds-incomplete" };

	const notice = hasNotice ? (input.noticeThreshold as number) : reduce * NOTICE_PROPORTION;
	const prepare = hasPrepare ? (input.prepareThreshold as number) : reduce * PREPARE_PROPORTION;
	if (!Number.isFinite(notice) || !Number.isFinite(prepare)) {
		return { ok: false, reason: "advisory-thresholds-out-of-order" };
	}
	if (!(notice > 0 && notice < prepare && prepare < reduce)) {
		return { ok: false, reason: "advisory-thresholds-out-of-order" };
	}

	return {
		ok: true,
		policy: Object.freeze({ notice, prepare, reduce, target, derived: !hasNotice }),
	};
}

/**
 * Advisory identity: everything that makes one advisory epoch different from
 * another, excluding the revision. Encoded as a JSON tuple so a separator
 * inside a session or branch id cannot collide with a different split of the
 * same characters.
 */
function advisoryIdentity(facts: PressureFacts, policy: ResolvedPressurePolicy): string {
	const identity = facts.contextIdentity ?? {};
	return JSON.stringify([
		"advisory/1",
		facts.revision.sessionId,
		facts.revision.branchAnchorTurnId,
		Number.isFinite(facts.effectiveContextWindow) ? facts.effectiveContextWindow : null,
		policy.notice,
		policy.prepare,
		policy.reduce,
		policy.target,
		identity.epoch ?? null,
		identity.targetId ?? null,
		identity.modelId ?? null,
		identity.promptFingerprint ?? null,
		identity.toolSignature ?? null,
	]);
}

/** Complete request identity: the advisory identity plus the exact revision. */
function requestIdentity(advisoryKey: string, facts: PressureFacts): string {
	return JSON.stringify(["request/1", advisoryKey, facts.revision.revisionId]);
}

function unmeasuredDecision(
	facts: PressureFacts,
	policy: ResolvedPressurePolicy,
	prior: AdvisoryMemory,
	reason: AdmissionReason,
): PressureDecision {
	return Object.freeze({
		phase: "normal" as PressurePhase,
		pressure: null,
		headroomTokens: null,
		measured: false,
		inputSource: facts.inputSource,
		completeInputTokens: null,
		admission: Object.freeze({ result: "unknown" as AdmissionResult, reason, requiredTokens: null }),
		advisory: Object.freeze({
			emit: false,
			phase: "normal" as AdvisoryPhase,
			suppressedBy: "measurement-unknown" as AdvisorySuppression,
		}),
		// An unmeasured turn carries prior memory through untouched. Advancing
		// the advisory key here would consume the re-arm owed to a target, model,
		// window, or policy change first seen without a usable reading.
		memory: Object.freeze({ ...prior }),
		policy,
	});
}

/**
 * Decide the phase, admission, and advisory for one request.
 *
 * Shadow mode: the returned verdict causes nothing on its own.
 *
 * Unknown or malformed measurements are reported as unknown, never as zero or
 * safe. A request whose complete input plus actual output reserve exceeds a
 * known window is `recover`/`unsafe` even when the percentage thresholds were
 * never crossed, which is how a single oversized observation skips every
 * advisory phase.
 */
export function evaluatePressure(
	facts: PressureFacts,
	policy: ResolvedPressurePolicy,
	prior: AdvisoryMemory = INITIAL_ADVISORY_MEMORY,
): PressureDecision {
	if (!isPositiveFinite(facts.effectiveContextWindow)) {
		return unmeasuredDecision(facts, policy, prior, "window-unknown");
	}
	if (facts.inputTokens === null || !Number.isFinite(facts.inputTokens) || facts.inputTokens < 0) {
		return unmeasuredDecision(facts, policy, prior, "input-unknown");
	}
	const overhead = isNonNegativeFinite(facts.pendingRequestOverheadTokens) ? facts.pendingRequestOverheadTokens : null;
	const reserve = isNonNegativeFinite(facts.outputReserveTokens) ? facts.outputReserveTokens : null;
	if (overhead === null || reserve === null) {
		return unmeasuredDecision(facts, policy, prior, "input-unknown");
	}

	const window = facts.effectiveContextWindow;
	const completeInput = facts.inputTokens + overhead;
	const required = completeInput + reserve;
	const pressure = completeInput / window;
	const headroom = window - required;

	const advisoryKey = advisoryIdentity(facts, policy);
	const requestKey = requestIdentity(advisoryKey, facts);
	const noCutNow = facts.reduction === "no-useful-cut";
	const noCutCarried = prior.noCutKey !== null && prior.noCutKey === requestKey;
	const suppressedByNoCut = noCutNow || noCutCarried;

	let phase: PressurePhase;
	let admission: RequestAdmission;
	if (required > window) {
		phase = "recover";
		admission = {
			result: "unsafe",
			reason: suppressedByNoCut ? "exceeds-window-no-material" : "exceeds-window",
			requiredTokens: required,
		};
	} else if (pressure >= policy.reduce) {
		phase = "reduce";
		admission = {
			result: suppressedByNoCut ? "admit" : "reduce-first",
			reason: suppressedByNoCut ? "fits" : "pressure-at-reduce-threshold",
			requiredTokens: required,
		};
	} else {
		phase = pressure >= policy.prepare ? "prepare" : pressure >= policy.notice ? "notice" : "normal";
		admission = { result: "admit", reason: "fits", requiredTokens: required };
	}

	const advisoryPhase: AdvisoryPhase = phase === "notice" || phase === "prepare" ? phase : "normal";
	const rearmed = prior.advisoryKey !== null && prior.advisoryKey !== advisoryKey;
	const resetLevel = policy.notice * (1 - ADVISORY_RESET_BAND);
	const fellBelowReset = pressure < resetLevel;
	const announcedBefore = rearmed || fellBelowReset ? "normal" : prior.announcedPhase;

	// Report the reason that actually held back an action. A reduce/recover
	// phase would otherwise ask for a cut, so an unchanged no-cut revision is
	// the operative suppression there even though no advisory phase was armed.
	const actionWouldBeRequested = advisoryPhase !== "normal" || phase === "reduce" || phase === "recover";
	let emit = false;
	let suppressedBy: AdvisorySuppression | null = null;
	if (suppressedByNoCut && actionWouldBeRequested) {
		suppressedBy = "no-useful-cut-unchanged-revision";
	} else if (advisoryPhase === "normal") {
		suppressedBy = "not-crossed";
	} else if (ADVISORY_RANK[advisoryPhase] > ADVISORY_RANK[announcedBefore]) {
		emit = true;
	} else {
		suppressedBy = "already-announced";
	}

	const nextAnnounced: AdvisoryPhase = emit ? advisoryPhase : announcedBefore;
	// A refusal survives only for the identical request. Any other identity
	// clears it rather than carrying it into a scope it was never measured in.
	const nextNoCutKey = noCutNow || noCutCarried ? requestKey : null;

	return Object.freeze({
		phase,
		pressure,
		headroomTokens: headroom,
		measured: true,
		inputSource: facts.inputSource,
		completeInputTokens: completeInput,
		admission: Object.freeze(admission),
		advisory: Object.freeze({ emit, phase: advisoryPhase, suppressedBy }),
		memory: Object.freeze({ announcedPhase: nextAnnounced, advisoryKey, noCutKey: nextNoCutKey }),
		policy,
	});
}
