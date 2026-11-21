import type { WorkerBudget } from "../../worker/spec-contract.js";
import type { AgentBudget, AgentBudgetPhase } from "../agents/recipe.js";

/** Invocation-level phase requested by dispatch. */
export interface DispatchBudgetPhase {
	toolCalls: number;
}

/** Typed advisory invocation estimate. A later phase may use a different estimate. */
export interface DispatchBudgetRequest extends DispatchBudgetPhase {
	retryRevision?: DispatchBudgetPhase;
}

export type BudgetEnvelopeReasonCode = "global-cap-clamp" | "retry-growth-authorized" | "revision-growth-authorized";

export interface BudgetEnvelopeReason {
	code: BudgetEnvelopeReasonCode;
	detail: string;
}

export interface RunToolBudgetEnvelope {
	version: 1;
	enforcement:
		| {
				classification: "native-per-tool";
				perTool: "advisory";
				clioControls: ReadonlyArray<"tool-observation" | "cancellation">;
		  }
		| {
				classification: "external-one-shot";
				perTool: "unobserved-not-enforced";
				clioControls: ReadonlyArray<"single-launch" | "wall-clock" | "output-cap" | "cancellation" | "result-contract">;
		  };
	policy: {
		recipeId: string;
		default: AgentBudgetPhase & { synthesis: boolean };
		maximum: AgentBudgetPhase;
		exact: boolean;
	};
	request: DispatchBudgetRequest | null;
	effective: WorkerBudget;
	reasons: ReadonlyArray<BudgetEnvelopeReason>;
}

const ADVISORY_CLIO_CONTROLS = ["tool-observation", "cancellation"] as const;
const EXTERNAL_CLIO_CONTROLS = [
	"single-launch",
	"wall-clock",
	"output-cap",
	"cancellation",
	"result-contract",
] as const;

export type BudgetAdmissionDenialCode = "ceiling-below-request";

export class BudgetAdmissionError extends Error {
	readonly code: BudgetAdmissionDenialCode;

	constructor(code: BudgetAdmissionDenialCode, message: string) {
		super(`dispatch: budget admission denied (${code}): ${message}`);
		this.name = "BudgetAdmissionError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clonePhase(value: unknown, prefix: string): DispatchBudgetPhase {
	if (!isRecord(value)) throw new Error(`${prefix} must be an object`);
	for (const key of Object.keys(value)) {
		if (key !== "toolCalls") throw new Error(`${prefix}.${key} is unknown`);
	}
	if (!Object.hasOwn(value, "toolCalls")) throw new Error(`${prefix}.toolCalls is required`);
	const toolCalls = value.toolCalls;
	if (typeof toolCalls !== "number" || !Number.isSafeInteger(toolCalls) || toolCalls <= 0) {
		throw new Error(`${prefix}.toolCalls must be a positive safe integer`);
	}
	return { toolCalls };
}

/** Strict validation and cloning for model, CLI, and persisted request inputs. */
export function cloneDispatchBudgetRequest(value: unknown, prefix = "budget"): DispatchBudgetRequest {
	if (!isRecord(value)) throw new Error(`${prefix} must be an object`);
	for (const key of Object.keys(value)) {
		if (key !== "toolCalls" && key !== "retryRevision") throw new Error(`${prefix}.${key} is unknown`);
	}
	const phase = clonePhase({ toolCalls: value.toolCalls }, prefix);
	const retryRevision =
		value.retryRevision === undefined ? undefined : clonePhase(value.retryRevision, `${prefix}.retryRevision`);
	return { ...phase, ...(retryRevision === undefined ? {} : { retryRevision }) };
}

function freezeEnvelope(envelope: RunToolBudgetEnvelope): RunToolBudgetEnvelope {
	Object.freeze(envelope.enforcement.clioControls);
	Object.freeze(envelope.enforcement);
	Object.freeze(envelope.policy.default);
	Object.freeze(envelope.policy.maximum);
	Object.freeze(envelope.policy);
	if (envelope.request !== null) {
		if (envelope.request.retryRevision !== undefined) Object.freeze(envelope.request.retryRevision);
		Object.freeze(envelope.request);
	}
	Object.freeze(envelope.effective);
	for (const reason of envelope.reasons) Object.freeze(reason);
	Object.freeze(envelope.reasons);
	return Object.freeze(envelope);
}

function samePhase(left: DispatchBudgetPhase, right: AgentBudgetPhase): boolean {
	return left.toolCalls === right.toolCalls;
}

export interface ResolveToolBudgetEnvelopeInput {
	recipeId: string;
	policy: AgentBudget;
	request?: DispatchBudgetRequest;
	hardCap: number;
	retry: boolean;
	revision: boolean;
	enforcement?: "native-per-tool" | "external-one-shot";
}

/**
 * Resolve the one immutable envelope used by admission, enforcement, and evidence. Every recipe is advisory: the
 * estimate steers the worker and `fleet.limits.toolCallsPerRun` is the only hard tool bound; the run's handback phase
 * ends it at a context, time or tool bound (DESIGN 4.5).
 */
export function resolveToolBudgetEnvelope(input: ResolveToolBudgetEnvelopeInput): RunToolBudgetEnvelope {
	if (!Number.isSafeInteger(input.hardCap) || input.hardCap <= 0) {
		throw new Error("dispatch: worker tool-call cap must be a positive safe integer");
	}

	const request = input.request === undefined ? null : cloneDispatchBudgetRequest(input.request);
	if (request?.retryRevision && request.retryRevision.toolCalls < request.toolCalls) {
		throw new BudgetAdmissionError("ceiling-below-request", "retryRevision must not be smaller than the requested phase");
	}
	const base: DispatchBudgetPhase = { toolCalls: (request ?? input.policy).toolCalls };
	const reasons: BudgetEnvelopeReason[] = [];
	let selected: DispatchBudgetPhase = base;
	const phaseKind = input.retry ? "retry" : input.revision ? "revision" : null;
	if (phaseKind !== null) {
		const ceiling = request?.retryRevision;
		if (ceiling !== undefined && !samePhase(ceiling, base)) {
			selected = ceiling;
			reasons.push({
				code: phaseKind === "retry" ? "retry-growth-authorized" : "revision-growth-authorized",
				detail: `${phaseKind} phase grew from ${base.toolCalls} to the advisory estimate ${ceiling.toolCalls}`,
			});
		}
	}
	// A native run stops at fleet.limits.toolCallsPerRun: a request may plan for less, never for more (M6).
	const advisoryCap = input.enforcement !== "external-one-shot" ? input.hardCap : Number.POSITIVE_INFINITY;
	const revisionCeiling = phaseKind === null ? request?.retryRevision : undefined;
	const requestedPeak = Math.max(selected.toolCalls, revisionCeiling?.toolCalls ?? 0);
	if (requestedPeak > advisoryCap) {
		reasons.push({
			code: "global-cap-clamp",
			detail: `the ${requestedPeak} tool calls estimated were held at fleet.limits.toolCallsPerRun ${input.hardCap}`,
		});
	}

	const toolCalls = Math.min(selected.toolCalls, advisoryCap);
	let effectiveRevision: DispatchBudgetPhase | undefined;
	if (revisionCeiling !== undefined && !samePhase(revisionCeiling, selected)) {
		const revisionToolCalls = Math.min(revisionCeiling.toolCalls, advisoryCap);
		// A revision the cap folds onto the base phase grows nothing and is dropped, with no growth reason.
		if (revisionToolCalls > toolCalls) {
			effectiveRevision = { toolCalls: revisionToolCalls };
			reasons.push({
				code: "revision-growth-authorized",
				detail: `a result-contract revision may grow from ${toolCalls} to ${revisionToolCalls}`,
			});
		}
	}

	const authoredMaximum = input.policy.maximum ?? input.policy;
	const envelope: RunToolBudgetEnvelope = {
		version: 1,
		enforcement:
			input.enforcement === "external-one-shot"
				? {
						classification: "external-one-shot",
						perTool: "unobserved-not-enforced",
						clioControls: [...EXTERNAL_CLIO_CONTROLS],
					}
				: {
						classification: "native-per-tool",
						perTool: "advisory",
						clioControls: [...ADVISORY_CLIO_CONTROLS],
					},
		policy: {
			recipeId: input.recipeId,
			default: { toolCalls: input.policy.toolCalls, synthesis: input.policy.synthesis },
			maximum: { toolCalls: authoredMaximum.toolCalls },
			exact: input.policy.maximum === undefined,
		},
		request,
		effective: {
			mode: "advisory",
			toolCalls,
			synthesis: input.policy.synthesis,
			hardCap: input.hardCap,
			...(effectiveRevision === undefined ? {} : { revision: effectiveRevision }),
		},
		reasons,
	};
	if (input.enforcement !== "external-one-shot") envelope.effective = workerBudgetFromEnvelope(envelope);
	return freezeEnvelope(envelope);
}

/**
 * The budget a worker enforces. An advisory envelope gains a hard ceiling at
 * `fleet.limits.toolCallsPerRun`, tightened to the recipe's explicit maximum
 * when it declares one, and never below the estimate or revision the request was admitted with,
 * which resolution already holds at the cap.
 */
export function workerBudgetFromEnvelope(envelope: RunToolBudgetEnvelope): RunToolBudgetEnvelope["effective"] & {
	ceiling?: number;
} {
	const effective = envelope.effective;
	if (effective.mode !== "advisory") return effective;
	const floor = Math.max(effective.toolCalls, effective.revision?.toolCalls ?? 0);
	const limit = envelope.policy.exact
		? effective.hardCap
		: Math.min(envelope.policy.maximum.toolCalls, effective.hardCap);
	return { ...effective, ceiling: Math.max(floor, limit) };
}

export function formatBudgetPolicy(envelope: RecordedRunToolBudgetEnvelope): string {
	if (isRetiredBudgetEnvelope(envelope)) return retiredBudgetPolicy(envelope);
	const policy = envelope.policy;
	return `${policy.recipeId} advisory default ${policy.default.toolCalls}, recommended max ${policy.maximum.toolCalls}`;
}

export function formatBudgetRequest(envelope: RecordedRunToolBudgetEnvelope): string {
	if (isRetiredBudgetEnvelope(envelope)) return retiredBudgetRequest(envelope);
	const request = envelope.request;
	if (request === null) return "recipe default";
	const ceiling = request.retryRevision;
	return `${request.toolCalls} advisory${ceiling ? `, retry/revision estimate ${ceiling.toolCalls}` : ""}`;
}

export function formatEffectiveBudget(envelope: RecordedRunToolBudgetEnvelope): string {
	if (isRetiredBudgetEnvelope(envelope)) return retiredEffectiveBudget(envelope);
	const budget = envelope.effective;
	const revision = budget.revision ? `, result revision ${budget.revision.toolCalls}` : "";
	const enforcement =
		envelope.enforcement.classification === "external-one-shot"
			? "external one-shot; per-tool unobserved/not enforced"
			: "native per-tool observed/advisory";
	return `${budget.toolCalls}${revision}, advisory baseline ${budget.hardCap}${budget.ceiling === undefined ? "" : `, worker ceiling ${budget.ceiling}`}, synthesis=${budget.synthesis ? "on" : "off"}; ${enforcement}`;
}

export function formatBudgetReasons(envelope: RecordedRunToolBudgetEnvelope): string {
	return envelope.reasons.length === 0 ? "none" : envelope.reasons.map((reason) => reason.code).join(",");
}

const BUDGET_REASON_CODES: ReadonlySet<string> = new Set<BudgetEnvelopeReasonCode>([
	"global-cap-clamp",
	"retry-growth-authorized",
	"revision-growth-authorized",
]);

function isExactStringArray(value: unknown[], expected: readonly string[]): boolean {
	return value.length === expected.length && value.every((item, index) => item === expected[index]);
}

/** Safely project an envelope that crossed a persistence or event boundary. */
export function cloneRunToolBudgetEnvelope(value: unknown): RunToolBudgetEnvelope | undefined {
	try {
		if (!isRecord(value) || value.version !== 1 || !isRecord(value.policy) || !isRecord(value.effective)) {
			return undefined;
		}
		const recipeId = value.policy.recipeId;
		if (typeof recipeId !== "string" || recipeId.length === 0 || typeof value.policy.exact !== "boolean") {
			return undefined;
		}
		if (!isRecord(value.policy.default) || typeof value.policy.default.synthesis !== "boolean") return undefined;
		const defaultPhase = clonePhase({ toolCalls: value.policy.default.toolCalls }, "budget.policy.default");
		const maximum = clonePhase(value.policy.maximum, "budget.policy.maximum");
		const request = value.request === null ? null : cloneDispatchBudgetRequest(value.request);
		const effectivePhase = clonePhase({ toolCalls: value.effective.toolCalls }, "budget.effective");
		const revision =
			value.effective.revision === undefined
				? undefined
				: clonePhase(value.effective.revision, "budget.effective.revision");
		if (
			value.effective.mode !== "advisory" ||
			typeof value.effective.synthesis !== "boolean" ||
			typeof value.effective.hardCap !== "number" ||
			!Number.isSafeInteger(value.effective.hardCap) ||
			value.effective.hardCap <= 0 ||
			!Array.isArray(value.reasons)
		) {
			return undefined;
		}
		const ceiling = value.effective.ceiling;
		if (
			ceiling !== undefined &&
			(typeof ceiling !== "number" ||
				!Number.isSafeInteger(ceiling) ||
				ceiling !==
					Math.max(
						effectivePhase.toolCalls,
						revision?.toolCalls ?? 0,
						value.policy.exact ? value.effective.hardCap : Math.min(maximum.toolCalls, value.effective.hardCap),
					))
		)
			return undefined;
		if (
			maximum.toolCalls < defaultPhase.toolCalls ||
			(value.policy.exact && !samePhase(maximum, defaultPhase)) ||
			value.effective.synthesis !== value.policy.default.synthesis ||
			(revision !== undefined && revision.toolCalls <= effectivePhase.toolCalls)
		) {
			return undefined;
		}
		const reasons: BudgetEnvelopeReason[] = [];
		for (const reason of value.reasons) {
			if (
				!isRecord(reason) ||
				typeof reason.code !== "string" ||
				!BUDGET_REASON_CODES.has(reason.code) ||
				typeof reason.detail !== "string"
			) {
				return undefined;
			}
			reasons.push({ code: reason.code as BudgetEnvelopeReasonCode, detail: reason.detail });
		}
		const enforcement = (() => {
			if (!isRecord(value.enforcement) || !Array.isArray(value.enforcement.clioControls)) return null;
			if (
				Object.keys(value.enforcement).some(
					(key) => key !== "classification" && key !== "perTool" && key !== "clioControls",
				)
			) {
				return null;
			}
			if (
				value.enforcement.classification === "external-one-shot" &&
				value.enforcement.perTool === "unobserved-not-enforced" &&
				isExactStringArray(value.enforcement.clioControls, EXTERNAL_CLIO_CONTROLS)
			) {
				return {
					classification: "external-one-shot" as const,
					perTool: "unobserved-not-enforced" as const,
					clioControls: [...EXTERNAL_CLIO_CONTROLS],
				};
			}
			if (
				value.enforcement.classification === "native-per-tool" &&
				value.enforcement.perTool === "advisory" &&
				isExactStringArray(value.enforcement.clioControls, ADVISORY_CLIO_CONTROLS)
			)
				return {
					classification: "native-per-tool" as const,
					perTool: "advisory" as const,
					clioControls: [...ADVISORY_CLIO_CONTROLS],
				};
			return null;
		})();
		if (enforcement === null) return undefined;
		return freezeEnvelope({
			version: 1,
			enforcement,
			policy: {
				recipeId,
				default: { ...defaultPhase, synthesis: value.policy.default.synthesis },
				maximum,
				exact: value.policy.exact,
			},
			request,
			effective: {
				mode: "advisory",
				...effectivePhase,
				synthesis: value.effective.synthesis,
				hardCap: value.effective.hardCap,
				...(ceiling === undefined ? {} : { ceiling }),
				...(revision === undefined ? {} : { revision }),
			},
			reasons,
		});
	} catch {
		return undefined;
	}
}

/**
 * The run's tool-call limit as a person reads it: how many calls it was planned for and where CLIO Coder stops it. The
 * recipe policy, the request and the reason codes stay in `/view` and `clio-coder fleet view`, which keep them whole.
 * A pre-M12 envelope read from a journal is worded as it was recorded.
 */
export function budgetLimitWords(envelope: RecordedRunToolBudgetEnvelope): string {
	if (envelope.enforcement.classification === "external-one-shot") {
		return "one launch; CLIO Coder cannot count its tool calls, so its time and output limits bound it";
	}
	if (isRetiredBudgetEnvelope(envelope)) return retiredBudgetLimitWords(envelope);
	const budget = workerBudgetFromEnvelope(envelope);
	const codes = new Set(envelope.reasons.map((reason) => reason.code));
	// Growth is worded from the revision the run holds after the cap, never from the reason codes the estimate
	// produced: a cap that folded the revision onto the base phase leaves nothing to grow into (M6).
	const revision = budget.revision;
	const notes = [
		...(codes.has("global-cap-clamp") ? ["lowered to CLIO Coder's overall limit"] : []),
		...(revision === undefined ? [] : [`about ${revision.toolCalls} if it has to redo its answer`]),
	];
	const stop = budget.ceiling ?? budget.hardCap;
	// A plan that equals the stop is one number, said once: `about 20; stops at 20` read as two limits.
	const limit =
		budget.toolCalls === stop
			? `CLIO Coder stops it at ${stop} tool calls`
			: `planned for about ${budget.toolCalls} tool calls; CLIO Coder stops it at ${stop}`;
	return notes.length === 0 ? limit : `${limit} (${notes.join("; ")})`;
}

/** One phase as a pre-M12 run recorded it, read reserve included. */
export interface RetiredBudgetPhase {
	readonly toolCalls: number;
	readonly readReserve: number;
}

/**
 * A budget envelope as a run admitted before fleet M12 recorded it in its journal: an enforced research phase or an
 * advisory one, both with a read reserve. Persisted run history is immutable, so readers render it as recorded;
 * nothing admits, enforces or emits this shape.
 */
export interface RetiredRunToolBudgetEnvelope {
	readonly version: 1;
	readonly enforcement: {
		readonly classification: "native-per-tool" | "external-one-shot";
		readonly perTool: "enforced" | "advisory" | "unobserved-not-enforced";
		readonly clioControls: ReadonlyArray<string>;
	};
	readonly policy: {
		readonly recipeId: string;
		readonly default: RetiredBudgetPhase & { readonly synthesis: boolean };
		readonly maximum: RetiredBudgetPhase;
		readonly exact: boolean;
	};
	readonly request: (RetiredBudgetPhase & { readonly retryRevision?: RetiredBudgetPhase }) | null;
	readonly effective: RetiredBudgetPhase & {
		/** Absent in the oldest records, which ran enforced. */
		readonly mode?: "advisory" | "enforced";
		readonly synthesis: boolean;
		readonly hardCap: number;
		readonly ceiling?: number;
		readonly revision?: RetiredBudgetPhase;
	};
	readonly reasons: ReadonlyArray<{ readonly code: string; readonly detail: string }>;
}

/** A budget envelope a journal holds: the current shape, or the pre-M12 shape read as recorded. */
export type RecordedRunToolBudgetEnvelope = RunToolBudgetEnvelope | RetiredRunToolBudgetEnvelope;

function isRetiredBudgetEnvelope(envelope: RecordedRunToolBudgetEnvelope): envelope is RetiredRunToolBudgetEnvelope {
	return "readReserve" in envelope.effective;
}

const RETIRED_BUDGET_REASON_CODES: ReadonlySet<string> = new Set([
	...BUDGET_REASON_CODES,
	"read-reserve-unavailable-clamp",
	"read-reserve-cap-clamp",
	"retry-growth-denied",
	"revision-growth-denied",
	"read-only-research-synthesis",
]);

function retiredPhase(value: unknown): RetiredBudgetPhase | null {
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "toolCalls" && key !== "readReserve")) return null;
	const { toolCalls, readReserve } = value;
	if (typeof toolCalls !== "number" || !Number.isSafeInteger(toolCalls) || toolCalls <= 0) return null;
	if (typeof readReserve !== "number" || !Number.isSafeInteger(readReserve) || readReserve < 0) return null;
	return { toolCalls, readReserve };
}

function retiredInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** The pre-M12 shape, checked field by field and copied; any other value is not an envelope. */
function cloneRetiredBudgetEnvelope(value: unknown): RetiredRunToolBudgetEnvelope | undefined {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.policy) || !isRecord(value.effective)) return undefined;
	const { policy, effective } = value;
	if (typeof policy.recipeId !== "string" || policy.recipeId.length === 0 || typeof policy.exact !== "boolean")
		return undefined;
	const defaultPhase = retiredPhase(
		isRecord(policy.default) ? { toolCalls: policy.default.toolCalls, readReserve: policy.default.readReserve } : null,
	);
	const maximum = retiredPhase(policy.maximum);
	const effectivePhase = retiredPhase({ toolCalls: effective.toolCalls, readReserve: effective.readReserve });
	if (
		defaultPhase === null ||
		maximum === null ||
		effectivePhase === null ||
		!isRecord(policy.default) ||
		typeof policy.default.synthesis !== "boolean" ||
		typeof effective.synthesis !== "boolean" ||
		!retiredInteger(effective.hardCap) ||
		(effective.mode !== undefined && effective.mode !== "advisory" && effective.mode !== "enforced") ||
		(effective.ceiling !== undefined && !retiredInteger(effective.ceiling)) ||
		!Array.isArray(value.reasons)
	)
		return undefined;
	const revision = effective.revision === undefined ? undefined : retiredPhase(effective.revision);
	if (revision === null) return undefined;
	let request: RetiredRunToolBudgetEnvelope["request"] = null;
	if (value.request !== null) {
		if (!isRecord(value.request)) return undefined;
		const phase = retiredPhase({ toolCalls: value.request.toolCalls, readReserve: value.request.readReserve });
		const retryRevision =
			value.request.retryRevision === undefined ? undefined : retiredPhase(value.request.retryRevision);
		if (phase === null || retryRevision === null) return undefined;
		request = { ...phase, ...(retryRevision === undefined ? {} : { retryRevision }) };
	}
	const reasons: { code: string; detail: string }[] = [];
	for (const reason of value.reasons) {
		if (
			!isRecord(reason) ||
			typeof reason.code !== "string" ||
			!RETIRED_BUDGET_REASON_CODES.has(reason.code) ||
			typeof reason.detail !== "string"
		)
			return undefined;
		reasons.push({ code: reason.code, detail: reason.detail });
	}
	// The oldest records carry no enforcement block; they ran native and enforced.
	const recorded = value.enforcement;
	const enforcement: RetiredRunToolBudgetEnvelope["enforcement"] | null =
		recorded === undefined
			? { classification: "native-per-tool", perTool: "enforced", clioControls: [] }
			: isRecord(recorded) &&
					(recorded.classification === "native-per-tool" || recorded.classification === "external-one-shot") &&
					(recorded.perTool === "enforced" ||
						recorded.perTool === "advisory" ||
						recorded.perTool === "unobserved-not-enforced") &&
					Array.isArray(recorded.clioControls) &&
					recorded.clioControls.every((control) => typeof control === "string")
				? {
						classification: recorded.classification,
						perTool: recorded.perTool,
						clioControls: [...(recorded.clioControls as string[])],
					}
				: null;
	if (enforcement === null) return undefined;
	return structuredClone({
		version: 1,
		enforcement,
		policy: {
			recipeId: policy.recipeId,
			default: { ...defaultPhase, synthesis: policy.default.synthesis },
			maximum,
			exact: policy.exact,
		},
		request,
		effective: {
			...(effective.mode === undefined ? {} : { mode: effective.mode }),
			...effectivePhase,
			synthesis: effective.synthesis,
			hardCap: effective.hardCap,
			...(effective.ceiling === undefined ? {} : { ceiling: effective.ceiling as number }),
			...(revision === undefined ? {} : { revision }),
		},
		reasons,
	});
}

/**
 * Read an envelope from immutable run history (a journal). The current shape comes first; a pre-M12 envelope is
 * returned as recorded, for display only. Live input never takes this path: it reads through
 * {@link cloneRunToolBudgetEnvelope}, which refuses the retired shape.
 */
export function readRecordedBudgetEnvelope(value: unknown): RecordedRunToolBudgetEnvelope | undefined {
	return cloneRunToolBudgetEnvelope(value) ?? cloneRetiredBudgetEnvelope(value);
}

/** The advisory ceiling a pre-M12 run derived from its recorded policy; an enforced run stops at its cap. */
function retiredWorkerBudget(envelope: RetiredRunToolBudgetEnvelope): RetiredRunToolBudgetEnvelope["effective"] {
	const effective = envelope.effective;
	if (effective.mode !== "advisory") return effective;
	const floor = Math.max(effective.toolCalls, effective.revision?.toolCalls ?? 0);
	const limit = envelope.policy.exact
		? effective.hardCap
		: Math.min(envelope.policy.maximum.toolCalls, effective.hardCap);
	return { ...effective, ceiling: Math.max(floor, limit) };
}

/** The recipe-policy words a pre-M12 run was shown, from its recorded envelope. */
function retiredBudgetPolicy(envelope: RetiredRunToolBudgetEnvelope): string {
	const policy = envelope.policy;
	if (envelope.effective.mode === "advisory")
		return `${policy.recipeId} advisory default ${policy.default.toolCalls}/${policy.default.readReserve}, recommended max ${policy.maximum.toolCalls}/${policy.maximum.readReserve}`;
	const range = policy.exact
		? `exact ${policy.default.toolCalls}/${policy.default.readReserve}`
		: `default ${policy.default.toolCalls}/${policy.default.readReserve}, max ${policy.maximum.toolCalls}/${policy.maximum.readReserve}`;
	const allowance = envelope.reasons.some((reason) => reason.code === "read-only-research-synthesis")
		? envelope.effective
		: undefined;
	if (allowance !== undefined && allowance.toolCalls !== policy.default.toolCalls) {
		const authored = policy.exact
			? `recipe default ${policy.default.toolCalls}/${policy.default.readReserve}`
			: `recipe ${range}`;
		return `${policy.recipeId} ${authored}; read-only research allowance ${allowance.toolCalls}/${allowance.readReserve}, synthesis=${policy.default.synthesis ? "on" : "off"}`;
	}
	return `${policy.recipeId} ${range}, synthesis=${policy.default.synthesis ? "on" : "off"}`;
}

/** The request words a pre-M12 run was shown, from its recorded envelope. */
function retiredBudgetRequest(envelope: RetiredRunToolBudgetEnvelope): string {
	const request = envelope.request;
	if (request === null) return "recipe default";
	const ceiling = request.retryRevision;
	if (envelope.effective.mode === "advisory")
		return `${request.toolCalls}/${request.readReserve} advisory${ceiling ? `, retry/revision estimate ${ceiling.toolCalls}/${ceiling.readReserve}` : ""}`;
	return ceiling === undefined
		? `${request.toolCalls}/${request.readReserve}, no retry/revision growth`
		: `${request.toolCalls}/${request.readReserve}, retry/revision ceiling ${ceiling.toolCalls}/${ceiling.readReserve}`;
}

/** The effective-envelope words a pre-M12 run was shown, from its recorded envelope. */
function retiredEffectiveBudget(envelope: RetiredRunToolBudgetEnvelope): string {
	const budget = envelope.effective;
	const revision = budget.revision
		? `, result revision ${budget.revision.toolCalls}/${budget.revision.readReserve}`
		: "";
	const enforcement =
		envelope.enforcement.classification === "external-one-shot"
			? "external one-shot; per-tool unobserved/not enforced"
			: envelope.enforcement.perTool === "advisory"
				? "native per-tool observed/advisory"
				: "native per-tool enforced";
	return `${budget.toolCalls}/${budget.readReserve}${revision}, ${budget.mode === "advisory" ? "advisory baseline" : "lifetime cap"} ${budget.hardCap}${budget.ceiling === undefined ? "" : `, worker ceiling ${budget.ceiling}`}, synthesis=${budget.synthesis ? "on" : "off"}; ${enforcement}`;
}

/** The limit words a pre-M12 run was shown, from its recorded envelope. */
function retiredBudgetLimitWords(envelope: RetiredRunToolBudgetEnvelope): string {
	const budget = retiredWorkerBudget(envelope);
	const advisory = budget.mode === "advisory";
	const revision = budget.revision;
	const notes = [
		...(envelope.reasons.some((reason) => reason.code === "global-cap-clamp")
			? ["lowered to CLIO Coder's overall limit"]
			: []),
		...(revision === undefined
			? []
			: [
					revision.toolCalls > budget.toolCalls
						? `about ${revision.toolCalls} if it has to redo its answer`
						: "more reads if it has to redo its answer",
				]),
	];
	const stop = advisory ? (budget.ceiling ?? budget.hardCap) : budget.hardCap;
	const limit =
		advisory && budget.toolCalls === stop
			? `CLIO Coder stops it at ${stop} tool calls`
			: advisory
				? `planned for about ${budget.toolCalls} tool calls; CLIO Coder stops it at ${stop}`
				: budget.synthesis
					? `answers after ${budget.toolCalls} tool calls; CLIO Coder stops it at ${budget.hardCap}`
					: `CLIO Coder stops it at ${budget.hardCap} tool calls`;
	return notes.length === 0 ? limit : `${limit} (${notes.join("; ")})`;
}
