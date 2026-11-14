// The words and rules of the "Restore workspace files" dialog, kept apart from React so they can be tested.
import type { SnapshotPlan, SnapshotRow } from "../../contracts/rewind.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";

export const REWIND_EMPTY =
	"No workspace snapshots in this task yet. CLIO Coder takes one before it first changes files in a turn and before every destructive command, in a Git work tree with safety snapshots on.";
export const REWIND_RUNNING =
	"CLIO Coder is working, so nothing restores now. Wait for the turn to finish, or stop it.";
export const REWIND_APPROVAL = "CLIO Coder is waiting for your approval, so nothing restores now. Answer it first.";
export const REWIND_UNAVAILABLE = "File snapshots are not available for this task.";
export const REWIND_RESUME = "Resume the task to use this.";
export const REWIND_MATCHES = "The workspace already matches this snapshot. Nothing would change.";
export const REWIND_NOTES = [
	"Gitignored files are never touched. Your Git index, HEAD and branches do not change.",
	"A snapshot of the current files is taken first, so you can undo this.",
] as const;

const REASON_WORDS: Readonly<Record<string, string>> = {
	"turn-start": "Before a turn changed files",
	destructive: "Before a destructive command",
	"pre-rewind": "Before a restore",
};
/** CLIO Coder's own bookkeeping tools: naming one would not tell the reader what the turn changed. */
const INTERNAL_TOOLS: ReadonlySet<string> = new Set(["store"]);

/** Why the snapshot was taken, in words, with the tool that triggered it when that says anything. */
export function snapshotWhy(row: Pick<SnapshotRow, "reason" | "tool">): string {
	const reason = Object.hasOwn(REASON_WORDS, row.reason) ? (REASON_WORDS[row.reason] ?? row.reason) : row.reason;
	return row.tool === undefined || INTERNAL_TOOLS.has(row.tool) ? reason : `${reason} · ${row.tool}`;
}

export function snapshotDiffers(differs: number | null): string | null {
	if (differs === null) return null;
	if (differs === 0) return "Matches the current files";
	return differs === 1 ? "1 file differs from now" : `${differs} files differ from now`;
}

/** The sentence shown instead of the list, or null when there are rows to show. */
export function rewindEmpty(rows: readonly SnapshotRow[]): string | null {
	return rows.length === 0 ? REWIND_EMPTY : null;
}

/** `Turn <n>` for a snapshot whose turn this window shows, numbered as the transcript numbers turns. */
export function snapshotTurn(
	turns: readonly { id: string }[],
	turnId: string | undefined,
): { turnId: string; label: string } | null {
	if (turnId === undefined) return null;
	const index = turns.findIndex((turn) => turn.id === turnId);
	return index < 0 ? null : { turnId, label: `Turn ${index + 1}` };
}

/** Why the dialog cannot be used at all, before any list is read. */
export function rewindUnavailable(state: SessionSnapshot["state"], offered: boolean | undefined): string | null {
	if (state !== "open") return REWIND_RESUME;
	return offered === false ? REWIND_UNAVAILABLE : null;
}

/** Why restoring is refused right now, or null when it may run. Reading the list and a preview stays allowed. */
export function restoreBlocked(input: { running: boolean; approvalPending: boolean }): string | null {
	if (input.running) return REWIND_RUNNING;
	if (input.approvalPending) return REWIND_APPROVAL;
	return null;
}

export function planCounts(plan: Extract<SnapshotPlan, { kind: "plan" }>) {
	return {
		restore: `Will restore (${plan.restore.length})`,
		remove: `Will remove (${plan.remove.length})`,
		kept: `Kept (${plan.kept.length})`,
	};
}

export function planChangesNothing(plan: Extract<SnapshotPlan, { kind: "plan" }>): boolean {
	return plan.restore.length === 0 && plan.remove.length === 0;
}

/** Restoring rewrites the project, so the first press only arms it and the second runs it. */
export type RestoreStep = "idle" | "armed";
export function restoreButton(step: RestoreStep): string {
	return step === "armed" ? "Confirm restore" : "Restore files";
}
export function pressRestore(step: RestoreStep, blocked: boolean): { next: RestoreStep; run: boolean } {
	if (blocked) return { next: "idle", run: false };
	return step === "armed" ? { next: "idle", run: true } : { next: "armed", run: false };
}

export function undoPoint(n: number | null): string | null {
	return n === null ? null : `Undo point saved as snapshot #${n}.`;
}
