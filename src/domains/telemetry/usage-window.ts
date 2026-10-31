import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cwdHash } from "../../core/cwd-hash.js";
import type { ExplanationV1, ParsedFactRef } from "../../core/telemetry/dto.js";
import { loadRepoTelemetrySources } from "../session/telemetry-source.js";
import { explain, parseRepoOwner, type RepoSource, repoOwner } from "./read-model.js";

/**
 * The window `usage report` folds and `telemetry explain` rebuilds for a repository reference (#434 §11.1, §11.4).
 * It lives here, not in the CLI, so the GUI's read model resolves the same window with none of the report's memory,
 * skill or tool-surface reads.
 */

const USAGE_WINDOW_FUTURE_SKEW_MS = 5_000;

/** What the window read could not use, counted and named so a report says so instead of reading it as quiet. */
export interface UsageDiagnostics {
	unreadableSessions: number;
	malformedSessionLines: number;
	notes: string[];
}

export function emptyUsageDiagnostics(): UsageDiagnostics {
	return { unreadableSessions: 0, malformedSessionLines: 0, notes: [] };
}

/**
 * The window `usage report` folds: the repository's sessions (every bucket's without one), and the runs no session
 * references that the run ledger attributes to it by cwd. `telemetry explain` rebuilds a `repo:` reference's window
 * through it, ending at its own now (#434 §11.4).
 */
export async function usageWindow(
	stateDir: string,
	scope: { hash: string; inRepo: (cwd: string) => boolean } | null,
	days: number,
	now: number,
	diagnostics: UsageDiagnostics = emptyUsageDiagnostics(),
): Promise<{ repo: RepoSource }> {
	const windowStart = now - days * 24 * 60 * 60 * 1000;
	const ledger = await readLedgerRows(stateDir, diagnostics);
	const repoRunIds =
		scope === null
			? null
			: new Set([...ledger].flatMap(([id, row]) => (row.cwd !== null && scope.inRepo(row.cwd) ? [id] : [])));
	const telemetry = loadRepoTelemetrySources(stateDir, {
		cwdHash: scope?.hash ?? null,
		from: windowStart,
		to: now + USAGE_WINDOW_FUTURE_SKEW_MS,
		standaloneRuns: repoRunIds ?? "all",
	});

	return {
		repo: { owner: repoOwner(scope?.hash ?? null, days), ...telemetry },
	};
}

/** The run ledger's cwd per run, while the ring keeps its row. */
async function readLedgerRows(
	stateDir: string,
	diagnostics: UsageDiagnostics,
): Promise<Map<string, { cwd: string | null }>> {
	const rows = new Map<string, { cwd: string | null }>();
	try {
		const parsed = JSON.parse(await readFile(join(stateDir, "runs.json"), "utf8")) as unknown;
		if (!Array.isArray(parsed)) throw new Error("expected array");
		for (const entry of parsed) {
			if (!isRecord(entry) || typeof entry.id !== "string") continue;
			rows.set(entry.id, {
				cwd: typeof entry.cwd === "string" ? entry.cwd : null,
			});
		}
	} catch (error) {
		// No ledger is no run filter; a ledger that does not parse says so.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			diagnostics.notes.push(
				`run ledger unreadable, --repo run filter skipped: ${error instanceof Error ? error.message : String(error)}`,
			);
	}
	return rows;
}

/** Whether a reference names a repository window: a `repo` one, or an `own` or `runs` one whose owner is a window. */
export function isRepoRef(ref: Pick<ParsedFactRef, "scope" | "owner">): boolean {
	return ref.scope === "repo" || ((ref.scope === "own" || ref.scope === "runs") && parseRepoOwner(ref.owner) !== null);
}

/**
 * A repository reference names a window, not a moment: it is rebuilt the way `usage report` loads it, ending now, so a
 * reference copied from an earlier report folds whatever the window holds today (#434 §11.4).
 */
export async function explainRepoRef(stateDir: string, ref: string, owner: string): Promise<ExplanationV1 | null> {
	const window = parseRepoOwner(owner);
	if (!window) return null;
	const hash = window.cwdHash;
	const scope = hash === null ? null : { hash, inRepo: (cwd: string) => cwdHash(cwd) === hash };
	const { repo } = await usageWindow(stateDir, scope, window.days, Date.now());
	return explain(ref, { repo });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
