import { closeSync, type Dirent, openSync, readdirSync, readSync } from "node:fs";
import path from "node:path";
import {
	listInstalledPlugins,
	pluginResourcePath,
	pluginSnapshotFor,
	readPluginInstallRecord,
} from "../../plugins/index.js";
import type { Skill } from "./loader.js";

export const PROJECT_SKILL_TRUST_REMEDY =
	"The operator must review and approve project plugins with clio-coder config trust plugins, then run /reload library. Do not ask for another activation choice or retry loading before trust is approved.";

const MEMBER_SCAN_DEPTH = 4;
const MEMBER_HEADER_BYTES = 4096;

/**
 * The name a member SKILL.md answers to: its frontmatter `name`, else its folder,
 * which is the loader's own rule. Only this name is read from the header.
 */
function memberSkillName(filePath: string): string {
	const folder = path.basename(path.dirname(filePath));
	try {
		const fd = openSync(filePath, "r");
		try {
			const buffer = Buffer.alloc(MEMBER_HEADER_BYTES);
			const header = buffer.toString("utf8", 0, readSync(fd, buffer, 0, MEMBER_HEADER_BYTES, 0));
			const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(header)?.[1] ?? "";
			return /^name:[ \t]*["']?([\w-]+)["']?[ \t]*$/m.exec(frontmatter)?.[1] ?? folder;
		} finally {
			closeSync(fd);
		}
	} catch {
		// An unreadable member still has its folder name, which is enough to say it needs attention.
		return folder;
	}
}

/**
 * Skills a package holds on disk whether or not it declared them. A package that
 * never loaded has no session record of its members, so without this a named load
 * of one reads as unknown. Symbolic links are not followed, because nobody has
 * reviewed this tree yet, and the names reach only refusal matching, never a prompt.
 */
function memberSkillNames(dir: string, depth = 0): string[] {
	if (depth > MEMBER_SCAN_DEPTH) return [];
	let entries: Dirent<string>[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		// A tree that cannot be read has no member names to offer; the package state reports the damage.
		return [];
	}
	if (entries.some((entry) => entry.name === "SKILL.md" && entry.isFile()))
		return [memberSkillName(path.join(dir, "SKILL.md"))];
	return entries
		.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
		.flatMap((entry) => memberSkillNames(path.join(dir, entry.name), depth + 1));
}

function undeclaredMembers(rootPath: string, skills: string | undefined): string[] {
	if (skills === undefined || skills === ".") return [];
	try {
		return memberSkillNames(pluginResourcePath(rootPath, skills));
	} catch {
		// An escaping resource path is an invalid package, which its state already reports.
		return [];
	}
}

/** Disk installation state, separate from the running session's resource snapshot. */
export function installedSkillPackages(skills: ReadonlyArray<Skill>, cwd: string, trustImports = false) {
	const snapshot = pluginSnapshotFor(cwd);
	return listInstalledPlugins(cwd, { all: true })
		.filter((pkg) => pkg.kind === "skill" || pkg.resources.skills)
		.map((pkg) => {
			const members = pkg.manifest?.clio.components.filter((item) => item.kind === "skill").map((item) => item.id) ?? [];
			const active = skills.some((skill) => {
				const relative = path.relative(pkg.rootPath, skill.filePath);
				return (
					skill.source === "plugin" &&
					relative !== ".." &&
					!relative.startsWith(`..${path.sep}`) &&
					!path.isAbsolute(relative)
				);
			});
			const names = [
				...new Set([
					...(pkg.kind === "skill" ? [pkg.id] : []),
					...members,
					...(active ? [] : undeclaredMembers(pkg.rootPath, pkg.resources.skills)),
				]),
			];
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
						: pkg.trustBlocked
							? "requires trust"
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
												: "pending reload; run /reload library";
			const record = readPluginInstallRecord(pkg.id, { cwd, scope: pkg.scope });
			const origin = typeof record?.origin === "object" ? record.origin.kind : (record?.origin ?? "local");
			return {
				name: pkg.id,
				names,
				scope: pkg.scope,
				state,
				origin,
				path: pkg.rootPath,
				...(pkg.trustBlocked ? { remedy: PROJECT_SKILL_TRUST_REMEDY } : {}),
			};
		});
}

/** Loose compatibility discoveries must never suppress a marketplace install offer. */
export function installedSkillNames(skills: ReadonlyArray<Skill>, cwd: string): Set<string> {
	return new Set([
		...skills.filter((skill) => skill.source === "clio-coder" || skill.source === "plugin").map((skill) => skill.name),
		...installedSkillPackages(skills, cwd).flatMap((pkg) => pkg.names),
	]);
}
