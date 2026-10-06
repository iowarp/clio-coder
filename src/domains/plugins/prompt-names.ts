import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { pluginResourcePath } from "./discovery.js";
import type { PluginManifest } from "./types.js";

/** Names from the same relative markdown paths the prompt loader uses; no bodies or host loaders. */
export function pluginPromptNames(root: string, manifest: PluginManifest): string[] {
	const declared = manifest.clio.resources.prompts;
	if (!declared) return [];
	const base = pluginResourcePath(root, declared);
	const pending = [base];
	const names: string[] = [];
	while (pending.length) {
		const directory = pending.pop();
		if (!directory || lstatSync(directory).isSymbolicLink()) continue;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const file = path.join(directory, entry.name);
			if (entry.isDirectory()) pending.push(file);
			else if (entry.isFile() && path.extname(file).toLowerCase() === ".md")
				names.push(path.relative(base, file).slice(0, -3).split(path.sep).join(":"));
		}
	}
	return names.sort();
}
