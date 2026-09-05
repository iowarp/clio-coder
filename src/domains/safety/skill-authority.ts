import { homedir } from "node:os";
import path from "node:path";
import { canonicalizeExistingPath } from "../../core/path-canonical.js";
import { clioConfigDir } from "../../core/xdg.js";
import { isSameOrDescendant, type PathPolicyOperation } from "./path-policy.js";
import { extractCommandCdTargets } from "./protected-artifacts.js";

/** Active Clio skill trees are operator-owned, independently of optional path
 * defaults. Keep lexical roots and resolve them again at admission: an operator
 * may install or replace a symlink after the session starts. Reads stay allowed.
 */
export function activeClioSkillRoots(cwd: string): string[] {
	return [path.join(cwd, ".clio-coder", "skills"), path.join(clioConfigDir(), "skills")];
}

export function skillMutationReason(
	roots: ReadonlyArray<string>,
	targets: ReadonlyArray<{ operation: PathPolicyOperation; path: string }>,
	cwd: string,
	command: string | null,
): string | null {
	const workingDirs = [cwd];
	// Existing shell inspection extracts literal path-bearing operations. Include
	// their possible cd bases so a visible cd cannot hide the protected target.
	// This deliberately cannot interpret arbitrary programs, variables or aliases.
	if (command !== null) {
		for (const destination of extractCommandCdTargets(command)) {
			workingDirs.push(path.resolve(workingDirs.at(-1) ?? cwd, expandHome(destination)));
		}
	}
	for (const target of targets) {
		if (target.operation === "read") continue;
		for (const directory of workingDirs) {
			const lexical = path.resolve(directory, expandHome(target.path));
			const resolved = canonicalizeExistingPath(lexical);
			for (const root of roots) {
				for (const boundary of [root, canonicalizeExistingPath(root)]) {
					for (const candidate of [lexical, resolved]) {
						if (
							isSameOrDescendant(candidate, boundary) ||
							(target.operation === "delete" && isSameOrDescendant(boundary, candidate))
						) {
							return `active skill tree ${root} is operator-owned; draft changes outside active skill roots and ask the operator to install or update them`;
						}
					}
				}
			}
		}
	}
	return null;
}

function expandHome(value: string): string {
	return value === "~" ? homedir() : value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
}
