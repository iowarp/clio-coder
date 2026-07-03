import type { RunPersonaOverride, RunPipelineProvenance, RunReceipt } from "../dispatch/types.js";

/**
 * Worker permission-escalation counters projected off a receipt's
 * `safety.decisions` block. Present only when the run saw at least one
 * escalation, so a legacy receipt (no escalation activity) yields no view and
 * every renderer omits the escalation output. `approved`/`denied`/`timedOut`
 * default to 0 when the writer folded only a subset of the optional counters.
 */
export interface RunEscalationCounts {
	requested: number;
	approved: number;
	denied: number;
	timedOut: number;
}

/**
 * The receipt-provenance subset the evidence and dispatch surfaces render:
 * pipeline threading, ad-hoc persona override, and escalation counters. Each
 * field is present only when the receipt carries it, so a legacy receipt maps
 * to an empty view and every renderer stays byte-identical to today.
 */
export interface RunProvenanceView {
	pipeline?: RunPipelineProvenance;
	personaOverride?: RunPersonaOverride;
	escalation?: RunEscalationCounts;
}

/** The receipt fields the provenance view reads; a narrow slice of RunReceipt. */
type ProvenanceReceipt = Pick<RunReceipt, "pipeline" | "personaOverride" | "safety">;

/** Number of leading hash characters shown as a persona-override prompt-hash prefix. */
export const PERSONA_HASH_PREFIX_CHARS = 12;

/**
 * Read the three provenance field sets off a receipt shape. Reads existing
 * optional fields only; never mutates the receipt or assumes a field is
 * present. Returns an empty view for a legacy receipt.
 */
export function extractRunProvenance(receipt: ProvenanceReceipt): RunProvenanceView {
	const view: RunProvenanceView = {};
	if (receipt.pipeline !== undefined) view.pipeline = receipt.pipeline;
	if (receipt.personaOverride !== undefined) view.personaOverride = receipt.personaOverride;
	const escalation = escalationCountsFrom(receipt.safety);
	if (escalation !== null) view.escalation = escalation;
	return view;
}

/** True when at least one provenance field set is present. */
export function hasRunProvenance(view: RunProvenanceView): boolean {
	return view.pipeline !== undefined || view.personaOverride !== undefined || view.escalation !== undefined;
}

/**
 * Defensively read a provenance view off a raw receipt JSON value (a
 * `receipt.json` bundle entry). Unlike {@link extractRunProvenance}, this
 * validates each field so a malformed or partial receipt yields an empty view
 * instead of throwing. Used by CLI surfaces that read the bundle back.
 */
export function runProvenanceFromUnknown(value: unknown): RunProvenanceView {
	if (!isRecord(value)) return {};
	const view: RunProvenanceView = {};
	const pipeline = pipelineFromUnknown(value.pipeline);
	if (pipeline !== null) view.pipeline = pipeline;
	const personaOverride = personaOverrideFromUnknown(value.personaOverride);
	if (personaOverride !== null) view.personaOverride = personaOverride;
	const escalation = escalationFromUnknown(value.safety);
	if (escalation !== null) view.escalation = escalation;
	return view;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pipelineFromUnknown(value: unknown): RunPipelineProvenance | null {
	if (!isRecord(value)) return null;
	const position = finiteNumber(value.position);
	const inputBytes = finiteNumber(value.inputBytes);
	if (position === null || inputBytes === null) return null;
	const fromRunId = typeof value.fromRunId === "string" ? value.fromRunId : null;
	return { fromRunId, position, inputBytes, inputTruncated: value.inputTruncated === true };
}

function personaOverrideFromUnknown(value: unknown): RunPersonaOverride | null {
	if (!isRecord(value) || typeof value.promptHash !== "string" || value.promptHash.length === 0) return null;
	return { promptHash: value.promptHash };
}

function escalationFromUnknown(safety: unknown): RunEscalationCounts | null {
	if (!isRecord(safety)) return null;
	const decisions = safety.decisions;
	if (!isRecord(decisions)) return null;
	const requested = finiteNumber(decisions.escalationRequested);
	if (requested === null) return null;
	return {
		requested,
		approved: finiteNumber(decisions.escalationApproved) ?? 0,
		denied: finiteNumber(decisions.escalationDenied) ?? 0,
		timedOut: finiteNumber(decisions.escalationTimedOut) ?? 0,
	};
}

function escalationCountsFrom(safety: RunReceipt["safety"]): RunEscalationCounts | null {
	const decisions = safety?.decisions;
	if (decisions === undefined || decisions.escalationRequested === undefined) return null;
	return {
		requested: decisions.escalationRequested,
		approved: decisions.escalationApproved ?? 0,
		denied: decisions.escalationDenied ?? 0,
		timedOut: decisions.escalationTimedOut ?? 0,
	};
}

/** Leading prefix of a persona-override prompt hash, with an ellipsis when clipped. */
export function formatPersonaHashPrefix(promptHash: string): string {
	if (promptHash.length <= PERSONA_HASH_PREFIX_CHARS) return promptHash;
	return `${promptHash.slice(0, PERSONA_HASH_PREFIX_CHARS)}...`;
}

/**
 * Human transcript sentences for a provenance view, one per present field set.
 * Empty for a legacy receipt so the transcript run section stays unchanged.
 */
export function provenanceTranscriptLines(view: RunProvenanceView): string[] {
	const lines: string[] = [];
	if (view.pipeline !== undefined) {
		const { fromRunId, position, inputBytes, inputTruncated } = view.pipeline;
		const source = fromRunId ?? "unknown";
		const truncation = inputTruncated ? "input truncated" : "not truncated";
		lines.push(`pipeline: step ${position}, input ${inputBytes} bytes from ${source} (${truncation})`);
	}
	if (view.personaOverride !== undefined) {
		lines.push(`persona override: prompt hash ${formatPersonaHashPrefix(view.personaOverride.promptHash)}`);
	}
	if (view.escalation !== undefined) {
		const { requested, approved, denied, timedOut } = view.escalation;
		lines.push(`escalations: ${requested} requested, ${approved} approved, ${denied} denied, ${timedOut} timed out`);
	}
	return lines;
}

/**
 * Compact ` key=value` suffix for the dispatch tool's per-run and CLI lines.
 * Leading space included so callers append it directly; empty string for a
 * legacy receipt so the existing line format is preserved exactly.
 */
export function provenanceCompactSuffix(view: RunProvenanceView): string {
	const parts: string[] = [];
	if (view.pipeline !== undefined) {
		const { fromRunId, position, inputBytes, inputTruncated } = view.pipeline;
		const from = fromRunId ?? "unknown";
		parts.push(`pipeline=step${position} from=${from} in=${inputBytes}b${inputTruncated ? " truncated" : ""}`);
	}
	if (view.personaOverride !== undefined) {
		parts.push(`persona=${formatPersonaHashPrefix(view.personaOverride.promptHash)}`);
	}
	if (view.escalation !== undefined) {
		const { requested, approved, denied, timedOut } = view.escalation;
		parts.push(`escalations=${requested}req/${approved}appr/${denied}deny/${timedOut}timeout`);
	}
	return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}
