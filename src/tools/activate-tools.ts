import { Type } from "typebox";
import { grantToolActivation } from "../core/tool-activation.js";
import { ToolNames } from "../core/tool-names.js";
import { isToolPaletteGroup, TOOL_GROUPS } from "./palette.js";
import type { ToolResult, ToolSpec } from "./registry.js";

export interface ActivateToolsDeps {
	/**
	 * Agent Fleet roster, returned inline when a dispatch tool is granted.
	 * The prompt-level fleet block only renders on turns where dispatch was
	 * already active at compile time, so a mid-run delegate activation gets
	 * the roster just in time through the tool result instead.
	 */
	getAgentCatalog?: () => string;
}

/**
 * Model-driven escalation inside the deterministic session bound. The Tool
 * Catalog lists every tool the run could use; this tool attaches the schemas
 * for a named subset before the next step. It grants no permissions: every
 * activated tool still passes the safety classifier per call, and a request
 * outside the session policy (profile, worker admission, skill narrowing) is
 * rejected deterministically.
 */
export function createActivateToolsTool(deps: ActivateToolsDeps = {}): ToolSpec {
	return {
		name: ToolNames.ActivateTools,
		description:
			"Activate additional tools from the Tool Catalog for the rest of this run. Pass catalog group names (for example external, delegate, validate) and/or individual tool names. Schemas attach before your next step. Activation cannot exceed session policy and does not bypass safety confirmation for the activated tools.",
		parameters: Type.Object({
			groups: Type.Optional(
				Type.Array(Type.String(), {
					description: "Tool Catalog group names to activate, for example external, delegate, mutate, validate.",
				}),
			),
			tools: Type.Optional(Type.Array(Type.String(), { description: "Individual tool names from the Tool Catalog." })),
			reason: Type.String({ description: "One sentence: what the next step needs these tools for." }),
		}),
		baseActionClass: "read",
		executionMode: "sequential",
		async run(args, options): Promise<ToolResult> {
			const policy = options?.toolActivationPolicy;
			if (!policy) {
				return {
					kind: "error",
					message:
						"activate_tools: no activation policy is active in this run. This tool is only available to the main agent; workers receive their full tool surface at admission.",
				};
			}
			const reason = typeof args.reason === "string" ? args.reason.trim() : "";
			if (reason.length === 0) return { kind: "error", message: "activate_tools: missing reason" };

			const requested: string[] = [];
			const unknownGroups: string[] = [];
			if (Array.isArray(args.groups)) {
				for (const raw of args.groups) {
					if (typeof raw !== "string") continue;
					const group = raw.trim();
					if (group.length === 0) continue;
					if (!isToolPaletteGroup(group)) {
						unknownGroups.push(group);
						continue;
					}
					requested.push(...TOOL_GROUPS[group]);
				}
			}
			if (Array.isArray(args.tools)) {
				for (const raw of args.tools) {
					if (typeof raw === "string" && raw.trim().length > 0) requested.push(raw.trim());
				}
			}
			if (requested.length === 0 && unknownGroups.length === 0) {
				return { kind: "error", message: "activate_tools: pass at least one catalog group or tool name" };
			}

			const grant = grantToolActivation(policy, requested, reason);
			const lines: string[] = [];
			if (grant.granted.length > 0) {
				lines.push(`activated: ${grant.granted.join(", ")}. Schemas attach before your next step; use them directly.`);
			}
			if (grant.alreadyActive.length > 0) {
				lines.push(`already active: ${grant.alreadyActive.join(", ")}.`);
			}
			if (grant.rejected.length > 0) {
				lines.push(`outside session policy (not activatable this run): ${grant.rejected.join(", ")}.`);
			}
			if (unknownGroups.length > 0) {
				lines.push(`unknown catalog groups: ${unknownGroups.join(", ")}.`);
			}
			if (grant.granted.length === 0 && grant.alreadyActive.length === 0) {
				return { kind: "error", message: `activate_tools: nothing activated. ${lines.join(" ")}` };
			}
			const grantedDispatch = grant.granted.some(
				(name) => name === ToolNames.Dispatch || name === ToolNames.DispatchBatch,
			);
			if (grantedDispatch && deps.getAgentCatalog) {
				const catalog = deps.getAgentCatalog().trim();
				if (catalog.length > 0) lines.push("", "Agent Fleet:", catalog);
			}
			return {
				kind: "ok",
				output: lines.join("\n"),
				details: {
					reason,
					granted: [...grant.granted],
					alreadyActive: [...grant.alreadyActive],
					rejected: [...grant.rejected],
					...(unknownGroups.length > 0 ? { unknownGroups } : {}),
				},
			};
		},
	};
}
