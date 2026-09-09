import { existsSync } from "node:fs";
import { pluginLocalPath } from "../plugins/catalog.js";
import { listInstalledPlugins, type PluginScope, pluginResourcePath, readPluginManifest } from "../plugins/index.js";

/** Evals are explicit package data, never installation-time executable hooks. */
export function resolveLibraryEval(
	ref: string,
	name: string | undefined,
	options: { cwd?: string; scope?: PluginScope } = {},
) {
	const local = pluginLocalPath(ref, options.cwd);
	let root: string;
	if (existsSync(local)) root = local;
	else {
		const installed = listInstalledPlugins(options.cwd ?? process.cwd(), { ...options, all: true })
			.filter((item) => (ref.includes(":") ? `${item.kind ?? "plugin"}:${item.id}` === ref : item.id === ref))
			.sort((a, b) => Number(b.scope === "project") - Number(a.scope === "project"))[0];
		if (!installed?.loadable) throw new Error(`package is not active and verified: ${ref}`);
		root = installed.rootPath;
	}
	const candidate = readPluginManifest(root);
	if (!candidate.valid || !candidate.manifest)
		throw new Error(candidate.diagnostics.map((item) => item.message).join("; "));
	const evals = candidate.manifest.clio.evals ?? {};
	const names = Object.keys(evals);
	const selected = name ?? (names.length === 1 ? names[0] : undefined);
	const file = selected ? evals[selected] : undefined;
	if (!file) throw new Error(`select a declared package eval with --eval: ${names.join(", ") || "none declared"}`);
	return {
		path: pluginResourcePath(root, file),
		provenance: {
			package: `${candidate.manifest.clio.kind ?? "plugin"}:${candidate.manifest.name}`,
			version: candidate.manifest.version,
			sha256: candidate.contentDigest,
			eval: selected,
		},
	};
}
