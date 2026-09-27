/**
 * The GUI's reading of a `gateway` call. The coordinator reaches most
 * capabilities through `gateway(op="call", capability, args)`, and several at
 * once through `gateway(op="chain", steps)`. A card names the capability that
 * ran, exactly as a direct call of it reads, and marks that it went through the
 * gateway; a chain lists each step on its own line.
 *
 * The ACP server already titles an op=call with its capability
 * (src/engine/acp/server.ts), but `rawInput` stays the wire arguments, so the
 * capability's own arguments are read from `rawInput.args` here. A replayed or
 * older item titled `gateway` is unwrapped the same way. The client cannot
 * import root `src/`, which holds the canonical unwrap (`src/tools/gateway-display.ts`);
 * this is its local mirror for the two shapes the wire carries.
 *
 * Pure: no React, no CSS, no API client.
 */

import type { TimelineItem } from "../../contracts/sessions.js";

const GATEWAY = "gateway";

export type ChainStepStatus = "done" | "failed" | "not run" | "planned";

export interface ChainStepView {
	readonly id: string;
	readonly capability: string;
	/** The arguments the step executed with once settled, the planned ones before. */
	readonly args: Record<string, unknown>;
	readonly status: ChainStepStatus;
}

export interface GatewayReading {
	/** The capability to present the call as; null keeps the item's own title. */
	readonly name: string | null;
	/** The arguments to read: the capability's own for op=call, the wire input otherwise. */
	readonly input: Record<string, unknown>;
	readonly viaGateway: boolean;
	/** Each step of a chain, settled ones first in the order they settled; null for anything else. */
	readonly steps: readonly ChainStepView[] | null;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** The planned steps of a chain's arguments. */
function plannedSteps(input: Record<string, unknown>): ChainStepView[] {
	if (!Array.isArray(input.steps)) return [];
	return input.steps.slice(0, 16).flatMap((entry): ChainStepView[] => {
		const step = record(entry);
		if (step === undefined || typeof step.id !== "string" || typeof step.capability !== "string") return [];
		return [{ id: step.id, capability: step.capability.trim(), args: record(step.args) ?? {}, status: "planned" }];
	});
}

/**
 * A chain's steps, from the settled result when the wire carried it and from
 * the planned arguments otherwise. A result the supervisor replaced with a
 * snippet carries no step results, so its steps stay `planned`.
 */
function chainSteps(input: Record<string, unknown>, rawOutput: unknown): ChainStepView[] {
	const planned = plannedSteps(input);
	const details = record(record(record(rawOutput)?.result)?.details);
	if (details?.op !== "chain" || !Array.isArray(details.chainResults)) return planned;
	const settled = details.chainResults.slice(0, 16).flatMap((entry): ChainStepView[] => {
		const child = record(entry);
		if (child === undefined || typeof child.id !== "string" || typeof child.capability !== "string") return [];
		return [
			{
				id: child.id,
				capability: child.capability,
				// A step whose `$from` binding failed never ran; it carries the
				// requested arguments instead of executed ones.
				args: record(child.args) ?? record(child.requestedArgs) ?? {},
				status: child.isError === true ? "failed" : "done",
			},
		];
	});
	const pending = new Set(
		Array.isArray(details.pending) ? details.pending.filter((id): id is string => typeof id === "string") : [],
	);
	const notRun = planned
		.filter((step) => pending.has(step.id))
		.map((step): ChainStepView => ({ ...step, status: "not run" }));
	return [...settled, ...notRun];
}

/** How a timeline item's gateway call reads, or the item unchanged when it is no gateway call. */
export function readGateway(item: Pick<TimelineItem, "title" | "rawInput" | "rawOutput">): GatewayReading {
	const input = record(item.rawInput) ?? {};
	const unchanged: GatewayReading = { name: null, input, viaGateway: false, steps: null };
	const capability = typeof input.capability === "string" ? input.capability.trim() : "";
	if (input.op === "call" && capability.length > 0 && capability !== GATEWAY) {
		// Only the gateway's own wire shape: a tool of another name whose
		// arguments happen to carry `op` and `capability` is left alone.
		if (item.title !== GATEWAY && item.title !== capability) return unchanged;
		return { name: capability, input: record(input.args) ?? {}, viaGateway: true, steps: null };
	}
	// ACP titles a live chain with its capabilities; replay may retain the wire name.
	if (input.op === "chain" && (item.title === GATEWAY || item.title?.startsWith("gateway chain(") === true)) {
		return { name: null, input, viaGateway: false, steps: chainSteps(input, item.rawOutput) };
	}
	return unchanged;
}
