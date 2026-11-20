import { tmpdir } from "node:os";
import path from "node:path";
import { isRefusalToolResultError } from "../../tools/result-disposition.js";
import type { ObservedCheck } from "../session/task-board.js";
import { type CallClassification, type CheckOutputReader, classifyCall, settleCheckCall } from "./check-classifier.js";
import {
	capabilityEntries,
	type DeclaredVerifierCommand,
	declaredVerifierCommands,
	dispatchRunRecordEvidence,
	type SessionVerifier,
	validationCheckId,
} from "./finish-contract.js";
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
 * A check the project catalog or the session declares (`run --verify`) is read as one by the same classifier (x7-5).
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
	declared: ReadonlyArray<DeclaredVerifierCommand>;
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
		{
			changed: (paths: Iterable<string>) => replay.outputTarget.changed(paths),
			outside: (base: string) => replay.outputTarget.outside(base),
		},
	);
	const reading = classifyCall(tool, args, {
		cwd: replay.root,
		gitHelpers: replay.gitHelpers,
		outputTarget,
		declaredChecks: replay.declared,
	});
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
		reading.check !== null &&
		reading.base === root &&
		reading.shell?.outsideCwd !== true &&
		reading.shell?.outsideLockedEnv !== true
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
	sessionVerifiers: ReadonlyArray<SessionVerifier> = [],
): ReadonlyArray<ObservedCheck> {
	const declared = declaredVerifierCommands(workspaceRoot, sessionVerifiers);
	return standingChecksWith(entries, boardId, taskId, workspaceRoot, scratchRoots, declared);
}

function standingChecksWith(
	entries: ReadonlyArray<unknown>,
	boardId: string,
	taskId: string,
	workspaceRoot: string,
	scratchRoots: ReadonlyArray<string>,
	declared: ReadonlyArray<DeclaredVerifierCommand>,
	cache?: RunReplayCache,
): ReadonlyArray<ObservedCheck> {
	const start = workWindowStart(entries, boardId, taskId);
	if (start === -1) return [];
	return standingChecksFrom(entries, start, workspaceRoot, scratchRoots, cache, declared);
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
 * lookups and each call's reading (x6-7), and a new run, workspace, scratch root, temp dir or declared check starts
 * afresh.
 */
export function createStandingChecks(): typeof standingChecks {
	let cache: RunReplayCache | undefined;
	return (entries, boardId, taskId, workspaceRoot, scratchRoots = [], sessionVerifiers = []) => {
		const run = currentRun(entries);
		const root = path.resolve(workspaceRoot);
		const declared = declaredVerifierCommands(root, sessionVerifiers);
		const key = JSON.stringify([run, root, scratchRoots, tmpdir(), process.env.HOME, process.env.TMPDIR, declared]);
		if (run === null) cache = undefined;
		else if (cache?.key !== key)
			cache = { key, gitHelpers: gitRunsConfiguredHelpers(root), gitAnswers: new Map(), readings: new Map() };
		return standingChecksWith(entries, boardId, taskId, workspaceRoot, scratchRoots, declared, cache);
	};
}

/** The same fold over any stretch of the session path, from `start` on; `scratchRoots` is `safety.scratchRoots`. */
export function standingChecksFrom(
	entries: ReadonlyArray<unknown>,
	start: number,
	workspaceRoot: string,
	scratchRoots: ReadonlyArray<string> = [],
	cache?: RunReplayCache,
	declared: ReadonlyArray<DeclaredVerifierCommand> = declaredVerifierCommands(workspaceRoot, []),
): ReadonlyArray<ObservedCheck> {
	return foldStanding(entries.slice(start), workspaceRoot, scratchRoots, declared, cache, pathStartedAt(entries)).checks;
}

/** When the path's first timestamped entry was written: an untracked check log born before it is not the session's. */
function pathStartedAt(entries: ReadonlyArray<unknown>): number | undefined {
	for (const entry of entries) {
		const at = Date.parse(text(record(entry)?.timestamp) ?? "");
		if (Number.isFinite(at)) return at;
	}
	return undefined;
}

/**
 * The passing dispatch run records that still stand from `start` on, named as the task board files them: the run-effects
 * recorder reads a dispatch only as an opaque write, so the headless line takes these from the same fold (bt-verify7a).
 */
export function standingDispatchRuns(
	entries: ReadonlyArray<unknown>,
	start: number,
	workspaceRoot: string,
	scratchRoots: ReadonlyArray<string> = [],
): string[] {
	const declared = declaredVerifierCommands(workspaceRoot, []);
	const fold = foldStanding(
		entries.slice(start),
		workspaceRoot,
		scratchRoots,
		declared,
		undefined,
		pathStartedAt(entries),
	);
	return fold.checks.flatMap((check) => (check.passed && fold.dispatchRuns.has(check.name) ? [check.name] : []));
}

/** What the same fold says of a finished stretch of work, for the finish contract. */
export interface RunCheckFacts {
	/**
	 * The calls whose passing check still stands: a model call by its id, an operator's `!` run as `#<index>` into
	 * `capabilityEntries(entries)`, each with the check it settled. A declared check is credited only through it, so the
	 * gate and the receipt read one change sequence (x7-5). A passing dispatch run record stands here by its call id
	 * too, with no `check`, so a later change retires it as it retires a check.
	 */
	passCalls: ReadonlyMap<string, ObservedCheck>;
	/**
	 * Checks whose last outcome since the last change is red, as the run-effects recorder seals them: a change retires
	 * every outcome and a later run of the same check replaces it (bt-44).
	 */
	failing: ReadonlyArray<string>;
}

export function runCheckFacts(
	entries: ReadonlyArray<unknown>,
	workspaceRoot: string,
	declared: ReadonlyArray<DeclaredVerifierCommand>,
): RunCheckFacts {
	const { passCalls, sealed } = foldStanding(entries, workspaceRoot, [], declared, undefined, pathStartedAt(entries));
	return { passCalls, failing: [...sealed].flatMap(([name, passed]) => (passed ? [] : [name])) };
}

function foldStanding(
	entries: ReadonlyArray<unknown>,
	workspaceRoot: string,
	scratchRoots: ReadonlyArray<string>,
	declared: ReadonlyArray<DeclaredVerifierCommand>,
	cache?: RunReplayCache,
	startedAt?: number,
): {
	checks: ObservedCheck[];
	passCalls: Map<string, ObservedCheck>;
	sealed: Map<string, boolean>;
	dispatchRuns: Set<string>;
} {
	const root = path.resolve(workspaceRoot);
	const gitHelpers = cache?.gitHelpers ?? gitRunsConfiguredHelpers(root);
	const outputTarget = checkOutputReader(root, process.env, scratchRoots, cache?.gitAnswers, startedAt);
	const replay: Replay = { root, gitHelpers, outputTarget, declared, ...(cache ? { readings: cache.readings } : {}) };
	const calls = new Map<string, TrackedCall>();
	const standing = new Map<string, ObservedCheck>();
	const standingCalls = new Map<string, string>();
	const sealed = new Map<string, boolean>();
	// The check each standing name ran, so a later run of it under another spelling re-files it, as the recorder does (SF-2).
	const identities = new Map<string, string>();
	const dispatchRuns = new Set<string>();
	let revision = 0;
	const settle = (call: TrackedCall, failed: boolean, at: string, key: string): void => {
		const settlement = settleCheckCall(call.reading, failed, failed ? "error" : "ok", call.revision === revision);
		if (settlement.mutation) {
			outputTarget.changed(call.reading.changedPaths);
			revision += 1;
			for (const [name, item] of standing) if (item.passed) standing.delete(name);
			sealed.clear();
		}
		if (call.name === null || !call.statusAttributable || !settlement.settled) return;
		const identity = call.reading.identity ?? call.name;
		identities.set(call.name, identity);
		// Earlier spellings of this check still standing take its outcome; one that already agrees keeps its own call, and
		// one that changes keeps no pass call, since `passCalls` credits a declared check only through the call that ran it.
		for (const [name, ran] of identities) {
			const earlier = standing.get(name);
			if (ran !== identity || name === call.name || earlier === undefined || earlier.passed === !failed) continue;
			sealed.set(name, !failed);
			standingCalls.delete(name);
			standing.set(name, { ...earlier, passed: !failed, observedAt: at });
		}
		sealed.set(call.name, !failed);
		standingCalls.set(call.name, key);
		standing.set(call.name, {
			name: call.name,
			...(call.check ? { check: call.check } : {}),
			passed: !failed,
			observedAt: at,
		});
	};
	for (const [index, entry] of capabilityEntries(entries).entries()) {
		const item = record(entry);
		const at = text(item?.timestamp) ?? "";
		if (item?.kind === "bashExecution") {
			const command = text(item.command);
			if (command === null || item.cancelled === true || typeof item.exitCode !== "number") continue;
			const args = { command, ...(text(item.cwd) ? { cwd: item.cwd } : {}) };
			settle(trackCall("bash", args, replay, revision), item.exitCode !== 0, at, `#${index}`);
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
		settle(call, outcome === "failed", at, id);
		if (call.dispatch && outcome === "passed") {
			const summary = dispatchRunRecordEvidence(
				{ ...item, payload: { ...payload, toolName: "dispatch" } },
				undefined,
			)?.summary;
			const run = summary?.replace(/^dispatch run record passed: /u, "");
			// Filed under its call id so the finish gate credits the run record only while no later change retired it.
			if (run) {
				dispatchRuns.add(run);
				standingCalls.set(run, id);
				standing.set(run, { name: run, passed: true, observedAt: at });
			}
		}
	}
	// Commands filed apart can still run one check id: a red among them answers for it, never a narrower green.
	const red = new Set([...standing.values()].flatMap((item) => (!item.passed && item.check ? [item.check] : [])));
	const checks = [...standing.values()].map((item) =>
		item.passed && item.check !== undefined && red.has(item.check)
			? { name: item.name, passed: item.passed, observedAt: item.observedAt }
			: item,
	);
	const passCalls = new Map(
		checks.flatMap((item) => {
			const key = item.passed ? standingCalls.get(item.name) : undefined;
			return key === undefined ? [] : [[key, item] as const];
		}),
	);
	return { checks, passCalls, sealed, dispatchRuns };
}
