import { homedir } from "node:os";
import path from "node:path";
import { canonicalizeExistingPath, canonicalizeRawPath } from "../../core/path-canonical.js";
import { clioConfigDir } from "../../core/xdg.js";
import { isSameOrDescendant, type PathPolicyOperation } from "./path-policy.js";
import { extractCommandCdTargets } from "./protected-artifacts.js";

/** Active Clio skill trees are operator-owned, independently of optional path
 * defaults. Keep lexical roots and resolve them again at admission: an operator
 * may install or replace a symlink after the session starts. Reads stay allowed.
 */
export function activeClioSkillRoots(cwd: string): string[] {
	return ["skills", "plugins", "extensions"].flatMap((kind) => [
		path.join(cwd, ".clio-coder", kind),
		path.join(clioConfigDir(), kind),
	]);
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
	// A shell cd is logical unless `-P` makes it physical, so both chains count.
	if (command !== null) {
		let logical = cwd;
		let physical = cwd;
		for (const destination of extractCommandCdTargets(command)) {
			const next = expandHome(destination);
			logical = path.resolve(logical, next);
			physical = canonicalizeRawPath(next, physical) ?? path.resolve(physical, next);
			workingDirs.push(logical);
			if (physical !== logical) workingDirs.push(physical);
		}
	}
	for (const target of targets) {
		if (target.operation === "read") continue;
		for (const directory of workingDirs) {
			const raw = expandHome(target.path);
			const lexical = path.resolve(directory, raw);
			// Physical, as the kernel resolves `link/..` in a write target.
			const resolved = canonicalizeRawPath(raw, directory) ?? canonicalizeExistingPath(lexical);
			for (const root of roots) {
				for (const boundary of [root, canonicalizeExistingPath(root)]) {
					for (const candidate of [lexical, resolved]) {
						if (
							isSameOrDescendant(candidate, boundary) ||
							(target.operation === "delete" && isSameOrDescendant(boundary, candidate))
						) {
							return `active resource tree ${root} is operator-owned; draft changes outside installed resource roots and use the operator install or update interface`;
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
