import { isBuiltinToolName, type ToolName, ToolNames } from "../core/tool-names.js";
import { ALL_MODES, MODE_MATRIX, type ModeName } from "../domains/modes/matrix.js";
import { classify } from "../domains/safety/action-classifier.js";
import type { ToolSpec } from "./registry.js";

const SESSION_BOUND_TOOLS = new Set<ToolName>([ToolNames.WorkspaceContext]);

export interface BuiltinToolPolicyOptions {
	includeSessionTools?: boolean;
}

export function matrixModesForTool(tool: ToolName): ReadonlyArray<ModeName> {
	return ALL_MODES.filter((mode) => MODE_MATRIX[mode].tools.has(tool));
}

function sortedModes(modes: ReadonlyArray<ModeName>): string {
	return [...modes].sort().join(",");
}

function sameModes(left: ReadonlyArray<ModeName>, right: ReadonlyArray<ModeName>): boolean {
	return sortedModes(left) === sortedModes(right);
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

		if (!spec.allowedModes) {
			errors.push(`tool ${spec.name} must declare allowedModes explicitly`);
			continue;
		}
		const matrixModes = spec.bypassModeMatrix === true ? (spec.allowedModes ?? []) : matrixModesForTool(spec.name);
		if (!sameModes(spec.allowedModes, matrixModes)) {
			errors.push(
				`tool ${spec.name} allowedModes=${sortedModes(spec.allowedModes)} does not match MODE_MATRIX=${sortedModes(matrixModes)}`,
			);
		}

		const classified = classify({ tool: spec.name }).actionClass;
		if (classified !== spec.baseActionClass) {
			errors.push(`tool ${spec.name} baseActionClass=${spec.baseActionClass} but classifier returns ${classified}`);
		}

		for (const mode of matrixModes) {
			if (!MODE_MATRIX[mode].allowedActions.has(spec.baseActionClass)) {
				errors.push(`tool ${spec.name} is visible in mode ${mode} but action ${spec.baseActionClass} is not allowed`);
			}
		}
	}

	const includeSessionTools = options.includeSessionTools ?? false;
	const required = new Set<ToolName>();
	for (const mode of ALL_MODES) {
		for (const tool of MODE_MATRIX[mode].tools) {
			if (!includeSessionTools && SESSION_BOUND_TOOLS.has(tool)) continue;
			required.add(tool);
		}
	}
	for (const tool of required) {
		if (!registered.has(tool)) errors.push(`MODE_MATRIX references unregistered tool ${tool}`);
	}

	return errors;
}

export function assertBuiltinToolPolicy(specs: ReadonlyArray<ToolSpec>, options: BuiltinToolPolicyOptions = {}): void {
	const errors = validateBuiltinToolPolicy(specs, options);
	if (errors.length === 0) return;
	throw new Error(`tool policy drift:\n${errors.map((line) => `- ${line}`).join("\n")}`);
}
