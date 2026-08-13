import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { clioDataDir, clioStateDir } from "../core/xdg.js";
import { loadMemoryRecordsSync, type MemoryRecord } from "../domains/memory/index.js";
import { readEvidenceIndex } from "../domains/observability/evidence-index.js";
import { loadSkills } from "../domains/resources/index.js";
import {
	type LedgerUsageCall,
	ledgerUsageCalls,
	listSessionLedgerRefs,
	parseSessionEntries,
	readAuditRows,
} from "../domains/session/index.js";
import { cwdHash } from "../engine/session.js";
import { formatColumns, printError } from "./shared.js";

const HELP = `clio usage report [--repo <path>] [--days <n>] [--json]

Cross-session usage analyzer (experimental, read-only). Reads the local usage
archive (receipts, session ledgers, audit rows, evidence index, memory store)
and reports facts plus improvement opportunities, every line citing ids and
counts. Nothing is written or stored; suggestions are printed only.

Flags:
  --repo <path>   restrict sessions (and runs via the run ledger) to one repo
  --days <n>      report window in days (default 30)
  --json          emit one JSONL row per fact and per opportunity
                  (schema: "experimental"); diagnostics stay on stderr
`;

const DEFAULT_WINDOW_DAYS = 30;
const RECEIPT_CAP = 1000;
const USAGE_WINDOW_FUTURE_SKEW_MS = 5_000;

/** Linkage/bookkeeping tags that are not failure causes. */
const NON_FAILURE_TAGS = new Set([
	"session-linked",
	"audit-linked",
	"best-effort-link",
	"protected-artifact",
	"session-missing",
	"audit-missing",
]);

interface UsageReceipt {
	runId: string;
	agentId: string;
	task: string;
	startedAt: string;
	endedAt: string;
	sessionId: string | null;
	toolStats: Array<{ tool: string; count: number; ok: number; errors: number; blocked: number }>;
	skillActivations: string[];
}

interface SessionUsage {
	sessionId: string;
	cwdHash: string;
	bashShapes: Map<string, number>;
	skillActivations: Set<string>;
	entriesInWindow: number;
	/** Completed API calls this session recorded in the window, one per call. */
	usageCalls: LedgerUsageCall[];
}

/** Per-call usage folded over one grouping (a model, or the whole window). */
interface UsageTotals {
	apiCalls: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoningTokens: number;
	totalTokens: number;
	costUsd: number;
}

function emptyUsageTotals(): UsageTotals {
	return {
		apiCalls: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoningTokens: 0,
		totalTokens: 0,
		costUsd: 0,
	};
}

function addUsageCall(totals: UsageTotals, call: LedgerUsageCall): void {
	totals.apiCalls += call.apiCalls ?? 1;
	totals.input += call.input;
	totals.output += call.output;
	totals.cacheRead += call.cacheRead;
	totals.cacheWrite += call.cacheWrite;
	totals.reasoningTokens += call.reasoningTokens;
	totals.totalTokens += call.totalTokens;
	totals.costUsd += call.costUsd;
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
	receiptsPath: string;
	receiptsPresent: boolean;
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
	const receiptsPath = join(stateDir, "receipts");
	return {
		sessionsPath,
		sessionsPresent: await isDirectory(sessionsPath),
		receiptsPath,
		receiptsPresent: await isDirectory(receiptsPath),
	};
}

function missingStoreNotes(presence: StorePresence): string[] {
	const notes: string[] = [];
	if (!presence.sessionsPresent) notes.push(`session store missing at ${presence.sessionsPath}`);
	if (!presence.receiptsPresent) notes.push(`receipt store missing at ${presence.receiptsPath}`);
	return notes;
}

interface Diagnostics {
	malformedReceipts: number;
	unreadableSessions: number;
	malformedSessionLines: number;
	malformedAuditRows: number;
	notes: string[];
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
	if (parsed.help || parsed.command === undefined) {
		process.stdout.write(HELP);
		return parsed.help ? 0 : 2;
	}
	if (parsed.command !== "report") {
		printError(`unknown usage command: ${parsed.command}`);
		process.stderr.write(HELP);
		return 2;
	}

	const stateDir = clioStateDir();
	const now = Date.now();
	const windowStart = now - parsed.days * 24 * 60 * 60 * 1000;
	const diagnostics: Diagnostics = {
		malformedReceipts: 0,
		unreadableSessions: 0,
		malformedSessionLines: 0,
		malformedAuditRows: 0,
		notes: [],
	};

	const presence = await readStorePresence(stateDir);
	const repoPath = parsed.repo === undefined ? undefined : resolve(parsed.repo);
	const repoHash = repoPath === undefined ? undefined : cwdHash(repoPath);
	const repoRunIds = repoPath === undefined ? null : await runIdsForCwd(stateDir, repoPath, diagnostics);

	const receipts = (await readReceipts(stateDir, windowStart, now, diagnostics)).filter(
		(receipt) => repoRunIds === null || repoRunIds.has(receipt.runId),
	);
	const sessions = await readSessions(stateDir, windowStart, now, repoHash, diagnostics);
	const auditRows = await readAuditRows(stateDir);
	diagnostics.malformedAuditRows = auditRows.errors.length;
	const auditInWindow = auditRows.rows.filter((row) => row.ts !== null && inWindow(row.ts, windowStart, now));
	const auditToolCalls = auditInWindow.filter((row) => row.auditKind === "tool_call");
	const auditBlocked = auditToolCalls.filter((row) => {
		const decision = typeof row.row.decision === "string" ? row.row.decision : "";
		return decision === "blocked" || decision === "denied";
	});
	const evidenceRows = readEvidenceIndex(stateDir).filter((row) => inWindow(row.generatedAt, windowStart, now));
	let memoryRecords: MemoryRecord[] = [];
	try {
		memoryRecords = loadMemoryRecordsSync(clioDataDir());
	} catch (error) {
		diagnostics.notes.push(`memory store unreadable: ${error instanceof Error ? error.message : String(error)}`);
	}
	const installedSkills = loadSkills({ cwd: repoPath ?? process.cwd() }).items.map((skill) => skill.name);

	// Aggregations
	const toolTotals = new Map<string, { count: number; ok: number; errors: number; blocked: number }>();
	for (const receipt of receipts) {
		for (const statRow of receipt.toolStats) {
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
	for (const receipt of receipts) {
		for (const name of receipt.skillActivations) {
			activatedSkills.set(name, (activatedSkills.get(name) ?? 0) + 1);
		}
	}
	const neverActivated = installedSkills.filter((name) => !activatedSkills.has(name)).sort();

	const recipeRuns = new Map<string, number>();
	for (const receipt of receipts) {
		recipeRuns.set(receipt.agentId, (recipeRuns.get(receipt.agentId) ?? 0) + 1);
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

	// Token and cost facts fold the same per-call usage the `/cost` overlay
	// reseeds from, through the same session-domain function, so the report and
	// the overlay cannot disagree about what a session spent.
	const usageByModel = new Map<string, { providerId: string; modelId: string; totals: UsageTotals }>();
	const usageTotals = emptyUsageTotals();
	for (const session of sessions) {
		for (const call of session.usageCalls) {
			addUsageCall(usageTotals, call);
			const key = `${call.providerId}::${call.modelId}`;
			const entry = usageByModel.get(key) ?? {
				providerId: call.providerId,
				modelId: call.modelId,
				totals: emptyUsageTotals(),
			};
			addUsageCall(entry.totals, call);
			usageByModel.set(key, entry);
		}
	}
	const usageRows = [...usageByModel.values()].sort(
		(a, b) => b.totals.totalTokens - a.totals.totalTokens || a.providerId.localeCompare(b.providerId),
	);

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
			kind: "workflow-distiller",
			suggestion: `bash shape "${shape}" recurs with no skill activation; consider /skill:workflow-distiller to distill it`,
			evidence: `${bareIds.length} sessions: ${bareIds.slice(0, 5).join(", ")}${bareIds.length > 5 ? ", ..." : ""}`,
		});
	}
	const taskPrefixGroups = new Map<string, string[]>();
	for (const receipt of receipts) {
		const prefix = receipt.task.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 64);
		if (prefix.length === 0) continue;
		const group = taskPrefixGroups.get(prefix) ?? [];
		group.push(receipt.runId);
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
			suggestion: `failure tag "${tag}" recurs with no memory record; consider: clio memory propose --from-evidence ${info.latestEvidenceId}`,
			evidence: `${info.count} evidence rows in window, latest ${info.latestEvidenceId} at ${info.latestAt}`,
		});
	}

	// Diagnostics to stderr (both modes)
	const diagParts: string[] = [];
	if (diagnostics.malformedReceipts > 0) diagParts.push(`${diagnostics.malformedReceipts} malformed receipt(s) skipped`);
	if (diagnostics.unreadableSessions > 0)
		diagParts.push(`${diagnostics.unreadableSessions} unreadable session ledger(s)`);
	if (diagnostics.malformedSessionLines > 0)
		diagParts.push(`${diagnostics.malformedSessionLines} malformed session line(s) skipped`);
	if (diagnostics.malformedAuditRows > 0)
		diagParts.push(`${diagnostics.malformedAuditRows} malformed audit row(s) skipped`);
	for (const note of diagnostics.notes) diagParts.push(note);
	if (diagParts.length > 0) process.stderr.write(`clio usage: ${diagParts.join("; ")}\n`);

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
		if (presence.receiptsPresent) emit({ kind: "fact", fact: "dispatch-runs", value: receipts.length });
		else emit({ kind: "fact", fact: "receipt-store-missing", path: presence.receiptsPath });
		emit({ kind: "fact", fact: "audit-tool-calls", value: auditToolCalls.length, blocked: auditBlocked.length });
		if (presence.sessionsPresent) {
			emit({ kind: "fact", fact: "tokens", ...usageTotals });
			for (const row of usageRows) {
				emit({ kind: "fact", fact: "model-usage", providerId: row.providerId, modelId: row.modelId, ...row.totals });
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
	if (presence.receiptsPresent) {
		out(`  dispatch runs (receipts) in window: ${receipts.length}`);
	} else {
		out(`  receipt store missing at ${presence.receiptsPath}`);
	}
	out(`  audited tool calls in window: ${auditToolCalls.length} (${auditBlocked.length} blocked/denied)`);
	if (presence.sessionsPresent) {
		out(
			`  tokens in window: ${usageTotals.totalTokens} over ${usageTotals.apiCalls} model calls (input ${usageTotals.input}, output ${usageTotals.output}, cache read ${usageTotals.cacheRead}, cache write ${usageTotals.cacheWrite}, reasoning ${usageTotals.reasoningTokens})`,
		);
		out(`  provider-reported cost in window: $${usageTotals.costUsd.toFixed(4)}`);
	}
	if (usageRows.length > 0) {
		out("");
		out("  tokens by model (from session ledgers, provider-reported)");
		process.stdout.write(
			indent(
				formatColumns([
					["provider", "model", "calls", "input", "output", "cache read", "reasoning", "tokens", "cost"],
					...usageRows.map((row) => [
						row.providerId,
						row.modelId,
						String(row.totals.apiCalls),
						String(row.totals.input),
						String(row.totals.output),
						String(row.totals.cacheRead),
						String(row.totals.reasoningTokens),
						String(row.totals.totalTokens),
						`$${row.totals.costUsd.toFixed(4)}`,
					]),
				]),
			),
		);
	}
	if (topTools.length > 0) {
		out("");
		out("  top tools (from receipt toolStats)");
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

export function inWindow(iso: string, start: number, end: number): boolean {
	const value = Date.parse(iso);
	return Number.isFinite(value) && value >= start && value <= end + USAGE_WINDOW_FUTURE_SKEW_MS;
}

async function runIdsForCwd(stateDir: string, repoPath: string, diagnostics: Diagnostics): Promise<Set<string>> {
	try {
		const raw = await readFile(join(stateDir, "runs.json"), "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) throw new Error("expected array");
		const ids = new Set<string>();
		for (const entry of parsed) {
			if (!isRecord(entry)) continue;
			if (typeof entry.id === "string" && entry.cwd === repoPath) ids.add(entry.id);
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
	diagnostics: Diagnostics,
): Promise<UsageReceipt[]> {
	const root = join(stateDir, "receipts");
	let files: string[];
	try {
		files = (await readdir(root)).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	if (files.length > RECEIPT_CAP) {
		const withTimes: Array<{ name: string; mtimeMs: number }> = [];
		for (const name of files) {
			try {
				withTimes.push({ name, mtimeMs: (await stat(join(root, name))).mtimeMs });
			} catch {
				diagnostics.malformedReceipts += 1;
			}
		}
		withTimes.sort((a, b) => b.mtimeMs - a.mtimeMs);
		const kept = withTimes.slice(0, RECEIPT_CAP);
		process.stderr.write(
			`clio usage: receipt cap: reading newest ${RECEIPT_CAP} of ${files.length} receipts; oldest ${files.length - RECEIPT_CAP} truncated\n`,
		);
		files = kept.map((entry) => entry.name);
	}
	const receipts: UsageReceipt[] = [];
	for (const name of files) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(join(root, name), "utf8"));
		} catch {
			diagnostics.malformedReceipts += 1;
			continue;
		}
		if (!isRecord(parsed) || typeof parsed.runId !== "string" || typeof parsed.endedAt !== "string") {
			diagnostics.malformedReceipts += 1;
			continue;
		}
		if (!inWindow(parsed.endedAt, windowStart, windowEnd)) continue;
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
			agentId: typeof parsed.agentId === "string" ? parsed.agentId : "unknown",
			task: typeof parsed.task === "string" ? parsed.task : "",
			startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : parsed.endedAt,
			endedAt: parsed.endedAt,
			sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null,
			toolStats,
			skillActivations,
		});
	}
	return receipts;
}

async function readSessions(
	stateDir: string,
	windowStart: number,
	windowEnd: number,
	repoHash: string | undefined,
	diagnostics: Diagnostics,
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
		// Ledgers untouched since before the window cannot contain in-window entries.
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
		const usage: SessionUsage = {
			sessionId: ref.sessionId,
			cwdHash: ref.cwdHash,
			bashShapes: new Map(),
			skillActivations: new Set(),
			entriesInWindow: 0,
			// modelChange rows are kept regardless of the window: they carry no
			// usage of their own, and dropping the ones that predate the window
			// would attribute in-window calls to the wrong target.
			usageCalls: ledgerUsageCalls(
				parsedEntries.entries.filter(
					(entry) => entry.kind === "modelChange" || inWindow(entry.timestamp, windowStart, windowEnd),
				),
			),
		};
		for (const entry of parsedEntries.entries) {
			if (!inWindow(entry.timestamp, windowStart, windowEnd)) continue;
			usage.entriesInWindow += 1;
			if (entry.kind === "skillActivation") {
				usage.skillActivations.add(entry.activation.name);
				continue;
			}
			let command: string | null = null;
			if (entry.kind === "bashExecution") {
				command = entry.command;
			} else if (entry.kind === "message" && entry.role === "tool_call") {
				command = bashCommandFromToolCallPayload(entry.payload);
			}
			if (command !== null) {
				const shape = bashShape(command);
				if (shape.length > 0) usage.bashShapes.set(shape, (usage.bashShapes.get(shape) ?? 0) + 1);
			}
		}
		if (usage.entriesInWindow > 0) sessions.push(usage);
	}
	return sessions;
}

/** Extract the bash command from a tool_call session payload, else null. */
function bashCommandFromToolCallPayload(payload: unknown): string | null {
	if (!isRecord(payload)) return null;
	const tool = firstString(payload.name, payload.toolName, payload.tool);
	if (tool !== "bash") return null;
	const args = payload.arguments ?? payload.args ?? payload.input;
	const argRecord = isRecord(args) ? args : maybeJsonRecord(args);
	const command = argRecord?.command;
	return typeof command === "string" && command.length > 0 ? command : null;
}

/**
 * Normalize a bash command to its shape: first pipeline segment only, env
 * assignments dropped, verb plus subcommand kept, flags kept with values
 * stripped, remaining arguments dropped.
 */
export function bashShape(command: string): string {
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
 * Applies to the workflow-distiller opportunity only; the facts table still
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
