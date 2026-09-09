import { disablePlugin, enablePlugin, listInstalledPlugins } from "../../domains/plugins/index.js";
import {
	installLibraryPlan,
	type LibraryEntry,
	libraryEntryDrift,
	libraryEntryPin,
	pinLibraryEntry,
	planPluginUpdate,
	releaseLibraryPlan,
	removeLibraryEntry,
} from "../../domains/resources/library.js";
import type { LibraryInstallConfirmSubject } from "./library-install-confirm.js";

export type PluginLibraryAction = "update" | "remove" | "toggle" | "pin" | "drift";

/** Interactive actions use the same lifecycle and integrity functions as the CLI. */
export async function runPluginLibraryAction(
	entry: LibraryEntry,
	action: PluginLibraryAction,
	confirm: (subject: LibraryInstallConfirmSubject) => Promise<boolean>,
): Promise<string> {
	if (entry.kind !== "plugin") throw new Error("this action requires a plugin");
	const installed = listInstalledPlugins(process.cwd()).find((plugin) => plugin.id === entry.name);
	if (!installed) throw new Error(`plugin not installed: ${entry.name}`);
	const options = { cwd: process.cwd(), scope: installed.scope };
	if (action === "drift") return `${entry.name}: ${libraryEntryDrift(entry, options).status}`;
	if (action === "pin") return `${entry.name}: pinned ${pinLibraryEntry(entry, options).sha256}`;
	if (action === "toggle") {
		const result = (installed.enabled ? disablePlugin : enablePlugin)(entry.name, options);
		if (result.diagnostics.some((item) => item.type === "error"))
			throw new Error(result.diagnostics.map((item) => item.message).join("; "));
		return `${entry.name} (${installed.scope}): ${installed.enabled ? "disabled" : "enabled"}; use /resources plugins reload to refresh this session`;
	}
	if (action === "remove") {
		const pin = libraryEntryPin(entry, options);
		if (
			!(await confirm({
				action: "remove",
				entryRef: `plugin:${entry.name}`,
				writes: [{ ref: `plugin:${entry.name}`, path: installed.rootPath, sha256: pin?.sha256 ?? "unrecorded" }],
				requirements: [],
				satisfied: [],
			}))
		)
			return `${entry.name}: cancelled`;
		const result = removeLibraryEntry(entry, options);
		return `${entry.name} (${installed.scope}): removed${result.recovery ? `; recovery copies: ${JSON.stringify(result.recovery)}` : ""}; use /resources plugins reload to refresh this session`;
	}
	const plan = planPluginUpdate(entry.name, options);
	try {
		if (
			!(await confirm({
				action: "update",
				entryRef: `plugin:${entry.name}`,
				writes: [{ ref: `plugin:${entry.name}`, path: plan.path, sha256: plan.sha256, sourceUrl: plan.entry.sourceUrl }],
				requirements: [],
				satisfied: [],
			}))
		)
			return `${entry.name}: cancelled`;
		installLibraryPlan(plan);
		return `${entry.name}: updated; use /resources plugins reload to refresh this session`;
	} finally {
		releaseLibraryPlan(plan);
	}
}
