import { ToolNames } from "../../core/tool-names.js";
import type { DispatchContract } from "../dispatch/contract.js";
import { isTerminalRunEnvelope, type RunOutcome } from "../dispatch/types.js";
import type { MiddlewareHookRegistration } from "./runtime.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "./types.js";

/**
 * Detached-dispatch collection nudge, packaged as a turn_end hook
 * registration (same shape as the open-tasks nudge in task-nudge.ts).
 *
 * A detached batch returns before its runs finish, so nothing in the turn
 * forces the model back to the results. When a settled turn ends while at
 * least one uncollected batch has every run terminal, the turn is carried
 * onward with a `request_continuation` plus a paired reminder naming the
 * ready batches. Collecting a batch (monitor mode="collect") marks it in the
 * durable store, which removes it from the open list and silences the nudge,
 * including across session resume.
 *
 * Deliberate non-triggers: batches with runs still in flight (there is
 * nothing to collect yet; the dispatch board shows live progress), aborted or
 * errored turns, and surfaces without the monitor tool (nudging them would
 * loop against a wall).
 */

export const DETACHED_DISPATCH_NUDGE_REGISTRATION_ID = "nudge.detached-dispatch";
export const READ_ONLY_EXPLORATION_NUDGE_REGISTRATION_ID = "nudge.read-only-exploration";
export const READ_ONLY_EXPLORATION_NUDGE_CALL_THRESHOLD = 9;

const EXPLORATION_TOOL_NAMES = new Set<string>([
	ToolNames.Read,
	ToolNames.Grep,
	ToolNames.Find,
	ToolNames.Ls,
	ToolNames.CodeNav,
	ToolNames.Context,
]);
const EXPLORATION_NUDGE_TURN_LIMIT = 32;
const NO_TURN = "no-turn";
const READ_ONLY_SHELL_COMMAND_PATTERN = /^\s*(?:cat|head|tail|ls|grep|rg|find|wc)\b/;

interface ExplorationTurnState {
	readOnlyCalls: number;
	dispatched: boolean;
}

export function buildReadOnlyExplorationMessage(): string {
	return `[Clio Coder] This turn used ${READ_ONLY_EXPLORATION_NUDGE_CALL_THRESHOLD}+ read-only exploration calls without dispatch; delegate broad repository reconnaissance to scout.`;
}

function isReadOnlyExplorationCall(input: MiddlewareHookInput): boolean {
	if (input.toolName && EXPLORATION_TOOL_NAMES.has(input.toolName)) return true;
	if (input.toolName !== ToolNames.Bash) return false;
	const command = input.toolArgs?.command;
	return typeof command === "string" && READ_ONLY_SHELL_COMMAND_PATTERN.test(command);
}

/**
 * Counts broad read-only exploration during a turn and gives the orchestrator
 * one bounded chance to continue with scout. It observes only; dispatch still
 * remains the model's decision and normal safety policy controls that call.
 */
export function createReadOnlyExplorationNudgeRegistration(): MiddlewareHookRegistration {
	const byTurn = new Map<string, ExplorationTurnState>();
	const turnKey = (input: MiddlewareHookInput): string => input.turnId ?? input.runId ?? NO_TURN;
	const stateFor = (key: string): ExplorationTurnState => {
		let state = byTurn.get(key);
		if (state) return state;
		if (byTurn.size >= EXPLORATION_NUDGE_TURN_LIMIT) {
			const oldest = byTurn.keys().next().value;
			if (oldest !== undefined) byTurn.delete(oldest);
		}
		state = { readOnlyCalls: 0, dispatched: false };
		byTurn.set(key, state);
		return state;
	};
	return {
		id: READ_ONLY_EXPLORATION_NUDGE_REGISTRATION_ID,
		description: "remind broad read-only exploration turns that the scout agent is available",
		hooks: ["before_tool", "turn_end"],
		evaluate(input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> {
			const key = turnKey(input);
			if (input.hook === "before_tool") {
				const state = stateFor(key);
				if (input.toolName === ToolNames.Dispatch) state.dispatched = true;
				if (isReadOnlyExplorationCall(input)) state.readOnlyCalls += 1;
				return [];
			}
			if (input.hook !== "turn_end") return [];
			const state = byTurn.get(key);
			byTurn.delete(key);
			const stopReason = input.metadata?.stopReason;
			if (stopReason !== undefined && stopReason !== "stop") return [];
			const activeToolNames = input.metadata?.activeToolNames;
			if (typeof activeToolNames !== "string" || !activeToolNames.split(",").includes(ToolNames.Dispatch)) return [];
			if (!state || state.dispatched || state.readOnlyCalls < READ_ONLY_EXPLORATION_NUDGE_CALL_THRESHOLD) return [];
			const message = buildReadOnlyExplorationMessage();
			return [
				{ kind: "request_continuation", message },
				{ kind: "inject_reminder", message, severity: "info" },
			];
		},
	};
}

type DetachedTerminalOutcome = RunOutcome | "missing" | "unknown";
type DetachedTerminalOutcomeCounts = Partial<Record<DetachedTerminalOutcome, number>>;

export interface DetachedBatchNudgeView {
	id: string;
	total: number;
	terminal: number;
	terminalOutcomes?: Readonly<DetachedTerminalOutcomeCounts>;
}

const TERMINAL_OUTCOME_ORDER: ReadonlyArray<DetachedTerminalOutcome> = [
	"succeeded",
	"canceled",
	"failed",
	"timed_out",
	"stalled",
	"denied_by_policy",
	"spawn_failed",
	"missing",
	"unknown",
];

function terminalOutcomeLabel(outcome: DetachedTerminalOutcome): string {
	switch (outcome) {
		case "timed_out":
			return "timed out";
		case "denied_by_policy":
			return "denied by policy";
		case "spawn_failed":
			return "spawn failed";
		case "missing":
			return "ledger row missing";
		case "unknown":
			return "outcome unknown";
		default:
			return outcome;
	}
}

function incrementTerminalOutcome(counts: DetachedTerminalOutcomeCounts, outcome: DetachedTerminalOutcome): void {
	counts[outcome] = (counts[outcome] ?? 0) + 1;
}

/**
 * Open (uncollected) detached batches with terminal-run progress, computed
 * from the durable batch store and the run ledger. A ledger row pruned from
 * the bounded ring counts as terminal: it can never complete, so the batch
 * must stay collectible instead of pending forever.
 */
export function openDetachedBatchViews(
	dispatch: Pick<DispatchContract, "detached" | "getRun">,
): DetachedBatchNudgeView[] {
	const detached = dispatch.detached;
	if (!detached) return [];
	let records: ReturnType<typeof detached.list>;
	try {
		records = detached.list();
	} catch {
		return [];
	}
	return records.map((record) => {
		let terminal = 0;
		const terminalOutcomes: DetachedTerminalOutcomeCounts = {};
		for (const run of record.runs) {
			const row = dispatch.getRun(run.runId);
			if (row === null) {
				terminal += 1;
				incrementTerminalOutcome(terminalOutcomes, "missing");
			} else if (isTerminalRunEnvelope(row)) {
				terminal += 1;
				incrementTerminalOutcome(terminalOutcomes, row.outcome ?? "unknown");
			}
		}
		return { id: record.id, total: record.runs.length, terminal, terminalOutcomes };
	});
}

function detachedBatchProgress(view: DetachedBatchNudgeView): string {
	const terminalOutcomes = view.terminalOutcomes ?? {};
	if (view.terminal === view.total && terminalOutcomes.succeeded === view.total) {
		return `${view.terminal}/${view.total} run(s) done`;
	}
	let accountedFor = 0;
	const breakdown = TERMINAL_OUTCOME_ORDER.flatMap((outcome) => {
		const count = terminalOutcomes[outcome] ?? 0;
		accountedFor += count;
		return count > 0 ? [`${count} ${terminalOutcomeLabel(outcome)}`] : [];
	});
	const unavailable = Math.max(0, view.terminal - accountedFor);
	if (unavailable > 0) breakdown.push(`${unavailable} outcome unknown`);
	return `${view.terminal}/${view.total} run(s) terminal (${breakdown.join(", ")})`;
}

export function buildDetachedBatchesMessage(
	ready: ReadonlyArray<DetachedBatchNudgeView>,
	running: ReadonlyArray<DetachedBatchNudgeView>,
): string {
	const rows = ready.map((view) => `  - batch ${view.id}: ${detachedBatchProgress(view)}`);
	const runningNote =
		running.length > 0 ? `\n${running.length} other detached batch(es) are still running; leave those for later.` : "";
	return (
		`[Clio Coder] ${ready.length} detached dispatch batch(es) finished and are uncollected:\n` +
		`${rows.join("\n")}\n` +
		`Collect each with monitor mode="collect" batch_id=<id> and act on the results. ` +
		`A batch stays open (and keeps nudging) until it is collected.${runningNote}`
	);
}

export interface CreateDetachedDispatchNudgeRegistrationOptions {
	/** Live view of open detached batches; see openDetachedBatchViews. */
	getOpenBatches: () => ReadonlyArray<DetachedBatchNudgeView>;
}

export function createDetachedDispatchNudgeRegistration(
	options: CreateDetachedDispatchNudgeRegistrationOptions,
): MiddlewareHookRegistration {
	return {
		id: DETACHED_DISPATCH_NUDGE_REGISTRATION_ID,
		description: "carry the turn onward when detached dispatch results are ready to collect",
		hooks: ["turn_end"],
		evaluate(input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> {
			if (input.hook !== "turn_end") return [];
			// Only settled stop turns are candidates; aborted and errored turns
			// already carry their own recovery path. Absent stopReason is "stop",
			// mirroring the finish contract.
			const stopReason = input.metadata?.stopReason;
			if (stopReason !== undefined && stopReason !== "stop") return [];
			// A surface without the monitor tool can never collect a batch, so
			// nudging it would loop against a wall.
			const activeToolNames = input.metadata?.activeToolNames;
			if (typeof activeToolNames === "string" && !activeToolNames.split(",").includes(ToolNames.Monitor)) return [];
			let views: ReadonlyArray<DetachedBatchNudgeView>;
			try {
				views = options.getOpenBatches();
			} catch {
				return [];
			}
			const ready = views.filter((view) => view.total > 0 && view.terminal >= view.total);
			if (ready.length === 0) return [];
			const running = views.filter((view) => view.total > 0 && view.terminal < view.total);
			const message = buildDetachedBatchesMessage(ready, running);
			return [
				{ kind: "request_continuation", message },
				{ kind: "inject_reminder", message, severity: "warn" },
			];
		},
	};
}
