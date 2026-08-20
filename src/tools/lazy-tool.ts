import { incompleteInstallationAdvice } from "../core/incomplete-installation.js";
import type { ToolResult, ToolSpec } from "./registry.js";

export type ToolSurface = Omit<ToolSpec, "run">;
export type ToolLoader = () => Promise<ToolSpec>;

function surfaceSnapshot(spec: ToolSurface | ToolSpec): string {
	return JSON.stringify({
		name: spec.name,
		description: spec.description,
		parameters: spec.parameters,
		baseActionClass: spec.baseActionClass,
		executionMode: spec.executionMode,
		prepareArguments: Boolean(spec.prepareArguments),
		prepareAdmissionArguments: Boolean(spec.prepareAdmissionArguments),
		disposeAdmissionArguments: Boolean(spec.disposeAdmissionArguments),
		describeDispatchPlan: Boolean(spec.describeDispatchPlan),
	});
}

function lazyLoadFailure(name: string, error: unknown): ToolResult {
	const advice = incompleteInstallationAdvice(error);
	return {
		kind: "error",
		message: advice ?? `${name}: implementation unavailable: ${error instanceof Error ? error.message : String(error)}`,
	};
}

/**
 * Register a complete immutable tool surface while deferring only its runner.
 * One promise owns first-use loading so parallel calls never evaluate a chunk
 * twice. A mismatched implementation is rejected before it can run: schemas,
 * action class, execution mode, and admission-hook posture may not drift from
 * the surface the model and policy engine already observed.
 */
export function lazyTool(surface: ToolSurface, load: ToolLoader): ToolSpec {
	const expected = surfaceSnapshot(surface);
	let loaded: Promise<ToolSpec> | null = null;
	const resolveImplementation = (): Promise<ToolSpec> => {
		loaded ??= load().then((spec) => {
			if (surfaceSnapshot(spec) !== expected) {
				throw new Error(`lazy tool surface drift for ${surface.name}`);
			}
			return spec;
		});
		return loaded;
	};
	return {
		...surface,
		async run(args, options): Promise<ToolResult> {
			let implementation: ToolSpec;
			try {
				implementation = await resolveImplementation();
			} catch (error) {
				return lazyLoadFailure(surface.name, error);
			}
			return implementation.run(args, options);
		},
	};
}
