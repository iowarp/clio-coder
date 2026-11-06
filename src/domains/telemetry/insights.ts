/**
 * Where Clio helps a project, from telemetry it already keeps on this machine. Each session gets one research task
 * category and an autonomy level from 1 to 5, both decided by fixed rules over content-free signals: which tools ran,
 * the kind of file a write touched by extension, the kind of check a verify ran, the skills loaded, worker runs,
 * approvals, operator messages, the autonomy mode and active time. It is a heuristic and says so wherever it prints.
 *
 * Content stays out by construction. The classifier reads only the record kinds in {@link INSIGHT_RECORD_KINDS}, all
 * registered as content-free or structural, and the settings object a config record cites, whose subject is never a
 * content subject. The verified-outcome share reads the session ledger only through {@link outcomeLedgerProjection},
 * which copies the typed fields the outcome count reads and leaves every text field behind.
 */

import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { JournalEventName } from "../../core/telemetry/events.js";
import type { ToolFileKind } from "../../core/telemetry/schemas.js";
import { TASK_BOARD_COMPLETION_CLAIM_PREFIX } from "../session/task-board.js";

export const INSIGHT_CATEGORIES = [
	"data analysis",
	"writing and communication",
	"data gathering",
	"reading and knowledge acquisition",
	"theoretical analysis",
	"design and development",
	"ideation and hypothesis generation",
	"other",
	"software (non-research)",
] as const;
export type InsightCategory = (typeof INSIGHT_CATEGORIES)[number];

export const AUTONOMY_LEVELS = [1, 2, 3, 4, 5] as const;
export type AutonomyLevelScore = (typeof AUTONOMY_LEVELS)[number];

export const INSIGHTS_HEURISTIC_NOTE =
	"Heuristic: categories and autonomy come from fixed rules over tool names, file kinds by extension, check kinds, skill names, worker runs, approvals and timing. No message content is read, so a session can land in the wrong category.";

/** The only journal record kinds the classifier reads. Each is registered content-free or structural. */
export const INSIGHT_RECORD_KINDS = [
	"tool.settled",
	"approval.resolved",
	"approval.requested",
	"message.stepped",
	"run.linked",
	"run.settled",
	"config.snapshotted",
	"config.changed",
] as const satisfies ReadonlyArray<JournalEventName>;
type InsightKind = (typeof INSIGHT_RECORD_KINDS)[number];
const INSIGHT_KIND_SET: ReadonlySet<string> = new Set(INSIGHT_RECORD_KINDS);

const PROSE: ReadonlySet<ToolFileKind> = new Set(["md", "tex", "bib", "rst"]);
const CODE: ReadonlySet<ToolFileKind> = new Set([
	"py",
	"r",
	"jl",
	"m",
	"c",
	"cpp",
	"h",
	"f90",
	"rs",
	"go",
	"java",
	"js",
	"ts",
	"sh",
]);
const DATA_FILES: ReadonlySet<ToolFileKind> = new Set(["csv", "tsv", "parquet", "h5", "nc", "npy"]);
/** Tools that are themselves software work when no research signal is present. */
const SOFTWARE_TOOLS: ReadonlySet<string> = new Set(["bash", "git", "code_nav", "write", "edit"]);

/** Library skills whose category is known; any other skill falls back to the name rules below. */
const SKILL_CATEGORIES: Readonly<Record<string, InsightCategory>> = {
	"arxiv-literature": "reading and knowledge acquisition",
	"materio-literature-reviewer": "reading and knowledge acquisition",
	"experiment-protocol": "design and development",
	"materio-lab-definer": "design and development",
	"materio-workflow-planner": "design and development",
	"scientific-modernization": "design and development",
	"scientific-debugging": "design and development",
	"materio-research-explorer": "ideation and hypothesis generation",
	"materio-task-executor": "data analysis",
	"materio-task-verifier": "data analysis",
};
/** Name rules for skills outside the table, first match wins. */
const SKILL_NAME_RULES: ReadonlyArray<readonly [RegExp, InsightCategory]> = [
	[/hypothes|ideat|brainstorm/u, "ideation and hypothesis generation"],
	[/literature|arxiv|citation|bibliograph|paper-read/u, "reading and knowledge acquisition"],
	[/proof|derivation|theor|symbolic/u, "theoretical analysis"],
	[/manuscript|latex|writing|paper-writ/u, "writing and communication"],
	[/pdb|uniprot|pubchem|crossref|catalog|dataset-fetch|download/u, "data gathering"],
	[/analysis|statistic|plot|visuali/u, "data analysis"],
	[/protocol|experiment|simulation|sweep/u, "design and development"],
];
/** Research skill families: loading one marks a session as research even when no category rule matches it. */
const RESEARCH_SKILL = /^(materio-|arxiv-|experiment-|scientific-|slurm-)/u;

export function skillCategory(name: string): InsightCategory | null {
	const known = SKILL_CATEGORIES[name];
	if (known !== undefined) return known;
	for (const [pattern, category] of SKILL_NAME_RULES) if (pattern.test(name)) return category;
	return null;
}

/** What one session did, in counts only. Every field comes from the record kinds above. */
export interface InsightSignals {
	/** Settled tool calls that ran (not blocked), main and workers, by tool; a gateway call counts its capabilities. */
	tools: Record<string, number>;
	/** Writes and edits that ran, by file kind. */
	writes: Partial<Record<ToolFileKind, number>>;
	/** Verify calls that ran, by declared check kind. */
	checks: Record<string, number>;
	/** Distinct skills loaded, sorted. */
	skills: string[];
	/** Tool calls that ran in the main session and in its workers. */
	toolCalls: number;
	/** Tool calls an operator approved or denied (a person, not a policy, judge or timeout). */
	operatorDecided: number;
	/** Messages the operator submitted. */
	operatorMessages: number;
	workerRuns: number;
	/** Agent ids of the settled worker runs, sorted. */
	workerAgents: string[];
	/** Autonomy modes the session ran under, sorted. */
	autonomyModes: string[];
	/** Summed span of each turn, first to last record, in ms. */
	activeMs: number;
	/** True when a write, edit or gateway call carries none of the per-call facets, so it was recorded before them. */
	facetsMissing: boolean;
	/**
	 * Distinct passing reproduce and numeric-compare checks the session's verified-outcome count found; the caller sets
	 * it, so a session recorded before verify calls carried their check kind still shows its science checks.
	 */
	verifiedChecks: number;
}

/** People who can decide an approval; anything else is policy, a judge, a timeout or the main agent. */
const OPERATOR_DECIDERS: ReadonlySet<string> = new Set(["operator", "acp-client"]);

function bump(map: Record<string, number>, key: string, by = 1): void {
	map[key] = (map[key] ?? 0) + by;
}

function insightRecords(records: readonly TelemetryRecord[]): Array<TelemetryRecord<InsightKind>> {
	return records.filter((record): record is TelemetryRecord<InsightKind> => INSIGHT_KIND_SET.has(record.k));
}

/**
 * Fold one session's journal and its worker run journals into signals. `autonomyOf` resolves the autonomy mode a
 * settings object names; the caller reads the object, which is configuration, never content.
 */
export function sessionSignals(
	session: readonly TelemetryRecord[],
	runs: ReadonlyArray<readonly TelemetryRecord[]>,
	autonomyOf: (settings: TelemetryRecord<"config.snapshotted">["data"]["settings"]) => string | null,
): InsightSignals {
	const signals: InsightSignals = {
		tools: {},
		writes: {},
		checks: {},
		skills: [],
		toolCalls: 0,
		operatorDecided: 0,
		operatorMessages: 0,
		workerRuns: 0,
		workerAgents: [],
		autonomyModes: [],
		activeMs: 0,
		facetsMissing: false,
		verifiedChecks: 0,
	};
	const skills = new Set<string>();
	const modes = new Set<string>();
	const linked = new Set<string>();
	const agents: string[] = [];
	const turns = new Map<string, { from: number; to: number }>();
	const tool = (record: TelemetryRecord<"tool.settled">): void => {
		const data = record.data;
		if (
			((data.tool === "write" || data.tool === "edit") && data.fileExt === undefined) ||
			(data.tool === "gateway" && data.capabilities === undefined && data.outcome === "ok")
		)
			signals.facetsMissing = true;
		if (data.outcome === "blocked") return;
		signals.toolCalls += 1;
		if (data.tool === "gateway" && data.capabilities !== undefined)
			for (const capability of data.capabilities) bump(signals.tools, capability);
		else bump(signals.tools, data.tool);
		if (data.fileExt !== undefined) bump(signals.writes, data.fileExt);
		if (data.checkKind !== undefined) bump(signals.checks, data.checkKind);
		if (data.skill !== undefined) skills.add(data.skill);
	};
	for (const record of insightRecords(session)) {
		const turnId = record.ctx.turnId;
		if (turnId !== undefined) {
			const at = Date.parse(record.t);
			if (Number.isFinite(at)) {
				const span = turns.get(turnId);
				if (span === undefined) turns.set(turnId, { from: at, to: at });
				else {
					span.from = Math.min(span.from, at);
					span.to = Math.max(span.to, at);
				}
			}
		}
		switch (record.k) {
			case "tool.settled":
				tool(record);
				break;
			case "approval.resolved":
				if (record.data.decidedBy !== undefined && OPERATOR_DECIDERS.has(record.data.decidedBy))
					signals.operatorDecided += 1;
				break;
			case "approval.requested":
				if (record.data.axis?.startsWith("autonomy:")) modes.add(record.data.axis.slice("autonomy:".length));
				break;
			case "message.stepped":
				if (record.data.step === "submitted" && record.data.by === "operator") signals.operatorMessages += 1;
				break;
			case "run.linked":
				linked.add(record.data.runId);
				break;
			case "config.snapshotted": {
				const mode = autonomyOf(record.data.settings);
				if (mode !== null) modes.add(mode);
				break;
			}
			case "config.changed": {
				const mode = autonomyOf(record.data.after);
				if (mode !== null) modes.add(mode);
				break;
			}
			default:
				break;
		}
	}
	for (const run of runs)
		for (const record of insightRecords(run)) {
			if (record.k === "tool.settled") tool(record);
			else if (record.k === "run.settled") agents.push(record.data.agentId);
			else if (record.k === "approval.resolved" && record.data.decidedBy !== undefined)
				if (OPERATOR_DECIDERS.has(record.data.decidedBy)) signals.operatorDecided += 1;
		}
	signals.workerRuns = linked.size;
	signals.workerAgents = [...new Set(agents)].sort();
	signals.skills = [...skills].sort();
	signals.autonomyModes = [...modes].sort();
	for (const span of turns.values()) signals.activeMs += span.to - span.from;
	return signals;
}

const count = (map: Record<string, number> | Partial<Record<string, number>>, keys: Iterable<string>): number => {
	let total = 0;
	for (const key of keys) total += map[key] ?? 0;
	return total;
};

/**
 * One category per session. A session shows research work when it used a science tool, wrote prose or data files,
 * ran a reproduce or numeric-compare check, read the web, loaded a research skill or delegated to the researcher;
 * without any of that, tool use is non-research software work and a session with no tools is `other`. Among research
 * sessions each category scores its own signals and the highest wins, ties going to the earlier category in
 * {@link INSIGHT_CATEGORIES}.
 */
export function classifySession(signals: InsightSignals): InsightCategory {
	const { tools, writes, checks } = signals;
	const prose = count(writes, PROSE);
	const code = count(writes, CODE);
	const dataFiles = count(writes, DATA_FILES);
	const notebooks = writes.ipynb ?? 0;
	const scienceChecks = Math.max((checks.reproduce ?? 0) + (checks["numeric-compare"] ?? 0), signals.verifiedChecks);
	const web = (tools.web_fetch ?? 0) + (tools.web_read ?? 0);
	const researcher = signals.workerAgents.some((agent) => agent === "researcher" || agent === "world-knowledge");
	const skillScores = new Map<InsightCategory, number>();
	let researchSkill = false;
	for (const skill of signals.skills) {
		const category = skillCategory(skill);
		if (category !== null) skillScores.set(category, (skillScores.get(category) ?? 0) + 4);
		if (category !== null || RESEARCH_SKILL.test(skill)) researchSkill = true;
	}
	const research =
		(tools.data ?? 0) > 0 ||
		(tools.run_script ?? 0) > 0 ||
		scienceChecks > 0 ||
		prose > 0 ||
		dataFiles > 0 ||
		notebooks > 0 ||
		web > 0 ||
		researchSkill ||
		researcher;
	if (!research) {
		const software = count(tools, SOFTWARE_TOOLS) + count(checks, ["command", "perf-budget"]);
		return software > 0 || code > 0 ? "software (non-research)" : "other";
	}
	const gathering = (tools.web_fetch ?? 0) > 0;
	const scores: Record<InsightCategory, number> = {
		"data analysis":
			3 * (tools.data ?? 0) +
			2 * (tools.run_script ?? 0) +
			3 * scienceChecks +
			2 * notebooks +
			(gathering ? 0 : dataFiles),
		"writing and communication": 3 * prose + (writes.txt ?? 0),
		"data gathering": 2 * (tools.web_fetch ?? 0) + (gathering ? 2 * dataFiles : 0),
		"reading and knowledge acquisition": 2 * (tools.web_read ?? 0) + (researcher ? 2 : 0),
		"theoretical analysis": 0,
		"design and development": code + count(checks, ["command", "perf-budget"]),
		"ideation and hypothesis generation": 2 * ((tools.decide ?? 0) + (tools.consult ?? 0)),
		other: 0,
		"software (non-research)": 0,
	};
	for (const [category, score] of skillScores) scores[category] += score;
	let best: InsightCategory = "other";
	for (const category of INSIGHT_CATEGORIES) if (scores[category] > scores[best]) best = category;
	return best;
}

/**
 * Autonomy from 1 to 5. A session with no tool call is 1. Otherwise the run length between operator messages sets the
 * base: under 3 tool calls per message is 2, under 10 is 3, more is 4. Worker delegation or yolo mode adds 1; more than
 * a tenth of the tool calls waiting on the operator's own approval takes 1 away, never below 2.
 */
export function autonomyLevel(signals: InsightSignals): AutonomyLevelScore {
	if (signals.toolCalls === 0) return 1;
	const perMessage = signals.toolCalls / Math.max(1, signals.operatorMessages);
	let level = perMessage < 3 ? 2 : perMessage < 10 ? 3 : 4;
	if (signals.workerRuns > 0 || signals.autonomyModes.includes("yolo")) level += 1;
	if (signals.operatorDecided / signals.toolCalls > 0.1) level -= 1;
	return Math.min(5, Math.max(2, level)) as AutonomyLevelScore;
}

export interface SessionInsight {
	sessionId: string;
	category: InsightCategory;
	autonomy: AutonomyLevelScore;
	/** Null when the session's ledger could not be read, so its outcomes are unknown. */
	verifiedOutcomes: number | null;
	signals: InsightSignals;
}

export interface ProjectInsights {
	project: string;
	/** The directory the project's sessions ran in, when a session recorded it. */
	cwd: string | null;
	sessions: number;
	categories: Record<InsightCategory, number>;
	autonomy: Record<`${AutonomyLevelScore}`, number>;
	verified: { sessions: number; known: number };
	/** Sessions recorded before tool calls carried their facets, so only their tool mix classified them. */
	facetsMissing: number;
	rows: SessionInsight[];
}

export function foldProjectInsights(project: string, cwd: string | null, rows: SessionInsight[]): ProjectInsights {
	const sorted = [...rows].sort((a, b) => (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
	const categories = Object.fromEntries(INSIGHT_CATEGORIES.map((category) => [category, 0])) as Record<
		InsightCategory,
		number
	>;
	const autonomy = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
	let verified = 0;
	let known = 0;
	let facetsMissing = 0;
	for (const row of sorted) {
		categories[row.category] += 1;
		autonomy[`${row.autonomy}`] += 1;
		if (row.verifiedOutcomes !== null) {
			known += 1;
			if (row.verifiedOutcomes > 0) verified += 1;
		}
		if (row.signals.facetsMissing) facetsMissing += 1;
	}
	return {
		project,
		cwd,
		sessions: sorted.length,
		categories,
		autonomy,
		verified: { sessions: verified, known },
		facetsMissing,
		rows: sorted,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Copy the named fields whose values are not text the model, a tool or the operator wrote. */
function pickTyped(source: Record<string, unknown>, fields: ReadonlyArray<string>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const field of fields) if (Object.hasOwn(source, field)) out[field] = source[field];
	return out;
}

const digestOnly = (value: unknown): unknown =>
	isRecord(value) && typeof value.sha256 === "string" ? { sha256: value.sha256 } : undefined;

/** A verify report as the outcome count reads it: kind, verdict and the digests of what it judged. */
function projectReport(report: unknown): unknown {
	if (!isRecord(report)) return undefined;
	const out: Record<string, unknown> = pickTyped(report, ["kind", "passed"]);
	if (report.reference !== undefined) out.reference = digestOnly(report.reference);
	if (report.actual !== undefined) out.actual = digestOnly(report.actual);
	if (Array.isArray(report.runs))
		out.runs = report.runs.map((run) => (isRecord(run) ? { payload: digestOnly(run.payload) } : {}));
	if (isRecord(report.conditions) && Array.isArray(report.conditions.inputs))
		out.conditions = { inputs: report.conditions.inputs.map(digestOnly) };
	return out;
}

function projectHostChecks(host: unknown): unknown {
	if (!isRecord(host) || !Array.isArray(host.checks)) return undefined;
	return {
		checks: host.checks.map((check) =>
			isRecord(check) ? { check: check.check, report: projectReport(check.report) } : {},
		),
	};
}

/** Tool result details as the outcome count and the chain expansion read them, recursively for chain children. */
function projectDetails(details: unknown): unknown {
	if (!isRecord(details)) return undefined;
	const out: Record<string, unknown> = pickTyped(details, ["check", "op", "capability", "runId"]);
	if (isRecord(details.judgement)) out.judgement = pickTyped(details.judgement, ["validation", "execution"]);
	if (details.report !== undefined) out.report = projectReport(details.report);
	if (details.hostVerification !== undefined) out.hostVerification = projectHostChecks(details.hostVerification);
	if (Array.isArray(details.runs))
		out.runs = details.runs.map((run) =>
			isRecord(run)
				? {
						...pickTyped(run, ["runId"]),
						...(run.hostVerification !== undefined ? { hostVerification: projectHostChecks(run.hostVerification) } : {}),
					}
				: {},
		);
	if (Array.isArray(details.chainResults))
		out.chainResults = details.chainResults.map((child) =>
			isRecord(child)
				? {
						...pickTyped(child, ["id", "capability", "isError"]),
						args: {},
						result: isRecord(child.result) ? { details: projectDetails(child.result.details) } : {},
					}
				: {},
		);
	return out;
}

/** Text in a task ledger is replaced by this marker, so presence checks still see a value and no words survive. */
const ELIDED = "";

function projectGoal(goal: unknown): unknown {
	if (!isRecord(goal)) return goal;
	return {
		...pickTyped(goal, ["id", "status", "parentGoalId", "origin", "userTaskId"]),
		title: ELIDED,
		// Only the completion-claim marker matters to the fold; the claim itself is the agent's prose.
		...(typeof goal.description === "string"
			? {
					description: goal.description.startsWith(TASK_BOARD_COMPLETION_CLAIM_PREFIX)
						? TASK_BOARD_COMPLETION_CLAIM_PREFIX
						: ELIDED,
				}
			: {}),
	};
}

function projectEvidence(row: unknown): unknown {
	if (!isRecord(row)) return row;
	const out: Record<string, unknown> = { ...pickTyped(row, ["id", "status", "observedAt"]), description: ELIDED };
	for (const field of ["command", "artifactPath", "notes"]) if (row[field] !== undefined) out[field] = ELIDED;
	return out;
}

/**
 * A session ledger entry as the verified-outcome count needs it, or null for an entry it never reads. Only a tool
 * result and a task ledger snapshot survive, each reduced to typed fields: tool name, error flag, check verdicts and
 * payload digests, run ids, task ids and statuses. Message text, tool arguments, result output and task wording are
 * never copied.
 */
export function outcomeLedgerProjection(entry: unknown): unknown {
	if (!isRecord(entry)) return null;
	const base = pickTyped(entry, ["kind", "turnId", "parentTurnId", "timestamp"]);
	if (entry.kind === "message" && entry.role === "tool_result" && isRecord(entry.payload)) {
		const payload = entry.payload;
		const result = isRecord(payload.result) ? payload.result : undefined;
		return {
			...base,
			role: "tool_result",
			payload: {
				...pickTyped(payload, ["toolName", "toolCallId", "isError"]),
				...(result !== undefined ? { result: { details: projectDetails(result.details) } } : {}),
			},
		};
	}
	if (entry.kind === "taskLedger") {
		return {
			...base,
			...pickTyped(entry, ["boardId"]),
			goals: Array.isArray(entry.goals) ? entry.goals.map(projectGoal) : [],
			subgoals: Array.isArray(entry.subgoals) ? entry.subgoals.map(projectGoal) : [],
			requiredValidationEvidence: Array.isArray(entry.requiredValidationEvidence)
				? entry.requiredValidationEvidence.map(projectEvidence)
				: [],
		};
	}
	return null;
}
