/**
 * `clio-coder session compact` (SPEC L3c, M-09): the headless compaction entry. The CLI boots a headless session on
 * the resumed session with `headless.compact` set, and the composition root hands its chat loop here instead of
 * running a turn. The compaction is the operator `/context compact` path (`ChatLoop.compact`), so it summarizes on
 * the same route, under the same admission and telemetry, and appends the same `compactionSummary` entry.
 *
 * Every type here is structural so the session domain takes no session-control or entry import.
 */
import type { SessionEntry } from "./entries.js";
import { filterEntriesToActivePath } from "./tree/active-path.js";

/** What a headless compaction ended with: the notices `ChatLoop.compact` raised, and the error ones among them. */
export interface HeadlessCompactionOutcome {
	failed: boolean;
	notices: string[];
	/** The error-level notices (and a thrown error's message): why a failed compaction failed. */
	errors: string[];
}

/** The boot option that turns a headless boot into one compaction of the resumed session. */
export interface HeadlessCompactionRequest {
	instructions?: string;
	/**
	 * Called once the compaction settled, before shutdown, so the CLI verb reports it while the process still runs
	 * (shutdown ends in `process.exit`). It returns the exit code the boot ends with.
	 */
	onSettled: (outcome: HeadlessCompactionOutcome) => number;
}

interface CompactingChat {
	compact(instructions?: string): Promise<void>;
	onEvent(handler: (event: { type: string; level?: string; surface?: string; text?: string }) => void): () => void;
}

/**
 * Compact the boot's current session once, let the caller report the outcome and pick the exit code, and shut down.
 * A notice is a refusal, a failure or an empty cut (the ACP `runCompact` host reads them the same way); an error
 * notice or a throw marks the outcome failed. Footer notices are ambient chips and are skipped.
 */
export async function runHeadlessCompaction(
	chat: CompactingChat,
	request: HeadlessCompactionRequest,
	boot: { termination: { shutdown(code: number): Promise<unknown> }; timer: { snapshot(): { totalMs: number } } },
): Promise<{ exitCode: number; bootTimeMs: number }> {
	const outcome: HeadlessCompactionOutcome = { failed: false, notices: [], errors: [] };
	const stop = chat.onEvent((event) => {
		if (event.type !== "notice" || event.surface === "footer" || event.text === undefined) return;
		outcome.notices.push(event.text);
		if (event.level !== "error") return;
		outcome.failed = true;
		outcome.errors.push(event.text);
	});
	try {
		await chat.compact(request.instructions);
	} catch (error) {
		outcome.failed = true;
		outcome.errors.push(error instanceof Error ? error.message : String(error));
	} finally {
		stop();
	}
	let exitCode = 1;
	try {
		exitCode = request.onSettled(outcome);
	} finally {
		await boot.termination.shutdown(exitCode);
	}
	return { exitCode, bootTimeMs: boot.timer.snapshot().totalMs };
}

/** The context the next request replays: entry count on the active path after the latest checkpoint's cut. */
export interface ReplayedContextSize {
	entries: number;
	/** The latest checkpoint on the active path, or null when the session was never compacted. */
	checkpointTurnId: string | null;
	tokensBefore: number | null;
	tokensAfter: number | null;
}

/**
 * Count what a resumed session replays, cutting at each `compactionSummary` the way the replay does: the summary
 * replaces everything before `firstKeptTurnId` (an empty or missing id keeps nothing older).
 */
export function replayedContextSize(entries: ReadonlyArray<SessionEntry>, leafTurnId?: string): ReplayedContextSize {
	let context: SessionEntry[] = [];
	let checkpoint: Extract<SessionEntry, { kind: "compactionSummary" }> | null = null;
	for (const entry of filterEntriesToActivePath(entries, leafTurnId)) {
		if (entry.kind !== "compactionSummary") {
			context.push(entry);
			continue;
		}
		const kept = context.findIndex((candidate) => candidate.turnId === entry.firstKeptTurnId);
		context = [entry, ...(kept >= 0 ? context.slice(kept) : [])];
		checkpoint = entry;
	}
	return {
		entries: context.length,
		checkpointTurnId: checkpoint?.turnId ?? null,
		tokensBefore: checkpoint?.tokensBefore ?? null,
		tokensAfter: checkpoint?.tokensAfter ?? null,
	};
}
