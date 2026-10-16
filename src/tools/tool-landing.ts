import { artifactDefaultPath } from "../core/artifact-paths.js";
import { canonicalizeRawPath } from "../core/path-canonical.js";
import { ToolNames } from "../core/tool-names.js";
import type { ToolCallLanding } from "../domains/middleware/index.js";
import { resolveMutationTarget, resolveReadTarget } from "./path-utils.js";

/** Tools that open their `path` for reading, through `resolveReadPath`; an absent path is the working directory. */
const READ_PATH_TOOLS: ReadonlySet<string> = new Set([ToolNames.Ls, ToolNames.Grep, ToolNames.Find]);
/** Tools that write their `path`, through `resolveMutationTarget`. */
const WRITE_PATH_TOOLS: ReadonlySet<string> = new Set([ToolNames.Write, ToolNames.Edit]);

/**
 * Where a path-taking tool lands its `path` argument, resolved by the same
 * functions the tool itself calls, so an extension hook judges the file the
 * tool opens: a leading `@` dropped, Unicode spaces made plain, `~` expanded
 * and every link followed, `..` after a link stepping up from its target.
 * `resolved` is false when that walk could not finish (a link loop, a
 * component that cannot be inspected); the tool then fails on `path`. A
 * `read` without a path opens nothing, so it has no landing. `artifact`
 * resolves against its own working directory (`artifactToolLanding`).
 */
export function pathToolLanding(
	tool: string,
	args: Readonly<Record<string, unknown>> | undefined,
): ToolCallLanding | null {
	const raw = typeof args?.path === "string" ? args.path : undefined;
	if (READ_PATH_TOOLS.has(tool) || (tool === ToolNames.Read && raw !== undefined && raw.length > 0)) {
		const target = resolveReadTarget(raw !== undefined && raw.length > 0 ? raw : ".");
		return { path: { arg: "path", path: target.path, resolved: target.physical !== undefined } };
	}
	if (WRITE_PATH_TOOLS.has(tool) && raw !== undefined) {
		const target = resolveMutationTarget(raw);
		return { path: { arg: "path", path: target.path, resolved: target.physical !== undefined } };
	}
	return null;
}

/**
 * Why a tool body refuses the path it resolved, or null. The awaited hooks
 * judged `landing` before the body ran; a link swapped meanwhile moves the
 * body's own resolution, and the body must not open a file no hook saw.
 * `opened` is the path the body is about to open, walked again here only
 * when a hook was shown a landing.
 */
export function hookLandingRefusal(
	tool: string,
	landing: ToolCallLanding | undefined,
	opened: string,
	cwd: string = process.cwd(),
): string | null {
	const judged = landing?.path;
	if (judged === undefined) return null;
	const now = canonicalizeRawPath(opened, cwd) ?? opened;
	if (now === judged.path) return null;
	return movedLanding(tool, now, judged.path);
}

function movedLanding(tool: string, now: string, judged: string): string {
	return `${tool}: path now lands at ${now}, not at ${judged} where its extension hooks judged it; refused`;
}

/**
 * The publish-seam check for a tool that writes through
 * `publishFileAtomically`, as its `admitTarget`. The entry check
 * (`hookLandingRefusal`) runs before the mutation queue and the tool's own
 * reads; a link swapped in meanwhile moves the physical publish target, so
 * that target is held to the hook-judged landing as well as to the write
 * roots. With neither a landing nor a write-root check there is nothing to
 * admit.
 */
export function publishTargetAdmission(
	tool: string,
	landing: ToolCallLanding | undefined,
	writeTargetViolation: ((target: string) => string | null) | undefined,
): ((target: string) => string | null) | undefined {
	const judged = landing?.path;
	if (judged === undefined && writeTargetViolation === undefined) return undefined;
	return (target) => {
		const outside = writeTargetViolation?.(target) ?? null;
		if (outside !== null) return `Refusing write outside the permitted write roots: ${outside}`;
		if (judged === undefined || target === judged.path) return null;
		return movedLanding(tool, target, judged.path);
	};
}

/** Where an `artifact` call lands, against the directory the tool itself writes under. */
export function artifactToolLanding(args: Readonly<Record<string, unknown>>, cwd: string): ToolCallLanding {
	const spelled =
		typeof args.path === "string" && args.path.trim().length > 0 ? args.path.trim() : artifactDefaultPath(args.kind);
	const target = resolveMutationTarget(spelled, cwd);
	return { path: { arg: "path", path: target.path, resolved: target.physical !== undefined } };
}
