import { type BuiltinToolName, isBuiltinToolName, type ToolName, ToolNames } from "../core/tool-names.js";
import { type ActionClass, classify } from "../domains/safety/action-classifier.js";
import { OBSERVATION_POLICY_SLACK_BYTES, OBSERVE_SELF_CAPS } from "./observation.js";
import { readMaxBytes } from "./read.js";
import type { ToolExecutionMode, ToolSpec } from "./registry.js";

/**
 * Surface invariants for the builtin toolkit. Asserted once at bootstrap so
 * drift between the plane design, the classifier, the metadata table, and the
 * registered specs fails loudly instead of shipping a surface that behaves
 * differently from what the policy engine assumes.
 */

export type ToolPlane = "observe" | "mutate" | "execute" | "orchestrate" | "retrieve" | "interact" | "artifact";

interface PlaneExpectation {
	plane: ToolPlane;
	actionClass: ActionClass;
	executionMode: ToolExecutionMode;
}

/** One row per registered tool: plane, action class, and concurrency rule. */
export const TOOL_PLANES: Readonly<Record<BuiltinToolName, PlaneExpectation>> = {
	[ToolNames.Read]: { plane: "observe", actionClass: "read", executionMode: "parallel" },
	[ToolNames.Grep]: { plane: "observe", actionClass: "read", executionMode: "parallel" },
	[ToolNames.Find]: { plane: "observe", actionClass: "read", executionMode: "parallel" },
	[ToolNames.Ls]: { plane: "observe", actionClass: "read", executionMode: "parallel" },
	[ToolNames.CodeNav]: { plane: "observe", actionClass: "read", executionMode: "parallel" },
	[ToolNames.Context]: { plane: "observe", actionClass: "read", executionMode: "parallel" },
	[ToolNames.CredentialPresent]: { plane: "observe", actionClass: "read", executionMode: "parallel" },
	[ToolNames.Write]: { plane: "mutate", actionClass: "write", executionMode: "sequential" },
	[ToolNames.Edit]: { plane: "mutate", actionClass: "write", executionMode: "sequential" },
	[ToolNames.Bash]: { plane: "execute", actionClass: "execute", executionMode: "sequential" },
	// git is read-only inspection on the safe-exec spine: EXECUTE plane for
	// its containment posture, read class for its safety disposition.
	[ToolNames.Git]: { plane: "execute", actionClass: "read", executionMode: "parallel" },
	[ToolNames.Verify]: { plane: "execute", actionClass: "execute", executionMode: "sequential" },
	[ToolNames.Dispatch]: { plane: "orchestrate", actionClass: "dispatch", executionMode: "sequential" },
	// monitor never mutates a run, so it stays read class and parallel.
	[ToolNames.Monitor]: { plane: "orchestrate", actionClass: "read", executionMode: "parallel" },
	[ToolNames.Steer]: { plane: "orchestrate", actionClass: "dispatch", executionMode: "sequential" },
	// tasks orchestrates the agent's own work rather than workers: read class
	// (session-ledger bookkeeping, no workspace mutation), sequential so two
	// board mutations in one batch never interleave.
	[ToolNames.Tasks]: { plane: "orchestrate", actionClass: "read", executionMode: "sequential" },
	[ToolNames.WebFetch]: { plane: "retrieve", actionClass: "read", executionMode: "parallel" },
	[ToolNames.AskUser]: { plane: "interact", actionClass: "read", executionMode: "sequential" },
	[ToolNames.Artifact]: { plane: "artifact", actionClass: "write", executionMode: "sequential" },
};

/**
 * OBSERVE envelope members and their self-caps. The registry policy cap must
 * sit at or above self cap + slack so the envelope's own notice line survives
 * the backstop. credential_present sits in the OBSERVE plane but returns a
 * typed boolean, so it carries no envelope cap.
 */
const OBSERVE_ENVELOPE_SELF_CAPS: ReadonlyArray<[BuiltinToolName, () => number]> = [
	[ToolNames.Read, () => readMaxBytes()],
	[ToolNames.Grep, () => OBSERVE_SELF_CAPS.grepContent],
	[ToolNames.Find, () => OBSERVE_SELF_CAPS.find],
	[ToolNames.Ls, () => OBSERVE_SELF_CAPS.ls],
	[ToolNames.CodeNav, () => OBSERVE_SELF_CAPS.codeNav],
	[
		ToolNames.Context,
		() => Math.max(OBSERVE_SELF_CAPS.contextDocs, OBSERVE_SELF_CAPS.contextSkills, OBSERVE_SELF_CAPS.contextWorkspace),
	],
];

const SESSION_BOUND_TOOLS = new Set<ToolName>([]);
const DISPATCH_BOUND_TOOLS = new Set<ToolName>([ToolNames.Dispatch, ToolNames.Monitor, ToolNames.Steer]);
const INTERACTIVE_BOUND_TOOLS = new Set<ToolName>([ToolNames.AskUser]);

export interface BuiltinToolPolicyOptions {
	includeSessionTools?: boolean;
	includeDispatchTools?: boolean;
	includeInteractiveTools?: boolean;
}

function validateBuiltinToolPolicy(specs: ReadonlyArray<ToolSpec>, options: BuiltinToolPolicyOptions = {}): string[] {
	const errors: string[] = [];
	const registered = new Map<ToolName, ToolSpec>();

	for (const spec of specs) {
		if (!isBuiltinToolName(spec.name)) {
			errors.push(`registered tool ${spec.name} is not in ToolNames`);
			continue;
		}
		registered.set(spec.name, spec);

		const expectation = TOOL_PLANES[spec.name];
		const classified = classify({ tool: spec.name }).actionClass;
		if (classified !== spec.baseActionClass) {
			errors.push(`tool ${spec.name} baseActionClass=${spec.baseActionClass} but classifier returns ${classified}`);
		}
		if (spec.baseActionClass !== expectation.actionClass) {
			errors.push(
				`tool ${spec.name} baseActionClass=${spec.baseActionClass} but plane ${expectation.plane} expects ${expectation.actionClass}`,
			);
		}
		if (spec.executionMode !== expectation.executionMode) {
			errors.push(
				`tool ${spec.name} executionMode=${spec.executionMode ?? "unset"} but plane ${expectation.plane} expects ${expectation.executionMode}`,
			);
		}
	}

	// Envelope caps: the registry backstop must never cut an envelope notice.
	for (const [tool, selfCap] of OBSERVE_ENVELOPE_SELF_CAPS) {
		const spec = registered.get(tool);
		if (!spec) continue;
		const policyCap = spec.metadata?.resultSizePolicy?.maxBytes ?? 0;
		const required = selfCap() + OBSERVATION_POLICY_SLACK_BYTES;
		if (policyCap < required) {
			errors.push(`tool ${tool} policy cap ${policyCap}B sits below self cap + slack (${required}B)`);
		}
	}

	const includeSessionTools = options.includeSessionTools ?? false;
	const includeDispatchTools = options.includeDispatchTools ?? false;
	const includeInteractiveTools = options.includeInteractiveTools ?? false;
	const required = new Set<ToolName>(Object.values(ToolNames));
	for (const tool of [...required]) {
		if (!includeSessionTools && SESSION_BOUND_TOOLS.has(tool)) required.delete(tool);
		if (!includeDispatchTools && DISPATCH_BOUND_TOOLS.has(tool)) required.delete(tool);
		if (!includeInteractiveTools && INTERACTIVE_BOUND_TOOLS.has(tool)) required.delete(tool);
	}
	for (const tool of required) {
		if (!registered.has(tool)) errors.push(`builtin tool ${tool} is not registered`);
	}

	return errors;
}

export function assertBuiltinToolPolicy(specs: ReadonlyArray<ToolSpec>, options: BuiltinToolPolicyOptions = {}): void {
	const errors = validateBuiltinToolPolicy(specs, options);
	if (errors.length === 0) return;
	throw new Error(`tool policy drift:\n${errors.map((line) => `- ${line}`).join("\n")}`);
}
