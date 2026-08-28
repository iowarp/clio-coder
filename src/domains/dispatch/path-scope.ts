import { asDirectoryPathBoundary, pathBoundaryCovers, resolvePathBoundary } from "../../core/path-boundary.js";
import type { DispatchRequest } from "./contract.js";

/** Path-like tokens retained for requests that do not carry typed intent. */
const DISPATCH_PATH_TOKEN_RE = /(?:[\w.-]+\/)+[\w.-]+|\b[\w-]+\.[A-Za-z0-9]{1,8}\b/g;

export interface DispatchPathScope {
	source: "declared" | "inferred";
	workingContextPaths: ReadonlyArray<string>;
	writeBoundaries: ReadonlyArray<string>;
	inferredOnlyPaths: ReadonlyArray<string>;
}

export interface DeclaredScopeReplacementNotice {
	code: "typed_scope_replaced_inferred_paths";
	level: "warning";
	omittedPaths: ReadonlyArray<string>;
	message: string;
}

function inferredPaths(req: Pick<DispatchRequest, "task" | "briefing">): string[] {
	const paths = new Set<string>();
	const text = `${req.task}\n${req.briefing ?? ""}`;
	for (const match of text.matchAll(DISPATCH_PATH_TOKEN_RE)) {
		const token = match[0];
		if (token.startsWith("http://") || token.startsWith("https://")) continue;
		paths.add(token);
	}
	return [...paths];
}

function legacyWriteBoundaries(req: DispatchRequest, cwd: string): string[] {
	return (req.writeRoots ?? []).map((root) => asDirectoryPathBoundary(resolvePathBoundary(cwd, root)));
}

/** Resolve every policy-bearing path projection for one dispatch request. */
export function resolveDispatchPathScope(req: DispatchRequest): DispatchPathScope {
	const cwd = req.cwd ?? process.cwd();
	if (req.intent === undefined) {
		const workingContextPaths = new Set<string>(req.writeRoots ?? []);
		for (const path of inferredPaths(req)) workingContextPaths.add(path);
		return {
			source: "inferred",
			workingContextPaths: [...workingContextPaths],
			writeBoundaries: legacyWriteBoundaries(req, cwd),
			inferredOnlyPaths: [],
		};
	}

	const declaredPaths = [
		...new Set([...req.intent.readRoots, ...req.intent.writeRoots, ...req.intent.relevantPaths]),
	].sort();
	const inferredOnlyPaths = inferredPaths(req).filter((candidate) => !pathBoundaryCovers(declaredPaths, candidate));
	return {
		source: "declared",
		workingContextPaths: declaredPaths,
		writeBoundaries: req.intent.writeRoots.map((root) => resolvePathBoundary(cwd, root)),
		inferredOnlyPaths,
	};
}

/** Render the named diagnostic for the declared-scope replacement tradeoff. */
export function declaredScopeReplacementDiagnostic(scope: DispatchPathScope): string | null {
	if (scope.source !== "declared" || scope.inferredOnlyPaths.length === 0) return null;
	return `typed_scope_replaced_inferred_paths: typed intent omitted prose-inferred paths ${scope.inferredOnlyPaths.join(
		", ",
	)}; those paths did not select project rules or expand worker authority`;
}

/** Render the interactive warning for the declared-scope replacement tradeoff. */
export function declaredScopeReplacementNotice(scope: DispatchPathScope): DeclaredScopeReplacementNotice | null {
	if (scope.source !== "declared" || scope.inferredOnlyPaths.length === 0) return null;
	const omittedPaths = [...scope.inferredOnlyPaths];
	return {
		code: "typed_scope_replaced_inferred_paths",
		level: "warning",
		omittedPaths,
		message: `[dispatch scope] typed intent replaced prose path inference; omitted paths: ${omittedPaths.join(
			", ",
		)}. Those paths did not select project rules or expand worker authority.`,
	};
}
