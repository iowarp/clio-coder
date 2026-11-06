import type { CompletedRunCaveat } from "../domains/dispatch/failure-headline.js";
import { DEFAULT_HEARTBEAT_SPEC } from "../domains/dispatch/heartbeat.js";
import type {
	WorkerAction,
	WorkerApprovalDecider,
	WorkerProgressSnapshot,
} from "../domains/telemetry/worker-progress.js";
import { type RouteFirstOutput, usualFirstOutput } from "./footer/silence-note.js";
import { TIER_THRESHOLDS_MS } from "./status/watchdog.js";
import type { ClioToken } from "./theme/index.js";
import { formatWaitClock, GLYPH } from "./theme/index.js";
import { formatUnattendedRemaining } from "./unattended-countdown.js";

/**
 * What a running worker is doing when no call is in flight, by the phase its
 * stream is in. The inline card and the Fleet runs island read the same
 * progress fold and name it in these words, so one run never reads `starting`
 * on the card and `running` on the island (BT-007).
 */
const WORKER_PHASE_ACTIVITY: Readonly<Record<string, readonly [glyph: string, words: string]>> = {
	starting: [GLYPH.phaseWaiting, "starting"],
	waiting: [GLYPH.phaseWaiting, "waiting on the model"],
	thinking: [GLYPH.phaseThinking, "thinking"],
	writing: [GLYPH.phaseWriting, "writing"],
	tool: [GLYPH.phaseTool, "between calls"],
	settled: [GLYPH.phaseWaiting, "finishing"],
};

/**
 * A worker whose heartbeat stopped, in words: how long it has been quiet. Its
 * phase is what it was doing when it went quiet, so every surface says this
 * instead while the watchdog reads it as stale.
 */
export function workerQuietWords(
	progress: Pick<WorkerProgressSnapshot, "quietSinceMs"> | undefined,
	now = Date.now(),
	room?: number,
): string | null {
	if (progress?.quietSinceMs === undefined) return null;
	// The watchdog reaps a worker whose heartbeat stays silent past its window and grace, so the words count down to
	// that end rather than leaving the operator to guess whether anything will happen.
	const quietMs = Math.max(0, now - progress.quietSinceMs);
	const endsInMs = DEFAULT_HEARTBEAT_SPEC.windowMs + DEFAULT_HEARTBEAT_SPEC.graceMs - quietMs;
	const left = formatWaitClock(endsInMs);
	const end = endsInMs >= 1000 ? `Clio stops it in ${left}` : "Clio is stopping it";
	// A narrow row keeps the countdown, which is what happens next, and lets the age of the silence go first.
	const forms = [
		`not responding for ${formatWaitClock(quietMs)} · ${end}`,
		`not responding · ${end}`,
		endsInMs >= 1000 ? `not responding · stops in ${left}` : "not responding · stopping",
	];
	return room === undefined ? (forms[0] ?? null) : (forms.find((form) => form.length <= room) ?? forms.at(-1) ?? null);
}

/**
 * A worker's model gone quiet, widest form first, for a row to pick the one that fits. The main rail's tiers apply:
 * past 30 s the words carry the age of the last evidence; past 90 s they also name the reply limit after which Clio ends
 * the call, and how to end it sooner. Null while the worker shows evidence, runs a tool, waits on a person, or has gone quiet as a process,
 * which `workerQuietWords` says instead.
 *
 * A worker waiting on its model also says whether the wait is unusual, from `history`: this session's worker calls on
 * the same route and how long the slowest took to its first output. Under two such calls the usual time is unknown and
 * the words say so. A pause mid-answer has no such history, so its usual length is always unknown.
 */
function workerSilenceForms(
	progress: Pick<
		WorkerProgressSnapshot,
		"phase" | "currentAction" | "awaitingApproval" | "quietSinceMs" | "evidenceAtMs" | "settled"
	>,
	now = Date.now(),
	history: RouteFirstOutput | null = null,
): readonly string[] | null {
	if (progress.settled || progress.quietSinceMs !== undefined || progress.awaitingApproval === true) return null;
	if (progress.currentAction !== null && progress.currentAction !== undefined) return null;
	const phase = progress.phase;
	if (phase !== "waiting" && phase !== "thinking" && phase !== "writing") return null;
	if (progress.evidenceAtMs === undefined) return null;
	const silentMs = Math.max(0, now - progress.evidenceAtMs);
	if (silentMs < TIER_THRESHOLDS_MS.tier2) return null;
	const silent = formatWaitClock(silentMs);
	const claim = phase === "waiting" ? `no output for ${silent}` : `no new output for ${silent}`;
	const known = phase === "waiting" ? usualFirstOutput(history) : null;
	// A sub-second first output reads `0s` on the wait clock, which says nothing true.
	const slowest = known === null ? "" : known.slowestMs < 1000 ? "under 1s" : formatWaitClock(known.slowestMs);
	const longer = known !== null && silentMs > known.slowestMs;
	// The widest form names the history; the next keeps only the verdict, which is what an operator acts on. The claim
	// leads every form, so a row that drops trailing clauses keeps the age and then the verdict.
	const usual =
		known === null
			? phase === "waiting"
				? "usual time for this route unknown"
				: "usual pauses unknown"
			: longer
				? `longer than usual for this route (slowest ${slowest})`
				: `this route has taken up to ${slowest}`;
	const verdict = known === null ? "usual unknown" : longer ? "longer than usual" : `up to ${slowest} before`;
	if (silentMs < TIER_THRESHOLDS_MS.tier3) return [`${claim} · ${usual}`, `${claim} · ${verdict}`, claim];
	// A reply that runs past the worker reply limit is ended, so the words name the limit when Clio knows it.
	const limitMs = readWorkerResponseLimitMs();
	// A setting in whole minutes reads as minutes: `10m`, not `10m0s`.
	const limitWords =
		limitMs === null ? null : limitMs % 60_000 === 0 ? `${limitMs / 60_000}m` : formatWaitClock(limitMs);
	const limit = limitWords === null ? null : `reply limit ${limitWords}`;
	const wide =
		limitWords === null ? "x in /fleet stops it" : `Clio ends a reply after ${limitWords} · x in /fleet stops it`;
	const short = limit === null ? "x in /fleet stops it" : `${limit} · x in /fleet stops it`;
	// With no history the limit outranks `usual unknown`, so that clause trails where a row drops it first.
	const middle =
		known === null
			? [`${claim} · ${short} · ${verdict}`, `${claim} · ${short}`]
			: [
					`${claim} · ${verdict} · ${short}`,
					...(limit === null ? [] : [`${claim} · ${verdict} · ${limit}`]),
					`${claim} · ${verdict}`,
				];
	return [`${claim} · ${usual} · ${wide}`, ...middle, ...(limit === null ? [] : [`${claim} · ${limit}`]), claim];
}

let readWorkerResponseLimitMs: () => number | null = () => null;

/**
 * Where the silence words read the worker reply limit (`safety.limits.workerResponseSeconds`) from. A worker's model
 * call that runs past it is ended and the run settles as timed out, so the words name it rather than claim a wait
 * with no end; the composition root binds it to live settings.
 */
export function bindWorkerResponseLimit(read: () => number | null): void {
	readWorkerResponseLimitMs = read;
}

/** The silence form that fits `room`, or the widest one with no room given. */
export function workerSilenceWords(
	progress: Parameters<typeof workerSilenceForms>[0],
	options: { now?: number; room?: number; history?: RouteFirstOutput | null } = {},
): string | null {
	const forms = workerSilenceForms(progress, options.now, options.history ?? null);
	if (forms === null) return null;
	const room = options.room;
	if (room === undefined) return forms[0] ?? null;
	return forms.find((form) => form.length <= room) ?? forms[forms.length - 1] ?? null;
}

/** The phase's glyph and words; `starting` until the stream reports a phase. */
export function workerPhaseActivity(phase: string | undefined): readonly [glyph: string, words: string] {
	return WORKER_PHASE_ACTIVITY[phase ?? "starting"] ?? [GLYPH.phaseWaiting, "starting"];
}

/**
 * A read-model quantity without its coverage clause: `≥999 (3 calls unknown)`
 * reads `≥999`, which still says it is a lower bound. A wholly unknown figure is
 * null so a row can leave it out, because `unknown tokens` tells a reader nothing
 * they can act on. The clause stays in `/view` and the board's expanded detail.
 */
export function compactQuantity(display: string): string | null {
	const figure = display.replace(/ \(.*\)$/u, "");
	return figure === "unknown" || figure === "?" || figure === "—" ? null : figure;
}

/**
 * The descriptor vocabulary's progressive verbs in the past tense. A verb that
 * names a tool rather than an act (`context`, `tasks`) reads the same either way.
 * A check that ran is `checked`, because `verified` would read as a pass on a
 * check that failed.
 */
const FINISHED_VERBS: Readonly<Record<string, string>> = {
	reading: "read",
	editing: "edited",
	writing: "wrote",
	listing: "listed",
	running: "ran",
	searching: "searched",
	finding: "found",
	fetching: "fetched",
	verifying: "checked",
	navigating: "navigated",
	inspecting: "inspected",
	monitoring: "monitored",
	steering: "steered",
	dispatching: "dispatched",
	deleting: "deleted",
	moving: "moved",
	thinking: "thought",
	calling: "called",
};

/** Tools the verb already names, so a `(read)` after `read a.ts` would only repeat it. */
const TOOLS_THE_VERB_NAMES: ReadonlySet<string> = new Set([
	"read",
	"write",
	"edit",
	"ls",
	"find",
	"git",
	"verify",
	"gateway",
	"tasks",
	"context",
	"monitor",
	"steer",
	"dispatch",
	"artifact",
	"think",
]);

/** Who owns a parked call. Naming the call's verb here would say it is running when it has not been allowed yet. */
export const WAITING_FOR_APPROVAL = "waiting for your approval";

export interface WorkerActionParts {
	verb: string;
	/** What the call acts on, marked when the safety layer cut it. Empty when nothing safe is known. */
	object: string;
	/** The tool to name after the object, when the verb has not already named it. */
	tool: string | null;
}

/**
 * One call in plain words. `git` and a recorded `gateway` descriptor are tool
 * names in the verb slot, so they read as the act instead. Live gateway calls
 * arrive already unwrapped; this only keeps replayed sessions readable.
 */
export function workerActionParts(action: WorkerAction, tense: "running" | "finished"): WorkerActionParts {
	const descriptor = action.descriptor;
	if (descriptor === undefined) return { verb: action.tool, object: "", tool: null };
	const object =
		descriptor.object === undefined ? "" : `${descriptor.object}${descriptor.truncated ? GLYPH.ellipsis : ""}`;
	if (descriptor.verb === "git" && object.length > 0) {
		return { verb: tense === "finished" ? "ran" : "running", object: `git ${object}`, tool: null };
	}
	if (descriptor.verb === "gateway") {
		return { verb: tense === "finished" ? "used" : "using", object: object || "a tool", tool: null };
	}
	const verb = tense === "finished" ? (FINISHED_VERBS[descriptor.verb] ?? descriptor.verb) : descriptor.verb;
	const tool = descriptor.capability ?? action.tool;
	if (TOOLS_THE_VERB_NAMES.has(tool)) return { verb, object, tool: null };
	return object.length > 0 ? { verb, object, tool } : { verb, object: tool, tool: null };
}

/** Who the wait is on, longest first. The person's own wait names no one, because `your` already does. */
const APPROVAL_WAITERS: Readonly<Record<WorkerApprovalDecider, readonly [string, string, string]>> = {
	operator: [WAITING_FOR_APPROVAL, "your approval", "asks you"],
	main: ["waiting for the main agent", "main agent", "main agent"],
	judge: ["waiting for the safety judge", "safety judge", "safety judge"],
};

/**
 * Whose wait this is, when it ends and what happens then, because nothing else
 * on a dock or rail says the ask has an end. Without a window the wait has no
 * end this process knows of, so it states none. `room` picks the longest form
 * that fits, and the time left is the last thing to survive, because a row cut
 * mid-sentence would drop exactly that.
 */
export function approvalWaitWords(
	progress: Pick<WorkerProgressSnapshot, "approvalWindow">,
	options: { now?: number; room?: number } = {},
): string {
	const window = progress.approvalWindow;
	if (window === undefined) return WAITING_FOR_APPROVAL;
	const left = formatUnattendedRemaining(window.expiresAt - (options.now ?? Date.now()));
	const held = window.held ? ["held"] : [];
	const denied = `denied in ${left}`;
	const fails = window.fallback === "fail";
	const [long, mid, short] = APPROVAL_WAITERS[window.decider];
	// Without the waiter beside it, a bare `denied in 1:53` read as already denied, so a narrow deny form says how
	// long is left to answer instead.
	const open = `${left} to answer`;
	const forms = [
		[long, ...held, fails ? `run fails in ${left}` : denied],
		[mid, ...held, fails ? `run fails in ${left}` : denied],
		[short, ...held, fails ? `fails in ${left}` : denied],
		[...held, fails ? `fails in ${left}` : open],
		[fails ? `fails in ${left}` : open],
	].map((parts) => parts.join(" · "));
	const room = options.room;
	if (room === undefined) return forms[0] as string;
	return forms.find((form) => form.length <= room) ?? (forms[forms.length - 1] as string);
}

/**
 * The activity a narrow row can afford: the running call's verb, or its tool
 * when the runtime sent no descriptor, else the phase's words. The card states
 * the call's object beside the verb; the island has room for the verb alone.
 */
export function workerActivityWords(
	progress: Pick<
		WorkerProgressSnapshot,
		"phase" | "currentAction" | "awaitingApproval" | "approvalWindow" | "quietSinceMs" | "evidenceAtMs" | "settled"
	>,
	options: { now?: number; room?: number; history?: RouteFirstOutput | null } = {},
): string {
	const quiet = workerQuietWords(progress, options.now);
	if (quiet !== null) return quiet;
	if (progress.awaitingApproval === true) return approvalWaitWords(progress, options);
	const action = progress.currentAction;
	if (action !== null && action !== undefined) return workerActionParts(action, "running").verb;
	return workerSilenceWords(progress, options) ?? workerPhaseActivity(progress.phase)[1];
}

/**
 * The mark and tone of a run that exited cleanly, from the shared caveat, so the worker card, the Fleet Runs row and
 * the task island draw the same glyph for the same run.
 */
export function completedRunMark(caveat: CompletedRunCaveat | null): { glyph: string; token: ClioToken } {
	switch (caveat?.kind) {
		case "against":
			return { glyph: GLYPH.error, token: "error" };
		case "refused":
			return { glyph: GLYPH.warn, token: "warning" };
		case "no-tools":
			return { glyph: GLYPH.queued, token: "toolMetadata" };
		default:
			return { glyph: GLYPH.ok, token: "success" };
	}
}
