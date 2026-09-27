/**
 * How a surface names a gateway call. The coordinator reaches most
 * capabilities through `gateway`, so engine events, ledger rows and assistant
 * tool-call blocks all say `gateway`. Every surface a person or an external
 * consumer reads (the TUI rows, the headless JSON stream, transcripts, traces,
 * the tree preview) names the capability instead, exactly as a direct call read
 * in v056, and marks that it went through the gateway. A chain keeps its own
 * `gateway` row and adds one child entry per settled step.
 *
 * This module only reads. Provider history and the persisted `tool_call` and
 * `tool_result` payloads keep the real wire name, because provider replay needs
 * it and the ledger consumers already unwrap through `effectiveToolCall`.
 *
 * Pure module: no I/O, no registry, no UI imports.
 */

import { ToolNames } from "../core/tool-names.js";
import { effectiveToolCall } from "./surface.js";

/** The marker every surface attaches to a call the gateway ran on the model's behalf. */
export const VIA_GATEWAY = "gateway" as const;

export interface DisplayToolCall {
	/** The capability that ran, or the tool itself for a direct call, a chain, find or describe. */
	toolName: string;
	/** That capability's own arguments; the wire arguments when nothing was unwrapped. */
	args: Record<string, unknown> | undefined;
	/** True when a gateway op=call was unwrapped to its capability. */
	viaGateway: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function detailsOf(result: unknown): Record<string, unknown> | undefined {
	return isRecord(result) && isRecord(result.details) ? result.details : undefined;
}

/**
 * Whether a gateway record is a chain, read from its arguments or from its
 * result details. A chain that loaded a skill stamps `capability: "context"`
 * on its aggregate details (gateway/chain.ts), which `effectiveToolCall` would
 * otherwise read as a context call.
 */
export function isGatewayChain(toolName: string, args: unknown, details?: unknown): boolean {
	if (toolName !== ToolNames.Gateway) return false;
	return (isRecord(args) && args.op === "chain") || (isRecord(details) && details.op === "chain");
}

/**
 * The call as a surface names it. A gateway op=call becomes its capability and
 * that capability's arguments; a chain, find and describe stay `gateway`.
 * `details` are the result details when the call has settled: they name the
 * capability even when the record carries no arguments.
 */
export function displayToolCall(toolName: string, args: unknown, details?: unknown): DisplayToolCall {
	if (isGatewayChain(toolName, args, details)) {
		return { toolName, args: isRecord(args) ? args : undefined, viaGateway: false };
	}
	return effectiveToolCall(toolName, args, details);
}

export interface GatewayChainStep {
	id: string;
	capability: string;
	/** The arguments the step executed with, after result bindings resolved. */
	args: Record<string, unknown>;
	isError: boolean;
	/** `{content, details}`: the step's bounded output and its own result details. */
	result: Record<string, unknown>;
	/** Registry admission for a step that reached it; absent when it failed before admission. */
	outcome?: "ok" | "error" | "blocked";
	decision?: string;
	actionClass?: string;
	blockReason?: string;
	terminate?: true;
	/** The chain cut this step's output to its share of the aggregate budget. */
	truncated?: true;
	/**
	 * The step's `$from` binding failed, so it never ran. `args` are then the
	 * step's requested arguments with their references unresolved, never
	 * arguments anything executed with.
	 */
	bindingError?: string;
}

/**
 * The settled steps of a chain aggregate result, in the order they settled.
 * Unlike `gatewayChainReceipts`, which counts admitted operations for
 * receipts, a display names every settled step, including one that failed
 * before admission (a bad binding, a rejected argument): the operator needs to
 * see it. Planned steps that never ran are not here; `gatewayChainPending`
 * names them.
 */
export function gatewayChainSteps(toolName: string, result: unknown): GatewayChainStep[] {
	const details = detailsOf(result);
	if (
		toolName !== ToolNames.Gateway ||
		details?.op !== "chain" ||
		(details.capability !== undefined && details.capability !== ToolNames.Context) ||
		!Array.isArray(details.chainResults)
	)
		return [];
	const cut = new Set(
		(Array.isArray(details.steps) ? details.steps : []).flatMap((row) =>
			isRecord(row) && row.truncated === true && typeof row.id === "string" ? [row.id] : [],
		),
	);
	return details.chainResults.slice(0, 16).flatMap((child): GatewayChainStep[] => {
		if (
			!isRecord(child) ||
			typeof child.id !== "string" ||
			typeof child.capability !== "string" ||
			child.capability === ToolNames.Gateway ||
			!isRecord(child.result)
		)
			return [];
		if (typeof child.bindingError === "string") {
			return [
				{
					id: child.id,
					capability: child.capability,
					args: isRecord(child.requestedArgs) ? child.requestedArgs : {},
					isError: true,
					result: child.result,
					bindingError: child.bindingError,
				},
			];
		}
		if (!isRecord(child.args)) return [];
		const childDetails = detailsOf(child.result);
		const admission = isRecord(childDetails?.chainAdmission) ? childDetails.chainAdmission : undefined;
		const outcome = admission?.outcome;
		return [
			{
				id: child.id,
				capability: child.capability,
				args: child.args,
				isError: child.isError === true || childDetails?.kind === "error",
				result: child.result,
				...(outcome === "ok" || outcome === "error" || outcome === "blocked" ? { outcome } : {}),
				...(typeof admission?.decision === "string" ? { decision: admission.decision } : {}),
				...(typeof admission?.actionClass === "string" ? { actionClass: admission.actionClass } : {}),
				...(typeof admission?.blockReason === "string" ? { blockReason: admission.blockReason } : {}),
				...(admission?.terminate === true ? { terminate: true as const } : {}),
				...(cut.has(child.id) ? { truncated: true as const } : {}),
			},
		];
	});
}

export interface PlannedChainStep {
	id: string;
	capability: string;
	args: Record<string, unknown>;
}

/** The steps a chain call asked for, from its arguments, for a row that has not settled yet. */
export function gatewayChainPlan(toolName: string, args: unknown): PlannedChainStep[] {
	if (!isGatewayChain(toolName, args) || !isRecord(args) || !Array.isArray(args.steps)) return [];
	return args.steps
		.slice(0, 16)
		.flatMap((step): PlannedChainStep[] =>
			isRecord(step) && typeof step.id === "string" && typeof step.capability === "string"
				? [{ id: step.id, capability: step.capability.trim(), args: isRecord(step.args) ? step.args : {} }]
				: [],
		);
}

/** Ids of the steps a settled chain never ran: a step failed, paused the chain, or ended the turn first. */
export function gatewayChainPending(result: unknown): string[] {
	const pending = detailsOf(result)?.pending;
	return Array.isArray(pending) ? pending.filter((id): id is string => typeof id === "string") : [];
}

/** The child tool-call id a surface gives a chain step, as the gateway numbers it for nested invocations. */
export function chainStepToolCallId(parentToolCallId: string, stepId: string): string {
	return `${parentToolCallId}:${stepId}`;
}
