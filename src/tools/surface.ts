/**
 * Tool placement: which registered tools carry an attached schema on every
 * turn (direct) and which are reached through the gateway's find/describe/call
 * results (gateway). One table for the builtins, one prefix rule for each
 * dynamic namespace, and the helpers every consumer of a placement decision
 * shares, so moving a tool between the two surfaces is a one-row edit here.
 *
 * Placement changes what the model sees, never what a call is allowed to do:
 * a capability behind the gateway runs through the same admission as a direct
 * call, under its own name and action class, and the ledger consumers unwrap
 * a gateway call back to that capability through {@link effectiveToolCall}.
 *
 * Pure module: no I/O, no registry construction. Imported by the prompt
 * compiler and by ledger consumers, so it depends on core/tool-names only.
 */

import {
	type BuiltinToolName,
	isBuiltinToolName,
	isHarnessExtensionToolName,
	isMcpToolName,
	type ToolName,
	ToolNames,
} from "../core/tool-names.js";

export type ToolPlacement = "direct" | "gateway";

/**
 * Builtin placement. Direct: the fundamental coding operations, context and
 * repository understanding, executable verification, the script runner, the
 * gateway itself, and the ORCHESTRATE and INTERACT planes (operator decision,
 * v0.4.9 handoff §5). Gateway: everything secondary, discovered on demand.
 */
export const TOOL_PLACEMENT: Readonly<Record<BuiltinToolName, ToolPlacement>> = {
	[ToolNames.Read]: "direct",
	[ToolNames.Evidence]: "gateway",
	[ToolNames.Grep]: "direct",
	[ToolNames.Find]: "direct",
	[ToolNames.Ls]: "direct",
	[ToolNames.CodeNav]: "direct",
	[ToolNames.Context]: "direct",
	[ToolNames.CredentialPresent]: "gateway",
	[ToolNames.ClioDocs]: "gateway",
	[ToolNames.ClioLibrary]: "gateway",
	[ToolNames.Data]: "gateway",
	[ToolNames.Write]: "direct",
	[ToolNames.Edit]: "direct",
	[ToolNames.Bash]: "direct",
	[ToolNames.Git]: "gateway",
	[ToolNames.Verify]: "direct",
	[ToolNames.RunScript]: "direct",
	[ToolNames.Dispatch]: "direct",
	[ToolNames.Monitor]: "direct",
	[ToolNames.Steer]: "direct",
	[ToolNames.Tasks]: "direct",
	[ToolNames.Ledger]: "direct",
	[ToolNames.Panes]: "direct",
	[ToolNames.Limitation]: "direct",
	[ToolNames.Decide]: "direct",
	[ToolNames.WebRead]: "gateway",
	[ToolNames.WebFetch]: "gateway",
	[ToolNames.AskUser]: "direct",
	[ToolNames.Artifact]: "gateway",
	[ToolNames.Gateway]: "direct",
};

/** Placement of a tool by name: the builtin table, then the dynamic namespaces. Unknown names are direct. */
export function toolPlacement(name: string): ToolPlacement {
	if (isBuiltinToolName(name as ToolName)) return TOOL_PLACEMENT[name as BuiltinToolName];
	if (isHarnessExtensionToolName(name) || isMcpToolName(name)) return "gateway";
	return "direct";
}

/** Placement of a registered spec: its explicit declaration wins, then the name rule. */
export function toolSpecPlacement(spec: { name: string; placement?: ToolPlacement }): ToolPlacement {
	return spec.placement ?? toolPlacement(spec.name);
}

function isGatewayPlacedToolName(name: string): boolean {
	return toolPlacement(name) === "gateway";
}

export type GatewayCapabilityKind = "builtin" | "extension" | "mcp";

/** Which namespace a gateway capability belongs to, for find listings and describe notes. */
export function gatewayCapabilityKind(name: string): GatewayCapabilityKind {
	if (isMcpToolName(name)) return "mcp";
	if (isHarnessExtensionToolName(name)) return "extension";
	return "builtin";
}

/**
 * Add `gateway` to a capability list that names any gateway-placed capability.
 * The dispatch admission filter and the worker's `effectiveToolNames` both
 * apply this rule to the same admitted list, which is what keeps the
 * orchestrator's approved tool signature equal to the one the worker attests.
 * A list that reaches nothing behind the gateway gains nothing.
 */
export function withGatewayForCapabilities(names: ReadonlyArray<ToolName>): ToolName[] {
	const out = [...new Set(names)];
	if (out.includes(ToolNames.Gateway)) return out;
	if (!out.some((name) => isGatewayPlacedToolName(name))) return out;
	out.push(ToolNames.Gateway);
	return out;
}

/**
 * The direct projection of a capability surface: the names that carry an
 * attached schema. Gateway-placed capabilities drop out and, when any was
 * present, `gateway` stands in for them. Used wherever a prompt or a display
 * lists "direct tools" from an admitted capability list.
 */
export function directSurfaceNames(names: ReadonlyArray<string>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	let reachesGateway = false;
	for (const name of names) {
		if (seen.has(name)) continue;
		seen.add(name);
		if (isGatewayPlacedToolName(name)) {
			reachesGateway = true;
			continue;
		}
		out.push(name);
	}
	if (reachesGateway && !out.includes(ToolNames.Gateway)) out.push(ToolNames.Gateway);
	return out;
}

export interface EffectiveToolCall {
	/** The capability that actually ran: the inner tool for a gateway call, the tool itself otherwise. */
	toolName: string;
	/** That capability's own arguments, when the record carried any. */
	args: Record<string, unknown> | undefined;
	/** True when the record was a gateway call unwrapped to its capability. */
	viaGateway: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Unwrap a ledger tool record to the capability it stands for. Every consumer
 * keyed on tool names (artifact folding, the read ledger, the path index,
 * mutation observers, evidence, transcript rendering) resolves the record
 * through this one helper so a `gateway` row never becomes an opaque "gateway
 * succeeded" entry that hides the artifact, git, or fetch it performed.
 *
 * The capability comes from the result details when they are present (the
 * gateway stamps `details.capability` on every call result) and from the
 * call arguments (`op: "call"`, `capability`) otherwise. Find and describe
 * records stay `gateway`.
 */
export function effectiveToolCall(toolName: string, args: unknown, details?: unknown): EffectiveToolCall {
	const record = isRecord(args) ? args : undefined;
	if (toolName !== ToolNames.Gateway) return { toolName, args: record, viaGateway: false };
	const fromDetails = isRecord(details) && typeof details.capability === "string" ? details.capability : null;
	const fromArgs = record?.op === "call" && typeof record.capability === "string" ? record.capability : null;
	const capability = (fromDetails ?? fromArgs)?.trim() ?? "";
	if (capability.length === 0 || capability === ToolNames.Gateway) return { toolName, args: record, viaGateway: false };
	return { toolName: capability, args: isRecord(record?.args) ? record.args : undefined, viaGateway: true };
}
