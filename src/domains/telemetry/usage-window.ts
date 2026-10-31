import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { cwdHash } from "../../core/cwd-hash.js";
import type { ExplanationV1, ParsedFactRef } from "../../core/telemetry/dto.js";
import { readReceiptText } from "../dispatch/receipt-store.js";
import { listSessionLedgerRefs } from "../session/archive-readers.js";
import { loadRepoTelemetrySources } from "../session/telemetry-source.js";
import { explain, parseRepoOwner, type RepoSource, repoOwner } from "./read-model.js";

/**
 * The window `usage report` folds and `telemetry explain` rebuilds for a repository reference (#434 §11.1, §11.4).
 * It lives here, not in the CLI, so the GUI's read model resolves the same window with none of the report's memory,
 * skill or tool-surface reads.
 */

const USAGE_WINDOW_FUTURE_SKEW_MS = 5_000;

/** What the tool, skill, recipe and opportunity facts read from a receipt; spend is the read model's (#434). */
export interface UsageReceipt {
	cwd: string | null;
	runId: string;
	agentId: string;
	task: string;
	endedAt: string;
	sessionId: string | null;
	toolStats: Array<{ tool: string; count: number; ok: number; errors: number; blocked: number }>;
	skillActivations: string[];
}

/** What the window read could not use, counted and named so a report says so instead of reading it as quiet. */
export interface UsageDiagnostics {
	malformedReceipts: number;
	unreadableSessions: number;
	malformedSessionLines: number;
	malformedAuditRows: number;
	notes: string[];
}

export function emptyUsageDiagnostics(): UsageDiagnostics {
	return { malformedReceipts: 0, unreadableSessions: 0, malformedSessionLines: 0, malformedAuditRows: 0, notes: [] };
}

/** Whether a timestamp falls in a window, allowing a writer clock a few seconds ahead. */
export function inUsageWindow(iso: string, start: number, end: number): boolean {
	const value = Date.parse(iso);
	return Number.isFinite(value) && value >= start && value <= end + USAGE_WINDOW_FUTURE_SKEW_MS;
}

/**
 * The window `usage report` folds: the repository's sessions (every bucket's without one), and the runs no session
 * references that the run ledger or a window receipt attributes to it, by cwd or by one of its sessions. `telemetry
 * explain` rebuilds a `repo:` reference's window through it, ending at its own now (#434 §11.4).
 */
export async function usageWindow(
	stateDir: string,
	scope: { hash: string; inRepo: (cwd: string) => boolean } | null,
	days: number,
	now: number,
	diagnostics: UsageDiagnostics = emptyUsageDiagnostics(),
): Promise<{ receipts: UsageReceipt[]; repo: RepoSource }> {
	const windowStart = now - days * 24 * 60 * 60 * 1000;
	const repoRunIds = scope === null ? null : await runIdsForCwd(stateDir, scope.inRepo, diagnostics);
	const repoSessions =
		scope === null ? null : new Set((await listSessionLedgerRefs(stateDir, scope.hash)).map((ref) => ref.sessionId));
	const receipts = (await readReceipts(stateDir, windowStart, now, diagnostics)).filter(
		(receipt) =>
			scope === null ||
			(receipt.cwd !== null && scope.inRepo(receipt.cwd)) ||
			repoRunIds?.has(receipt.runId) ||
			(receipt.sessionId !== null && repoSessions?.has(receipt.sessionId)),
	);
	const telemetry = loadRepoTelemetrySources(stateDir, {
		cwdHash: scope?.hash ?? null,
		from: windowStart,
		to: now + USAGE_WINDOW_FUTURE_SKEW_MS,
		// A receipt from before run journals may have left the run ledger's ring; its own cwd still attributes it.
		standaloneRuns: repoRunIds === null ? "all" : new Set([...repoRunIds, ...receipts.map((receipt) => receipt.runId)]),
	});
	return { receipts, repo: { owner: repoOwner(scope?.hash ?? null, days), ...telemetry } };
}

async function runIdsForCwd(
	stateDir: string,
	inRepo: (cwd: string) => boolean,
	diagnostics: UsageDiagnostics,
): Promise<Set<string>> {
	try {
		const raw = await readFile(join(stateDir, "runs.json"), "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) throw new Error("expected array");
		const ids = new Set<string>();
		for (const entry of parsed) {
			if (!isRecord(entry)) continue;
			if (typeof entry.id === "string" && typeof entry.cwd === "string" && inRepo(entry.cwd)) ids.add(entry.id);
		}
		return ids;
	} catch (error) {
		diagnostics.notes.push(
			`run ledger unreadable, --repo run filter skipped: ${error instanceof Error ? error.message : String(error)}`,
		);
		return new Set<string>();
	}
}

async function readReceipts(
	stateDir: string,
	windowStart: number,
	windowEnd: number,
	diagnostics: UsageDiagnostics,
): Promise<UsageReceipt[]> {
	const root = join(stateDir, "receipts");
	let files: string[];
	try {
		files = (await readdir(root)).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}

	const receipts: UsageReceipt[] = [];
	for (const name of files) {
		let parsed: unknown;
		try {
			// A pruned receipt reads back from its evidence copy, as every receipt reader's does (#434).
			parsed = JSON.parse(await readReceiptText(join(root, name)));
		} catch {
			diagnostics.malformedReceipts += 1;
			continue;
		}
		if (!isRecord(parsed) || typeof parsed.runId !== "string" || typeof parsed.endedAt !== "string") {
			diagnostics.malformedReceipts += 1;
			continue;
		}
		if (!inUsageWindow(parsed.endedAt, windowStart, windowEnd)) continue;
		const toolStats = Array.isArray(parsed.toolStats)
			? parsed.toolStats.flatMap((entry) => {
					if (!isRecord(entry) || typeof entry.tool !== "string") return [];
					return [
						{
							tool: entry.tool,
							count: numberOr0(entry.count),
							ok: numberOr0(entry.ok),
							errors: numberOr0(entry.errors),
							blocked: numberOr0(entry.blocked),
						},
					];
				})
			: [];
		const skillActivations = Array.isArray(parsed.skillActivations)
			? parsed.skillActivations.flatMap((entry) => (isRecord(entry) && typeof entry.name === "string" ? [entry.name] : []))
			: [];
		receipts.push({
			runId: parsed.runId,
			cwd: typeof parsed.cwd === "string" ? parsed.cwd : null,
			agentId: typeof parsed.agentId === "string" ? parsed.agentId : "unknown",
			task: typeof parsed.task === "string" ? parsed.task : "",
			endedAt: parsed.endedAt,
			sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
			toolStats,
			skillActivations,
		});
	}
	return receipts;
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

function numberOr0(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
