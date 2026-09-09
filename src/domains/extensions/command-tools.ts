import type { DynamicToolName } from "../../core/tool-names.js";
import { extensionToolName } from "./command-schema.js";
import { listInstalledExtensions } from "./state.js";
import { isLoadableExtension } from "./types.js";

/** Available names for dispatch planning; registry construction re-verifies captured declarations. */
export function enabledHarnessExtensionToolNames(cwd = process.cwd()): ReadonlySet<DynamicToolName> {
	return new Set(
		listInstalledExtensions(cwd)
			.filter(isLoadableExtension)
			.flatMap((entry) =>
				(entry.capabilities?.tools ?? []).map((tool) => extensionToolName(entry.id, tool.name) as DynamicToolName),
			),
	);
}
