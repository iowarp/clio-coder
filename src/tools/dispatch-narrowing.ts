import { isDeepStrictEqual } from "node:util";
import { asDirectoryPathBoundary, resolvePathBoundary, writeRootsCover } from "../core/path-boundary.js";
import { canonicalizePath, createPathWalkMemo, type PathWalkMemo } from "../core/path-canonical.js";
import type { DispatchDerivedGrants, DispatchRequest } from "../domains/dispatch/contract.js";
import { dispatchIntentScopeWidening } from "../domains/dispatch/intent-compatibility.js";
import {
	DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT,
	type DispatchPlanTaskView,
	RESOLVED_DISPATCH_PLAN_ARGUMENT,
} from "./dispatch-plan.js";
import type { DispatchExecutionSnapshot, DispatchMode } from "./dispatch-types.js";

/**
 * Request fields a narrowing rewrite may change, each judged below. Every
 * other field must match exactly, so a field added later is held fixed until
 * someone decides how it narrows. The raw input check below holds the task
 * text and briefing to what the operator approved, so here they differ only
 * where the host re-rendered them from the narrowed intent. The context seed is
 * host-selected from the parent conversation by the intent's scope paths, so
 * it may differ only once those paths are shown not to widen (WX3).
 */
const JUDGED_REQUEST_FIELDS = new Set<string>([
	"task",
	"briefing",
	"intent",
	"writeRoots",
	"readOnly",
	"denyTools",
	"contextSeed",
]);

/**
 * Plan-view task fields the host re-renders from the narrowed intent. Every
 * other field must match, so host-derived fields re-planned for the rewrite
 * (agentDecision, routingIntent, a field added later) cannot drift (WX3). The
 * worker context provenance follows the seed readScopeHolds bounds, and
 * routeApproval is judged by routeApprovalNarrows.
 */
const INTENT_DERIVED_TASK_FIELDS = new Set<string>(["task", "briefing", "intent", "workerContext", "routeApproval"]);

/** Plan-view fields rendered from the tasks; every other plan-level field must match. */
const RENDERED_PLAN_FIELDS = new Set<string>(["tasks", "text", "hash"]);

const fieldsExcept = (value: object, excluded: ReadonlySet<string>): Record<string, unknown> =>
	Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.has(key)));

/** The same route decision under bounds that stay equal or shrink. */
function routeApprovalNarrows(
	original: DispatchPlanTaskView["routeApproval"],
	rewritten: DispatchPlanTaskView["routeApproval"],
): boolean {
	if (original === null || rewritten === null) return original === rewritten;
	if (original.version !== rewritten.version || !isDeepStrictEqual(original.decision, rewritten.decision)) return false;
	if (original.deadlineMs !== null && (rewritten.deadlineMs === null || rewritten.deadlineMs > original.deadlineMs))
		return false;
	return (
		rewritten.totalCostUpperBoundUsd <= original.totalCostUpperBoundUsd && rewritten.maxAttempts <= original.maxAttempts
	);
}

function taskViewNarrows(original: DispatchPlanTaskView, rewritten: DispatchPlanTaskView): boolean {
	return (
		isDeepStrictEqual(
			fieldsExcept(original, INTENT_DERIVED_TASK_FIELDS),
			fieldsExcept(rewritten, INTENT_DERIVED_TASK_FIELDS),
		) && routeApprovalNarrows(original.routeApproval, rewritten.routeApproval)
	);
}

/**
 * The roots enforcement confines the worker to. With an intent that is
 * intent.writeRoots (path-scope.ts), while request.writeRoots can hold a
 * legacy `writeRoots: []` argument that would read a confined task as
 * unrestricted (WX4). Only a legacy request with no intent uses request.writeRoots.
 */
const effectiveWriteRoots = (request: DispatchRequest): ReadonlyArray<string> =>
	request.intent !== undefined ? request.intent.writeRoots : (request.writeRoots ?? []);

/**
 * A write root where enforcement places it: resolved against the request cwd
 * and then through every link, the way policy-engine.ts physicalWriteRoots
 * does. A root that does not exist yet resolves from its deepest existing
 * ancestor. Null when the walk cannot finish.
 */
function physicalWriteRoot(cwd: string, root: string, memo: PathWalkMemo): string | null {
	const boundary = resolvePathBoundary(cwd, root);
	const directory = boundary.endsWith("/");
	const resolved = canonicalizePath(directory ? boundary.slice(0, -1) : boundary, memo);
	if (resolved === null) return null;
	return directory ? asDirectoryPathBoundary(resolved) : resolved;
}

const fixedFields = (request: DispatchRequest): Record<string, unknown> =>
	Object.fromEntries(Object.entries(request).filter(([key]) => !JUDGED_REQUEST_FIELDS.has(key)));

const scopePaths = (intent: NonNullable<DispatchRequest["intent"]>): number =>
	intent.readRoots.length + intent.writeRoots.length + intent.relevantPaths.length;

/**
 * Whether the rewritten seed hands the worker nothing the approved seed did not:
 * the same snapshot and mode, and for a splice only refs the approved splice
 * selected. This is what reaches the worker, so it bounds the seed whatever
 * scope paths picked it (WX4).
 */
function contextSeedHolds(
	original: DispatchRequest["contextSeed"],
	rewritten: DispatchRequest["contextSeed"],
): boolean {
	if (rewritten === undefined) return true;
	if (original === undefined) return false;
	const approved = original.provenance;
	const next = rewritten.provenance;
	if (approved.mode !== next.mode || approved.snapshotHash !== next.snapshotHash) return false;
	const approvedRefs = new Set(approved.selectedRefs);
	return next.selectedRefs.every((ref) => approvedRefs.has(ref));
}

/**
 * Whether the rewritten intent reads no more than the approved one. Read roots
 * and relevant paths pick the context seed spliced into the worker prompt, so a
 * rewrite naming `.env` would carry the approval onto results the operator
 * never saw (WX3). An unscoped original has no ceiling to check paths against,
 * so its seed must stay exactly as approved.
 */
function readScopeHolds(original: DispatchRequest, rewritten: DispatchRequest): boolean {
	// The seed is what reaches the worker, so it is bounded whether or not
	// either side has an intent (WX4).
	if (!contextSeedHolds(original.contextSeed, rewritten.contextSeed)) return false;
	if (original.intent === undefined) {
		// An unscoped original may gain only the write roots that confine it.
		// Expected outputs, read roots and relevant paths each choose seed refs or
		// what the result must hold, and nothing approved bounds them (WX4).
		const added = rewritten.intent;
		if (
			added !== undefined &&
			(added.expectedOutputs.length > 0 || added.readRoots.length > 0 || added.relevantPaths.length > 0)
		)
			return false;
		return isDeepStrictEqual(original.contextSeed, rewritten.contextSeed);
	}
	if (rewritten.intent === undefined) return false;
	// The splice reads no scope paths as every parent observation being relevant,
	// so emptying a scoped intent widens the seed to the whole session (WX4).
	if (scopePaths(original.intent) > 0 && scopePaths(rewritten.intent) === 0) return false;
	if (dispatchIntentScopeWidening(original.intent, rewritten.intent) !== null) return false;
	const approvedOutputs = new Set(original.intent.expectedOutputs);
	return rewritten.intent.expectedOutputs.every((output) => approvedOutputs.has(output));
}

/** Two root lists that name the same roots, in any order. */
const sameRoots = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
	isDeepStrictEqual([...new Set(left)].sort(), [...new Set(right)].sort());

function requestNarrows(original: DispatchRequest, rewritten: DispatchRequest, mode: DispatchMode): boolean {
	if (!isDeepStrictEqual(fixedFields(original), fixedFields(rewritten))) return false;
	if (!readScopeHolds(original, rewritten)) return false;
	if (original.readOnly === true && rewritten.readOnly !== true) return false;
	// Fewer denied tools would widen the worker's tool list.
	const denied = new Set(rewritten.denyTools ?? []);
	if ((original.denyTools ?? []).some((tool) => !denied.has(tool))) return false;
	// Host verification runs as the dispatching agent, so its checks stay as approved.
	if (!isDeepStrictEqual(original.intent?.verification ?? [], rewritten.intent?.verification ?? [])) return false;
	const originalRoots = effectiveWriteRoots(original);
	const rewrittenRoots = effectiveWriteRoots(rewritten);
	// A worktree task or compete candidate writes in a tree checked out from the
	// base commit at run time, whose links can differ from the parent checkout's.
	// That tree does not exist at admission, so the real-path check below would
	// judge the wrong filesystem; its roots must stay as approved (WX4).
	if ((original.worktree === true || mode === "compete") && !sameRoots(originalRoots, rewrittenRoots)) return false;
	// An unrestricted original admits any roots; a confined one admits only roots inside it.
	if (originalRoots.length === 0) return true;
	if (rewrittenRoots.length === 0 || !rewrittenRoots.every((root) => writeRootsCover(originalRoots, root))) return false;
	// The text check alone passes src/vendor/ under an approved src/ even when
	// src/vendor links to ../lib, and enforcement then admits writes under lib/
	// (WX3). Each rewritten root must also stay inside an approved one by real path.
	const cwd = original.cwd ?? process.cwd();
	const memo = createPathWalkMemo();
	const approved = originalRoots.flatMap((root) => physicalWriteRoot(cwd, root, memo) ?? []);
	return rewrittenRoots.every((root) => {
		const physical = physicalWriteRoot(cwd, root, memo);
		return physical !== null && writeRootsCover(approved, physical);
	});
}

/** Host-attached preparation keys, which are not part of the model's input. */
const HOST_ARGUMENTS = new Set<string>([RESOLVED_DISPATCH_PLAN_ARGUMENT, DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT]);

/** The input arguments with every intent removed, a bare task string read as its object form. */
function inputOutsideIntent(args: Record<string, unknown>): Record<string, unknown> {
	const input = Object.fromEntries(Object.entries(args).filter(([key]) => !HOST_ARGUMENTS.has(key) && key !== "intent"));
	if (Array.isArray(input.tasks)) {
		input.tasks = input.tasks.map((entry: unknown) => {
			if (typeof entry === "string") return { task: entry };
			if (entry === null || typeof entry !== "object") return entry;
			const { intent: _intent, ...rest } = entry as Record<string, unknown>;
			return rest;
		});
	}
	return input;
}

/**
 * Whether the rewrite's input arguments equal the original's except for the
 * intents, where write roots live. An extension that changes what a task says
 * or anything else the model sent loses the approval, whatever the snapshots show.
 */
export function dispatchInputChangesOnlyIntent(
	original: Record<string, unknown>,
	rewritten: Record<string, unknown>,
): boolean {
	return isDeepStrictEqual(inputOutsideIntent(original), inputOutsideIntent(rewritten));
}

/**
 * Whether a hook's rewrite of an approved dispatch only narrows what the
 * operator approved (WX2): the same tasks run by the same agents on the same
 * targets, runtimes and placements, inside the approved write roots, with no
 * read-only task made writable and no tool or delegation ceiling widened.
 * Both snapshots are the trusted ones admission sealed for each argument set.
 */
export function dispatchRewriteNarrows(
	original: DispatchExecutionSnapshot | undefined,
	rewritten: DispatchExecutionSnapshot | undefined,
): boolean {
	if (original?.kind !== "dispatch" || rewritten?.kind !== "dispatch") return false;
	if (
		original.mode !== rewritten.mode ||
		original.writers !== rewritten.writers ||
		!isDeepStrictEqual(original.review, rewritten.review) ||
		!isDeepStrictEqual(original.compete, rewritten.compete) ||
		!isDeepStrictEqual(original.council, rewritten.council)
	) {
		return false;
	}
	if (original.requests.length !== rewritten.requests.length) return false;
	if (
		!isDeepStrictEqual(
			fieldsExcept(original.planView, RENDERED_PLAN_FIELDS),
			fieldsExcept(rewritten.planView, RENDERED_PLAN_FIELDS),
		)
	)
		return false;
	const originalTasks = original.planView.tasks;
	const rewrittenTasks = rewritten.planView.tasks;
	if (originalTasks.length !== rewrittenTasks.length) return false;
	for (const [index, task] of originalTasks.entries()) {
		const next = rewrittenTasks[index];
		if (next === undefined || !taskViewNarrows(task, next)) return false;
	}
	return original.requests.every((request, index) => {
		const next = rewritten.requests[index];
		return next !== undefined && requestNarrows(request, next, original.mode);
	});
}

type McpAttestation = DispatchDerivedGrants["mcp"];

/**
 * Whether every MCP capability the rewrite admits was admitted as approved,
 * with a network grant only where the approved call had one. A narrower write
 * root that no longer reaches a server's code switches its grant on
 * (worker-mcp.ts withholdWritableMcpNetwork), so input fields alone miss it.
 */
function mcpNarrows(original: McpAttestation | undefined, rewritten: McpAttestation | undefined): boolean {
	if (rewritten === null || rewritten === undefined) return true;
	if (original === null || original === undefined || original.projectRoot !== rewritten.projectRoot) return false;
	return rewritten.tools.every((entry) => {
		const { network, ...rest } = entry;
		return original.tools.some((approved) => {
			const { network: approvedNetwork, ...approvedRest } = approved;
			return isDeepStrictEqual(rest, approvedRest) && (network !== true || approvedNetwork === true);
		});
	});
}

/**
 * Whether the capabilities admission derives for a rewritten request stay
 * within those it derived for the approved one (WX4): the requested actions,
 * the MCP attestation and every part of the worker permit. A capability the
 * approved call lacks, or grants that cannot be derived, refuse the carry.
 */
export function derivedGrantsNarrow(
	original: DispatchDerivedGrants | null,
	rewritten: DispatchDerivedGrants | null,
): boolean {
	if (original === null || rewritten === null) return false;
	const actions = new Set(original.requestedActions);
	if (!rewritten.requestedActions.every((action) => actions.has(action))) return false;
	if (!mcpNarrows(original.mcp, rewritten.mcp)) return false;
	const approved = original.permit;
	const next = rewritten.permit;
	if (
		approved.version !== next.version ||
		approved.trustedUnmediated !== next.trustedUnmediated ||
		!isDeepStrictEqual(approved.allowance, next.allowance) ||
		approved.ceiling.capabilityClass !== next.ceiling.capabilityClass ||
		!isDeepStrictEqual(approved.ceiling.enforcement, next.ceiling.enforcement) ||
		(approved.ceiling.readOnly && !next.ceiling.readOnly) ||
		!mcpNarrows(approved.ceiling.mcp, next.ceiling.mcp)
	)
		return false;
	const tools = new Set(approved.ceiling.tools);
	if (!next.ceiling.tools.every((tool) => tools.has(tool))) return false;
	if (approved.ceiling.writeRoots.length === 0) return true;
	return (
		next.ceiling.writeRoots.length > 0 &&
		next.ceiling.writeRoots.every((root) => writeRootsCover(approved.ceiling.writeRoots, root))
	);
}
