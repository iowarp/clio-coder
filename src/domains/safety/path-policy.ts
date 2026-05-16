import path from "node:path";

export type PathPolicyKind = "zeroAccessPaths" | "readOnlyPaths" | "noDeletePaths";
export type PathPolicyOperation = "read" | "write" | "delete";

export interface PathPolicyInput {
	zeroAccessPaths?: ReadonlyArray<string>;
	readOnlyPaths?: ReadonlyArray<string>;
	noDeletePaths?: ReadonlyArray<string>;
}

export interface PathPolicyEntry {
	kind: PathPolicyKind;
	path: string;
	source: string;
}

export interface CompiledPathPolicy {
	root: string;
	entries: ReadonlyArray<PathPolicyEntry>;
	diagnostics: ReadonlyArray<string>;
}

export type PathPolicyDecision =
	| { kind: "allow" }
	| {
			kind: "block";
			reasonCode: `path-policy:${PathPolicyKind}`;
			reason: string;
			matchedPath: string;
			policyKind: PathPolicyKind;
	  };

const ORDERED_KINDS: readonly PathPolicyKind[] = ["zeroAccessPaths", "readOnlyPaths", "noDeletePaths"];

export function isSameOrDescendant(candidatePath: string, policyPath: string): boolean {
	const candidate = path.resolve(candidatePath);
	const policy = path.resolve(policyPath);
	const relative = path.relative(policy, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizePolicyEntry(rawPath: string, root: string): string {
	return path.resolve(root, rawPath.trim());
}

function blocksOperation(kind: PathPolicyKind, operation: PathPolicyOperation): boolean {
	if (kind === "zeroAccessPaths") return true;
	if (kind === "readOnlyPaths") return operation === "write" || operation === "delete";
	return operation === "delete";
}

export function compilePathPolicy(input: PathPolicyInput, root = process.cwd()): CompiledPathPolicy {
	const resolvedRoot = path.resolve(root);
	const entries: PathPolicyEntry[] = [];
	const diagnostics: string[] = [];
	for (const kind of ORDERED_KINDS) {
		for (const rawPath of input[kind] ?? []) {
			const trimmed = rawPath.trim();
			if (trimmed.length === 0) {
				diagnostics.push(`${kind}: path must not be empty`);
				continue;
			}
			entries.push({ kind, path: normalizePolicyEntry(trimmed, resolvedRoot), source: trimmed });
		}
	}
	return {
		root: resolvedRoot,
		entries: entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.path.localeCompare(b.path)),
		diagnostics,
	};
}

export function evaluatePathPolicy(
	policy: CompiledPathPolicy,
	operation: PathPolicyOperation,
	targetPath: string,
	cwd = policy.root,
): PathPolicyDecision {
	const resolvedTarget = path.resolve(cwd, targetPath);
	for (const entry of policy.entries) {
		if (!blocksOperation(entry.kind, operation)) continue;
		if (!isSameOrDescendant(resolvedTarget, entry.path)) continue;
		return {
			kind: "block",
			reasonCode: `path-policy:${entry.kind}`,
			reason: `${operation} denied by ${entry.kind} entry ${entry.source}`,
			matchedPath: entry.path,
			policyKind: entry.kind,
		};
	}
	return { kind: "allow" };
}
