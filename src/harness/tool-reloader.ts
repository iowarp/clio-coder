import { pathToFileURL } from "node:url";
import type { ToolRegistry, ToolSpec } from "../tools/registry.js";
import { compileTool } from "./hot-compile.js";

export type ReloadResult = { kind: "ok"; name: string; elapsedMs: number } | { kind: "error"; error: string };

/**
 * Inspects the dynamic import result for a single property whose name ends
 * with "Tool" and whose value looks like a ToolSpec (has string name + fn run).
 */
function findToolExport(mod: Record<string, unknown>): ToolSpec | null {
	for (const [key, value] of Object.entries(mod)) {
		if (!key.endsWith("Tool")) continue;
		if (
			value &&
			typeof value === "object" &&
			typeof (value as { name?: unknown }).name === "string" &&
			typeof (value as { run?: unknown }).run === "function"
		) {
			return value as ToolSpec;
		}
	}
	return null;
}

/**
 * Compile a single src/tools/*.ts file, dynamic-import it, and re-register
 * the resulting tool spec on the live ToolRegistry. allowedModesByName is
 * captured once at boot from bootstrap.ts and preserved across reloads so
 * re-registration doesn't silently widen the mode visibility.
 */
export async function reloadToolFile(
	sourcePath: string,
	cacheRoot: string,
	registry: ToolRegistry,
	allowedModesByName: ReadonlyMap<string, ReadonlyArray<string>>,
): Promise<ReloadResult> {
	const started = Date.now();
	const compiled = await compileTool(sourcePath, cacheRoot);
	if (compiled.kind === "error") return compiled;

	let mod: Record<string, unknown>;
	try {
		mod = (await import(pathToFileURL(compiled.outputPath).href)) as Record<string, unknown>;
	} catch (err) {
		return { kind: "error", error: `import failed: ${err instanceof Error ? err.message : String(err)}` };
	}

	const spec = findToolExport(mod);
	if (!spec) {
		return { kind: "error", error: "no export ending in 'Tool' with a valid ToolSpec shape" };
	}

	const preservedModes = allowedModesByName.get(spec.name);
	const finalSpec: ToolSpec =
		preservedModes !== undefined ? ({ ...spec, allowedModes: preservedModes } as ToolSpec) : spec;
	registry.register(finalSpec);

	return { kind: "ok", name: spec.name, elapsedMs: Date.now() - started };
}
