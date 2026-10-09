import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { type LoadResult, loadDomains } from "../core/domain-loader.js";
import { asDirectoryPathBoundary } from "../core/path-boundary.js";
import { safeResourceWrite } from "../core/safe-resource-write.js";
import { runWithBudget, writeShutdownNotice } from "../core/termination.js";
import { ALL_TOOL_NAMES, ToolNames } from "../core/tool-names.js";
import { AgentsDomainModule } from "../domains/agents/index.js";
import type { ConfigContract } from "../domains/config/contract.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { ContextDomainModule } from "../domains/context/runtime.js";
import { pageSourceIndex } from "../domains/context/wiki/assemble.js";
import { inspectWikiPageEvidence } from "../domains/context/wiki/evidence.js";
import type { WikiGenerate, WikiGenerateInput } from "../domains/context/wiki/generate.js";
import type { WikiPlan, WikiPlanPage } from "../domains/context/wiki/plan.js";
import {
	MAX_PAGE_ATTEMPTS,
	pendingPages,
	readAuthoredWikiPlan,
	validateWikiPlanAnchors,
	writeWikiPlanFile,
} from "../domains/context/wiki/plan-store.js";
import { buildWikiPagePrompt, buildWikiPlanPrompt, buildWikiRepairPrompt } from "../domains/context/wiki/prompts.js";
import {
	captureWikiSourceContent,
	observedWikiSources,
	wikiSourcesMatch,
} from "../domains/context/wiki/source-content.js";
import { formatEffectiveBudget } from "../domains/dispatch/budget-envelope.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { createDispatchDomainModule } from "../domains/dispatch/index.js";
import { declaredScopeIntent } from "../domains/dispatch/intent.js";
import { runEventJournalPath } from "../domains/dispatch/run-event-journal.js";
import type { RunReceipt } from "../domains/dispatch/types.js";
import type { JobSpec, JobThinkingLevel } from "../domains/dispatch/validation.js";
import { MiddlewareDomainModule } from "../domains/middleware/index.js";
import { renderCostAmount } from "../domains/observability/cost.js";
import { createObservabilityDomainModule } from "../domains/observability/index.js";
import { createPromptsDomainModule } from "../domains/prompts/index.js";
import { canonicalizeWireModelId, type ProvidersContract, ProvidersDomainModule } from "../domains/providers/index.js";
import { ResourcesDomainModule } from "../domains/resources/index.js";
import { SafetyDomainModule } from "../domains/safety/index.js";
import { redactSecretString } from "../domains/safety/redaction.js";
import { SchedulingDomainModule } from "../domains/scheduling/index.js";
import { SessionDomainModule } from "../domains/session/index.js";
import { armInternalDispatchDeadline } from "./internal-dispatch.js";

/**
 * Model id recorded on wiki metadata when the documenter target cannot be
 * resolved. It is only reached when no target is configured, in which case the
 * dispatch also fails and no metadata is written, so it never lands on a real
 * artifact; it exists so the resolver never throws.
 */
const UNRESOLVED_DOCUMENTER_MODEL = "unresolved-documenter-target";

/** The agent recipe that plans and writes pages. */
const WIKI_AGENT_ID = "wiki-writer";

/** Planning estimates inform progress, never admission or execution limits. */
const PAGE_ESTIMATE_MS = 6 * 60 * 1000;
const PLAN_ESTIMATE_MS = 8 * 60 * 1000;
const RUN_ESTIMATE_MS = 60 * 60 * 1000;

export interface WikiModelRoute {
	workerProfile?: string;
	target?: string;
	model?: string;
	thinkingLevel?: JobThinkingLevel;
}

export interface ModelWikiGenerateOptions {
	dispatch?: DispatchContract;
	route?: WikiModelRoute;
	/** Explicit whole-run duration; omission leaves ordinary estimates advisory. */
	runBudgetMs?: number;
	/** Explicit absolute deadline, shared unchanged by planning and every page. */
	deadlineAt?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The one place an operator's exact wiki route reaches a dispatch. The planner
 * and every page writer are pinned identically, so a wiki never silently mixes
 * models across its own pages.
 */
function routeFields(route: WikiModelRoute): Pick<JobSpec, "target" | "model" | "thinkingLevel" | "workerProfile"> {
	return {
		...(route.workerProfile !== undefined ? { workerProfile: route.workerProfile } : {}),
		...(route.target !== undefined ? { target: route.target } : {}),
		...(route.model !== undefined ? { model: route.model } : {}),
		...(route.thinkingLevel !== undefined ? { thinkingLevel: route.thinkingLevel } : {}),
	};
}

function eventPayloadString(event: unknown, key: string): string | null {
	if (!isRecord(event) || !isRecord(event.payload)) return null;
	const value = event.payload[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function formatElapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "elapsed unknown";
	if (ms < 1000) return `elapsed ${Math.round(ms)}ms`;
	return `elapsed ${Math.round(ms / 1000)}s`;
}

const BLOCK_REASON_MAX_CHARS = 80;
// Same bounds as the diagnostics a writer prompt carries, so the sidecar cannot outgrow what the writer saw.
const SIDECAR_REASON_LIMIT = 32;
const SIDECAR_REASON_MAX_CHARS = 1000;

/** First sentence of a block reason, bounded so one line stays one line. */
function summarizeBlockReason(reason: string): string {
	const firstSentence = reason.split(/(?<=[.;])\s/, 1)[0]?.trim() ?? reason.trim();
	const collapsed = firstSentence.replace(/\s+/g, " ");
	return collapsed.length <= BLOCK_REASON_MAX_CHARS
		? collapsed
		: `${collapsed.slice(0, BLOCK_REASON_MAX_CHARS - 1).trimEnd()}…`;
}

interface DispatchSummary {
	tools: number;
	errors: number;
	blocked: number;
	firstBlockReason: string | null;
	firstError: string | null;
	mix: string;
}

/** Throttle activity summaries so long-running healthy work remains visible. */
const HEARTBEAT_MS = 30_000;

/**
 * Drain a dispatch's event stream, summarizing rather than narrating. One
 * dispatch is one page, so a line per tool call would tell the operator
 * nothing; the per-page line printed on completion carries the same facts.
 * `onActivity` fires on every tool finish and its consumer decides how often
 * that is worth a line.
 */
async function drainDispatchEvents(
	events: AsyncIterable<unknown>,
	onActivity?: (completed: number) => void,
): Promise<DispatchSummary> {
	const tools = new Map<string, number>();
	let completed = 0;
	let errors = 0;
	let blocked = 0;
	let firstBlockReason: string | null = null;
	let firstError: string | null = null;
	// Every event is consumed so finalization cannot block on an unread iterator.
	for await (const event of events) {
		if (!isRecord(event) || (event.type !== "clio_coder_tool_finish" && event.type !== "clio_coder_tool_observation"))
			continue;
		const tool = eventPayloadString(event, "tool");
		if (!tool) continue;
		const outcome = eventPayloadString(event, "outcome") ?? "done";
		if (event.type === "clio_coder_tool_finish") {
			completed += 1;
			tools.set(tool, (tools.get(tool) ?? 0) + 1);
		}
		if (outcome === "error") {
			errors += 1;
			firstError ??= `${tool}: ${summarizeBlockReason(redactSecretString(eventPayloadString(event, "reason") ?? "reason unavailable"))}`;
		}
		if (outcome === "blocked") {
			blocked += 1;
			firstBlockReason ??= eventPayloadString(event, "reason");
		}
		onActivity?.(completed);
	}
	const mix = [...tools.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([tool, count]) => `${tool}=${count}`)
		.join(", ");
	return { tools: completed, errors, blocked, firstBlockReason, firstError, mix };
}

function summaryDetail(summary: DispatchSummary, startedAtClock: number, attemptCount = 1): string {
	const blockedDetail =
		summary.blocked > 0
			? `; blocked=${summary.blocked}${summary.firstBlockReason ? ` (${summarizeBlockReason(summary.firstBlockReason)})` : ""}`
			: "";
	return (
		`${formatElapsed(performance.now() - startedAtClock)}${attemptCount > 1 ? ` spanning ${attemptCount} attempts` : ""}; ${summary.mix || "no tools completed"}` +
		`${attemptCount > 1 && summary.mix ? ` (all ${attemptCount} attempts)` : ""}` +
		`${summary.errors > 0 ? `; errors=${summary.errors}${summary.firstError ? ` (${summary.firstError})` : ""}` : ""}${blockedDetail}`
	);
}

/** Usage and cost facts of one attempt, from its receipt or its finalized ledger envelope. */
type WikiRunUsage = Pick<
	RunReceipt,
	| "tokenCount"
	| "inputTokenCount"
	| "outputTokenCount"
	| "cacheReadTokenCount"
	| "cacheWriteTokenCount"
	| "missingTokenCalls"
	| "costUsd"
	| "costProvenance"
> &
	Partial<Pick<RunReceipt, "costSummary" | "budget">>;

interface WikiEarlierAttempt {
	runId: string;
	outcome: string;
	usage: WikiRunUsage | undefined;
}

/** Attempts of one logical dispatch other than the terminal one. */
interface WikiAttempts {
	/** Run id of the attempt whose receipt resolved the dispatch. */
	terminalRunId: string;
	/** Total attempts, terminal included. */
	count: number;
	earlier: ReadonlyArray<WikiEarlierAttempt>;
	/** Set when the ledger lookup failed, so earlier attempts may exist whose usage is unknown. */
	incomplete?: true;
}

type WikiDispatchOutcome =
	| { ok: false; phase: "admission"; detail: string }
	| {
			ok: boolean;
			phase: "writer";
			detail: string;
			runId: string;
			receipt?: RunReceipt;
			attempts?: WikiAttempts;
	  };

/**
 * dispatch() hands back the first attempt's run id while its final promise
 * resolves to the last attempt's receipt. Recover the earlier attempts from the
 * assignment and the run ledger so a transient retry does not erase their usage.
 * A dispatch without those surfaces reads as a single attempt.
 */
function collectWikiAttempts(
	dispatch: DispatchContract,
	rootRunId: string,
	terminal: RunReceipt | undefined,
): WikiAttempts | undefined {
	try {
		if (typeof dispatch.getRun !== "function") return undefined;
		const refs = dispatch.assignments?.get(rootRunId)?.attempts;
		if (!refs || refs.length === 0) return undefined;
		const terminalRunId = terminal?.runId ?? refs[refs.length - 1]?.runId ?? rootRunId;
		const earlier: WikiEarlierAttempt[] = [];
		for (const ref of refs) {
			if (ref.runId === terminalRunId) continue;
			const run = dispatch.getRun(ref.runId);
			const finalized =
				run !== null &&
				run.endedAt !== null &&
				run.status !== "queued" &&
				run.status !== "running" &&
				(run.lineage === undefined || run.lineage.rootRunId === rootRunId);
			earlier.push({
				runId: ref.runId,
				outcome: ref.outcome,
				usage: finalized
					? {
							tokenCount: run.tokenCount,
							...(run.inputTokenCount !== undefined ? { inputTokenCount: run.inputTokenCount } : {}),
							...(run.outputTokenCount !== undefined ? { outputTokenCount: run.outputTokenCount } : {}),
							...(run.cacheReadTokenCount !== undefined ? { cacheReadTokenCount: run.cacheReadTokenCount } : {}),
							...(run.cacheWriteTokenCount !== undefined ? { cacheWriteTokenCount: run.cacheWriteTokenCount } : {}),
							...(run.missingTokenCalls !== undefined ? { missingTokenCalls: run.missingTokenCalls } : {}),
							costUsd: run.costUsd,
							costProvenance: run.costProvenance ?? "unknown",
							...(run.costSummary ? { costSummary: run.costSummary } : {}),
						}
					: undefined,
			});
		}
		return { terminalRunId, count: earlier.length + 1, earlier };
	} catch {
		// A ledger failure must not fail the page, but silently reporting single-receipt totals would
		// undercount retried dispatches, so the outcome is flagged and renders as incomplete usage.
		return { terminalRunId: terminal?.runId ?? rootRunId, count: 1, earlier: [], incomplete: true };
	}
}

const USAGE_FIELDS = [
	["tokenCount", "total"],
	["inputTokenCount", "input"],
	["outputTokenCount", "output"],
	["cacheReadTokenCount", "cache read"],
	["cacheWriteTokenCount", "cache write"],
	["missingTokenCalls", "missing-usage calls"],
] as const;

type WikiUsage = Pick<RunReceipt, (typeof USAGE_FIELDS)[number][0]>;
type WikiReceipts = Array<{
	receipt: WikiRunUsage | undefined;
	kind: "writer" | "repair";
	/** The attempt ledger was unreadable, so this dispatch may have unrecorded earlier attempts. */
	unrecoveredAttempts?: true;
}>;
const ATTEMPT_LINE_LIMIT = 4;

function usageDetail(usage: WikiUsage): string {
	return USAGE_FIELDS.map(([key, label]) => `${label}=${usage[key] ?? "unknown"}`).join(", ");
}

function dispatchUsage(
	outcome: WikiDispatchOutcome,
	receipts: WikiReceipts,
	kind: "writer" | "repair" = "writer",
): string {
	if (outcome.phase === "admission") return "";
	const receipt = outcome.receipt;
	const attempts = outcome.attempts;
	receipts.push({ receipt, kind, ...(attempts?.incomplete ? { unrecoveredAttempts: true as const } : {}) });
	for (const earlier of attempts?.earlier ?? []) receipts.push({ receipt: earlier.usage, kind });
	const runId = attempts?.terminalRunId ?? outcome.runId;
	const breakdown = attempts?.incomplete
		? "; earlier attempts unrecoverable; all-attempt tokens total unknown (incomplete)"
		: attempts && attempts.count > 1
			? attemptsBreakdown(attempts, receipt)
			: "";
	if (!receipt) return `; run=${runId}; usage unavailable${breakdown}`;
	const provenance = receipt.costProvenance;
	return (
		`; run=${runId}; tokens: ${usageDetail(receipt)}; cost=${renderCostAmount(receipt.costUsd, provenance, receipt.costSummary)} (${provenance})` +
		(receipt.budget ? `; budget=${formatEffectiveBudget(receipt.budget)}` : "") +
		breakdown
	);
}

function attemptsBreakdown(attempts: WikiAttempts, terminal: WikiRunUsage | undefined): string {
	const shown = attempts.earlier
		.slice(0, ATTEMPT_LINE_LIMIT)
		.map((a) => `${a.runId} tokens=${a.usage?.tokenCount ?? "unknown"} outcome=${a.outcome}`);
	const hidden = attempts.earlier.length - shown.length;
	const all = [terminal, ...attempts.earlier.map((a) => a.usage)];
	const total = all.reduce((sum, usage) => sum + (usage?.tokenCount ?? 0), 0);
	const incomplete = all.some((usage) => usage === undefined);
	return (
		`; attempts=${attempts.count} (earlier: ${shown.join(", ")}${hidden > 0 ? `, +${hidden} more` : ""})` +
		`; all-attempt tokens total=${total}${incomplete ? " (incomplete)" : ""}`
	);
}

function invocationUsage(receipts: WikiReceipts): string {
	if (receipts.length === 0) return "no worker runs admitted; no usage recorded";
	const totals: WikiUsage = { tokenCount: 0 };
	let known = 0;
	let estimated = 0;
	let unknown = 0;
	let incomplete = 0;
	let missingUsage = 0;
	for (const { receipt, unrecoveredAttempts } of receipts) {
		if (unrecoveredAttempts && receipt) {
			incomplete += 1;
			missingUsage += 1;
		}
		if (!receipt) {
			unknown += 1;
			incomplete += 1;
			missingUsage += 1;
			continue;
		}
		for (const [key] of USAGE_FIELDS) totals[key] = (totals[key] ?? 0) + (receipt[key] ?? 0);
		if (USAGE_FIELDS.some(([key]) => receipt[key] === undefined)) incomplete += 1;
		if (receipt.missingTokenCalls === undefined) missingUsage += 1;
		if (receipt.costProvenance === "unknown") unknown += 1;
		else if (receipt.costProvenance === "estimated") estimated += receipt.costUsd;
		else known += receipt.costUsd;
	}
	return (
		`${receipts.length} dispatched runs; reported tokens: ${usageDetail(totals)}` +
		(receipts.some((run) => run.kind === "repair")
			? `; repair runs=${receipts.filter((run) => run.kind === "repair").length}`
			: "") +
		`; incomplete usage breakdown=${incomplete} runs; missing-usage count unknown=${missingUsage} runs` +
		`; reported cost subtotals: known=${renderCostAmount(known, "known")}, estimated=${renderCostAmount(estimated, "estimated")}; unknown cost=${unknown} runs` +
		((totals.missingTokenCalls ?? 0) > 0 || incomplete > 0 ? "; usage/cost totals may be incomplete" : "")
	);
}

interface WikiDeadline {
	at: number;
	remainingMs(): number;
}

function explicitWikiDeadline(options: ModelWikiGenerateOptions): WikiDeadline | undefined {
	if (options.runBudgetMs !== undefined && (!Number.isFinite(options.runBudgetMs) || options.runBudgetMs < 0))
		throw new Error("wiki runBudgetMs must be a finite non-negative duration");
	if (options.deadlineAt !== undefined && !Number.isFinite(options.deadlineAt))
		throw new Error("wiki deadlineAt must be a finite timestamp");
	if (options.deadlineAt === undefined && options.runBudgetMs === undefined) return undefined;
	const wallNow = Date.now();
	const at = Math.min(
		options.deadlineAt ?? Number.POSITIVE_INFINITY,
		wallNow + (options.runBudgetMs ?? Number.POSITIVE_INFINITY),
	);
	if (!Number.isFinite(new Date(at).getTime())) throw new Error("wiki deadline exceeds the supported timestamp range");
	const clockNow = performance.now();
	// Keep the admission timestamp fixed while elapsed enforcement is monotonic.
	return { at, remainingMs: () => at - wallNow - (performance.now() - clockNow) };
}

/**
 * Run one wiki dispatch to completion and report how it ended. It never
 * throws: a failed page must not take down the pages around it, and whatever
 * the run wrote before it stopped is already on disk.
 */
async function runWikiDispatch(input: {
	dispatch: DispatchContract;
	cwd: string;
	outputDir: string;
	task: string;
	/** Caller-owned page path, relative to cwd; the planner remains unbound. */
	artifactPath?: string;
	repairSources?: readonly string[];
	route: WikiModelRoute;
	deadline: WikiDeadline | undefined;
	/** Liveness signal while the dispatch runs, already throttled by the caller. */
	onHeartbeat?: (info: { elapsedMs: number; tools: number }) => void;
}): Promise<WikiDispatchOutcome> {
	const startedAtClock = performance.now();
	let handle: Awaited<ReturnType<DispatchContract["dispatch"]>>;
	try {
		if (input.deadline && input.deadline.remainingMs() <= 0)
			throw new Error("explicit wiki deadline reached before admission");
		const stagingRoot = relative(input.cwd, input.outputDir);
		if (!stagingRoot) throw new Error("wiki staging directory must be below the repository root");
		// The repository is readable; only this staging tree is writable. Declare
		// those paths directly so absolute filenames in prompt prose cannot become
		// legacy scope tokens (including a sentence-ending period).
		const repair = input.repairSources !== undefined;
		const writeRoots = repair && input.artifactPath ? [input.artifactPath] : [asDirectoryPathBoundary(stagingRoot)];
		const scope = declaredScopeIntent({
			readRoots: repair && input.artifactPath ? [input.artifactPath, ...(input.repairSources ?? [])] : ["."],
			writeRoots,
		});
		if (!scope.ok) throw new Error(`${scope.reason}: ${scope.message}`);
		handle = await input.dispatch.dispatch({
			intent: scope.intent,
			agentId: repair ? "wiki-repair" : WIKI_AGENT_ID,
			executionRole: "builder",
			task: input.task,
			...(input.artifactPath !== undefined
				? { resultContractOverride: { kind: "artifact-report" as const, path: input.artifactPath } }
				: {}),
			cwd: input.cwd,
			requestOrigin: "internal",
			// Wiki pages are generated context too; stable local sampling reduces variation between refreshes.
			sampling: "deterministic",
			noSkills: true,
			...routeFields(input.route),
			// `git` cannot answer anything for this dispatch. The prompt already
			// embeds `git status` and `git log` verbatim, and the staging dir is
			// under the gitignored `.clio-coder/`, so `op=diff` cannot see the pages this
			// run is writing.
			denyTools: repair
				? ALL_TOOL_NAMES.filter((tool) => tool !== ToolNames.Read && tool !== ToolNames.Grep && tool !== ToolNames.Edit)
				: [ToolNames.Git],
			...(repair ? { budget: { toolCalls: 10, readReserve: 4 } } : {}),
			// Containment: the worker safety seam blocks any write-class tool call
			// whose target escapes the staging dir.
			writeRoots:
				repair && input.artifactPath ? [join(input.cwd, input.artifactPath)] : [asDirectoryPathBoundary(input.outputDir)],
			// Only an explicit caller deadline constrains admission; recipe estimates
			// must not become assignment deadlines or restart for each page.
			...(input.deadline ? { assignmentDeadlineAt: input.deadline.at } : {}),
		});
	} catch (err) {
		return { ok: false, phase: "admission", detail: err instanceof Error ? err.message : String(err) };
	}
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const armDeadline = (): void => {
		if (!input.deadline) return;
		const remaining = input.deadline.remainingMs();
		if (remaining <= 0) {
			timedOut = true;
			input.dispatch.abort(handle.runId, { cause: "timeout", detail: "explicit wiki deadline reached" });
			return;
		}
		// Long explicit deadlines must not overflow Node's timer range into 1ms.
		timer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647));
		timer.unref();
	};
	armDeadline();
	const safetyDeadline = armInternalDispatchDeadline(input.dispatch, handle.runId, "wiki dispatch");
	let completedTools = 0;
	const heartbeat = setInterval(
		() => input.onHeartbeat?.({ elapsedMs: Math.round(performance.now() - startedAtClock), tools: completedTools }),
		HEARTBEAT_MS,
	);
	heartbeat.unref();
	let receipt: RunReceipt | undefined;
	try {
		const summary = await drainDispatchEvents(handle.events, (tools) => {
			completedTools = tools;
		});
		receipt = await handle.finalPromise;
		const attempts = collectWikiAttempts(input.dispatch, handle.runId, receipt);
		const spanned = attempts?.count ?? 1;
		if (timedOut || safetyDeadline.timedOut())
			return {
				ok: false,
				phase: "writer",
				runId: handle.runId,
				receipt,
				...(attempts ? { attempts } : {}),
				detail: `${timedOut ? "timed out: explicit wiki deadline reached" : safetyDeadline.message()}; ${summaryDetail(summary, startedAtClock, spanned)}`,
			};
		if (receipt.exitCode !== 0) {
			input.dispatch.abort(handle.runId);
			return {
				ok: false,
				phase: "writer",
				runId: handle.runId,
				receipt,
				...(attempts ? { attempts } : {}),
				detail: `${receiptFailure(receipt)}; ${summaryDetail(summary, startedAtClock, spanned)}`,
			};
		}
		return {
			ok: true,
			phase: "writer",
			runId: handle.runId,
			receipt,
			...(attempts ? { attempts } : {}),
			detail: summaryDetail(summary, startedAtClock, spanned),
		};
	} catch (err) {
		if (!timedOut) input.dispatch.abort(handle.runId);
		receipt = await handle.finalPromise.catch(() => undefined);
		const attempts = collectWikiAttempts(input.dispatch, handle.runId, receipt);
		const reason = timedOut
			? "timed out: explicit wiki deadline reached"
			: safetyDeadline.timedOut()
				? safetyDeadline.message()
				: err instanceof Error
					? err.message
					: String(err);
		return {
			ok: false,
			phase: "writer",
			runId: handle.runId,
			...(receipt ? { receipt } : {}),
			...(attempts ? { attempts } : {}),
			detail: `${reason}; ${formatElapsed(performance.now() - startedAtClock)}`,
		};
	} finally {
		clearInterval(heartbeat);
		safetyDeadline.clear();
		clearTimeout(timer);
	}
}

function receiptFailure(receipt: RunReceipt): string {
	const code = receipt.outcomeCode ? ` (${receipt.outcomeCode})` : "";
	const detail = receipt.outcomeDetail?.replace(/\s+/gu, " ").slice(0, 350);
	return `exit ${receipt.exitCode}${code}${detail ? `: ${detail}` : ""}`;
}

/**
 * The planning pass. It rewrites a plan file that already holds a usable
 * candidate, so nothing here can fail the generation: a planner that errors,
 * times out, or writes unparseable JSON simply leaves the candidate in place.
 */
async function runPlanPhase(
	dispatch: DispatchContract,
	input: WikiGenerateInput,
	route: WikiModelRoute,
	deadline: WikiDeadline | undefined,
	receipts: WikiReceipts,
): Promise<WikiPlan> {
	input.progress?.({ phase: "generate", status: "started", message: "planning wiki pages" });
	const outcome = await runWikiDispatch({
		dispatch,
		cwd: input.cwd,
		outputDir: input.outputDir,
		task: buildWikiPlanPrompt({
			cwd: input.cwd,
			mode: input.mode,
			codewiki: input.codewiki,
			generation: input.generation,
			plan: input.plan,
			unclaimedAreas: input.unclaimedAreas,
			outputDir: input.outputDir,
			gitHead: input.gitHead ?? null,
		}),
		route,
		deadline,
		onHeartbeat: ({ elapsedMs, tools }) =>
			input.progress?.({
				phase: "generate",
				status: "running",
				message: `still planning (${formatElapsed(elapsedMs)}, ${tools} tool calls)`,
				detail: `planner estimate ${Math.round(PLAN_ESTIMATE_MS / 60000)}m; healthy work may continue longer`,
			}),
	});
	const revised = readAuthoredWikiPlan(input.outputDir, input.plan);
	const plan = revised ?? input.plan;
	const usage = dispatchUsage(outcome, receipts);
	input.progress?.({
		phase: "generate",
		status: "completed",
		message: outcome.ok
			? `plan has ${plan.pages.length} page${plan.pages.length === 1 ? "" : "s"}`
			: "planner did not finish; using the indexed candidate plan",
		detail: outcome.detail + usage,
	});
	return plan;
}

/** Write or repair one page, then checkpoint its actual publication outcome. */
async function runPagePhase(
	dispatch: DispatchContract,
	input: WikiGenerateInput,
	plan: WikiPlan,
	page: WikiPlanPage,
	route: WikiModelRoute,
	position: { index: number; total: number },
	deadline: WikiDeadline | undefined,
	receipts: WikiReceipts,
	repair = page.lastFailure?.phase === "validation" && Boolean(page.lastFailure.runId),
): Promise<WikiPlan> {
	const seeded = existsSync(join(input.outputDir, page.path));
	const baseline = plan.sourceContent ?? captureWikiSourceContent(input.cwd);
	const sources = [
		...new Set([
			...page.sources,
			...(page.dependencies ?? []),
			...(pageSourceIndex(input.outputDir, input.cwd).get(page.path) ?? []),
		]),
	];
	const stable = (dependencies: readonly string[] = []): boolean => {
		const current = captureWikiSourceContent(input.cwd);
		// Repair exists to fix unresolved citations, so only observed claims can veto it.
		const observed = observedWikiSources(baseline, current, [...sources, ...dependencies]);
		return (
			wikiSourcesMatch(baseline, current) && (observed.length === 0 || wikiSourcesMatch(baseline, current, observed))
		);
	};
	const diagnostic = seeded
		? inspectWikiPageEvidence({
				pagePath: page.path,
				outputDir: input.outputDir,
				sourceRoot: input.cwd,
				plan,
			})
		: undefined;
	for (const dependency of diagnostic?.dependencies ?? diagnostic?.resolvedDependencies ?? []) {
		if (!sources.includes(dependency)) sources.push(dependency);
	}
	const draftHash = diagnostic?.draftHash ?? "";
	if (
		repair &&
		(!draftHash ||
			!plan.sourceContent ||
			diagnostic?.validationKind === "coverage" ||
			!stable(diagnostic?.dependencies ?? diagnostic?.resolvedDependencies))
	)
		repair = false;
	const kind = repair ? "repair" : "writer";
	input.progress?.({
		phase: "generate",
		status: "started",
		message: `${repair ? "repairing" : "writing"} ${page.path} (${position.index}/${position.total})`,
	});
	const outcome = await runWikiDispatch({
		dispatch,
		cwd: input.cwd,
		outputDir: input.outputDir,
		artifactPath: relative(input.cwd, join(input.outputDir, page.path)),
		...(repair ? { repairSources: sources } : {}),
		task: repair
			? buildWikiRepairPrompt({
					cwd: input.cwd,
					outputDir: input.outputDir,
					page,
					draftHash,
					diagnostics: diagnostic?.allReasons ?? diagnostic?.reasons ?? [],
					sources,
				})
			: buildWikiPagePrompt({
					depth: input.generation.depth,
					cwd: input.cwd,
					mode: input.mode,
					codewiki: input.codewiki,
					page,
					siblings: plan.pages,
					...(input.decisions ? { decisions: input.decisions } : {}),
					outputDir: input.outputDir,
					seeded,
					...(seeded && diagnostic ? { diagnostics: diagnostic.allReasons ?? diagnostic.reasons } : {}),
				}),
		route,
		deadline,
		onHeartbeat: ({ elapsedMs, tools }) =>
			input.progress?.({
				phase: "generate",
				status: "running",
				message: `still ${repair ? "repairing" : "writing"} ${page.path} (${position.index}/${position.total}, ${formatElapsed(elapsedMs)}, ${tools} tool calls)`,
				...(repair
					? {}
					: { detail: `page estimate ${Math.round(PAGE_ESTIMATE_MS / 60000)}m; healthy work may continue longer` }),
			}),
	});
	// A tool-call cap hit after a successful write or edit still leaves a draft on disk. Only the
	// evidence gate can judge it, and discarding it forces a full writer (~1M tokens) where a
	// validation or bounded repair costs a fraction. The receipt keeps the cap in the run detail.
	const delivered =
		outcome.ok ||
		(outcome.phase === "writer" &&
			outcome.receipt?.outcomeCode === "worker_tool_call_cap_exhausted" &&
			outcome.receipt.toolActivity?.mutatingSucceeded === true);
	const evidence = delivered
		? inspectWikiPageEvidence({
				pagePath: page.path,
				outputDir: input.outputDir,
				sourceRoot: input.cwd,
				plan,
			})
		: undefined;
	const written = delivered && evidence?.ok === true && (!repair || stable(evidence.dependencies));
	// dispatch() returns the first attempt's id; after a transient retry the page was authored by the terminal run.
	const authorRunId = outcome.phase === "writer" ? (outcome.attempts?.terminalRunId ?? outcome.runId) : undefined;
	if (evidence && authorRunId !== undefined) {
		const sourceSnapshotHash = createHash("sha256")
			.update(JSON.stringify(Object.entries(baseline).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))
			.digest("hex");
		const allReasons = evidence.allReasons ?? evidence.reasons;
		const reasons = allReasons.slice(0, SIDECAR_REASON_LIMIT);
		const omittedReasons = allReasons.length - reasons.length;
		try {
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(authorRunId)) throw new Error("invalid validation run id");
			safeResourceWrite(
				join(dirname(runEventJournalPath(authorRunId)), "wiki-validation.json"),
				`${JSON.stringify(
					{
						version: 1,
						page: page.path,
						attempt: page.attempts + 1,
						runId: authorRunId,
						assignment: kind,
						validationKind: evidence.validationKind ?? "evidence",
						ok: evidence.ok,
						written,
						reasons: reasons.map((reason) => redactSecretString(reason).slice(0, SIDECAR_REASON_MAX_CHARS)),
						...(omittedReasons > 0 ? { omittedReasons } : {}),
						sourceSnapshotHash,
						sourceTreeHash: plan.sourceTreeHash ?? null,
						sourceGitHead: plan.sourceGitHead ?? null,
					},
					null,
					2,
				)}\n`,
				{ encoding: "utf8" },
			);
		} catch (error) {
			input.progress?.({
				phase: "generate",
				status: "running",
				message: `could not record validation for ${page.path}`,
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	}
	const usage = dispatchUsage(outcome, receipts, kind);
	const detail =
		evidence && !evidence.ok
			? // Reasons lead because lastFailure.detail is cut to 500 chars, and elapsed time or tool mix must not push them out.
				`evidence check failed: ${JSON.stringify(evidence.reasons)}; ${outcome.detail}`
			: delivered && repair && !written
				? `${outcome.detail}; source baseline changed during repair; full writer required next invocation`
				: outcome.detail;
	const next: WikiPlan = {
		...plan,
		sourceContent: baseline,
		pages: plan.pages.map((entry) => {
			if (entry.path !== page.path) return entry;
			const nextPage: WikiPlanPage = {
				...entry,
				status: written ? "written" : "pending",
				...(evidence
					? {
							dependencies: written
								? (evidence.dependencies ?? [])
								: [...new Set([...(entry.dependencies ?? []), ...(evidence.resolvedDependencies ?? [])])],
						}
					: {}),
				attempts: entry.attempts + (outcome.phase === "writer" ? 1 : 0),
			};
			if (written) delete nextPage.lastFailure;
			else
				nextPage.lastFailure = {
					phase: repair || evidence?.validationKind === "coverage" ? "writer" : delivered ? "validation" : outcome.phase,
					detail: (repair ? `repair failed: ${detail}; full writer required next invocation` : detail)
						.replace(/\s+/gu, " ")
						.slice(0, 500),
					...(authorRunId !== undefined ? { runId: authorRunId } : {}),
				};
			return nextPage;
		}),
	};
	writeWikiPlanFile(input.outputDir, next);
	input.progress?.({
		phase: "generate",
		status: "completed",
		message: `${written ? (repair ? "repaired" : "wrote") : repair ? "could not repair" : "could not write"} ${page.path} (${position.index}/${position.total})`,
		current: position.index,
		total: position.total,
		detail: `${repair ? "repair; " : ""}${detail}${usage}`,
	});
	if (
		!repair &&
		!input.retryPending &&
		delivered &&
		evidence &&
		!evidence.ok &&
		evidence.validationKind !== "coverage" &&
		(!deadline || deadline.remainingMs() > 0)
	) {
		const pending = next.pages.find((entry) => entry.path === page.path);
		if (
			pending &&
			pending.attempts < MAX_PAGE_ATTEMPTS &&
			existsSync(join(input.outputDir, page.path)) &&
			stable(evidence.dependencies ?? evidence.resolvedDependencies)
		)
			return runPagePhase(dispatch, input, next, pending, route, position, deadline, receipts, true);
	}
	return next;
}

async function generateWikiWithDocumenter(
	dispatch: DispatchContract,
	input: WikiGenerateInput,
	receipts: WikiReceipts,
	route: WikiModelRoute = {},
	deadline?: WikiDeadline,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	const startedAtClock = performance.now();
	const checkAnchors = (plan: WikiPlan): WikiPlan =>
		validateWikiPlanAnchors(plan, input.cwd, (page, sources) =>
			input.progress?.({
				phase: "generate",
				status: "completed",
				message: `rejected invalid anchors for ${page}`,
				detail: sources.map((source) => JSON.stringify(source)).join(", "),
			}),
		);
	let plan = checkAnchors(input.plan);
	if (
		!input.replan &&
		input.mode === "update" &&
		input.unclaimedAreas.length === 0 &&
		plan.pages.every((page) => page.status === "written")
	) {
		input.progress?.({
			phase: "generate",
			status: "running",
			message: "all wiki evidence is current; no model dispatch needed",
		});
		return;
	}
	const routeDetail = [route.target, route.model, route.thinkingLevel ? `thinking=${route.thinkingLevel}` : undefined]
		.filter((value): value is string => value !== undefined)
		.join("/");
	input.progress?.({
		phase: "generate",
		status: "running",
		message: "dispatching wiki writers",
		detail: `one page per dispatch${routeDetail ? `; ${routeDetail}` : ""}`,
	});

	// Keep page paths stable while updating their source evidence. Only new
	// areas, a changed depth, or --replan need the repository-wide planner.
	if (!input.resumed) plan = checkAnchors(await runPlanPhase(dispatch, { ...input, plan }, route, deadline, receipts));
	signal?.throwIfAborted();
	writeWikiPlanFile(input.outputDir, plan);

	const queue = pendingPages(plan, input.retryPending);
	if (queue.length === 0) {
		const pending = plan.pages.filter((page) => page.status !== "written").length;
		input.progress?.({
			phase: "generate",
			status: "running",
			message:
				pending > 0
					? `${pending} pending page${pending === 1 ? " has" : "s have"} exhausted writer attempts`
					: "every planned page is already current",
		});
		return;
	}
	// Say the shape of the wait before starting it. A 20-page wiki is 20 model
	// runs and can legitimately take most of an hour, which is longer than any
	// default command timeout an operator is likely to have wrapped around it.
	{
		const estimateMs = Math.min(RUN_ESTIMATE_MS, queue.length * PAGE_ESTIMATE_MS);
		input.progress?.({
			phase: "generate",
			status: "running",
			message: `${queue.length} page${queue.length === 1 ? "" : "s"} to write, one model run each`,
			detail: `estimate ${Math.round(estimateMs / 60000)}m; activity summaries every ${Math.round(HEARTBEAT_MS / 1000)}s; finished pages are kept if the run stops early${deadline ? `; explicit deadline ${new Date(deadline.at).toISOString()}` : "; healthy work may continue beyond estimates"}`,
		});
	}
	for (const [index, page] of queue.entries()) {
		signal?.throwIfAborted();
		if (deadline && deadline.remainingMs() <= 0) {
			const left = queue.length - index;
			input.progress?.({
				phase: "generate",
				status: "running",
				message: `explicit deadline reached with ${left} page${left === 1 ? "" : "s"} unwritten`,
				detail: `${formatElapsed(performance.now() - startedAtClock)}; staged pages are kept and promoted`,
			});
			return;
		}
		const current = plan.pages.find((entry) => entry.path === page.path) ?? page;
		if (current.status === "written" || (!input.retryPending && current.attempts >= MAX_PAGE_ATTEMPTS)) continue;
		plan = await runPagePhase(
			dispatch,
			input,
			plan,
			current,
			route,
			{
				index: index + 1,
				total: queue.length,
			},
			deadline,
			receipts,
		);
	}
}

async function loadWikiDispatch(): Promise<{ dispatch: DispatchContract; loaded: LoadResult; workerProfile?: string }> {
	const loaded = await loadDomains([
		ConfigDomainModule,
		ResourcesDomainModule,
		ContextDomainModule,
		ProvidersDomainModule,
		SafetyDomainModule,
		createPromptsDomainModule({ noContextFiles: true }),
		AgentsDomainModule,
		MiddlewareDomainModule,
		SessionDomainModule,
		createObservabilityDomainModule({ dispatchTrace: false }),
		SchedulingDomainModule,
		createDispatchDomainModule({ journalRunEvents: true }),
	]);
	const dispatch = loaded.getContract<DispatchContract>("dispatch");
	if (!dispatch) {
		await loaded.stop();
		throw new Error("wiki writer dispatch unavailable");
	}
	const workerProfile = loaded.getContract<ConfigContract>("config")?.get().fleet?.agentProfiles?.[WIKI_AGENT_ID];
	return { dispatch, loaded, ...(workerProfile ? { workerProfile } : {}) };
}

/**
 * Resolve the wire model id the wiki dispatches will run on, so wiki metadata
 * records the real model instead of a placeholder. Mirrors dispatch's
 * default-target precedence for a request with no explicit target: agent
 * binding profile, then the worker default, then the first configured target;
 * the model follows the same profile/default/target.defaultModel order and is
 * canonicalized through providers. This approximates dispatch resolution: it
 * does not replicate the best-available health-ranking fallback that only
 * matters when the primary target is unavailable. Best-effort and never throws.
 */
export async function resolveDocumenterModelId(route: WikiModelRoute = {}): Promise<string> {
	const loaded = await loadDomains([ConfigDomainModule, ResourcesDomainModule, ProvidersDomainModule]);
	try {
		const config = loaded.getContract<ConfigContract>("config");
		const providers = loaded.getContract<ProvidersContract>("providers");
		if (!config || !providers) return UNRESOLVED_DOCUMENTER_MODEL;
		const settings = config.get();
		const workers = settings.fleet;
		// Keyed on the dispatched agent id and nothing else, because that is what
		// `placement.ts` reads. Falling back to another agent's binding here would
		// record a model in wiki metadata that no dispatch ever ran.
		const bindingProfileName = workers?.agentProfiles?.[WIKI_AGENT_ID];
		const profileName = route.workerProfile ?? bindingProfileName;
		const profile = profileName ? workers?.profiles?.[profileName] : undefined;
		const targetId = route.target ?? profile?.target ?? workers?.default?.target ?? settings.targets?.[0]?.id ?? null;
		if (!targetId) return UNRESOLVED_DOCUMENTER_MODEL;
		const target = providers.getTarget(targetId);
		const requestedModel = route.model ?? profile?.model ?? workers?.default?.model ?? target?.defaultModel ?? null;
		if (!requestedModel) return UNRESOLVED_DOCUMENTER_MODEL;
		const status = providers.list().find((entry) => entry.target.id === targetId);
		return status ? canonicalizeWireModelId(status, requestedModel) : requestedModel;
	} catch {
		return UNRESOLVED_DOCUMENTER_MODEL;
	} finally {
		await loaded.stop();
	}
}

/**
 * A standalone wiki command owns a dispatch runtime outside the main entry
 * orchestrator. Hold its signal ownership until workers settle, including
 * their 500ms forced-kill window, then stop domains before exiting. This is
 * scoped to the runtime we loaded; injected dispatches keep their caller's
 * lifecycle. The signal budget fits inside the enclosing editor shell grace.
 */
export async function withWikiDispatchLifecycle(
	runtime: { dispatch: Pick<DispatchContract, "drain">; stop(): Promise<void> },
	generate: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
	const abort = new AbortController();
	let closing: Promise<void> | null = null;
	let interrupted: Promise<void> | null = null;
	const close = (): Promise<void> => {
		closing ??= (async () => {
			let failure: { error: unknown } | null = null;
			try {
				await runtime.dispatch.drain();
			} catch (error) {
				failure = { error };
			}
			try {
				await runtime.stop();
			} catch (error) {
				if (failure) writeShutdownNotice(`clio-coder context wiki: domain cleanup failed: ${String(error)}`);
				else failure = { error };
			}
			if (failure) throw failure.error;
		})();
		return closing;
	};
	const exitCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
	const onSignal = (signal: keyof typeof exitCodes): void => {
		if (interrupted) return;
		abort.abort(new Error(`wiki generation interrupted by ${signal}`));
		interrupted = (async () => {
			const completed = await runWithBudget(close, 2000, (error) => {
				writeShutdownNotice(`clio-coder context wiki: shutdown failed: ${String(error)}`);
			});
			if (!completed) writeShutdownNotice("clio-coder context wiki: shutdown exceeded 2000ms budget");
			process.exit(exitCodes[signal]);
		})();
	};
	for (const signal of Object.keys(exitCodes) as Array<keyof typeof exitCodes>) process.on(signal, onSignal);
	let failure: { error: unknown } | null = null;
	try {
		await generate(abort.signal);
	} catch (error) {
		failure = { error };
	}
	try {
		if (interrupted) await interrupted;
		else await close();
	} catch (error) {
		if (failure) writeShutdownNotice(`clio-coder context wiki: cleanup failed: ${String(error)}`);
		else failure = { error };
	} finally {
		for (const signal of Object.keys(exitCodes) as Array<keyof typeof exitCodes>) process.off(signal, onSignal);
	}
	if (failure) throw failure.error;
}

export function modelWikiGenerate(options: ModelWikiGenerateOptions = {}): WikiGenerate {
	return async (input) => {
		const deadline = explicitWikiDeadline(options);
		const receipts: WikiReceipts = [];
		try {
			if (options.dispatch) {
				await generateWikiWithDocumenter(options.dispatch, input, receipts, options.route, deadline);
				return;
			}
			const { dispatch, loaded, workerProfile } = await loadWikiDispatch();
			const route = { ...(workerProfile ? { workerProfile } : {}), ...options.route };
			await withWikiDispatchLifecycle({ dispatch, stop: () => loaded.stop() }, (signal) =>
				generateWikiWithDocumenter(dispatch, input, receipts, route, deadline, signal),
			);
		} finally {
			input.progress?.({
				phase: "generate",
				status: "completed",
				message: "wiki invocation usage",
				detail: invocationUsage(receipts),
			});
		}
	};
}
