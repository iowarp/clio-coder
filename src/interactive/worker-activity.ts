import type { WorkerAction, WorkerProgressSnapshot } from "../domains/telemetry/worker-progress.js";
import { GLYPH } from "./theme/index.js";

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
	return figure === "unknown" || figure === "?" ? null : figure;
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

/**
 * The activity a narrow row can afford: the running call's verb, or its tool
 * when the runtime sent no descriptor, else the phase's words. The card states
 * the call's object beside the verb; the island has room for the verb alone.
 */
export function workerActivityWords(
	progress: Pick<WorkerProgressSnapshot, "phase" | "currentAction" | "awaitingApproval">,
): string {
	if (progress.awaitingApproval === true) return WAITING_FOR_APPROVAL;
	const action = progress.currentAction;
	if (action !== null && action !== undefined) return workerActionParts(action, "running").verb;
	return workerPhaseActivity(progress.phase)[1];
}
