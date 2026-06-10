import { isBuiltinToolName, type ToolName, ToolNames } from "../core/tool-names.js";
import { classify } from "../domains/safety/action-classifier.js";
import type { ToolSpec } from "./registry.js";

const SESSION_BOUND_TOOLS = new Set<ToolName>([ToolNames.WorkspaceContext]);
const DISPATCH_BOUND_TOOLS = new Set<ToolName>([ToolNames.Dispatch, ToolNames.DispatchBatch]);
const INTERACTIVE_BOUND_TOOLS = new Set<ToolName>([ToolNames.AskUser]);

export interface BuiltinToolPolicyOptions {
	includeSessionTools?: boolean;
	includeDispatchTools?: boolean;
	includeInteractiveTools?: boolean;
}

export function validateBuiltinToolPolicy(
	specs: ReadonlyArray<ToolSpec>,
	options: BuiltinToolPolicyOptions = {},
): string[] {
	const errors: string[] = [];
	const registered = new Map<ToolName, ToolSpec>();

	for (const spec of specs) {
		if (!isBuiltinToolName(spec.name)) {
			errors.push(`registered tool ${spec.name} is not in ToolNames`);
			continue;
		}
		registered.set(spec.name, spec);

		const classified = classify({ tool: spec.name }).actionClass;
		if (classified !== spec.baseActionClass) {
			errors.push(`tool ${spec.name} baseActionClass=${spec.baseActionClass} but classifier returns ${classified}`);
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
