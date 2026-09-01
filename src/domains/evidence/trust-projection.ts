import { RUN_RECEIPT_INTEGRITY_VERSION } from "../dispatch/receipt-integrity.js";
import {
	type CanonicalTrustStatus,
	retiredIntegrityVersionOf,
	TRUST_STATUS_AXES,
	type TRUST_STATUS_STATES,
	type TrustArtifactReference,
	type TrustStatusAxis,
} from "./trust-status.js";

/**
 * The one projection of the canonical trust status every operator surface
 * renders. The six-axis model stays the source of truth and is never
 * collapsed into a score here; this module only fixes the words each state is
 * called and the order the axes are read in, so the dispatch line, the
 * monitor block, `evidence inspect`, `findings.md`, the Alt+W board, the
 * receipt view and the ACP wire cannot each spell the same
 * fact differently.
 *
 * Two shapes leave this module. `formatTrustSummary` is the compact human
 * line: it answers who claims the result, what was observed, what was
 * independently checked, and what is still unknown, without receipt
 * internals. `summarizeTrustStatus` is the bounded, versioned machine record
 * behind that line, carrying the axis states and typed references back to
 * the artifacts the detailed model cites.
 */

export const TRUST_SUMMARY_VERSION = 1 as const;

/** Reference cap for the machine projection; the canonical model keeps up to 16 per axis. */
export const TRUST_SUMMARY_MAX_REFS = 8;

/**
 * How much the run's result can be leaned on, read off the axes in a fixed
 * order. It is a presentation tier for styling and sorting, never a score:
 * `reviewed` is the only tier that may be styled as independently verified.
 */
export type TrustVerdict = "reviewed" | "grounded" | "unverified" | "compromised" | "unknown";

export const TRUST_VERDICTS: ReadonlyArray<TrustVerdict> = [
	"reviewed",
	"grounded",
	"unverified",
	"compromised",
	"unknown",
];

/** Bounded, versioned machine projection with references to the detailed artifacts. */
export interface TrustSummaryProjection {
	version: typeof TRUST_SUMMARY_VERSION;
	verdict: TrustVerdict;
	/** The compact human line, byte-identical to what the text surfaces print. */
	text: string;
	/** Every axis state, in canonical vocabulary, for machine consumers. */
	axes: Record<TrustStatusAxis, string>;
	/** Who asserts the validation fact: `<authority kind>:<id>`, or `worker` when only the run's own prose exists. */
	claimant: string;
	/** Axes that answer nothing, so a consumer knows what remains unknown. */
	unknown: TrustStatusAxis[];
	/** `<artifact kind>:<id>` pointers to the detailed records, sorted, unique, capped. */
	refs: string[];
}

type AxisStates = { [Axis in TrustStatusAxis]: (typeof TRUST_STATUS_STATES)[Axis][number] };

/**
 * The standardized word for every state. A word is what an operator reads;
 * the state id is what a machine reads. `mediated` names the `enforced`
 * autonomy state because that is the receipt grade and the documented
 * meaning: Clio's own safety gate mediated the run. `inferred` names an
 * ungrounded validation claim: the worker said it validated, nothing was
 * observed to have run.
 */
export const TRUST_STATE_WORDS: { [Axis in TrustStatusAxis]: Record<AxisStates[Axis], string> } = {
	artifactIntegrity: {
		verified: "sealed",
		failed: "seal broken",
		absent: "no receipt",
		unknown: "seal unchecked",
		not_applicable: "seal not applicable",
	},
	validationGrounding: {
		validated: "grounded",
		failed: "validation failed",
		ungrounded: "inferred: validation claimed, none observed",
		absent: "no validation observed",
		unknown: "validation unknown",
		not_applicable: "validation not applicable",
	},
	independentReview: {
		passed: "independently reviewed: pass",
		failed: "independently reviewed: fail",
		inconclusive: "independent review inconclusive",
		not_independent: "review not independent",
		absent: "not independently reviewed",
		unknown: "independent review unknown",
		not_applicable: "independent review not applicable",
	},
	contextProvenance: {
		recorded: "context recorded",
		invalid: "context record invalid",
		absent: "context not recorded",
		unknown: "context unknown",
		not_applicable: "context not applicable",
	},
	autonomyEnforcement: {
		enforced: "mediated",
		approximated: "approximated",
		bypassed: "bypassed",
		absent: "autonomy not recorded",
		unknown: "autonomy unknown",
		not_applicable: "autonomy not applicable",
	},
	completionEvidence: {
		evidenced: "completion evidenced",
		incomplete: "completion unevidenced",
		limited: "completion limited",
		absent: "completion not recorded",
		unknown: "completion unknown",
		not_applicable: "completion not applicable",
	},
};

/** The word for one axis state; unknown input never throws, it reads as unknown. */
export function trustStateWord<Axis extends TrustStatusAxis>(axis: Axis, state: string): string {
	const words = TRUST_STATE_WORDS[axis] as Record<string, string>;
	return words[state] ?? words.unknown ?? "unknown";
}

function authorityOf(status: CanonicalTrustStatus, axis: TrustStatusAxis): string | null {
	const entry = status[axis];
	return entry.state === "absent" ? null : `${entry.authority.kind}:${entry.authority.id}`;
}

/**
 * A seal this build does not verify because its version is retired names
 * that version and the one in force, so an intact receipt from the previous
 * release never reads as "seal broken" or as merely unchecked. The state
 * behind the clause is `unknown`, which is what it is: nothing was checked.
 */
function integrityClause(status: CanonicalTrustStatus): string {
	const retired = retiredIntegrityVersionOf(status.artifactIntegrity);
	if (retired !== null) return `seal v${retired} retired (this build verifies v${RUN_RECEIPT_INTEGRITY_VERSION})`;
	return trustStateWord("artifactIntegrity", status.artifactIntegrity.state);
}

/**
 * The validation clause names its claimant, because "grounded" alone hides
 * the difference between a host-run check and a self-reported one.
 */
function validationClause(status: CanonicalTrustStatus): string {
	const entry = status.validationGrounding;
	const word = trustStateWord("validationGrounding", entry.state);
	if (entry.state === "absent") return word;
	if (entry.state === "validated" || entry.state === "failed") return `${word} by ${entry.authority.id}`;
	// A named external system that could not observe the run is worth naming;
	// the historical-format placeholder is not an authority anyone can ask.
	if (entry.state === "unknown" && entry.authority.kind !== "unknown") return `${word} (${entry.authority.id})`;
	return word;
}

/** External runtimes name themselves on the autonomy clause so approximation is never anonymous. */
function autonomyClause(status: CanonicalTrustStatus): string {
	const entry = status.autonomyEnforcement;
	const word = trustStateWord("autonomyEnforcement", entry.state);
	if (entry.state !== "approximated" && entry.state !== "bypassed") return word;
	return `${word} (${entry.authority.id})`;
}

/**
 * The compact human body. Clause order is fixed: integrity, validation with
 * its claimant, independent review, autonomy, context, completion. Every
 * surface prints this body verbatim, so two surfaces can only disagree by
 * reading different canonical input.
 */
export function formatTrustSummary(status: CanonicalTrustStatus): string {
	return [
		integrityClause(status),
		validationClause(status),
		trustStateWord("independentReview", status.independentReview.state),
		autonomyClause(status),
		trustStateWord("contextProvenance", status.contextProvenance.state),
		trustStateWord("completionEvidence", status.completionEvidence.state),
	].join("; ");
}

/** The tier and body under one versioned label for receipt-facing surfaces. */
export function formatTrustSummaryLine(status: CanonicalTrustStatus): string {
	return `trust v${TRUST_SUMMARY_VERSION}: ${trustVerdict(status)}; ${formatTrustSummary(status)}`;
}

/**
 * The drill-down token line: every axis in canonical state ids. This is the
 * one machine-readable text form; `evidence inspect` and the dispatch and
 * monitor labels all print it from here.
 */
export function formatTrustAxes(status: CanonicalTrustStatus): string {
	return [`trust_status=v${status.version}`, ...TRUST_STATUS_AXES.map((axis) => `${axis}:${status[axis].state}`)].join(
		" ",
	);
}

function isUnanswered(status: CanonicalTrustStatus, axis: TrustStatusAxis): boolean {
	const state = status[axis].state;
	return state === "absent" || state === "unknown";
}

/**
 * Read the tier off the axes in priority order. A broken seal, a bypassed
 * gate, a failed or inferred validation, a failed or correlated review, or a
 * contradictory context record compromises the result whatever else holds.
 * An unchecked or missing seal leaves it unknown. Only an authenticated
 * independent pass is `reviewed`; observed validation without one is
 * `grounded`; a sealed receipt with nothing observed is `unverified`.
 */
export function trustVerdict(status: CanonicalTrustStatus): TrustVerdict {
	const integrity = status.artifactIntegrity.state;
	const validation = status.validationGrounding.state;
	const review = status.independentReview.state;
	const autonomy = status.autonomyEnforcement.state;
	if (
		integrity === "failed" ||
		autonomy === "bypassed" ||
		validation === "failed" ||
		validation === "ungrounded" ||
		review === "failed" ||
		review === "not_independent" ||
		status.contextProvenance.state === "invalid"
	) {
		return "compromised";
	}
	if (integrity !== "verified") return "unknown";
	if (review === "passed") return "reviewed";
	if (validation === "validated") return "grounded";
	return "unverified";
}

function claimantOf(status: CanonicalTrustStatus): string {
	const state = status.validationGrounding.state;
	if (state === "absent" || state === "ungrounded") return "worker";
	return authorityOf(status, "validationGrounding") ?? "worker";
}

function referenceKey(reference: TrustArtifactReference): string {
	return `${reference.kind}:${reference.id}`;
}

/** Every artifact the axes cite, as bounded pointers a consumer can resolve. */
export function trustSummaryReferences(status: CanonicalTrustStatus): string[] {
	const keys = new Set<string>();
	for (const axis of TRUST_STATUS_AXES) {
		const entry = status[axis];
		if (entry.state === "absent") continue;
		for (const reference of entry.artifacts) keys.add(referenceKey(reference));
	}
	return [...keys].sort().slice(0, TRUST_SUMMARY_MAX_REFS);
}

/** The bounded machine projection. Flat by design so a depth-capped wire keeps it whole. */
export function summarizeTrustStatus(status: CanonicalTrustStatus): TrustSummaryProjection {
	const axes = Object.fromEntries(TRUST_STATUS_AXES.map((axis) => [axis, status[axis].state])) as Record<
		TrustStatusAxis,
		string
	>;
	return {
		version: TRUST_SUMMARY_VERSION,
		verdict: trustVerdict(status),
		text: formatTrustSummary(status),
		axes,
		claimant: claimantOf(status),
		unknown: TRUST_STATUS_AXES.filter((axis) => isUnanswered(status, axis)),
		refs: trustSummaryReferences(status),
	};
}
