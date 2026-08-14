import { existsSync } from "node:fs";
import { join } from "node:path";
import { type LoadResult, loadDomains } from "../core/domain-loader.js";
import { ToolNames } from "../core/tool-names.js";
import { AgentsDomainModule } from "../domains/agents/index.js";
import type { ConfigContract } from "../domains/config/contract.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { ContextDomainModule, type WikiGenerate, type WikiGenerateInput } from "../domains/context/index.js";
import type { WikiPlan, WikiPlanPage } from "../domains/context/wiki/plan.js";
import {
	MAX_PAGE_ATTEMPTS,
	pendingPages,
	readAuthoredWikiPlan,
	writeWikiPlanFile,
} from "../domains/context/wiki/plan-store.js";
import { buildWikiPagePrompt, buildWikiPlanPrompt } from "../domains/context/wiki/prompts.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { DispatchDomainModule } from "../domains/dispatch/index.js";
import type { RunReceipt } from "../domains/dispatch/types.js";
import type { JobSpec, JobThinkingLevel } from "../domains/dispatch/validation.js";
import { MiddlewareDomainModule } from "../domains/middleware/index.js";
import { createObservabilityDomainModule } from "../domains/observability/index.js";
import { createPromptsDomainModule } from "../domains/prompts/index.js";
import { canonicalizeWireModelId, type ProvidersContract, ProvidersDomainModule } from "../domains/providers/index.js";
import { ResourcesDomainModule } from "../domains/resources/index.js";
import { SafetyDomainModule } from "../domains/safety/index.js";
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

/**
 * Wall-clock ceiling for one page dispatch, clamped against the configured
 * internal-dispatch guardrail. A page is a small job: read a handful of named
 * sources and write one file. Bounding it here is what keeps one degenerate
 * page from consuming the time every other page needed, and losing it costs
 * exactly that page because the plan records it as still owed.
 */
const PAGE_DEADLINE_MS = 6 * 60 * 1000;

/** Wall-clock ceiling for the single planning dispatch. */
const PLAN_DEADLINE_MS = 8 * 60 * 1000;

/**
 * Wall-clock budget for a whole generation, checked between page dispatches and
 * never during one. Exceeding it ends the run cleanly with every finished page
 * promoted and the rest recorded as owed, so a repository too large for one
 * sitting is finished by the next run instead of failing forever.
 */
const RUN_BUDGET_MS = 60 * 60 * 1000;

export interface WikiModelRoute {
	target?: string;
	model?: string;
	thinkingLevel?: JobThinkingLevel;
}

export interface ModelWikiGenerateOptions {
	dispatch?: DispatchContract;
	route?: WikiModelRoute;
	/** Overrides the whole-run wall-clock budget. Tests use it to force an early stop. */
	runBudgetMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The one place an operator's exact wiki route reaches a dispatch. The planner
 * and every page writer are pinned identically, so a wiki never silently mixes
 * models across its own pages.
 */
function routeFields(route: WikiModelRoute): Pick<JobSpec, "target" | "model" | "thinkingLevel"> {
	return {
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
	mix: string;
}

/**
 * Longest an in-flight phase may go without saying anything. The planner is
 * allowed eight minutes and a page six, and the operator who reported this saw
 * two lines in five minutes, concluded the command had deadlocked, and killed
 * it. Narrating every tool call would scroll the terminal for nothing, so the
 * heartbeat is throttled to this and carries only elapsed time and tool count.
 */
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
	// Every event is consumed so finalization cannot block on an unread iterator.
	for await (const event of events) {
		if (!isRecord(event) || event.type !== "clio_tool_finish") continue;
		const tool = eventPayloadString(event, "tool");
		if (!tool) continue;
		const outcome = eventPayloadString(event, "outcome") ?? "done";
		completed += 1;
		tools.set(tool, (tools.get(tool) ?? 0) + 1);
		if (outcome === "error") errors += 1;
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
	return { tools: completed, errors, blocked, firstBlockReason, mix };
}

function summaryDetail(summary: DispatchSummary, startedAt: number): string {
	const blockedDetail =
		summary.blocked > 0
			? `; blocked=${summary.blocked}${summary.firstBlockReason ? ` (${summarizeBlockReason(summary.firstBlockReason)})` : ""}`
			: "";
	return (
		`${formatElapsed(Date.now() - startedAt)}; ${summary.mix || "no tools completed"}` +
		`${summary.errors > 0 ? `; errors=${summary.errors}` : ""}${blockedDetail}`
	);
}

interface WikiDispatchOutcome {
	ok: boolean;
	detail: string;
}

/**
 * Run one wiki dispatch to completion and report how it ended. It never
 * throws: a failed page must not take down the pages around it, and whatever
 * the run wrote before it stopped is already on disk.
 */
export async function runWikiDispatch(input: {
	dispatch: DispatchContract;
	cwd: string;
	outputDir: string;
	task: string;
	route: WikiModelRoute;
	deadlineMs: number;
	label: string;
	/** Liveness signal while the dispatch runs, already throttled by the caller. */
	onHeartbeat?: (info: { elapsedMs: number; tools: number }) => void;
}): Promise<WikiDispatchOutcome> {
	const startedAt = Date.now();
	let handle: Awaited<ReturnType<DispatchContract["dispatch"]>>;
	try {
		handle = await input.dispatch.dispatch({
			agentId: WIKI_AGENT_ID,
			executionRole: "builder",
			task: input.task,
			cwd: input.cwd,
			requestOrigin: "internal",
			noSkills: true,
			...routeFields(input.route),
			// `git` cannot answer anything for this dispatch. The prompt already
			// embeds `git status` and `git log` verbatim, and the staging dir is
			// under the gitignored `.clio-coder/`, so `op=diff` cannot see the pages this
			// run is writing.
			denyTools: [ToolNames.Git],
			// Containment: the worker safety seam blocks any write-class tool call
			// whose target escapes the staging dir.
			writeRoots: [input.outputDir],
			// Admission patience must match execution patience. Without this the
			// queue applies its 60s default while `deadlineMs` below allows six
			// minutes to run, so a page waiting behind two in-flight writers was
			// dropped before it ever started. Observed live: a 33-page plan lost
			// `core.md` to `dispatch: admission timed_out` at 10/33 while every
			// page ahead of it was taking 110 to 125 seconds. A page the caller is
			// willing to wait six minutes for is a page it should be willing to
			// queue for six minutes.
			assignmentDeadlineAt: startedAt + input.deadlineMs,
		});
	} catch (err) {
		return { ok: false, detail: err instanceof Error ? err.message : String(err) };
	}
	const deadline = armInternalDispatchDeadline(input.dispatch, handle.runId, input.label, process.env, input.deadlineMs);
	let lastHeartbeatAt = startedAt;
	try {
		const summary = await drainDispatchEvents(handle.events, (tools) => {
			const nowMs = Date.now();
			if (!input.onHeartbeat || nowMs - lastHeartbeatAt < HEARTBEAT_MS) return;
			lastHeartbeatAt = nowMs;
			input.onHeartbeat({ elapsedMs: nowMs - startedAt, tools });
		});
		const receipt = await handle.finalPromise;
		if (deadline.timedOut()) return { ok: false, detail: `timed out; ${summaryDetail(summary, startedAt)}` };
		if (receipt.exitCode !== 0) {
			input.dispatch.abort(handle.runId);
			return { ok: false, detail: `${receiptFailure(receipt)}; ${summaryDetail(summary, startedAt)}` };
		}
		return { ok: true, detail: summaryDetail(summary, startedAt) };
	} catch (err) {
		if (!deadline.timedOut()) input.dispatch.abort(handle.runId);
		await handle.finalPromise.catch(() => undefined);
		const reason = deadline.timedOut() ? "timed out" : err instanceof Error ? err.message : String(err);
		return { ok: false, detail: `${reason}; ${formatElapsed(Date.now() - startedAt)}` };
	} finally {
		deadline.clear();
	}
}

function receiptFailure(receipt: RunReceipt): string {
	const code = receipt.outcomeCode ? ` (${receipt.outcomeCode})` : "";
	return `exit ${receipt.exitCode}${code}`;
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
): Promise<WikiPlan> {
	input.progress?.({ phase: "generate", status: "running", message: "planning wiki pages" });
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
		deadlineMs: PLAN_DEADLINE_MS,
		label: "wiki planner",
		onHeartbeat: ({ elapsedMs, tools }) =>
			input.progress?.({
				phase: "generate",
				status: "running",
				message: `still planning (${formatElapsed(elapsedMs)}, ${tools} tool calls)`,
				detail: `planner deadline ${Math.round(PLAN_DEADLINE_MS / 60000)}m`,
			}),
	});
	const revised = readAuthoredWikiPlan(input.outputDir, input.plan);
	const plan = revised ?? input.plan;
	input.progress?.({
		phase: "generate",
		status: "running",
		message: outcome.ok
			? `plan has ${plan.pages.length} page${plan.pages.length === 1 ? "" : "s"}`
			: "planner did not finish; using the indexed candidate plan",
		detail: outcome.detail,
	});
	return plan;
}

/** Write one page, then checkpoint the plan so the work survives whatever follows. */
async function runPagePhase(
	dispatch: DispatchContract,
	input: WikiGenerateInput,
	plan: WikiPlan,
	page: WikiPlanPage,
	route: WikiModelRoute,
	position: { index: number; total: number },
): Promise<WikiPlan> {
	const seeded = existsSync(join(input.outputDir, page.path));
	const outcome = await runWikiDispatch({
		dispatch,
		cwd: input.cwd,
		outputDir: input.outputDir,
		task: buildWikiPagePrompt({
			cwd: input.cwd,
			mode: input.mode,
			codewiki: input.codewiki,
			page,
			siblings: plan.pages,
			outputDir: input.outputDir,
			seeded,
		}),
		route,
		deadlineMs: PAGE_DEADLINE_MS,
		label: `wiki page ${page.path}`,
		onHeartbeat: ({ elapsedMs, tools }) =>
			input.progress?.({
				phase: "generate",
				status: "running",
				message: `still writing ${page.path} (${position.index}/${position.total}, ${formatElapsed(elapsedMs)}, ${tools} tool calls)`,
				detail: `page deadline ${Math.round(PAGE_DEADLINE_MS / 60000)}m`,
			}),
	});
	// The file on disk is the postcondition, not what the writer reported. A run
	// that ended on its budget after writing the page still wrote the page.
	const written = existsSync(join(input.outputDir, page.path));
	const next: WikiPlan = {
		...plan,
		pages: plan.pages.map((entry) =>
			entry.path === page.path
				? { ...entry, status: written ? ("written" as const) : ("pending" as const), attempts: entry.attempts + 1 }
				: entry,
		),
	};
	writeWikiPlanFile(input.outputDir, next);
	input.progress?.({
		phase: "generate",
		status: "running",
		message: `${written ? "wrote" : "could not write"} ${page.path} (${position.index}/${position.total})`,
		detail: outcome.detail,
	});
	return next;
}

export async function generateWikiWithDocumenter(
	dispatch: DispatchContract,
	input: WikiGenerateInput,
	route: WikiModelRoute = {},
	runBudgetMs: number = RUN_BUDGET_MS,
): Promise<void> {
	const startedAt = Date.now();
	const routeDetail = [route.target, route.model, route.thinkingLevel ? `thinking=${route.thinkingLevel}` : undefined]
		.filter((value): value is string => value !== undefined)
		.join("/");
	input.progress?.({
		phase: "generate",
		status: "running",
		message: "dispatching wiki writers",
		detail: `one page per dispatch${routeDetail ? `; ${routeDetail}` : ""}`,
	});

	// A resumed run keeps the plan its finished pages were written against;
	// re-planning would churn the paths those pages already link to. Every other
	// run plans, including an update, which is the only thing allowed to change
	// a wiki's shape as the repository grows.
	let plan = input.resumed ? input.plan : await runPlanPhase(dispatch, input, route);
	if (!input.resumed) writeWikiPlanFile(input.outputDir, plan);

	const queue = pendingPages(plan);
	if (queue.length === 0) {
		input.progress?.({ phase: "generate", status: "running", message: "every planned page is already current" });
		return;
	}
	// Say the shape of the wait before starting it. A 20-page wiki is 20 model
	// runs and can legitimately take most of an hour, which is longer than any
	// default command timeout an operator is likely to have wrapped around it.
	{
		const worstCaseMs = Math.min(runBudgetMs, queue.length * PAGE_DEADLINE_MS);
		input.progress?.({
			phase: "generate",
			status: "running",
			message: `${queue.length} page${queue.length === 1 ? "" : "s"} to write, one model run each`,
			detail: `up to ${Math.round(worstCaseMs / 60000)}m; progress is reported at least every ${Math.round(HEARTBEAT_MS / 1000)}s and finished pages are kept if the run stops early`,
		});
	}
	for (const [index, page] of queue.entries()) {
		if (Date.now() - startedAt >= runBudgetMs) {
			const left = queue.length - index;
			input.progress?.({
				phase: "generate",
				status: "running",
				message: `run budget reached with ${left} page${left === 1 ? "" : "s"} unwritten`,
				detail: `${formatElapsed(Date.now() - startedAt)}; staged pages are kept and promoted`,
			});
			return;
		}
		const current = plan.pages.find((entry) => entry.path === page.path) ?? page;
		if (current.status === "written" || current.attempts >= MAX_PAGE_ATTEMPTS) continue;
		plan = await runPagePhase(dispatch, input, plan, current, route, {
			index: index + 1,
			total: queue.length,
		});
	}
}

async function loadWikiDispatch(): Promise<{ dispatch: DispatchContract; loaded: LoadResult }> {
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
		DispatchDomainModule,
	]);
	const dispatch = loaded.getContract<DispatchContract>("dispatch");
	if (!dispatch) {
		await loaded.stop();
		throw new Error("wiki writer dispatch unavailable");
	}
	return { dispatch, loaded };
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
		const workers = settings.workers;
		// Keyed on the dispatched agent id and nothing else, because that is what
		// `placement.ts` reads. Falling back to another agent's binding here would
		// record a model in wiki metadata that no dispatch ever ran.
		const bindingProfileName = workers?.agentBindings?.[WIKI_AGENT_ID];
		const profile = bindingProfileName ? workers?.profiles?.[bindingProfileName] : undefined;
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

export function modelWikiGenerate(options: ModelWikiGenerateOptions = {}): WikiGenerate {
	return async (input) => {
		let loaded: LoadResult | null = null;
		try {
			if (options.dispatch) {
				await generateWikiWithDocumenter(options.dispatch, input, options.route, options.runBudgetMs);
				return;
			}
			const lazy = await loadWikiDispatch();
			loaded = lazy.loaded;
			await generateWikiWithDocumenter(lazy.dispatch, input, options.route, options.runBudgetMs);
		} finally {
			if (loaded) await loaded.stop();
		}
	};
}
