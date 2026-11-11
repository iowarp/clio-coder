import path from "node:path";
import { isRefusalToolResultError } from "../../tools/result-disposition.js";
import type { ObservedCheck } from "../session/task-board.js";
import { classify } from "./action-classifier.js";
import { capabilityEntries, dispatchRunRecordEvidence, validationCheckId } from "./finish-contract.js";
import { mutationTargets, validationCommandOf } from "./run-effects.js";

/**
 * The checks standing behind one task, folded from the session path. A note can
 * say anything; this reads only what the tools recorded. A refused call ran
 * nothing and counts for nothing. A later call that could have written retires
 * earlier passes, since they no longer describe the tree, and a failure stands
 * until the same check passes again.
 *
 * Only the task's own stretch of work counts: from when it became active, or for
 * a task closed without a start, from the board's last change. A check run for
 * an earlier task does not speak for this one.
 */

interface TrackedCall {
	name: string | null;
	check?: string;
	mutates: boolean;
	dispatch: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function callCanWrite(tool: string, args: Record<string, unknown> | undefined): boolean {
	if (mutationTargets(tool, args).length > 0) return true;
	const actionClass = classify({ tool, ...(args ? { args } : {}) }).actionClass;
	return actionClass !== "read";
}

function trackCall(tool: string, args: Record<string, unknown> | undefined, root: string): TrackedCall {
	const name = validationCommandOf(tool, args, "grounding");
	const dir = typeof args?.cwd === "string" && args.cwd.length > 0 ? path.resolve(root, args.cwd) : root;
	const check = dir === root && name !== null ? validationCheckId(name) : undefined;
	return {
		name: name !== null && dir !== root ? `${name} in ${path.relative(root, dir) || dir}` : name,
		...(check ? { check } : {}),
		// Running a check is not a write, and a dispatched worker may have written anything.
		mutates: tool === "dispatch" || (name === null && callCanWrite(tool, args)),
		dispatch: tool === "dispatch",
	};
}

/** Whether a result came from a call that really ran, and whether that run came back clean. */
function resultStanding(payload: Record<string, unknown>): "passed" | "failed" | "refused" {
	const result = record(payload.result);
	const details = record(result?.details);
	const admission = record(details?.chainAdmission)?.outcome ?? payload.outcome;
	if (admission === "blocked" || isRefusalToolResultError(result)) return "refused";
	// A check that ran and came back red also carries its message as a block reason, so only a bare one means refused.
	if (admission === undefined && typeof payload.blockReason === "string") return "refused";
	const nonZero = typeof details?.exitCode === "number" && details.exitCode !== 0;
	const failed =
		payload.isError === true ||
		payload.error === true ||
		admission === "error" ||
		result?.kind === "error" ||
		details?.kind === "error" ||
		nonZero;
	if (!failed) return "passed";
	// Failed with no outcome at all is a call the engine answered without reaching its tool.
	return admission === "error" || admission === "ok" || nonZero ? "failed" : "refused";
}

/** Where a task's stretch of work opens: the first snapshot of the trailing run that leaves its state unchanged. */
function workWindowStart(entries: ReadonlyArray<unknown>, boardId: string, taskId: string): number {
	const statuses = (entry: Record<string, unknown>): Map<string, unknown> =>
		new Map(
			(Array.isArray(entry.subgoals) ? entry.subgoals : []).flatMap((goal) => {
				const item = record(goal);
				return item && typeof item.id === "string" ? [[item.id, item.status] as const] : [];
			}),
		);
	const sameStatuses = (left: Map<string, unknown>, right: Map<string, unknown>): boolean =>
		left.size === right.size && [...left].every(([id, status]) => right.get(id) === status);
	let start = -1;
	let latest: Map<string, unknown> | null = null;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const item = record(entries[index]);
		if (item?.kind !== "taskLedger" || item.boardId !== boardId) continue;
		const current = statuses(item);
		latest ??= current;
		const belongs = latest.get(taskId) === "active" ? current.get(taskId) === "active" : sameStatuses(current, latest);
		if (!belongs) break;
		start = index;
	}
	return start;
}

export function standingChecks(
	entries: ReadonlyArray<unknown>,
	boardId: string,
	taskId: string,
	workspaceRoot: string,
): ReadonlyArray<ObservedCheck> {
	const start = workWindowStart(entries, boardId, taskId);
	if (start === -1) return [];
	return standingChecksFrom(entries, start, workspaceRoot);
}

/** The same fold over any stretch of the session path, from `start` on: a headless run folds its own turn. */
export function standingChecksFrom(
	entries: ReadonlyArray<unknown>,
	start: number,
	workspaceRoot: string,
): ReadonlyArray<ObservedCheck> {
	const root = path.resolve(workspaceRoot);
	const calls = new Map<string, TrackedCall>();
	const standing = new Map<string, ObservedCheck>();
	const retirePasses = (): void => {
		for (const [name, item] of standing) if (item.passed) standing.delete(name);
	};
	for (const entry of capabilityEntries(entries.slice(start))) {
		const item = record(entry);
		const at = text(item?.timestamp) ?? "";
		if (item?.kind === "bashExecution") {
			const command = text(item.command);
			if (command === null || item.cancelled === true || typeof item.exitCode !== "number") continue;
			const call = trackCall("bash", { command, ...(text(item.cwd) ? { cwd: item.cwd } : {}) }, root);
			if (call.name === null) {
				if (call.mutates) retirePasses();
				continue;
			}
			standing.set(call.name, {
				name: call.name,
				...(call.check ? { check: call.check } : {}),
				passed: item.exitCode === 0,
				observedAt: at,
			});
			continue;
		}
		if (item?.kind !== "message") continue;
		const payload = record(item.payload);
		if (payload === null) continue;
		const id = text(payload.toolCallId) ?? text(payload.tool_call_id) ?? text(payload.id);
		if (id === null) continue;
		if (item.role === "tool_call") {
			const tool = text(payload.name) ?? text(payload.toolName) ?? text(payload.tool);
			if (tool !== null) calls.set(id, trackCall(tool, record(payload.args) ?? undefined, root));
			continue;
		}
		if (item.role !== "tool_result") continue;
		const call = calls.get(id);
		if (call === undefined) continue;
		calls.delete(id);
		const outcome = resultStanding(payload);
		if (outcome === "refused") continue;
		if (call.mutates) retirePasses();
		if (call.name !== null) {
			standing.set(call.name, {
				name: call.name,
				...(call.check ? { check: call.check } : {}),
				passed: outcome === "passed",
				observedAt: at,
			});
		}
		if (call.dispatch && outcome === "passed") {
			const summary = dispatchRunRecordEvidence(
				{ ...item, payload: { ...payload, toolName: "dispatch" } },
				undefined,
			)?.summary;
			const run = summary?.replace(/^dispatch run record passed: /u, "");
			if (run) standing.set(run, { name: run, passed: true, observedAt: at });
		}
	}
	return [...standing.values()];
}
