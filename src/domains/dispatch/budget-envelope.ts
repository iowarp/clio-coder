import type { WorkerBudget } from "../../worker/spec-contract.js";
import type { AgentBudget, AgentBudgetPhase } from "../agents/recipe.js";

/** Invocation-level phase requested by dispatch. */
export interface DispatchBudgetPhase {
	toolCalls: number;
	readReserve: number;
}

/** Typed invocation request. The ceiling preauthorizes growth on a later phase. */
export interface DispatchBudgetRequest extends DispatchBudgetPhase {
	retryRevision?: DispatchBudgetPhase;
}

export type BudgetEnvelopeReasonCode =
	| "global-cap-clamp"
	| "read-reserve-unavailable-clamp"
	| "read-reserve-cap-clamp"
	| "retry-growth-authorized"
	| "retry-growth-denied"
	| "revision-growth-authorized"
	| "revision-growth-denied";

export interface BudgetEnvelopeReason {
	code: BudgetEnvelopeReasonCode;
	detail: string;
}

export interface RunToolBudgetEnvelope {
	version: 1;
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

export type BudgetAdmissionDenialCode =
	| "exact-recipe-policy"
	| "recipe-maximum"
	| "global-cap"
	| "ceiling-below-request";

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
		if (key !== "toolCalls" && key !== "readReserve") throw new Error(`${prefix}.${key} is unknown`);
	}
	for (const key of ["toolCalls", "readReserve"] as const) {
		if (!Object.hasOwn(value, key)) throw new Error(`${prefix}.${key} is required`);
	}
	const toolCalls = value.toolCalls;
	if (typeof toolCalls !== "number" || !Number.isSafeInteger(toolCalls) || toolCalls <= 0) {
		throw new Error(`${prefix}.toolCalls must be a positive safe integer`);
	}
	const readReserve = value.readReserve;
	if (typeof readReserve !== "number" || !Number.isSafeInteger(readReserve) || readReserve < 0) {
		throw new Error(`${prefix}.readReserve must be a non-negative safe integer`);
	}
	if (readReserve >= toolCalls) throw new Error(`${prefix}.readReserve must be less than ${prefix}.toolCalls`);
	return { toolCalls, readReserve };
}

/** Strict validation and cloning for model, CLI, and persisted request inputs. */
export function cloneDispatchBudgetRequest(value: unknown, prefix = "budget"): DispatchBudgetRequest {
	if (!isRecord(value)) throw new Error(`${prefix} must be an object`);
	for (const key of Object.keys(value)) {
		if (key !== "toolCalls" && key !== "readReserve" && key !== "retryRevision") {
			throw new Error(`${prefix}.${key} is unknown`);
		}
	}
	const phase = clonePhase({ toolCalls: value.toolCalls, readReserve: value.readReserve }, prefix);
	const retryRevision =
		value.retryRevision === undefined ? undefined : clonePhase(value.retryRevision, `${prefix}.retryRevision`);
	return { ...phase, ...(retryRevision === undefined ? {} : { retryRevision }) };
}

function freezeEnvelope(envelope: RunToolBudgetEnvelope): RunToolBudgetEnvelope {
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

function phaseWithin(candidate: DispatchBudgetPhase, maximum: AgentBudgetPhase): boolean {
	return candidate.toolCalls <= maximum.toolCalls && candidate.readReserve <= maximum.readReserve;
}

function samePhase(left: DispatchBudgetPhase, right: AgentBudgetPhase): boolean {
	return left.toolCalls === right.toolCalls && left.readReserve === right.readReserve;
}

function assertRequestAdmitted(input: { request: DispatchBudgetRequest; policy: AgentBudget; hardCap: number }): void {
	const { request, policy, hardCap } = input;
	const authoredMaximum = policy.maximum ?? policy;
	if (policy.maximum === undefined && !samePhase(request, policy)) {
		throw new BudgetAdmissionError(
			"exact-recipe-policy",
			`the recipe pins ${policy.toolCalls} tool calls with a read reserve of ${policy.readReserve}`,
		);
	}
	if (!phaseWithin(request, authoredMaximum)) {
		throw new BudgetAdmissionError(
			"recipe-maximum",
			`the requested phase ${request.toolCalls}/${request.readReserve} exceeds recipe maximum ${authoredMaximum.toolCalls}/${authoredMaximum.readReserve}`,
		);
	}
	if (request.toolCalls > hardCap) {
		throw new BudgetAdmissionError(
			"global-cap",
			`the requested ${request.toolCalls} tool calls exceed the operator cap of ${hardCap}`,
		);
	}
	const ceiling = request.retryRevision;
	if (ceiling === undefined) return;
	if (ceiling.toolCalls < request.toolCalls || ceiling.readReserve < request.readReserve) {
		throw new BudgetAdmissionError(
			"ceiling-below-request",
			`retryRevision ${ceiling.toolCalls}/${ceiling.readReserve} must not be smaller than the requested phase ${request.toolCalls}/${request.readReserve}`,
		);
	}
	if (policy.maximum === undefined && !samePhase(ceiling, policy)) {
		throw new BudgetAdmissionError(
			"exact-recipe-policy",
			`the recipe pins ${policy.toolCalls} tool calls with a read reserve of ${policy.readReserve}`,
		);
	}
	if (!phaseWithin(ceiling, authoredMaximum)) {
		throw new BudgetAdmissionError(
			"recipe-maximum",
			`retryRevision ${ceiling.toolCalls}/${ceiling.readReserve} exceeds recipe maximum ${authoredMaximum.toolCalls}/${authoredMaximum.readReserve}`,
		);
	}
	if (ceiling.toolCalls > hardCap) {
		throw new BudgetAdmissionError(
			"global-cap",
			`retryRevision ${ceiling.toolCalls} exceeds the operator cap of ${hardCap}`,
		);
	}
}

export interface ResolveToolBudgetEnvelopeInput {
	recipeId: string;
	policy: AgentBudget;
	request?: DispatchBudgetRequest;
	hardCap: number;
	hasReadTool: boolean;
	retry: boolean;
	revision: boolean;
}

/** Resolve the one immutable envelope used by admission, enforcement, and evidence. */
export function resolveToolBudgetEnvelope(input: ResolveToolBudgetEnvelopeInput): RunToolBudgetEnvelope {
	if (!Number.isSafeInteger(input.hardCap) || input.hardCap <= 0) {
		throw new Error("dispatch: worker tool-call cap must be a positive safe integer");
	}
	if (input.request !== undefined)
		assertRequestAdmitted({ request: input.request, policy: input.policy, hardCap: input.hardCap });

	const request = input.request === undefined ? null : cloneDispatchBudgetRequest(input.request);
	const base = request ?? input.policy;
	const reasons: BudgetEnvelopeReason[] = [];
	let selected: DispatchBudgetPhase = base;
	const phaseKind = input.retry ? "retry" : input.revision ? "revision" : null;
	if (phaseKind !== null) {
		const ceiling = request?.retryRevision;
		if (ceiling !== undefined && !samePhase(ceiling, base)) {
			selected = ceiling;
			reasons.push({
				code: phaseKind === "retry" ? "retry-growth-authorized" : "revision-growth-authorized",
				detail: `${phaseKind} phase grew from ${base.toolCalls}/${base.readReserve} to the preauthorized ceiling ${ceiling.toolCalls}/${ceiling.readReserve}`,
			});
		} else {
			reasons.push({
				code: phaseKind === "retry" ? "retry-growth-denied" : "revision-growth-denied",
				detail:
					ceiling === undefined
						? `${phaseKind} phase retained ${base.toolCalls}/${base.readReserve} because the original request declared no ceiling`
						: `${phaseKind} phase retained ${base.toolCalls}/${base.readReserve} because the declared ceiling did not authorize growth`,
			});
		}
	}
	const revisionCeiling = phaseKind === null ? request?.retryRevision : undefined;
	if (revisionCeiling !== undefined && !samePhase(revisionCeiling, selected)) {
		reasons.push({
			code: "revision-growth-authorized",
			detail: `a result-contract revision may grow from ${selected.toolCalls}/${selected.readReserve} to the preauthorized ceiling ${revisionCeiling.toolCalls}/${revisionCeiling.readReserve}`,
		});
	}

	let toolCalls = selected.toolCalls;
	if (toolCalls > input.hardCap) {
		reasons.push({
			code: "global-cap-clamp",
			detail: `tool calls were clamped from ${toolCalls} to the operator cap of ${input.hardCap}`,
		});
		toolCalls = input.hardCap;
	}
	let readReserve = selected.readReserve;
	if (!input.hasReadTool && readReserve > 0) {
		reasons.push({
			code: "read-reserve-unavailable-clamp",
			detail: `read reserve was clamped from ${readReserve} to 0 because the read tool is unavailable`,
		});
		readReserve = 0;
	}
	const maximumEffectiveReserve = Math.max(0, toolCalls - 1);
	if (readReserve > maximumEffectiveReserve) {
		reasons.push({
			code: "read-reserve-cap-clamp",
			detail: `read reserve was clamped from ${readReserve} to ${maximumEffectiveReserve} after the tool-call cap`,
		});
		readReserve = maximumEffectiveReserve;
	}
	let effectiveRevision: DispatchBudgetPhase | undefined;
	if (revisionCeiling !== undefined && !samePhase(revisionCeiling, selected)) {
		let revisionReadReserve = revisionCeiling.readReserve;
		if (!input.hasReadTool && revisionReadReserve > 0) {
			reasons.push({
				code: "read-reserve-unavailable-clamp",
				detail: `result-contract revision read reserve was clamped from ${revisionReadReserve} to 0 because the read tool is unavailable`,
			});
			revisionReadReserve = 0;
		}
		effectiveRevision = { toolCalls: revisionCeiling.toolCalls, readReserve: revisionReadReserve };
	}

	const authoredMaximum = input.policy.maximum ?? input.policy;
	return freezeEnvelope({
		version: 1,
		policy: {
			recipeId: input.recipeId,
			default: {
				toolCalls: input.policy.toolCalls,
				readReserve: input.policy.readReserve,
				synthesis: input.policy.synthesis,
			},
			maximum: { toolCalls: authoredMaximum.toolCalls, readReserve: authoredMaximum.readReserve },
			exact: input.policy.maximum === undefined,
		},
		request,
		effective: {
			toolCalls,
			readReserve,
			synthesis: input.policy.synthesis,
			hardCap: input.hardCap,
			...(effectiveRevision === undefined ? {} : { revision: effectiveRevision }),
		},
		reasons,
	});
}

export function formatBudgetPolicy(envelope: RunToolBudgetEnvelope): string {
	const policy = envelope.policy;
	const range = policy.exact
		? `exact ${policy.default.toolCalls}/${policy.default.readReserve}`
		: `default ${policy.default.toolCalls}/${policy.default.readReserve}, max ${policy.maximum.toolCalls}/${policy.maximum.readReserve}`;
	return `${policy.recipeId} ${range}, synthesis=${policy.default.synthesis ? "on" : "off"}`;
}

export function formatBudgetRequest(envelope: RunToolBudgetEnvelope): string {
	const request = envelope.request;
	if (request === null) return "recipe default";
	const ceiling = request.retryRevision;
	return ceiling === undefined
		? `${request.toolCalls}/${request.readReserve}, no retry/revision growth`
		: `${request.toolCalls}/${request.readReserve}, retry/revision ceiling ${ceiling.toolCalls}/${ceiling.readReserve}`;
}

export function formatEffectiveBudget(envelope: RunToolBudgetEnvelope): string {
	const budget = envelope.effective;
	const revision = budget.revision
		? `, result revision ${budget.revision.toolCalls}/${budget.revision.readReserve}`
		: "";
	return `${budget.toolCalls}/${budget.readReserve}${revision}, lifetime cap ${budget.hardCap}, synthesis=${budget.synthesis ? "on" : "off"}`;
}

export function formatBudgetReasons(envelope: RunToolBudgetEnvelope): string {
	return envelope.reasons.length === 0 ? "none" : envelope.reasons.map((reason) => reason.code).join(",");
}

const BUDGET_REASON_CODES: ReadonlySet<string> = new Set<BudgetEnvelopeReasonCode>([
	"global-cap-clamp",
	"read-reserve-unavailable-clamp",
	"read-reserve-cap-clamp",
	"retry-growth-authorized",
	"retry-growth-denied",
	"revision-growth-authorized",
	"revision-growth-denied",
]);

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
		const defaultPhase = clonePhase(
			{ toolCalls: value.policy.default.toolCalls, readReserve: value.policy.default.readReserve },
			"budget.policy.default",
		);
		const maximum = clonePhase(value.policy.maximum, "budget.policy.maximum");
		const request = value.request === null ? null : cloneDispatchBudgetRequest(value.request);
		const effectivePhase = clonePhase(
			{ toolCalls: value.effective.toolCalls, readReserve: value.effective.readReserve },
			"budget.effective",
		);
		const revision =
			value.effective.revision === undefined
				? undefined
				: clonePhase(value.effective.revision, "budget.effective.revision");
		if (
			typeof value.effective.synthesis !== "boolean" ||
			typeof value.effective.hardCap !== "number" ||
			!Number.isSafeInteger(value.effective.hardCap) ||
			value.effective.hardCap <= 0 ||
			!Array.isArray(value.reasons)
		) {
			return undefined;
		}
		if (
			maximum.toolCalls < defaultPhase.toolCalls ||
			maximum.readReserve < defaultPhase.readReserve ||
			(value.policy.exact && !samePhase(maximum, defaultPhase)) ||
			effectivePhase.toolCalls > value.effective.hardCap ||
			value.effective.synthesis !== value.policy.default.synthesis ||
			(revision !== undefined &&
				(revision.toolCalls < effectivePhase.toolCalls ||
					revision.toolCalls > value.effective.hardCap ||
					(revision.toolCalls === effectivePhase.toolCalls && revision.readReserve <= effectivePhase.readReserve)))
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
		return freezeEnvelope({
			version: 1,
			policy: {
				recipeId,
				default: { ...defaultPhase, synthesis: value.policy.default.synthesis },
				maximum,
				exact: value.policy.exact,
			},
			request,
			effective: {
				...effectivePhase,
				synthesis: value.effective.synthesis,
				hardCap: value.effective.hardCap,
				...(revision === undefined ? {} : { revision }),
			},
			reasons,
		});
	} catch {
		return undefined;
	}
}
