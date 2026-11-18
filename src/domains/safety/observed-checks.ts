import { tmpdir } from "node:os";
import path from "node:path";
import { isRefusalToolResultError } from "../../tools/result-disposition.js";
import type { ObservedCheck } from "../session/task-board.js";
import { type CallClassification, type CheckOutputReader, classifyCall, settleCheckCall } from "./check-classifier.js";
import { capabilityEntries, dispatchRunRecordEvidence, validationCheckId } from "./finish-contract.js";
import { checkOutputReader, gitRunsConfiguredHelpers } from "./run-effects.js";

/**
 * The checks standing behind one task, folded from the session path. A note can
 * say anything; this reads only what the tools recorded. A refused call ran
 * nothing and counts for nothing. A later call that could have written retires
 * earlier passes, since they no longer describe the tree, and a failure stands
 * until the same check passes again.
 *
 * Each call is read and settled by the run-effects recorder's own rules, so a pass
 * the sealed receipt refuses never stands here (x4-1): a check sharing its call
 * with a change, a status that is a later command's, a red a later pipe stage can
 * cause, and a pass outside the workspace settle nothing, and a bash check is
 * filed under its full command, so a narrower pass never answers a wider red.
 *
 * Only the task's own stretch of work counts: from when it became active, or for
 * a task closed without a start, from the board's last change. A check run for
 * an earlier task does not speak for this one.
 */

interface TrackedCall {
	name: string | null;
	check?: string;
	reading: CallClassification;
	/** False when a bash call's exit status is only a later command's. */
	statusAttributable: boolean;
	/** The count of changes already settled when the call started. */
	revision: number;
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

/**
 * What the replays within one run share (x6-7): the git helper answer, git's ignore and tracking answers, and each
 * call's reading by its id. `key` names the run and every input a reading depends on, so nothing outlives the run.
 */
interface RunReplayCache {
	key: string;
	gitHelpers: boolean;
	gitAnswers: Map<string, boolean>;
	readings: Map<string, { fingerprint: string; reading: CallClassification }>;
}

interface Replay {
	root: string;
	gitHelpers: boolean;
	outputTarget: CheckOutputReader;
	readings?: RunReplayCache["readings"];
}

/** A call's reading, kept by its id unless it asked where output lands, which depends on this replay's own changes. */
function readCall(
	tool: string,
	args: Record<string, unknown> | undefined,
	replay: Replay,
	id: string | null,
): CallClassification {
	const fingerprint = `${tool}\0${JSON.stringify(args ?? null)}`;
	const known = id === null ? undefined : replay.readings?.get(id);
	if (known?.fingerprint === fingerprint) return known.reading;
	let asked = false;
	const outputTarget: CheckOutputReader = Object.assign(
		(base: string, logs?: ReadonlySet<string>) => {
			asked = true;
			return replay.outputTarget(base, logs);
		},
		{ changed: (paths: Iterable<string>) => replay.outputTarget.changed(paths) },
	);
	const reading = classifyCall(tool, args, { cwd: replay.root, gitHelpers: replay.gitHelpers, outputTarget });
	if (!asked && id !== null) replay.readings?.set(id, { fingerprint, reading });
	return reading;
}

function trackCall(
	tool: string,
	args: Record<string, unknown> | undefined,
	replay: Replay,
	revision: number,
	id: string | null = null,
): TrackedCall {
	const { root } = replay;
	const reading = readCall(tool, args, replay, id);
	const check =
		reading.check !== null && reading.base === root && reading.shell?.outsideCwd !== true
			? validationCheckId(reading.check)
			: undefined;
	return {
		name: reading.name,
		...(check ? { check } : {}),
		reading,
		statusAttributable: reading.shell?.statusAttributable ?? true,
		revision,
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
	scratchRoots: ReadonlyArray<string> = [],
): ReadonlyArray<ObservedCheck> {
	return standingChecksWith(entries, boardId, taskId, workspaceRoot, scratchRoots);
}

function standingChecksWith(
	entries: ReadonlyArray<unknown>,
	boardId: string,
	taskId: string,
	workspaceRoot: string,
	scratchRoots: ReadonlyArray<string>,
	cache?: RunReplayCache,
): ReadonlyArray<ObservedCheck> {
	const start = workWindowStart(entries, boardId, taskId);
	if (start === -1) return [];
	return standingChecksFrom(entries, start, workspaceRoot, scratchRoots, cache);
}

/** The turn of the session path's last user message, which opens the run now in progress; null before any. */
function currentRun(entries: ReadonlyArray<unknown>): string | null {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const item = record(entries[index]);
		if (item?.kind === "message" && item.role === "user") return text(item.turnId);
	}
	return null;
}

/**
 * {@link standingChecks} for a board that replays on every `done` and `block`: the replays of one run share its git
 * lookups and each call's reading (x6-7), and a new run, workspace, scratch root or temp dir starts afresh.
 */
export function createStandingChecks(): typeof standingChecks {
	let cache: RunReplayCache | undefined;
	return (entries, boardId, taskId, workspaceRoot, scratchRoots = []) => {
		const run = currentRun(entries);
		const root = path.resolve(workspaceRoot);
		const key = JSON.stringify([run, root, scratchRoots, tmpdir(), process.env.HOME, process.env.TMPDIR]);
		if (run === null) cache = undefined;
		else if (cache?.key !== key)
			cache = { key, gitHelpers: gitRunsConfiguredHelpers(root), gitAnswers: new Map(), readings: new Map() };
		return standingChecksWith(entries, boardId, taskId, workspaceRoot, scratchRoots, cache);
	};
}

/** The same fold over any stretch of the session path, from `start` on; `scratchRoots` is `safety.scratchRoots`. */
export function standingChecksFrom(
	entries: ReadonlyArray<unknown>,
	start: number,
	workspaceRoot: string,
	scratchRoots: ReadonlyArray<string> = [],
	cache?: RunReplayCache,
): ReadonlyArray<ObservedCheck> {
	const root = path.resolve(workspaceRoot);
	const gitHelpers = cache?.gitHelpers ?? gitRunsConfiguredHelpers(root);
	const outputTarget = checkOutputReader(root, process.env, scratchRoots, cache?.gitAnswers);
	const replay: Replay = { root, gitHelpers, outputTarget, ...(cache ? { readings: cache.readings } : {}) };
	const calls = new Map<string, TrackedCall>();
	const standing = new Map<string, ObservedCheck>();
	let revision = 0;
	const settle = (call: TrackedCall, failed: boolean, at: string): void => {
		const settlement = settleCheckCall(call.reading, failed, failed ? "error" : "ok", call.revision === revision);
		if (settlement.mutation) {
			outputTarget.changed(call.reading.changedPaths);
			revision += 1;
			for (const [name, item] of standing) if (item.passed) standing.delete(name);
		}
		if (call.name === null || !call.statusAttributable || !settlement.settled) return;
		standing.set(call.name, {
			name: call.name,
			...(call.check ? { check: call.check } : {}),
			passed: !failed,
			observedAt: at,
		});
	};
	for (const entry of capabilityEntries(entries.slice(start))) {
		const item = record(entry);
		const at = text(item?.timestamp) ?? "";
		if (item?.kind === "bashExecution") {
			const command = text(item.command);
			if (command === null || item.cancelled === true || typeof item.exitCode !== "number") continue;
			const args = { command, ...(text(item.cwd) ? { cwd: item.cwd } : {}) };
			settle(trackCall("bash", args, replay, revision), item.exitCode !== 0, at);
			continue;
		}
		if (item?.kind !== "message") continue;
		const payload = record(item.payload);
		if (payload === null) continue;
		const id = text(payload.toolCallId) ?? text(payload.tool_call_id) ?? text(payload.id);
		if (id === null) continue;
		if (item.role === "tool_call") {
			const tool = text(payload.name) ?? text(payload.toolName) ?? text(payload.tool);
			if (tool !== null) calls.set(id, trackCall(tool, record(payload.args) ?? undefined, replay, revision, id));
			continue;
		}
		if (item.role !== "tool_result") continue;
		const call = calls.get(id);
		if (call === undefined) continue;
		calls.delete(id);
		const outcome = resultStanding(payload);
		if (outcome === "refused") continue;
		settle(call, outcome === "failed", at);
		if (call.dispatch && outcome === "passed") {
			const summary = dispatchRunRecordEvidence(
				{ ...item, payload: { ...payload, toolName: "dispatch" } },
				undefined,
			)?.summary;
			const run = summary?.replace(/^dispatch run record passed: /u, "");
			if (run) standing.set(run, { name: run, passed: true, observedAt: at });
		}
	}
	// Commands filed apart can still run one check id: a red among them answers for it, never a narrower green.
	const red = new Set([...standing.values()].flatMap((item) => (!item.passed && item.check ? [item.check] : [])));
	return [...standing.values()].map((item) =>
		item.passed && item.check !== undefined && red.has(item.check)
			? { name: item.name, passed: item.passed, observedAt: item.observedAt }
			: item,
	);
}
