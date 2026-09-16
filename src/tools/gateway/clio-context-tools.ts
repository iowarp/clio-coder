import { ToolNames } from "../../core/tool-names.js";
import type { LoadSkillsInput } from "../../domains/resources/index.js";
import { runDocsScope } from "../context/index.js";
import { OBSERVE_SELF_CAPS, observationBudgetExhausted, reserveObservation } from "../observation.js";
import type { ToolResult, ToolSpec } from "../registry.js";
import { clioDocsToolSurface, clioLibraryToolSurface } from "./clio-context-surface.js";

export { clioDocsToolSurface, clioLibraryToolSurface } from "./clio-context-surface.js";

/**
 * The two Clio-internal reads that left the permanent `context` schema:
 * `clio_docs` (bundled documentation) and `clio_library` (the recipe catalog).
 * Each is the former context scope under its own name, reusing the scope
 * function unchanged, so what the gateway returns is exactly what
 * context(scope="docs"|"library") returned.
 */

export function createClioDocsTool(): ToolSpec {
	return {
		...clioDocsToolSurface,
		async run(args, options): Promise<ToolResult> {
			const reservation = reserveObservation(OBSERVE_SELF_CAPS.contextDocs, options);
			if (reservation.exhausted) {
				return observationBudgetExhausted({
					tool: ToolNames.ClioDocs,
					unit: "sections",
					reservation,
					subject: typeof args.query === "string" && args.query.length > 0 ? `query=${args.query}` : "corpus",
					hint: "Continue in a follow-up turn.",
				});
			}
			return runDocsScope(args, reservation, options, ToolNames.ClioDocs);
		},
	};
}

export interface ClioLibraryToolDeps {
	getCwd?: () => string;
	/** False on every worker registry: the read refuses there, as the context scope did. */
	skillMarketplace?: boolean;
	getSkillLoaderOptions?: () => Pick<
		LoadSkillsInput,
		"trustProjectCompatRoots" | "disableDiscovery" | "explicitSkillPaths"
	>;
}

export function createClioLibraryTool(deps: ClioLibraryToolDeps = {}): ToolSpec {
	return {
		...clioLibraryToolSurface,
		async run(args, options): Promise<ToolResult> {
			// Reserved before the inventory is walked, so an exhausted pool answers
			// with the notice and no catalog read happens for nothing.
			const reservation = reserveObservation(OBSERVE_SELF_CAPS.contextLibrary, options);
			if (reservation.exhausted) {
				return observationBudgetExhausted({
					tool: ToolNames.ClioLibrary,
					unit: "entries",
					reservation,
					subject: "catalog",
					hint: "Continue in a follow-up turn.",
				});
			}
			const { runLibraryScope } = await import("../context/library.js");
			return runLibraryScope(
				{
					getCwd: () => deps.getCwd?.() ?? process.cwd(),
					...(deps.skillMarketplace !== undefined ? { skillMarketplace: deps.skillMarketplace } : {}),
					...(deps.getSkillLoaderOptions ? { skillLoaderOptions: deps.getSkillLoaderOptions() } : {}),
				},
				args,
				reservation,
				options,
				ToolNames.ClioLibrary,
			);
		},
	};
}
