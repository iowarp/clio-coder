import type {
	RunPersonaOverride,
	RunPipelineProvenance,
	RunReceipt,
	RunReceiptAutonomyEnforcement,
} from "../dispatch/types.js";
import type { CanonicalTrustStatus } from "./trust-status.js";

/**
 * Worker permission-escalation counters projected from sealed receipt
 * provenance. Renderers omit this view when no escalation was requested.
 * Optional outcome counters default to zero until the receipt schema makes
 * every escalation counter required.
 */
export interface RunEscalationCounts {
	requested: number;
	approved: number;
	denied: number;
	timedOut: number;
}

/**
 * The sealed receipt provenance that evidence and dispatch surfaces render.
 * Each field is present only when the receipt carries it. Renderers omit
 * provenance output when none of these fields are present.
 */
export interface RunProvenanceView {
	pipeline?: RunPipelineProvenance;
	personaOverride?: RunPersonaOverride;
	escalation?: RunEscalationCounts;
	autonomyEnforcement?: RunReceiptAutonomyEnforcement;
}

/** The receipt fields the provenance view reads; a narrow slice of RunReceipt. */
type ProvenanceReceipt = Pick<RunReceipt, "pipeline" | "personaOverride" | "safety" | "autonomyEnforcement">;

/** Number of leading hash characters shown as a persona-override prompt-hash prefix. */
export const PERSONA_HASH_PREFIX_CHARS = 12;

/**
 * Read provenance from a sealed receipt shape. This reads optional fields
 * without mutating the receipt and returns an empty view when none are present.
 */
export function extractRunProvenance(receipt: ProvenanceReceipt): RunProvenanceView {
	const view: RunProvenanceView = {};
	if (receipt.pipeline !== undefined) view.pipeline = receipt.pipeline;
	if (receipt.personaOverride !== undefined) view.personaOverride = receipt.personaOverride;
	const escalation = escalationCountsFrom(receipt.safety);
	if (escalation !== null) view.escalation = escalation;
	if (receipt.autonomyEnforcement !== undefined) view.autonomyEnforcement = receipt.autonomyEnforcement;
	return view;
}

/**
 * The slice of a provenance view the canonical projection admits. The
 * projection is the only thing that decides whether an axis is reported, so
 * the autonomy detail (`autonomy=`, `mode=`, `dangerousBypass=`) is kept only
 * when the projection reports the autonomy axis in a recorded state, and the
 * non-axis provenance (pipeline, persona override, escalations) only when the
 * seal that carries it verified. With no projection at hand no axis detail is
 * admitted at all, whatever the receipt says; the non-axis provenance passes
 * through for a caller that prints it beside its own integrity banner.
 */
export function admitRunProvenance(view: RunProvenanceView, status?: CanonicalTrustStatus): RunProvenanceView {
	const admitted: RunProvenanceView = {};
	if (status === undefined || status.artifactIntegrity.state === "verified") {
		if (view.pipeline !== undefined) admitted.pipeline = view.pipeline;
		if (view.personaOverride !== undefined) admitted.personaOverride = view.personaOverride;
		if (view.escalation !== undefined) admitted.escalation = view.escalation;
	}
	const autonomy = status?.autonomyEnforcement.state;
	if (
		view.autonomyEnforcement !== undefined &&
		(autonomy === "enforced" || autonomy === "approximated" || autonomy === "bypassed")
	) {
		admitted.autonomyEnforcement = view.autonomyEnforcement;
	}
	return admitted;
}

/** True when at least one provenance field set is present. */
export function hasRunProvenance(view: RunProvenanceView): boolean {
	return (
		view.pipeline !== undefined ||
		view.personaOverride !== undefined ||
		view.escalation !== undefined ||
		view.autonomyEnforcement !== undefined
	);
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
	const autonomyEnforcement = autonomyEnforcementFromUnknown(value.autonomyEnforcement);
	if (autonomyEnforcement !== null) view.autonomyEnforcement = autonomyEnforcement;
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

function autonomyEnforcementFromUnknown(value: unknown): RunReceiptAutonomyEnforcement | null {
	if (!isRecord(value)) return null;
	if (value.grade !== "mediated" && value.grade !== "approximated" && value.grade !== "bypassed") return null;
	if (typeof value.autonomy !== "string" || value.autonomy.length === 0) return null;
	const view: RunReceiptAutonomyEnforcement = { grade: value.grade, autonomy: value.autonomy };
	if (typeof value.externalMode === "string" && value.externalMode.length > 0) view.externalMode = value.externalMode;
	if (typeof value.dangerousBypass === "boolean") view.dangerousBypass = value.dangerousBypass;
	return view;
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
function formatPersonaHashPrefix(promptHash: string): string {
	if (promptHash.length <= PERSONA_HASH_PREFIX_CHARS) return promptHash;
	return `${promptHash.slice(0, PERSONA_HASH_PREFIX_CHARS)}...`;
}

/**
 * Human transcript sentences for each admitted provenance field set, gated
 * through {@link admitRunProvenance}. The autonomy line carries only the
 * detail the canonical projection does not: the policy name, the external
 * mode, and the bypass flag. The axis itself (mediated, approximated,
 * bypassed) is printed by the trust summary and nowhere else, so one
 * autonomy fact never appears in two vocabularies on one screen.
 */
export function provenanceTranscriptLines(source: RunProvenanceView, status?: CanonicalTrustStatus): string[] {
	const view = admitRunProvenance(source, status);
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
	if (view.autonomyEnforcement !== undefined) {
		const { autonomy, externalMode, dangerousBypass } = view.autonomyEnforcement;
		const mode = externalMode !== undefined ? ` mode=${externalMode}` : "";
		const bypass = dangerousBypass === true ? " dangerousBypass=true" : "";
		lines.push(`autonomy: ${autonomy}${mode}${bypass}`);
	}
	return lines;
}

/**
 * Compact ` key=value` suffix for the dispatch tool's per-run and CLI lines,
 * gated through {@link admitRunProvenance} on the same terms as the
 * transcript lines. The leading space lets callers append it directly. An
 * empty admitted view returns an empty string.
 */
export function provenanceCompactSuffix(source: RunProvenanceView, status?: CanonicalTrustStatus): string {
	const view = admitRunProvenance(source, status);
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
	if (view.autonomyEnforcement !== undefined) {
		const { autonomy, externalMode, dangerousBypass } = view.autonomyEnforcement;
		const mode = externalMode !== undefined ? `/${externalMode}` : "";
		const bypass = dangerousBypass === true ? "/bypass" : "";
		parts.push(`autonomy=${autonomy}${mode}${bypass}`);
	}
	return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}
