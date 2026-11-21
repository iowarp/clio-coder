/**
 * The normalize stage of dispatch admission (fleet design 4.7, M2).
 *
 * Parse produces requests; this stage rewrites the shapes a model sends that
 * name admissible work in a non-canonical form, before the writer-conflict
 * check, preview and the execution snapshot read them. Each rewrite yields one
 * notice line that dispatch puts in front of the result text, so the model
 * learns the canonical form instead of meeting a refusal.
 *
 * Shapes held here:
 * - an absolute task or briefing token equal to or under the run's cwd, or a
 *   leading-slash workspace path, on a request inferring its scope from prose;
 * - `intent.write_roots: []`, which declares a task that writes nothing;
 * - a builder recipe with no write roots and no expected outputs in a parallel
 *   batch of two or more tasks, which runs read-only as an explorer (row 146);
 * - an outside read root with `detach: true`, whose approval is asked before
 *   the batch detaches.
 * A dispatch called through the gateway is forwarded by the gateway itself
 * (src/tools/gateway/index.ts), which adds its own notice line.
 */

import type { AgentSpec } from "../domains/agents/spec.js";
import type { DispatchRequest } from "../domains/dispatch/contract.js";
import { relativizeWorkspaceAbsoluteTokens } from "../domains/dispatch/path-scope.js";
import { canonicalWriteRoots } from "../domains/dispatch/writer-set.js";
import { dispatchTaskArgs } from "./dispatch-arguments.js";
import type { DispatchMode } from "./dispatch-types.js";

const NOTICE_PREFIX = "[dispatch normalize]";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The member asked for checks itself, through a non-empty intent.verification or
 * a gate. `verification: []` asks for none, so it does not make a member a writer.
 */
function declaresVerification(itemArgs: Record<string, unknown>): boolean {
	const checks = isRecord(itemArgs.intent) ? itemArgs.intent.verification : undefined;
	const named = checks !== undefined && checks !== null && !(Array.isArray(checks) && checks.length === 0);
	return named || (itemArgs.gate !== undefined && itemArgs.gate !== null && itemArgs.gate !== false);
}

/** intent.write_roots is an explicit empty array and no legacy writeRoots stands beside it. */
function declaresEmptyWriteRoots(itemArgs: Record<string, unknown>): boolean {
	if (!isRecord(itemArgs.intent)) return false;
	const roots = itemArgs.intent.write_roots;
	if (!Array.isArray(roots) || roots.length > 0) return false;
	return !(Array.isArray(itemArgs.writeRoots) && itemArgs.writeRoots.length > 0);
}

/**
 * The member named a write root. `write_roots: ["."]` names the whole workspace, and intent
 * resolution drops the entry because an empty list already means no boundary, so the
 * resolved roots cannot tell it from a member that declared nothing.
 */
function declaresWriteRoots(itemArgs: Record<string, unknown>): boolean {
	const roots = isRecord(itemArgs.intent) ? itemArgs.intent.write_roots : undefined;
	return (
		(Array.isArray(roots) && roots.length > 0) || (Array.isArray(itemArgs.writeRoots) && itemArgs.writeRoots.length > 0)
	);
}

/** Check ids on the parsed request: the operator's named checks parse merged in, since callers exclude a member's own. */
function attachedChecks(request: DispatchRequest): string[] {
	return [
		...new Set([
			...(request.intent?.verification ?? []).map((entry) => entry.check),
			...(request.resolvedVerification ?? []).map((entry) => entry.check),
		]),
	];
}

/**
 * Run the request read-only. Callers pass only a request carrying no checks: a
 * member's own exclude it, and so do the operator's named checks parse merged in.
 */
function readOnly(request: DispatchRequest): DispatchRequest {
	const { resolvedVerification: _checks, ...rest } = request;
	return {
		...rest,
		readOnly: true,
		...(request.intent !== undefined ? { intent: { ...request.intent, verification: [] } } : {}),
	};
}

/** A member admission may run read-only: in place, writing no store tag, no artifact, nothing outside. */
function mayRunReadOnly(
	request: DispatchRequest,
	itemArgs: Record<string, unknown> | null,
	capabilityClass: AgentSpec["capabilityClass"] | undefined,
): itemArgs is Record<string, unknown> {
	return (
		itemArgs !== null &&
		request.readOnly !== true &&
		request.worktree !== true &&
		request.storeTags === undefined &&
		request.externalReadRoot === undefined &&
		capabilityClass !== "artifact-write" &&
		!declaresVerification(itemArgs)
	);
}

export interface DispatchNormalizeInput {
	/** Prepared arguments, `tasks` already in array form. */
	readonly args: Record<string, unknown>;
	/** Parsed requests; rewritten in place. */
	readonly requests: DispatchRequest[];
	/** 1-based task position of each request. */
	readonly positions: ReadonlyArray<number>;
	readonly mode: DispatchMode;
	readonly specs: ReadonlyArray<AgentSpec>;
}

/** Normalize parsed dispatch requests in place; returns one notice line per rewrite. */
export function normalizeDispatchAdmission(input: DispatchNormalizeInput): string[] {
	const { args, requests, positions, mode, specs } = input;
	const classes = new Map(specs.map((spec) => [spec.id, spec.capabilityClass]));
	const notices: string[] = [];
	const label = (index: number): string => `task ${positions[index] ?? index + 1} (${requests[index]?.agentId})`;
	const memberArgs = (index: number): Record<string, unknown> | null =>
		dispatchTaskArgs(args, (positions[index] ?? index + 1) - 1);

	for (const [index, request] of requests.entries()) {
		// Absolute workspace paths only fail a request whose scope is inferred from its prose.
		if (request.intent !== undefined) continue;
		const cwd = request.cwd ?? process.cwd();
		const task = relativizeWorkspaceAbsoluteTokens(request.task, cwd);
		const briefing =
			request.briefing === undefined ? undefined : relativizeWorkspaceAbsoluteTokens(request.briefing, cwd);
		const rewrites = [...task.rewrites, ...(briefing?.rewrites ?? [])];
		if (rewrites.length === 0) continue;
		requests[index] = { ...request, task: task.text, ...(briefing !== undefined ? { briefing: briefing.text } : {}) };
		const named = [...new Map(rewrites.map((entry) => [entry.from, entry])).values()]
			.map((entry) => `${entry.from} -> ${entry.to}`)
			.join(", ");
		notices.push(
			`${NOTICE_PREFIX} ${label(index)}: read absolute workspace paths as workspace-relative (${named}); name workspace paths relative to the workspace root.`,
		);
	}

	for (const [index, request] of requests.entries()) {
		const itemArgs = memberArgs(index);
		const capabilityClass = classes.get(request.agentId);
		if (!mayRunReadOnly(request, itemArgs, capabilityClass) || !declaresEmptyWriteRoots(itemArgs)) continue;
		// Normalization never removes a check the operator required: the request stays as parsed and admission
		// decides, or refuses, with the check in place.
		if (attachedChecks(request).length > 0) continue;
		requests[index] = readOnly(request);
		if (capabilityClass === "read-only") continue;
		notices.push(
			`${NOTICE_PREFIX} ${label(index)} runs read-only: its intent.write_roots: [] declares no writes, so it gets the read-only tool surface and changes no files; declare write roots or use worktree: true for a task that writes.`,
		);
	}

	// Row 146 (DESIGN 4.7): in a parallel batch a builder that declared nothing to write or produce is
	// inspection: role explorer, no writes. writers: 1 asks for serialized writers.
	// The reading is inferred, so it yields to evidence of a write: a named write root ("." included) or a check
	// the operator named in the turn, which expects a change for the merge gate to judge.
	if (mode === "parallel" && requests.length > 1 && args.writers !== 1) {
		for (const [index, request] of requests.entries()) {
			const itemArgs = memberArgs(index);
			const capabilityClass = classes.get(request.agentId);
			if (
				request.executionRole !== "builder" ||
				capabilityClass === undefined ||
				capabilityClass === "read-only" ||
				!mayRunReadOnly(request, itemArgs, capabilityClass) ||
				declaresWriteRoots(itemArgs) ||
				attachedChecks(request).length > 0 ||
				canonicalWriteRoots(request).length > 0 ||
				(request.intent?.expectedOutputs.length ?? 0) > 0
			)
				continue;
			requests[index] = { ...readOnly(request), executionRole: "explorer" };
			notices.push(
				`${NOTICE_PREFIX} ${label(index)} runs read-only as an explorer: a builder in a parallel batch with no intent.write_roots and no expected_outputs is admitted as inspection; declare disjoint write roots or use worktree: true for a task that writes.`,
			);
		}
	}

	if (args.detach === true) {
		for (const [index, request] of requests.entries()) {
			if (request.externalReadRoot === undefined) continue;
			notices.push(
				`${NOTICE_PREFIX} ${label(index)}: outside read root ${request.externalReadRoot} is approved before the batch detaches; the run starts detached once approved.`,
			);
		}
	}
	return notices;
}
