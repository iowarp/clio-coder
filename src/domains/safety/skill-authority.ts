import { homedir } from "node:os";
import path from "node:path";
import { devRootsHeldByOthers } from "../../core/dev-roots.js";
import { canonicalizeExistingPath, canonicalizeRawPath, type PathWalkMemo } from "../../core/path-canonical.js";
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

/** Where one mutating path target can land, lexically and physically, from one possible working directory. */
export interface MutationCandidate {
	operation: PathPolicyOperation;
	lexical: string;
	resolved: string;
}

/**
 * Resolve every mutating target once per admission, so each authority check
 * that follows compares the same answers instead of walking the target again.
 */
export function mutationCandidates(
	targets: ReadonlyArray<{ operation: PathPolicyOperation; path: string }>,
	cwd: string,
	command: string | null,
	memo: PathWalkMemo,
): MutationCandidate[] {
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
			physical = canonicalizeRawPath(next, physical, memo) ?? path.resolve(physical, next);
			workingDirs.push(logical);
			if (physical !== logical) workingDirs.push(physical);
		}
	}
	const candidates: MutationCandidate[] = [];
	for (const target of targets) {
		if (target.operation === "read") continue;
		for (const directory of workingDirs) {
			const raw = expandHome(target.path);
			const lexical = path.resolve(directory, raw);
			// Physical, as the kernel resolves `link/..` in a write target.
			const resolved = canonicalizeRawPath(raw, directory, memo) ?? canonicalizeExistingPath(lexical, memo);
			candidates.push({ operation: target.operation, lexical, resolved });
		}
	}
	return candidates;
}

export function skillMutationReason(
	roots: ReadonlyArray<string>,
	candidates: ReadonlyArray<MutationCandidate>,
	memo: PathWalkMemo,
): string | null {
	// Each root resolves at most once per check, and only when a candidate
	// reaches it, in the order the candidates reach it.
	const boundaries: Array<readonly string[] | undefined> = [];
	for (const candidate of candidates) {
		for (const [index, root] of roots.entries()) {
			boundaries[index] ??= [root, canonicalizeExistingPath(root, memo)];
			for (const boundary of boundaries[index]) {
				for (const location of [candidate.lexical, candidate.resolved]) {
					if (
						isSameOrDescendant(location, boundary) ||
						(candidate.operation === "delete" && isSameOrDescendant(boundary, location))
					) {
						return `active resource tree ${root} is operator-owned; draft changes outside installed resource roots and use the operator install or update interface`;
					}
				}
			}
		}
	}
	return null;
}

/**
 * Dev extension folders another live session registered. The session that
 * registered a folder authors it; this one's model may not change it, whatever
 * the folder is named or where the operator pointed the session at it.
 */
export function foreignDevRootReason(candidates: ReadonlyArray<MutationCandidate>, memo: PathWalkMemo): string | null {
	const held = devRootsHeldByOthers();
	if (held.length === 0) return null;
	for (const candidate of candidates) {
		for (const { root, holder } of held) {
			const boundaries = [root, canonicalizeExistingPath(root, memo)];
			for (const boundary of boundaries) {
				for (const location of [candidate.lexical, candidate.resolved]) {
					if (
						isSameOrDescendant(location, boundary) ||
						(candidate.operation === "delete" && isSameOrDescendant(boundary, location))
					) {
						return `dev extension folder ${root} is registered to another session (pid ${holder.pid}); only that session develops it`;
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
