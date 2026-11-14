// Where a dispatch's runs stand, for the line under its transcript row. Pure; `DispatchOutcome.tsx` draws it.

import type { TimelineItem } from "../../contracts/sessions.js";
import type { StatusTone } from "../design/status.js";
import type { FleetRun, FleetRunState } from "./fleet-facts.js";
import { isLiveRun } from "./fleet-facts.js";
import { readWire, record, str } from "./tool-presentation.js";

/**
 * The runs a settled dispatch started, as its result details name them (`src/tools/dispatch-runner.ts`): a detached
 * batch's `runs`, a blocking batch's `terminalRunIds`, or a single run's `runId`.
 */
export function dispatchRunIds(item: Pick<TimelineItem, "title" | "rawInput" | "rawOutput">): readonly string[] {
	if (item.title !== "dispatch") return [];
	const details = readWire(item).details;
	const listed = [
		...(Array.isArray(details?.runs) ? details.runs.map((run) => str(record(run)?.runId)) : []),
		...(Array.isArray(details?.terminalRunIds) ? details.terminalRunIds.map(str) : []),
		...(Array.isArray(details?.settledRunIds) ? details.settledRunIds.map(str) : []),
		str(details?.runId),
	];
	return [...new Set(listed.filter((id): id is string => id !== null))];
}

const SETTLED_WORDS: ReadonlyArray<readonly [FleetRunState, string]> = [
	["done", "done"],
	["failed", "failed"],
	["stopped", "stopped"],
	["ended", "ended without a final event"],
];

/**
 * Where a dispatch's runs stand, for its transcript row. The model's words after a detached dispatch ("The plan is
 * running.") describe the moment it was sent; this line follows the runs to their end. Null while the feed holds
 * none of them, so a dispatch whose runs scrolled out of the bounded feed claims nothing.
 */
export function dispatchOutcome(
	runIds: readonly string[],
	runs: readonly FleetRun[],
): { readonly text: string; readonly tone: StatusTone } | null {
	const ids = new Set(runIds);
	const mine = runs.filter((run) => ids.has(run.runId));
	if (mine.length === 0) return null;
	const total = ids.size;
	const noun = total === 1 ? "run" : "runs";
	const live = mine.filter(isLiveRun).length;
	if (live > 0) return { text: `${live} of ${total} ${noun} still running`, tone: "running" };
	const parts = SETTLED_WORDS.flatMap(([state, word]) => {
		const count = mine.filter((run) => run.state === state).length;
		return count === 0 ? [] : [`${count} ${word}`];
	});
	if (mine.length < total) parts.push(`${total - mine.length} not reported`);
	const tone: StatusTone = mine.some((run) => run.state === "failed")
		? "fail"
		: mine.length === total && mine.every((run) => run.state === "done")
			? "success"
			: "neutral";
	return { text: `${total} ${noun} finished: ${parts.join(" · ")}`, tone };
}
