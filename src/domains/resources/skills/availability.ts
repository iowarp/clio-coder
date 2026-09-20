import path from "node:path";
import { listInstalledPlugins, pluginSnapshotFor, readPluginInstallRecord } from "../../plugins/index.js";
import type { Skill } from "./loader.js";

/** Disk installation state, separate from the running session's resource snapshot. */
export function installedSkillPackages(skills: ReadonlyArray<Skill>, cwd: string, trustImports = false) {
	const snapshot = pluginSnapshotFor(cwd);
	return listInstalledPlugins(cwd, { all: true })
		.filter((pkg) => pkg.kind === "skill" || pkg.resources.skills)
		.map((pkg) => {
			const members = pkg.manifest?.clio.components.filter((item) => item.kind === "skill").map((item) => item.id) ?? [];
			const names = [...new Set([...(pkg.kind === "skill" ? [pkg.id] : []), ...members])];
			const active = skills.some((skill) => {
				const relative = path.relative(pkg.rootPath, skill.filePath);
				return (
					skill.source === "plugin" &&
					relative !== ".." &&
					!relative.startsWith(`..${path.sep}`) &&
					!path.isAbsolute(relative)
				);
			});
			const admitted = snapshot.resourceRoots.skills.some(
				(root) =>
					root.provenance.canonicalRoot === pkg.provenance?.canonicalRoot &&
					root.provenance.contentDigest === pkg.provenance?.contentDigest,
			);
			const state = !pkg.valid
				? "invalid"
				: !pkg.compatible
					? "incompatible"
					: !pkg.enabled
						? "disabled"
						: !pkg.effective
							? "shadowed"
							: !pkg.loadable
								? "damaged"
								: pkg.trust === "foreign" && !trustImports
									? "requires trust"
									: active
										? "ready"
										: admitted
											? "no ready skills; inspect /library"
											: "pending reload; run /library reload";
			const record = readPluginInstallRecord(pkg.id, { cwd, scope: pkg.scope });
			const origin = typeof record?.origin === "object" ? record.origin.kind : (record?.origin ?? "local");
			return { name: pkg.id, names, scope: pkg.scope, state, origin, path: pkg.rootPath };
		});
}

/** Loose compatibility discoveries must never suppress a marketplace install offer. */
export function installedSkillNames(skills: ReadonlyArray<Skill>, cwd: string): Set<string> {
	return new Set([
		...skills.filter((skill) => skill.source === "clio-coder" || skill.source === "plugin").map((skill) => skill.name),
		...installedSkillPackages(skills, cwd).flatMap((pkg) => pkg.names),
	]);
}
