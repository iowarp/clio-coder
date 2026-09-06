import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { type LoadResult, loadDomains } from "../core/domain-loader.js";
import { asDirectoryPathBoundary } from "../core/path-boundary.js";
import { runWithBudget, writeShutdownNotice } from "../core/termination.js";
import { ToolNames } from "../core/tool-names.js";
import { AgentsDomainModule } from "../domains/agents/index.js";
import type { ConfigContract } from "../domains/config/contract.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { ContextDomainModule } from "../domains/context/runtime.js";
import { inspectWikiPageEvidence } from "../domains/context/wiki/evidence.js";
import type { WikiGenerate, WikiGenerateInput } from "../domains/context/wiki/generate.js";
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
import { declaredScopeIntent } from "../domains/dispatch/intent.js";
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
	// Every event is consumed so finalization cannot block on an unread iterator.
	for await (const event of events) {
		if (!isRecord(event) || event.type !== "clio_coder_tool_finish") continue;
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

function summaryDetail(summary: DispatchSummary, startedAtClock: number): string {
	const blockedDetail =
		summary.blocked > 0
			? `; blocked=${summary.blocked}${summary.firstBlockReason ? ` (${summarizeBlockReason(summary.firstBlockReason)})` : ""}`
			: "";
	return (
		`${formatElapsed(performance.now() - startedAtClock)}; ${summary.mix || "no tools completed"}` +
		`${summary.errors > 0 ? `; errors=${summary.errors}` : ""}${blockedDetail}`
	);
}

type WikiDispatchOutcome =
	| { ok: false; phase: "admission"; detail: string }
	| { ok: boolean; phase: "writer"; detail: string; runId: string };

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
		const scope = declaredScopeIntent({ readRoots: ["."], writeRoots: [asDirectoryPathBoundary(stagingRoot)] });
		if (!scope.ok) throw new Error(`${scope.reason}: ${scope.message}`);
		handle = await input.dispatch.dispatch({
			intent: scope.intent,
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
			writeRoots: [asDirectoryPathBoundary(input.outputDir)],
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
	let lastHeartbeatAt = startedAtClock;
	try {
		const summary = await drainDispatchEvents(handle.events, (tools) => {
			const nowMs = performance.now();
			if (!input.onHeartbeat || nowMs - lastHeartbeatAt < HEARTBEAT_MS) return;
			lastHeartbeatAt = nowMs;
			input.onHeartbeat({ elapsedMs: Math.round(nowMs - startedAtClock), tools });
		});
		const receipt = await handle.finalPromise;
		if (timedOut)
			return {
				ok: false,
				phase: "writer",
				runId: handle.runId,
				detail: `timed out; ${summaryDetail(summary, startedAtClock)}`,
			};
		if (receipt.exitCode !== 0) {
			input.dispatch.abort(handle.runId);
			return {
				ok: false,
				phase: "writer",
				runId: handle.runId,
				detail: `${receiptFailure(receipt)}; ${summaryDetail(summary, startedAtClock)}`,
			};
		}
		return { ok: true, phase: "writer", runId: handle.runId, detail: summaryDetail(summary, startedAtClock) };
	} catch (err) {
		if (!timedOut) input.dispatch.abort(handle.runId);
		await handle.finalPromise.catch(() => undefined);
		const reason = timedOut ? "timed out" : err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			phase: "writer",
			runId: handle.runId,
			detail: `${reason}; ${formatElapsed(performance.now() - startedAtClock)}`,
		};
	} finally {
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
	deadline: WikiDeadline | undefined,
): Promise<WikiPlan> {
	const seeded = existsSync(join(input.outputDir, page.path));
	const outcome = await runWikiDispatch({
		dispatch,
		cwd: input.cwd,
		outputDir: input.outputDir,
		task: buildWikiPagePrompt({
			depth: input.generation.depth,
			cwd: input.cwd,
			mode: input.mode,
			codewiki: input.codewiki,
			page,
			siblings: plan.pages,
			...(input.decisions ? { decisions: input.decisions } : {}),
			outputDir: input.outputDir,
			seeded,
		}),
		route,
		deadline,
		onHeartbeat: ({ elapsedMs, tools }) =>
			input.progress?.({
				phase: "generate",
				status: "running",
				message: `still writing ${page.path} (${position.index}/${position.total}, ${formatElapsed(elapsedMs)}, ${tools} tool calls)`,
				detail: `page estimate ${Math.round(PAGE_ESTIMATE_MS / 60000)}m; healthy work may continue longer`,
			}),
	});
	// Keep failed refresh prose available, but require both a successful writer
	// and mechanically valid evidence before crediting a page as completed.
	const evidence = outcome.ok
		? inspectWikiPageEvidence({
				pagePath: page.path,
				outputDir: input.outputDir,
				sourceRoot: input.cwd,
			})
		: undefined;
	const written = outcome.ok && evidence?.ok === true;
	const detail = evidence && !evidence.ok ? `evidence check failed: ${evidence.reasons.join("; ")}` : outcome.detail;
	const next: WikiPlan = {
		...plan,
		pages: plan.pages.map((entry) => {
			if (entry.path !== page.path) return entry;
			const nextPage: WikiPlanPage = {
				...entry,
				status: written ? "written" : "pending",
				...(written ? { dependencies: evidence?.dependencies ?? [] } : {}),
				attempts: entry.attempts + (outcome.phase === "writer" ? 1 : 0),
			};
			if (written) delete nextPage.lastFailure;
			else
				nextPage.lastFailure = {
					phase: outcome.ok ? "validation" : outcome.phase,
					detail: detail.replace(/\s+/gu, " ").slice(0, 500),
					...(outcome.phase === "writer" ? { runId: outcome.runId } : {}),
				};
			return nextPage;
		}),
	};
	writeWikiPlanFile(input.outputDir, next);
	input.progress?.({
		phase: "generate",
		status: "running",
		message: `${written ? "wrote" : "could not write"} ${page.path} (${position.index}/${position.total})`,
		detail,
	});
	return next;
}

async function generateWikiWithDocumenter(
	dispatch: DispatchContract,
	input: WikiGenerateInput,
	route: WikiModelRoute = {},
	deadline?: WikiDeadline,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	const startedAtClock = performance.now();
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
	let plan = input.resumed ? input.plan : await runPlanPhase(dispatch, input, route, deadline);
	signal?.throwIfAborted();
	if (!input.resumed) writeWikiPlanFile(input.outputDir, plan);

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
		);
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
		const workers = settings.fleet;
		// Keyed on the dispatched agent id and nothing else, because that is what
		// `placement.ts` reads. Falling back to another agent's binding here would
		// record a model in wiki metadata that no dispatch ever ran.
		const bindingProfileName = workers?.agentProfiles?.[WIKI_AGENT_ID];
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
		if (options.dispatch) {
			await generateWikiWithDocumenter(options.dispatch, input, options.route, deadline);
			return;
		}
		const { dispatch, loaded } = await loadWikiDispatch();
		await withWikiDispatchLifecycle({ dispatch, stop: () => loaded.stop() }, (signal) =>
			generateWikiWithDocumenter(dispatch, input, options.route, deadline, signal),
		);
	};
}
