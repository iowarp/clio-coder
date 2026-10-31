import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { clioDataDir, clioStateDir } from "../core/xdg.js";
import { loadMemoryRecordsSync, type MemoryRecord } from "../domains/memory/index.js";
import { loadSkills } from "../domains/resources/index.js";
import {
	foldRecallTelemetry,
	hasRecallTelemetry,
	listSessionLedgerRefs,
	parseSessionEntries,
	type RecallTelemetry,
} from "../domains/session/index.js";
import { summarizeEvidenceIndex } from "../domains/telemetry/accountability.js";
import { readEvidenceIndex } from "../domains/telemetry/evidence-index.js";
import { telemetryRunsDirectory } from "../domains/telemetry/paths.js";
import {
	type AccountabilityRecord,
	accountabilityRecords,
	cacheReport,
	repoCostReport,
	repoTokenQuantities,
	sessionJournals,
} from "../domains/telemetry/read-model.js";
import {
	emptyUsageDiagnostics,
	inUsageWindow,
	type UsageDiagnostics,
	usageWindow,
} from "../domains/telemetry/usage-window.js";
import { cwdHash } from "../engine/session.js";
import { displayToolCall } from "../tools/gateway-display.js";
import { expandChainMessages } from "../tools/surface.js";
import { formatColumns, printError } from "./shared.js";

const HELP = `clio-coder usage report [--repo <path>] [--days <n>] [--json]

Cross-session usage analyzer (experimental, read-only). Spend comes from the
telemetry read model: session, run and process call journals; without
--repo, the calls a process made with no session count too. Receipts, session
ledgers, the journals' safety decisions, the
evidence index and the memory store supply the other facts and the improvement
opportunities, every line citing ids and counts. Nothing is written or stored;
suggestions are printed only.

Flags:
  --repo <path>   restrict sessions (and runs via the run ledger) to one repo
  --days <n>      report window in days (default 30)
  --json          emit one JSONL row per fact and per opportunity
                  (schema: "experimental"); diagnostics stay on stderr
`;

const DEFAULT_WINDOW_DAYS = 30;

/** Linkage/bookkeeping tags that are not failure causes. */
const NON_FAILURE_TAGS = new Set([
	"session-linked",
	"audit-linked",
	"best-effort-link",
	"protected-artifact",
	"session-missing",
	"audit-missing",
]);

interface SessionUsage {
	harnessActions: number;
	duplicateDispatches: number;
	sessionId: string;
	cwdHash: string;
	bashShapes: Map<string, number>;
	skillActivations: Set<string>;
	entriesInWindow: number;
	/** #422: working-set recalls in the window and the tokens they sent back into context. */
	recall: RecallTelemetry;
}

/**
 * Both stores the report reads, and whether they are on disk at all.
 *
 * An absent store and an empty one are different facts with different remedies,
 * and the report printed the same `0` for both: a machine whose session store
 * had never been created, or had been removed, read as thirty quiet days.
 */
interface StorePresence {
	sessionsPath: string;
	sessionsPresent: boolean;
	runsPath: string;
	runsPresent: boolean;
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function readStorePresence(stateDir: string): Promise<StorePresence> {
	const sessionsPath = join(stateDir, "sessions");
	const runsPath = telemetryRunsDirectory(stateDir);
	return {
		sessionsPath,
		sessionsPresent: await isDirectory(sessionsPath),
		runsPath,
		runsPresent: await isDirectory(runsPath),
	};
}

function missingStoreNotes(presence: StorePresence): string[] {
	const notes: string[] = [];
	if (!presence.sessionsPresent) notes.push(`session store missing at ${presence.sessionsPath}`);
	if (!presence.runsPresent) notes.push(`run journal store missing at ${presence.runsPath}`);
	return notes;
}

interface ParsedArgs {
	command?: string;
	repo?: string;
	days: number;
	json: boolean;
	help: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
	const out: ParsedArgs = { days: DEFAULT_WINDOW_DAYS, json: false, help: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === undefined) continue;
		if (!out.command && !arg.startsWith("-")) {
			out.command = arg;
			continue;
		}
		switch (arg) {
			case "--json":
				out.json = true;
				break;
			case "--help":
			case "-h":
				out.help = true;
				break;
			case "--repo": {
				const value = argv[i + 1];
				if (!value || value.startsWith("-")) throw new Error("--repo requires a path");
				out.repo = value;
				i += 1;
				break;
			}
			case "--days": {
				const value = argv[i + 1];
				const days = value === undefined ? Number.NaN : Number.parseInt(value, 10);
				if (!Number.isInteger(days) || days <= 0) throw new Error("--days requires a positive integer");
				out.days = days;
				i += 1;
				break;
			}
			default:
				throw new Error(`unknown flag: ${arg}`);
		}
	}
	return out;
}

export async function runUsageCommand(argv: ReadonlyArray<string>): Promise<number> {
	let parsed: ParsedArgs;
	try {
		parsed = parseArgs(argv);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stderr.write(HELP);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(HELP);
		return 0;
	}
	// A bare `clio-coder usage` already exited 2, but wrote its usage to stdout,
	// which is where the report itself goes. Usage that stands in for output the
	// caller asked for belongs on stderr.
	if (parsed.command === undefined) {
		process.stderr.write(HELP);
		return 2;
	}
	if (parsed.command !== "report") {
		printError(`unknown usage command: ${parsed.command}`);
		process.stderr.write(HELP);
		return 2;
	}

	const stateDir = clioStateDir();
	const now = Date.now();
	const windowStart = now - parsed.days * 24 * 60 * 60 * 1000;
	const diagnostics = emptyUsageDiagnostics();

	const presence = await readStorePresence(stateDir);
	const repoPath = parsed.repo === undefined ? undefined : resolve(parsed.repo);
	const repoHash = repoPath === undefined ? undefined : cwdHash(repoPath);

	const sessions = await readSessions(stateDir, windowStart, now, repoHash, diagnostics);
	// Every token and cost figure is the read model's: one window over the sessions and the runs they reference, plus
	// standalone runs, folded once and worded by the canonical renderer, so nothing here sums spend (#434 §11.3).
	const { runs, repo } = await usageWindow(
		stateDir,
		repoPath === undefined ? null : { hash: cwdHash(repoPath), inRepo: (cwd) => cwd === repoPath },
		parsed.days,
		now,
		diagnostics,
	);
	const scope = { repo: repoPath ?? "all", days: parsed.days };
	const costReports = (["role", "model"] as const).map((groupBy) => repoCostReport(repo, scope, groupBy));
	const tokens = repoTokenQuantities(repo);
	const cacheReports = repo.sessions
		.map((source) => cacheReport(source))
		.filter((report) => Object.values(report.verdicts).some((count) => count > 0))
		.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
	const unreadableJournals = repo.sessions.filter(
		(source) => source.journal.skipped > 0 || source.journal.damaged > 0,
	).length;
	if (unreadableJournals > 0)
		diagnostics.notes.push(
			`${unreadableJournals} session call journal(s) have unreadable records; the totals they feed are partial`,
		);
	// Spend needs a store to measure: a missing session store with no standalone run has nothing to report.
	const spendMeasurable = presence.sessionsPresent || repo.runs.size > 0;
	const harnessActions = sessions.reduce((total, session) => total + session.harnessActions, 0);
	const duplicateDispatches = sessions.reduce((total, session) => total + session.duplicateDispatches, 0);
	// Safety decisions are the journals' accountability records, in the same window as the spend (#434).
	const decisions = accountabilityRecords([...repo.sessions.flatMap(sessionJournals), ...repo.runs.values()]).filter(
		(record) => inUsageWindow(record.t, windowStart, now),
	);
	const toolDecisions = decisions.filter((record) => record.k === "tool.decided");
	const permissions = summarizePermissionDecisions(decisions);
	const blockedDecisions = toolDecisions.filter(
		(record) => record.data.decision === "blocked" || record.data.decision === "denied",
	);
	const evidenceRows = readEvidenceIndex(stateDir).filter((row) => inUsageWindow(row.generatedAt, windowStart, now));
	const accountability = summarizeEvidenceIndex(evidenceRows);
	let memoryRecords: MemoryRecord[] = [];
	try {
		memoryRecords = loadMemoryRecordsSync(clioDataDir());
	} catch (error) {
		diagnostics.notes.push(`memory store unreadable: ${error instanceof Error ? error.message : String(error)}`);
	}
	const installedSkills = loadSkills({ cwd: repoPath ?? process.cwd() }).items.map((skill) => skill.name);

	// Aggregations
	const toolTotals = new Map<string, { count: number; ok: number; errors: number; blocked: number }>();
	for (const run of runs) {
		for (const statRow of run.toolStats) {
			const entry = toolTotals.get(statRow.tool) ?? { count: 0, ok: 0, errors: 0, blocked: 0 };
			entry.count += statRow.count;
			entry.ok += statRow.ok;
			entry.errors += statRow.errors;
			entry.blocked += statRow.blocked;
			toolTotals.set(statRow.tool, entry);
		}
	}
	const topTools = [...toolTotals.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 10);

	const shapeSessions = new Map<string, Set<string>>();
	const shapeCounts = new Map<string, number>();
	for (const session of sessions) {
		for (const [shape, count] of session.bashShapes) {
			shapeCounts.set(shape, (shapeCounts.get(shape) ?? 0) + count);
			const set = shapeSessions.get(shape) ?? new Set<string>();
			set.add(session.sessionId);
			shapeSessions.set(shape, set);
		}
	}
	const topShapes = [...shapeCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10);

	const activatedSkills = new Map<string, number>();
	for (const session of sessions) {
		for (const name of session.skillActivations) {
			activatedSkills.set(name, (activatedSkills.get(name) ?? 0) + 1);
		}
	}
	for (const run of runs) {
		for (const name of run.skillActivations) {
			activatedSkills.set(name, (activatedSkills.get(name) ?? 0) + 1);
		}
	}
	const neverActivated = installedSkills.filter((name) => !activatedSkills.has(name)).sort();

	const recipeRuns = new Map<string, number>();
	for (const run of runs) {
		recipeRuns.set(run.agentId, (recipeRuns.get(run.agentId) ?? 0) + 1);
	}

	const tagCounts = new Map<string, { count: number; latestEvidenceId: string; latestAt: string }>();
	for (const row of evidenceRows) {
		for (const tag of row.tags) {
			if (NON_FAILURE_TAGS.has(tag)) continue;
			const entry = tagCounts.get(tag);
			if (entry === undefined) {
				tagCounts.set(tag, { count: 1, latestEvidenceId: row.evidenceId, latestAt: row.generatedAt });
			} else {
				entry.count += 1;
				if (row.generatedAt > entry.latestAt) {
					entry.latestAt = row.generatedAt;
					entry.latestEvidenceId = row.evidenceId;
				}
			}
		}
	}

	const recallSessions = sessions
		.filter((session) => hasRecallTelemetry(session.recall))
		.sort((a, b) => a.sessionId.localeCompare(b.sessionId));

	const approvedMemory = memoryRecords.filter((record) => record.approved && record.rejectedAt === undefined);
	const pendingMemory = memoryRecords.filter((record) => !record.approved && record.rejectedAt === undefined);

	// Opportunities
	interface Opportunity {
		kind: string;
		suggestion: string;
		evidence: string;
	}
	const opportunities: Opportunity[] = [];
	const sessionsWithSkills = new Set(
		sessions.filter((session) => session.skillActivations.size > 0).map((session) => session.sessionId),
	);
	for (const [shape, ids] of [...shapeSessions.entries()].sort((a, b) => b[1].size - a[1].size)) {
		if (isTrivialShape(shape)) continue;
		const bareIds = [...ids].filter((id) => !sessionsWithSkills.has(id));
		if (bareIds.length < 3) continue;
		opportunities.push({
			kind: "workflow-capture",
			suggestion: `bash shape "${shape}" recurs with no skill activation; consider /skill workflow-capture to distill it`,
			evidence: `${bareIds.length} sessions: ${bareIds.slice(0, 5).join(", ")}${bareIds.length > 5 ? ", ..." : ""}`,
		});
	}
	const taskPrefixGroups = new Map<string, string[]>();
	for (const run of runs) {
		const prefix = run.task.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 64);
		if (prefix.length === 0) continue;
		const group = taskPrefixGroups.get(prefix) ?? [];
		group.push(run.runId);
		taskPrefixGroups.set(prefix, group);
	}
	for (const [prefix, runIds] of [...taskPrefixGroups.entries()].sort((a, b) => b[1].length - a[1].length)) {
		if (runIds.length < 2) continue;
		opportunities.push({
			kind: "recipe",
			suggestion: `dispatch task prefix "${prefix}" repeats; consider a recipe on the agents surface`,
			evidence: `${runIds.length} runs: ${runIds.slice(0, 5).join(", ")}${runIds.length > 5 ? ", ..." : ""}`,
		});
	}
	for (const [tag, info] of [...tagCounts.entries()].sort((a, b) => b[1].count - a[1].count)) {
		if (info.count < 2) continue;
		if (memoryMentions(memoryRecords, tag)) continue;
		opportunities.push({
			kind: "memory",
			suggestion: `failure tag "${tag}" recurs with no memory record; consider: clio-coder memory propose --from-evidence ${info.latestEvidenceId}`,
			evidence: `${info.count} evidence rows in window, latest ${info.latestEvidenceId} at ${info.latestAt}`,
		});
	}

	// Diagnostics to stderr (both modes)
	const diagParts: string[] = [];
	if (diagnostics.unreadableSessions > 0)
		diagParts.push(`${diagnostics.unreadableSessions} unreadable session ledger(s)`);
	if (diagnostics.malformedSessionLines > 0)
		diagParts.push(`${diagnostics.malformedSessionLines} malformed session line(s) skipped`);
	for (const note of diagnostics.notes) diagParts.push(note);
	if (diagParts.length > 0) process.stderr.write(`clio-coder usage: ${diagParts.join("; ")}\n`);

	const windowFrom = new Date(windowStart).toISOString();
	const windowTo = new Date(now).toISOString();

	if (parsed.json) {
		const emit = (row: Record<string, unknown>): void => {
			process.stdout.write(
				`${JSON.stringify({ schema: "experimental", windowDays: parsed.days, from: windowFrom, to: windowTo, ...row })}\n`,
			);
		};
		// A missing store emits its absence instead of a count, because `0` here
		// is a measurement and there was nothing to measure.
		if (presence.sessionsPresent) emit({ kind: "fact", fact: "sessions", value: sessions.length });
		else emit({ kind: "fact", fact: "session-store-missing", path: presence.sessionsPath });
		if (presence.runsPresent) emit({ kind: "fact", fact: "dispatch-runs", value: runs.length });
		else emit({ kind: "fact", fact: "run-store-missing", path: presence.runsPath });
		emit({ kind: "fact", fact: "unverified-successes", value: accountability.unverifiedSuccesses });
		emit({ kind: "fact", fact: "harness-actions", value: harnessActions });
		emit({ kind: "fact", fact: "duplicate-dispatches", value: duplicateDispatches });
		emit({ kind: "fact", fact: "ungrounded-claims", value: accountability.ungroundedClaims });
		emit({ kind: "fact", fact: "tool-decisions", value: toolDecisions.length, blocked: blockedDecisions.length });
		emit({ kind: "fact", fact: "permission-approval", ...permissions });
		if (spendMeasurable) {
			for (const report of costReports) emit({ kind: "fact", fact: "telemetry-cost", groupBy: report.groupBy, report });
			emit({ kind: "fact", fact: "telemetry-tokens", tokens });
			for (const report of cacheReports)
				emit({ kind: "fact", fact: "telemetry-cache", sessionId: report.sessionId, report });
			for (const session of recallSessions) {
				emit({
					kind: "fact",
					fact: "session-recall",
					sessionId: session.sessionId,
					toolRecalls: session.recall.toolRecalls,
					rereads: session.recall.rereads,
					operatorRecalls: session.recall.operatorRecalls,
					readmittedTokens: session.recall.readmittedTokens,
				});
			}
		}
		for (const [tool, totals] of topTools) emit({ kind: "fact", fact: "top-tool", tool, ...totals });
		for (const [shape, count] of topShapes) {
			emit({ kind: "fact", fact: "bash-shape", shape, count, sessions: shapeSessions.get(shape)?.size ?? 0 });
		}
		for (const [name, count] of [...activatedSkills.entries()].sort((a, b) => b[1] - a[1])) {
			emit({ kind: "fact", fact: "skill-activated", skill: name, activations: count });
		}
		for (const name of neverActivated) emit({ kind: "fact", fact: "skill-never-activated", skill: name });
		for (const [agentId, count] of [...recipeRuns.entries()].sort((a, b) => b[1] - a[1])) {
			emit({ kind: "fact", fact: "recipe-used", agentId, runs: count });
		}
		for (const [tag, info] of [...tagCounts.entries()].sort((a, b) => b[1].count - a[1].count)) {
			emit({ kind: "fact", fact: "failure-tag", tag, count: info.count, latestEvidenceId: info.latestEvidenceId });
		}
		emit({ kind: "fact", fact: "memory", approved: approvedMemory.length, pending: pendingMemory.length });
		for (const opportunity of opportunities) {
			emit({
				kind: "opportunity",
				opportunity: opportunity.kind,
				suggestion: opportunity.suggestion,
				evidence: opportunity.evidence,
			});
		}
		return 0;
	}

	const out = (text: string): void => {
		process.stdout.write(`${text}\n`);
	};
	out(
		`usage report: last ${parsed.days} days (${windowFrom} -> ${windowTo})${repoPath === undefined ? "" : ` repo=${repoPath}`}`,
	);
	out("");
	out("facts");
	// `sessions in window: 0` over a store that does not exist is a measurement
	// of nothing reported as a measurement of zero. The two have different
	// remedies, so the row says which one this is.
	if (presence.sessionsPresent) {
		out(`  sessions in window: ${sessions.length} (${sessionsWithSkills.size} with skill activations)`);
	} else {
		out(`  session store missing at ${presence.sessionsPath}`);
	}
	if (presence.runsPresent) {
		out(`  dispatch runs in window: ${runs.length}`);
	} else {
		out(`  run journal store missing at ${presence.runsPath}`);
	}
	out(
		`  permission decisions: ${permissions.requested} requested, ${permissions.granted} granted, ${permissions.denied} denied, ${permissions.expired} expired; approval rate ${permissions.approvalRate === null ? "n/a" : `${(permissions.approvalRate * 100).toFixed(1)}%`}`,
	);
	out(`  tool decisions in window: ${toolDecisions.length} (${blockedDecisions.length} blocked/denied)`);
	const [byOrigin] = costReports;
	if (spendMeasurable && byOrigin)
		out(
			`  recorded spend in window (sessions, side calls and worker runs): cost ${byOrigin.total.usd.display}, tokens ${byOrigin.total.tokens.display}, calls ${byOrigin.total.calls.display}`,
		);
	if (spendMeasurable)
		out(
			`  token fields: input ${tokens.input.display}, output ${tokens.output.display}, cache read ${tokens.cacheRead.display}, cache write ${tokens.cacheWrite.display}, reasoning ${tokens.reasoning.display}`,
		);
	for (const report of spendMeasurable ? costReports : []) {
		if (report.groups.length === 0) continue;
		const subject = report.groupBy === "role" ? "agent" : "target/model";
		out("");
		out(`  spend by ${subject}`);
		process.stdout.write(
			indent(
				formatColumns([
					// A model's row splits its cost between the sessions' own calls and the worker runs (#434 §11.3).
					[subject, "calls", "tokens", "cost", ...(report.groupBy === "role" ? [] : ["session cost", "worker cost"])],
					...report.groups.map((group) => [
						group.key,
						group.calls.display,
						group.tokens.display,
						group.usd.display,
						...(group.audience ? [group.audience.session.usd.display, group.audience.worker.usd.display] : []),
					]),
				]),
			),
		);
	}
	if (spendMeasurable && cacheReports.length > 0) {
		out("");
		out("  prompt cache by session");
		process.stdout.write(
			indent(
				formatColumns([
					[
						"session",
						"cache read",
						"cache write",
						"uncached prefill",
						"re-prefilled",
						"cache-break bill",
						"hot/partial/cold/small/unknown",
					],
					...cacheReports.map((report) => [
						report.sessionId,
						report.cacheRead.display,
						report.cacheWrite.display,
						report.uncachedPrefill.display,
						report.rePrefilled.display,
						report.breakUsd.display,
						[
							report.verdicts.hot,
							report.verdicts.partial,
							report.verdicts.cold,
							report.verdicts.small,
							report.verdicts.unknown,
						].join("/"),
					]),
				]),
			),
		);
	}
	if (recallSessions.length > 0) {
		out("");
		out(
			"  working-set recall by session (tokens the model asked back after eviction; estimate, operator recalls not billed)",
		);
		process.stdout.write(
			indent(
				formatColumns([
					["session", "recalls", "rereads", "operator", "readmitted tokens"],
					...recallSessions.map((session) => [
						session.sessionId,
						String(session.recall.toolRecalls),
						String(session.recall.rereads),
						String(session.recall.operatorRecalls),
						String(session.recall.readmittedTokens),
					]),
				]),
			),
		);
	}
	if (topTools.length > 0) {
		out("");
		out("  top tools (from settled runs)");
		process.stdout.write(
			indent(
				formatColumns([
					["tool", "calls", "ok", "errors", "blocked"],
					...topTools.map(([tool, totals]) => [
						tool,
						String(totals.count),
						String(totals.ok),
						String(totals.errors),
						String(totals.blocked),
					]),
				]),
			),
		);
	}
	if (topShapes.length > 0) {
		out("");
		out("  top bash shapes (from session ledgers, arguments stripped)");
		process.stdout.write(
			indent(
				formatColumns([
					["shape", "calls", "sessions"],
					...topShapes.map(([shape, count]) => [shape, String(count), String(shapeSessions.get(shape)?.size ?? 0)]),
				]),
			),
		);
	}
	out("");
	if (activatedSkills.size > 0) {
		out("  skills activated");
		process.stdout.write(
			indent(
				formatColumns([
					["skill", "activations"],
					...[...activatedSkills.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => [name, String(count)]),
				]),
			),
		);
	} else {
		out("  skills activated: none");
	}
	out(
		`  installed but never activated (${neverActivated.length}): ${neverActivated.length > 0 ? neverActivated.join(", ") : "none"}`,
	);
	if (recipeRuns.size > 0) {
		out("");
		out("  dispatch recipes used");
		process.stdout.write(
			indent(
				formatColumns([
					["recipe", "runs"],
					...[...recipeRuns.entries()].sort((a, b) => b[1] - a[1]).map(([agentId, count]) => [agentId, String(count)]),
				]),
			),
		);
	}
	out(`  unverified successes: ${accountability.unverifiedSuccesses}`);
	out(`  harness actions: ${harnessActions}`);
	out(`  duplicate dispatches: ${duplicateDispatches}`);
	out(`  ungrounded claims: ${accountability.ungroundedClaims}`);
	if (tagCounts.size > 0) {
		out("");
		out("  failure tags (from evidence index)");
		process.stdout.write(
			indent(
				formatColumns([
					["tag", "count", "latest evidence"],
					...[...tagCounts.entries()]
						.sort((a, b) => b[1].count - a[1].count)
						.map(([tag, info]) => [tag, String(info.count), info.latestEvidenceId]),
				]),
			),
		);
	}
	out("");
	out(`  memory records: ${approvedMemory.length} approved, ${pendingMemory.length} pending`);
	out("");
	out("opportunities");
	const absentInputs = missingStoreNotes(presence);
	if (opportunities.length === 0 && absentInputs.length > 0) {
		// "none" is a conclusion, and a conclusion drawn from stores that are not
		// there is one this command did not earn. Say what is missing instead.
		out(`  not computed: the inputs are absent (${absentInputs.join("; ")})`);
	} else if (opportunities.length === 0) {
		out("  none: no recurring unskilled bash shapes, repeated dispatch tasks, or unmemorized failure tags in window");
	} else {
		for (const opportunity of opportunities) {
			out(`  [${opportunity.kind}] ${opportunity.suggestion}`);
			out(`    evidence: ${opportunity.evidence}`);
		}
	}
	return 0;
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((line) => (line.length > 0 ? `  ${line}` : line))
		.join("\n");
}

async function readSessions(
	stateDir: string,
	windowStart: number,
	windowEnd: number,
	repoHash: string | undefined,
	diagnostics: UsageDiagnostics,
): Promise<SessionUsage[]> {
	const refs = await listSessionLedgerRefs(stateDir, repoHash);
	const sessions: SessionUsage[] = [];
	for (const ref of refs) {
		let mtimeMs: number;
		try {
			mtimeMs = (await stat(ref.path)).mtimeMs;
		} catch {
			// A session directory without current.jsonl (e.g. archived) is not an error.
			continue;
		}
		// A ledger untouched since before the window holds no in-window entry; spend is read through the read model.
		if (mtimeMs < windowStart) continue;
		let raw: string;
		try {
			raw = await readFile(ref.path, "utf8");
		} catch {
			diagnostics.unreadableSessions += 1;
			continue;
		}
		const parsedEntries = parseSessionEntries(raw, ref.path);
		diagnostics.malformedSessionLines += parsedEntries.errors.length;
		const accountingEntries = parsedEntries.entries.filter(
			(entry) => entry.kind === "modelChange" || inUsageWindow(entry.timestamp, windowStart, windowEnd),
		);
		const usage: SessionUsage = {
			harnessActions: 0,
			duplicateDispatches: 0,
			sessionId: ref.sessionId,
			cwdHash: ref.cwdHash,
			bashShapes: new Map(),
			skillActivations: new Set(),
			entriesInWindow: 0,
			recall: foldRecallTelemetry(accountingEntries),
		};
		for (const entry of parsedEntries.entries) {
			if (!inUsageWindow(entry.timestamp, windowStart, windowEnd)) continue;
			usage.entriesInWindow += 1;
			if (entry.kind === "custom" && entry.customType === "turnOutcome" && isRecord(entry.data)) {
				const harness = entry.data.harness;
				if (
					isRecord(harness) &&
					((Array.isArray(harness.runIds) && harness.runIds.length > 0) || numberOr0(harness.reads) > 0)
				)
					usage.harnessActions += 1;
				const coordinator = entry.data.coordinator;
				if (isRecord(coordinator) && coordinator.duplicateDispatch === true) usage.duplicateDispatches += 1;
			}
			if (entry.kind === "skillActivation") {
				usage.skillActivations.add(entry.activation.name);
				continue;
			}
			const commands: string[] = [];
			if (entry.kind === "bashExecution") {
				commands.push(entry.command);
			} else if (entry.kind === "message" && entry.role === "tool_call") {
				const command = bashCommandFromToolCallPayload(entry.payload);
				if (command !== null) commands.push(command);
			} else if (entry.kind === "message" && entry.role === "tool_result") {
				// A chain's bash steps ran as bash; its one call record names only gateway.
				for (const step of expandChainMessages([entry]).slice(1)) {
					if (step.kind !== "message" || step.role !== "tool_call") continue;
					const command = bashCommandFromToolCallPayload(step.payload);
					if (command !== null) commands.push(command);
				}
			}
			for (const command of commands) {
				const shape = bashShape(command);
				if (shape.length > 0) usage.bashShapes.set(shape, (usage.bashShapes.get(shape) ?? 0) + 1);
			}
		}
		if (usage.entriesInWindow > 0) sessions.push(usage);
	}
	return sessions;
}

/** Extract the bash command from a tool_call session payload, a gateway op=call to bash included, else null. */
function bashCommandFromToolCallPayload(payload: unknown): string | null {
	if (!isRecord(payload)) return null;
	const wire = firstString(payload.name, payload.toolName, payload.tool);
	if (wire === null) return null;
	const rawArgs = payload.arguments ?? payload.args ?? payload.input;
	const call = displayToolCall(wire, isRecord(rawArgs) ? rawArgs : maybeJsonRecord(rawArgs));
	if (call.toolName !== "bash") return null;
	const command = call.args?.command;
	return typeof command === "string" && command.length > 0 ? command : null;
}

/**
 * Normalize a bash command to its shape: first pipeline segment only, env
 * assignments dropped, verb plus subcommand kept, flags kept with values
 * stripped, remaining arguments dropped.
 */
function bashShape(command: string): string {
	const firstLine = command.split("\n").find((line) => {
		const trimmed = line.trim();
		return trimmed.length > 0 && !trimmed.startsWith("#");
	});
	if (firstLine === undefined) return "";
	const firstSegment = firstLine.split(/&&|\|\||;|\|/)[0] ?? "";
	const tokens = firstSegment
		.trim()
		.split(/\s+/)
		.filter((token) => token.length > 0);
	const out: string[] = [];
	let positionals = 0;
	for (const token of tokens) {
		if (positionals === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
		if (token.startsWith("-")) {
			const flag = token.split("=")[0] ?? token;
			out.push(flag);
			continue;
		}
		if (positionals < 2) {
			const clean = positionals === 0 ? (token.split("/").at(-1) ?? token) : token;
			if (positionals === 1 && !/^[A-Za-z][A-Za-z0-9._-]*$/.test(clean)) {
				positionals += 1;
				continue;
			}
			out.push(clean);
			positionals += 1;
		}
	}
	return out.join(" ");
}

/**
 * Shell furniture whose recurrence says nothing about a distillable workflow.
 * Applies to the workflow-capture opportunity only; the facts table still
 * reports these shapes.
 */
const TRIVIAL_SHAPE_VERBS = new Set([
	"cd",
	"ls",
	"pwd",
	"cat",
	"echo",
	"wc",
	"which",
	"head",
	"tail",
	"mkdir",
	"cp",
	"mv",
	"touch",
	"true",
	"env",
	"date",
]);

function isTrivialShape(shape: string): boolean {
	const verb = shape.split(" ")[0] ?? "";
	return TRIVIAL_SHAPE_VERBS.has(verb);
}

function memoryMentions(records: ReadonlyArray<MemoryRecord>, tag: string): boolean {
	const needle = tag.toLowerCase();
	return records.some((record) => {
		if (record.rejectedAt !== undefined) return false;
		const haystacks = [record.key, record.lesson, ...record.appliesWhen, ...record.evidenceRefs];
		return haystacks.some((text) => text.toLowerCase().includes(needle));
	});
}

function firstString(...values: unknown[]): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.length > 0) return value;
	}
	return null;
}

function maybeJsonRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "string") return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function numberOr0(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Event-window approval rate. Resolutions can belong to requests outside the window. */
export function summarizePermissionDecisions(records: ReadonlyArray<AccountabilityRecord>): {
	requested: number;
	granted: number;
	denied: number;
	expired: number;
	approvalRate: number | null;
} {
	const counts = { requested: 0, granted: 0, denied: 0, expired: 0 };
	// A forwarded ask republishes its request; one request id is one ask.
	const asked = new Set<string>();
	for (const record of records) {
		if (record.k === "approval.requested") {
			const id = record.data.requestId;
			if (id === undefined || !asked.has(id)) counts.requested += 1;
			if (id !== undefined) asked.add(id);
		} else if (record.k === "approval.resolved") counts[record.data.status] += 1;
	}
	return { ...counts, approvalRate: counts.requested === 0 ? null : counts.granted / counts.requested };
}
