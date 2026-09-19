import { homedir } from "node:os";
import path from "node:path";
import { canonicalizePath, canonicalizeRawPath, type PathWalkMemo } from "../../core/path-canonical.js";
import { ToolNames } from "../../core/tool-names.js";
import { clioConfigDir, clioStateDir } from "../../core/xdg.js";
import { expandPath, readPathVariants } from "../../tools/path-utils.js";
import { INTEROP_AGENT_KINDS } from "../interop/registry.js";
import { isSameOrDescendant } from "./path-policy.js";

/**
 * The read-class tools that take a path from the model. Each opens whatever
 * the path resolves to, so each is held to the workspace the same way.
 */
const READ_SCOPE_TOOLS: ReadonlySet<string> = new Set([ToolNames.Read, ToolNames.Ls, ToolNames.Grep, ToolNames.Find]);

export function isReadScopeTool(tool: string): boolean {
	return READ_SCOPE_TOOLS.has(tool);
}

export interface ReadScopeExemptRoot {
	path: string;
	/** True for a tree tools can never write (skill authority, foreign agent dirs). */
	operatorOwned: boolean;
}

/**
 * Trees outside the workspace that Clio itself points the model at: installed
 * skills, plugins, and extensions (a loaded SKILL.md names sibling files), the
 * user skill roots of the agents Clio interoperates with, the offload scratch
 * a truncation stub names, and dispatch receipts. They are operator-owned or
 * Clio-written, the model cannot author them, and zero-access entries still
 * apply inside them. Lexical on purpose: they are resolved again at every
 * admission, because an operator may replace a link after the session starts.
 */
export function readScopeExemptRoots(): ReadScopeExemptRoot[] {
	const roots: ReadScopeExemptRoot[] = [];
	try {
		const config = clioConfigDir();
		for (const kind of ["skills", "plugins", "extensions"]) {
			roots.push({ path: path.join(config, kind), operatorOwned: true });
		}
		const state = clioStateDir();
		roots.push({ path: path.join(state, "scratch"), operatorOwned: false });
		roots.push({ path: path.join(state, "receipts"), operatorOwned: false });
	} catch {
		// An unresolvable Clio home exempts nothing.
	}
	const home = homedir();
	for (const kind of INTEROP_AGENT_KINDS) {
		if (kind.userSkillRoot !== undefined) {
			roots.push({ path: path.join(home, kind.userSkillRoot), operatorOwned: true });
		}
	}
	return roots;
}

/**
 * Every spelling a read tool can open for one path argument, already expanded
 * the way the tool expands it and never to be expanded again (a fallback
 * carries the narrow no-break space that expansion folds away): the path as
 * given, then the fallbacks resolveReadPath tries on the resolved path when it
 * does not exist. A fallback can name a link the plain spelling does not, so
 * the path policy and the scope check judge each of them.
 */
export function readScopeSpellings(rawPath: string, callCwd: string): string[] {
	const expanded = expandPath(rawPath);
	const resolved = canonicalizeRawPath(expanded, callCwd) ?? path.resolve(callCwd, expanded);
	return [expanded, ...readPathVariants(resolved)];
}

function hasParentSegment(rawPath: string): boolean {
	return rawPath.split(/[\\/]/u).includes("..");
}

/**
 * Where a read-class path call lands when that is outside the workspace, or
 * null when it stays inside or inside an exempt root. The target is resolved
 * the way the read tools resolve it (resolveReadPath: physical, `link/..`
 * steps up from the link's target). A path that cannot be canonicalized is
 * outside: nothing proves where a read through it lands.
 *
 * An exempt root admits a target whose real path sits under the root's real
 * path. An operator-owned root also admits a path that, as written, has no
 * `..` and sits under the root as written: an operator may install one skill
 * as a link into a dotfiles tree, and what a tree no tool can write links to
 * is the operator's choice.
 */
export function readScopeEscape(
	rawPath: string,
	callCwd: string,
	workspace: string,
	exemptRoots: ReadonlyArray<ReadScopeExemptRoot>,
	memo: PathWalkMemo,
): string | null {
	for (const spelling of readScopeSpellings(rawPath, callCwd)) {
		const escaped = spellingEscape(spelling, callCwd, workspace, exemptRoots, memo);
		if (escaped !== null) return escaped;
	}
	return null;
}

function spellingEscape(
	expanded: string,
	callCwd: string,
	workspace: string,
	exemptRoots: ReadonlyArray<ReadScopeExemptRoot>,
	memo: PathWalkMemo,
): string | null {
	const physical = canonicalizeRawPath(expanded, callCwd, memo);
	if (physical !== null && isSameOrDescendant(physical, workspace)) return null;
	const lexical = path.resolve(callCwd, expanded);
	const lexicalEligible = !hasParentSegment(expanded);
	for (const root of exemptRoots) {
		if (root.operatorOwned && lexicalEligible && isSameOrDescendant(lexical, root.path)) return null;
		if (physical === null) continue;
		const realRoot = canonicalizePath(root.path, memo);
		if (realRoot !== null && isSameOrDescendant(physical, realRoot)) return null;
	}
	return physical ?? lexical;
}
