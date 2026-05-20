import { homedir } from "node:os";
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
	pattern?: RegExp;
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

function expandTilde(rawPath: string): string {
	if (rawPath === "~") return homedir();
	if (rawPath.startsWith("~/")) return path.join(homedir(), rawPath.slice(2));
	return rawPath;
}

function normalizePolicyEntry(rawPath: string, root: string): string {
	const expanded = expandTilde(rawPath.trim());
	return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
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
			const entry: PathPolicyEntry = { kind, path: normalizePolicyEntry(trimmed, resolvedRoot), source: trimmed };
			const pattern = compilePathPattern(trimmed, resolvedRoot);
			if (pattern !== null) entry.pattern = pattern;
			entries.push(entry);
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
	const expanded = expandTilde(targetPath);
	const resolvedTarget = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
	const normalizedResolvedTarget = normalizeSeparators(resolvedTarget);
	const normalizedRelativeTarget = normalizeSeparators(path.relative(policy.root, resolvedTarget));
	const normalizedRawTarget = normalizeSeparators(targetPath);
	for (const entry of policy.entries) {
		if (!blocksOperation(entry.kind, operation)) continue;
		if (!matchesEntry(entry, resolvedTarget, normalizedResolvedTarget, normalizedRelativeTarget, normalizedRawTarget)) continue;
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

function matchesEntry(
	entry: PathPolicyEntry,
	resolvedTarget: string,
	normalizedResolvedTarget: string,
	normalizedRelativeTarget: string,
	normalizedRawTarget: string,
): boolean {
	if (isSameOrDescendant(resolvedTarget, entry.path)) return true;
	if (entry.pattern === undefined) return false;
	return (
		entry.pattern.test(normalizedResolvedTarget) ||
		entry.pattern.test(normalizedRelativeTarget) ||
		entry.pattern.test(normalizedRawTarget)
	);
}

function compilePathPattern(rawPath: string, root: string): RegExp | null {
	if (!rawPath.includes("*")) return null;
	const expanded = expandTilde(rawPath.trim());
	const source = path.isAbsolute(expanded) ? expanded : path.join(root, expanded);
	const normalized = normalizeSeparators(source);
	const relative = normalizeSeparators(path.isAbsolute(expanded) ? expanded : expanded);
	const absolutePattern = segmentPattern(normalized);
	const relativePattern = segmentPattern(relative);
	return new RegExp(`(?:${absolutePattern})|(?:${relativePattern})`);
}

function segmentPattern(rawPath: string): string {
	const escaped = rawPath
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("[^/]*");
	return `(?:^|/)${escaped}(?:$|/)`;
}

function normalizeSeparators(value: string): string {
	return value.split(path.sep).join("/");
}
