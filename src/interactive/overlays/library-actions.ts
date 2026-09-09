import { disablePlugin, enablePlugin, listInstalledPlugins } from "../../domains/plugins/index.js";
import {
	installLibraryPlan,
	type LibraryEntry,
	libraryEntryDrift,
	libraryEntryPin,
	pinLibraryEntry,
	planLibraryUpdate,
	releaseLibraryPlan,
	removeLibraryEntry,
} from "../../domains/resources/library.js";
import type { LibraryInstallConfirmSubject } from "./library-install-confirm.js";

export type LibraryAction = "update" | "remove" | "toggle" | "pin" | "drift";

/** Interactive actions use the same lifecycle and integrity functions as the CLI. */
export async function runLibraryAction(
	entry: LibraryEntry,
	action: LibraryAction,
	confirm: (subject: LibraryInstallConfirmSubject) => Promise<boolean>,
	options: { scope?: "user" | "project" } = {},
): Promise<string> {
	const installed = listInstalledPlugins(process.cwd(), { ...options, all: true })
		.filter((plugin) => plugin.id === entry.name && (plugin.kind ?? "plugin") === entry.kind)
		.sort((a, b) => Number(b.scope === "project") - Number(a.scope === "project"))[0];
	if (!installed) throw new Error(`plugin not installed: ${entry.name}`);
	const scoped = { cwd: process.cwd(), scope: installed.scope };
	if (action === "drift") return `${entry.name}: ${libraryEntryDrift(entry, scoped).status}`;
	if (action === "pin") return `${entry.name}: pinned ${pinLibraryEntry(entry, scoped).sha256}`;
	if (action === "toggle") {
		const result = (installed.enabled ? disablePlugin : enablePlugin)(entry.name, scoped);
		if (result.diagnostics.some((item) => item.type === "error"))
			throw new Error(result.diagnostics.map((item) => item.message).join("; "));
		return `${entry.name} (${installed.scope}): ${installed.enabled ? "disabled" : "enabled"}; use /library reload to refresh this session`;
	}
	if (action === "remove") {
		const pin = libraryEntryPin(entry, scoped);
		if (
			!(await confirm({
				action: "remove",
				entryRef: `${entry.kind}:${entry.name}`,
				writes: [{ ref: `${entry.kind}:${entry.name}`, path: installed.rootPath, sha256: pin?.sha256 ?? "unrecorded" }],
				requirements: [],
				satisfied: [],
			}))
		)
			return `${entry.name}: cancelled`;
		const result = removeLibraryEntry(entry, scoped);
		return `${entry.name} (${installed.scope}): removed${result.recovery ? `; recovery copies: ${JSON.stringify(result.recovery)}` : ""}; use /library reload to refresh this session`;
	}
	const plan = planLibraryUpdate(entry.name, scoped);
	try {
		if (
			!(await confirm({
				action: "update",
				entryRef: `${entry.kind}:${entry.name}`,
				writes: [
					{ ref: `${entry.kind}:${entry.name}`, path: plan.path, sha256: plan.sha256, sourceUrl: plan.entry.sourceUrl },
				],
				requirements: [],
				satisfied: [],
			}))
		)
			return `${entry.name}: cancelled`;
		installLibraryPlan(plan);
		return `${entry.name}: updated; use /library reload to refresh this session`;
	} finally {
		releaseLibraryPlan(plan);
	}
}
