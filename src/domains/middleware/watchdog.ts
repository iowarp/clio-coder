/**
 * The opt-in turn-end watchdog.
 *
 * A long agentic turn can leave the tree in a state nobody looked at: the
 * model reports success, the operator reads the report, and the drift between
 * what the board asked for and what the diff actually did stays invisible
 * until someone reads the diff themselves. When `watchdog.enabled` is on, a
 * turn that changed the tree is handed to one read-only verifier run briefed
 * with the turn's coalesced diff and the board's current scope. Its blockers
 * become one transcript notice and nothing else.
 *
 * What it deliberately does not do: it never auto-follows, never carries the
 * turn onward, never queues a turn, and never mutates. A watchdog that could
 * start work would be a second agent nobody asked for; this one can only tell
 * the operator what it saw.
 *
 * The registration itself emits no middleware effects. It owns the decision of
 * when to fire and the coalesced diff it fires with; the caller owns the
 * dispatch and the notice.
 */

import { ToolNames } from "../../core/tool-names.js";
import type { MiddlewareHookRegistration } from "./runtime.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "./types.js";

export const WATCHDOG_REGISTRATION_ID = "observer.watchdog";

/**
 * Bound on the coalesced diff a watchdog briefing carries, in UTF-8 bytes. The
 * run is meant to be cheap enough to spend on every mutating turn, so it is
 * given the shape of the change rather than every byte of it.
 */
export const WATCHDOG_DIFF_MAX_BYTES = 12 * 1024;

/** Bound on how many mutated paths the briefing names before it summarizes the rest. */
export const WATCHDOG_PATHS_MAX = 40;

export const WATCHDOG_TRUNCATION_MARKER = "\n[diff truncated]";

/** Tools whose successful results carry a file diff worth coalescing. */
const MUTATING_TOOL_NAMES = new Set<string>([ToolNames.Write, ToolNames.Edit, ToolNames.Artifact]);

const NO_EFFECTS: ReadonlyArray<MiddlewareEffect> = [];

export type WatchdogTriggerReason = "turn_end" | "cadence";

export interface WatchdogTrigger {
	reason: WatchdogTriggerReason;
	/** The turn's coalesced diff, one block per mutated path in first-touch order. */
	diff: string;
	/** Paths the turn mutated, in first-touch order. */
	paths: ReadonlyArray<string>;
	/** The board's current scope, or null when the session has no task board. */
	scope: string | null;
	/** Tool calls seen in this turn when the trigger fired. */
	toolCalls: number;
}

/** The live settings view the registration reads on every boundary, so a hot reload lands immediately. */
export interface WatchdogSettingsView {
	enabled: boolean;
	target?: string;
	cadenceToolCalls?: number;
}

export interface WatchdogDeps {
	getSettings: () => Readonly<WatchdogSettingsView>;
	/** The board's current scope line, or null when there is no board. */
	getScope?: () => string | null;
	/**
	 * Dispatch the watchdog run and deliver whatever it found. Resolves when the
	 * run has settled; the registration awaits only to know the in-flight slot is
	 * free again, never to hold the turn.
	 */
	run: (trigger: WatchdogTrigger) => Promise<void>;
	/**
	 * False on a surface that must never fire the watchdog whatever the setting
	 * says. Headless and ACP runs pass false: neither has an operator watching a
	 * transcript, so a notice they cannot read is a worker run spent on nothing.
	 */
	firesOnThisSurface?: boolean;
}

export interface WatchdogRegistration extends MiddlewareHookRegistration {
	/** Triggers dropped because a watchdog run was already in flight. */
	droppedTriggers(): number;
	/** True while a watchdog run is outstanding. */
	runInFlight(): boolean;
	/** Resolves once no watchdog run is outstanding. */
	whenIdle(): Promise<void>;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function firstPath(details: Readonly<Record<string, unknown>> | undefined): string | null {
	const paths = details?.paths;
	if (!Array.isArray(paths)) return null;
	for (const entry of paths) {
		const path = stringValue(entry);
		if (path !== null) return path;
	}
	return null;
}

/**
 * Coalesce the per-call diffs of one turn into one diff.
 *
 * Per-path last-write-wins, in first-touch order. A turn that edited one file
 * six times produced six diffs against six different base contents; replaying
 * all of them tells a reviewer the history of the edit rather than its result,
 * and the result is what the reviewer is being asked about.
 */
export function coalesceTurnDiff(
	byPath: ReadonlyMap<string, string>,
	maxBytes: number = WATCHDOG_DIFF_MAX_BYTES,
): string {
	const blocks: string[] = [];
	let index = 0;
	for (const [path, diff] of byPath) {
		if (index >= WATCHDOG_PATHS_MAX) {
			blocks.push(`[${byPath.size - WATCHDOG_PATHS_MAX} more changed path(s) omitted]`);
			break;
		}
		blocks.push(`--- ${path}\n${diff}`);
		index += 1;
	}
	const whole = blocks.join("\n\n");
	if (Buffer.byteLength(whole, "utf8") <= maxBytes) return whole;
	const room = Math.max(0, maxBytes - Buffer.byteLength(WATCHDOG_TRUNCATION_MARKER, "utf8"));
	const buffer = Buffer.from(whole, "utf8");
	let cut = Math.min(room, buffer.byteLength);
	while (cut > 0) {
		const next = buffer[cut];
		if (next === undefined || (next & 0xc0) !== 0x80) break;
		cut -= 1;
	}
	return `${buffer.subarray(0, cut).toString("utf8")}${WATCHDOG_TRUNCATION_MARKER}`;
}

/** The bounded, fixed task every watchdog run is given. It never varies with the diff. */
export const WATCHDOG_TASK =
	"Review the coalesced diff in the briefing against the scope it names. Report one check per concern: " +
	"a change outside the stated scope, a change the scope required that the diff does not make, or a defect " +
	"visible in the diff itself. Run no commands and change nothing.";

/** The briefing body a watchdog run receives. Data, never instructions. */
export function watchdogBriefing(trigger: WatchdogTrigger): string {
	const scope = trigger.scope === null ? "(no task board; scope is unstated)" : trigger.scope;
	const paths = trigger.paths.length === 0 ? "(none)" : trigger.paths.join("\n");
	return [
		"## Current scope",
		scope,
		"",
		"## Changed paths",
		paths,
		"",
		"## Coalesced diff for this turn",
		trigger.diff,
	].join("\n");
}

/**
 * Build the registration. It is hooked on `after_tool` and `turn_end`:
 * `after_tool` is where the diffs and the tool count come from, and `turn_end`
 * is the boundary a mutating turn fires on.
 */
export function createWatchdogRegistration(deps: WatchdogDeps): WatchdogRegistration {
	const diffByPath = new Map<string, string>();
	let toolCalls = 0;
	let dropped = 0;
	let inFlight = false;
	let outstanding: Promise<void> = Promise.resolve();

	const active = (): WatchdogSettingsView | null => {
		if (deps.firesOnThisSurface === false) return null;
		let settings: Readonly<WatchdogSettingsView>;
		try {
			settings = deps.getSettings();
		} catch {
			return null;
		}
		return settings.enabled ? settings : null;
	};

	const resetTurn = (): void => {
		diffByPath.clear();
		toolCalls = 0;
	};

	const fire = (reason: WatchdogTriggerReason): void => {
		if (diffByPath.size === 0) return;
		// One run at a time. A watchdog slower than the turns that trigger it must
		// not queue: a queued review describes a tree that has already moved on,
		// and a backlog of them would outlive the session. The drop is counted so
		// a starved cadence and a quiet one stay distinguishable.
		if (inFlight) {
			dropped += 1;
			return;
		}
		const trigger: WatchdogTrigger = {
			reason,
			diff: coalesceTurnDiff(diffByPath),
			paths: [...diffByPath.keys()].slice(0, WATCHDOG_PATHS_MAX),
			scope: scopeNow(),
			toolCalls,
		};
		inFlight = true;
		// Started synchronously, so the in-flight slot is genuinely taken before
		// this hook returns. Deferring the start to a microtask would let two
		// triggers in the same tool batch both find the slot free.
		let started: Promise<void>;
		try {
			started = deps.run(trigger);
		} catch {
			inFlight = false;
			return;
		}
		outstanding = started
			.catch(() => {
				// A failed watchdog run is not a failed turn. The run's own reporting
				// path already told the operator whatever it could.
			})
			.finally(() => {
				inFlight = false;
			});
	};

	const scopeNow = (): string | null => {
		try {
			return deps.getScope?.() ?? null;
		} catch {
			return null;
		}
	};

	return {
		id: WATCHDOG_REGISTRATION_ID,
		description: "review a mutating turn's coalesced diff against the board scope with a read-only verifier run",
		hooks: ["after_tool", "turn_end"],
		evaluate(input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> {
			const settings = active();
			if (settings === null) {
				// Still clear turn state so a mid-session disable cannot leave a diff
				// behind that a later enable would fire on.
				if (input.hook === "turn_end") resetTurn();
				return NO_EFFECTS;
			}
			if (input.hook === "after_tool") {
				toolCalls += 1;
				recordMutation(input);
				const cadence = settings.cadenceToolCalls;
				// Mid-turn cadence keeps accumulating: turn end still reviews the whole
				// turn, not just what landed after the last cadence firing.
				if (cadence !== undefined && cadence >= 1 && toolCalls % cadence === 0) fire("cadence");
				return NO_EFFECTS;
			}
			if (input.hook !== "turn_end") return NO_EFFECTS;
			// A turn with no file mutations never fires. A middleware continuation
			// re-evaluates turn_end with the accumulator already cleared, so it
			// cannot fire a second run for the same change either.
			fire("turn_end");
			resetTurn();
			return NO_EFFECTS;
		},
		droppedTriggers: () => dropped,
		runInFlight: () => inFlight,
		whenIdle: () => outstanding,
	};

	function recordMutation(input: MiddlewareHookInput): void {
		if (input.metadata?.resultKind !== "ok") return;
		if (input.toolName === undefined || !MUTATING_TOOL_NAMES.has(input.toolName)) return;
		const diff = stringValue(input.toolResultDetails?.diff);
		if (diff === null) return;
		// Map.set on an existing key keeps its insertion position, so the newest
		// diff for a path wins while the path keeps its first-touch order.
		diffByPath.set(firstPath(input.toolResultDetails) ?? input.toolName, diff);
	}
}
