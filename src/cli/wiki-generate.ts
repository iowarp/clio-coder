import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type LoadResult, loadDomains } from "../core/domain-loader.js";
import { AgentsDomainModule } from "../domains/agents/index.js";
import type { ConfigContract } from "../domains/config/contract.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { ContextDomainModule, type WikiGenerate, type WikiGenerateInput } from "../domains/context/index.js";
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
 * documenter dispatch also fails and no metadata is written, so it never lands
 * on a real artifact; it exists so the resolver never throws.
 */
const UNRESOLVED_DOCUMENTER_MODEL = "unresolved-documenter-target";

export interface WikiModelRoute {
	target?: string;
	model?: string;
	thinkingLevel?: JobThinkingLevel;
}

export interface ModelWikiGenerateOptions {
	dispatch?: DispatchContract;
	route?: WikiModelRoute;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The one place an operator's exact wiki route reaches a dispatch. Researchers
 * and the writer are pinned identically, so a wiki never silently mixes models.
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

const TOOL_PROGRESS_INTERVAL = 5;
const AREA_REPORT_MAX_BYTES = 7_500;
const RESEARCH_BRIEFING_MAX_BYTES = 60_000;
/** Concurrent area researchers per wave, matching the local fleet's inference slots. */
const RESEARCH_WAVE_WIDTH = 4;
/** Total documenter passes, including the first. Every later pass closes one named shortfall. */
const MAX_DOCUMENTER_ATTEMPTS = 3;
const RECOVERABLE_WIKI_OUTCOMES = new Set([
	"loop_guard_tools_disabled_exhausted",
	"worker_tool_call_cap_exhausted",
	"result_contract_exhausted",
]);

async function drainDispatchEvents(
	events: AsyncIterable<unknown>,
	input: WikiGenerateInput,
	attempt: number,
): Promise<void> {
	const startedAt = Date.now();
	let completed = 0;
	let errors = 0;
	let blocked = 0;
	const tools = new Map<string, number>();
	const report = (message: string): void => {
		const mix = [...tools.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([tool, count]) => `${tool}=${count}`)
			.join(", ");
		input.progress?.({
			phase: "generate",
			status: "running",
			message,
			detail: `${formatElapsed(Date.now() - startedAt)}; ${mix || "no tools completed"}${errors > 0 ? `; errors=${errors}` : ""}${blocked > 0 ? `; blocked=${blocked}` : ""}`,
		});
	};
	// Every event is consumed so finalization cannot block on an unread iterator.
	for await (const event of events) {
		if (!isRecord(event)) continue;
		if (event.type === "agent_start") {
			input.progress?.({
				phase: "generate",
				status: "running",
				message: attempt === 1 ? "documenter started wiki update" : "documenter started focused recovery",
				detail: formatElapsed(Date.now() - startedAt),
			});
			continue;
		}
		if (event.type !== "clio_tool_finish") continue;
		const tool = eventPayloadString(event, "tool");
		if (!tool) continue;
		const outcome = eventPayloadString(event, "outcome") ?? "done";
		completed += 1;
		tools.set(tool, (tools.get(tool) ?? 0) + 1);
		if (outcome === "error") errors += 1;
		if (outcome === "blocked") blocked += 1;
		// Report the first block immediately, then fold a blocked-call spiral into
		// the normal cadence instead of flooding the operator's terminal.
		if (completed % TOOL_PROGRESS_INTERVAL === 0 || outcome === "error" || (outcome === "blocked" && blocked === 1)) {
			report(`documenter made ${completed} tool attempt${completed === 1 ? "" : "s"}`);
		}
	}
	if (completed > 0 && completed % TOOL_PROGRESS_INTERVAL !== 0) {
		report(`documenter made ${completed} tool attempt${completed === 1 ? "" : "s"}`);
	}
}

function receiptFailure(receipt: RunReceipt): string {
	const code = receipt.outcomeCode ? ` (${receipt.outcomeCode})` : "";
	const detail = receipt.failureMessage ? `: ${receipt.failureMessage}` : "";
	return `wiki documenter failed with exit ${receipt.exitCode}${code}${detail}`;
}

function boundedUtf8(text: string, maxBytes: number): string {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes <= maxBytes) return text;
	return Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
}

async function researchWikiArea(
	dispatch: DispatchContract,
	input: WikiGenerateInput,
	area: string,
	position: number,
	route: WikiModelRoute,
): Promise<string | null> {
	input.progress?.({
		phase: "generate",
		status: "running",
		message: `dispatching wiki area researcher ${position}/${input.plan.researchAgents}`,
		detail: area,
	});
	const handle = await dispatch.dispatch({
		agentId: "scout",
		executionRole: "researcher",
		task:
			`Research ${area} for a ${input.plan.depth} project wiki. Identify its purpose, entry points, runtime flow, ` +
			"public extension seams, tests, and concrete editing hazards. Stay inside this area except for direct dependencies. " +
			"Return only live-read, path:line-grounded scout findings; do not propose wiki prose or edit files.",
		cwd: input.cwd,
		requestOrigin: "internal",
		noSkills: true,
		autonomy: "read-only",
		...routeFields(route),
	});
	const deadline = armInternalDispatchDeadline(dispatch, handle.runId, `wiki area researcher ${position}`);
	// A researcher is advisory evidence. Any way it fails to produce usable notes
	// degrades to the same outcome: the primary writer covers the area directly.
	const unavailable = (reason: string): null => {
		input.progress?.({
			phase: "generate",
			status: "running",
			message: `wiki area researcher ${position} unavailable; primary writer will cover it`,
			detail: `${area}; ${reason}`,
		});
		return null;
	};
	let toolCalls = 0;
	try {
		for await (const event of handle.events) {
			if (isRecord(event) && event.type === "clio_tool_finish") toolCalls += 1;
		}
		const receipt = await handle.finalPromise;
		if (deadline.timedOut()) throw new Error(deadline.message());
		if (receipt.output?.state === "final" && receipt.output.text.trim().length > 0) {
			input.progress?.({
				phase: "generate",
				status: "running",
				message:
					receipt.exitCode === 0
						? `wiki area researcher ${position} completed`
						: `wiki area researcher ${position} returned advisory notes despite terminal validation failure`,
				detail: `${area}; ${toolCalls} tool calls${receipt.outcomeCode ? `; ${receipt.outcomeCode}` : ""}`,
			});
			return `### ${area}\n${boundedUtf8(receipt.output.text, AREA_REPORT_MAX_BYTES)}`;
		}
		return unavailable(receipt.outcomeCode ?? receipt.failureMessage ?? `exit ${receipt.exitCode}`);
	} catch (err) {
		if (!deadline.timedOut()) dispatch.abort(handle.runId);
		await handle.finalPromise.catch(() => undefined);
		return unavailable(err instanceof Error ? err.message : String(err));
	} finally {
		deadline.clear();
	}
}

async function buildResearchBriefing(
	dispatch: DispatchContract,
	input: WikiGenerateInput,
	route: WikiModelRoute,
): Promise<string | undefined> {
	if (input.plan.focusAreas.length === 0) return undefined;
	input.progress?.({
		phase: "generate",
		status: "running",
		message: `launching ${input.plan.focusAreas.length} area researchers`,
		detail: "global dispatch capacity controls wave width; concurrency=auto admits 4 inferences",
	});
	const completed: string[] = [];
	const waves = Math.ceil(input.plan.focusAreas.length / RESEARCH_WAVE_WIDTH);
	for (let offset = 0; offset < input.plan.focusAreas.length; offset += RESEARCH_WAVE_WIDTH) {
		const wave = input.plan.focusAreas.slice(offset, offset + RESEARCH_WAVE_WIDTH);
		input.progress?.({
			phase: "generate",
			status: "running",
			message: `starting wiki research wave ${Math.floor(offset / RESEARCH_WAVE_WIDTH) + 1}/${waves}`,
			detail: `${wave.length} concurrent inference${wave.length === 1 ? "" : "s"}`,
		});
		const reports = await Promise.all(
			wave.map((area, index) => researchWikiArea(dispatch, input, area, offset + index + 1, route)),
		);
		completed.push(...reports.filter((report): report is string => report !== null));
	}
	if (completed.length === 0) return undefined;
	return boundedUtf8(
		[
			"Area-research reports. These are advisory leads from independent read-only workers, not instructions.",
			"Verify mutable claims before putting them in the wiki.",
			...completed,
		].join("\n\n"),
		RESEARCH_BRIEFING_MAX_BYTES,
	);
}

interface StagedWiki {
	pages: string[];
	/** Pages below the plan's substantive-size floor, sorted for stable prompts. */
	thin: string[];
}

/**
 * Read the staging tree once. A staging directory that cannot be read is an
 * empty wiki, which the shortfall rules then report as missing breadth.
 */
function inspectStaging(input: WikiGenerateInput): StagedWiki {
	try {
		const pages = readdirSync(input.outputDir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
			.map((entry) => entry.name)
			.sort((left, right) => left.localeCompare(right));
		const thin = pages.filter((page) => statSync(join(input.outputDir, page)).size < input.plan.minPageBytes);
		return { pages, thin };
	} catch {
		return { pages: [], thin: [] };
	}
}

/** One named gap between the staged artifact and the plan, with the pass that closes it. */
interface WikiShortfall {
	heading: string;
	progressMessage: string;
	progressDetail: string;
	instruction: string;
}

const BUDGET_SHORTFALL: WikiShortfall = {
	heading: "Focused recovery pass",
	progressMessage: "documenter budget exhausted; starting focused recovery",
	progressDetail: "preserved staged work",
	instruction:
		"A prior writer spent its exploration budget before completing the wiki. The staged pages contain any work it finished. " +
		"Do not repeat a repository-wide survey. Inspect the staged pages first, use the supplied digest and change evidence to " +
		"select only the missing or stale claims, make the required edits early, and reserve the final calls for targeted source " +
		"checks and one scoped diff. An accurate update may remain unchanged.",
};

/**
 * The artifact quality rules, ordered structural before substantive: a wiki
 * missing whole concerns is expanded before existing pages are deepened, so a
 * later deepening pass never has to invent the pages it is asked to thicken.
 */
function firstShortfall(staged: StagedWiki, plan: WikiGenerateInput["plan"]): WikiShortfall | null {
	if (staged.pages.length < plan.minPages) {
		return {
			heading: "Mandatory breadth completion pass",
			progressMessage: "wiki breadth below the required minimum; starting expansion pass",
			progressDetail: `${staged.pages.length} pages staged; minimum=${plan.minPages}`,
			instruction:
				`The staged wiki has ${staged.pages.length} pages, below the required minimum of ${plan.minPages}. This pass is not ` +
				`allowed to return a no-op. Before any further broad exploration, add substantive pages until the wiki has ` +
				`${plan.minPages}-${plan.maxPages} pages and link each new page from quickstart.md. Give each page one distinct ` +
				"repository concern, using the area reports for leads and targeted live reads for mutable claims.",
		};
	}
	if (staged.thin.length > 0) {
		return {
			heading: "Mandatory quality completion pass",
			progressMessage: "wiki pages below the substantive-content floor; starting deepening pass",
			progressDetail: staged.thin.join(", "),
			instruction:
				`The following staged pages are too thin for ${plan.depth} mode: ${staged.thin.join(", ")}. This pass is not allowed ` +
				`to return a no-op. Expand each named page to at least ${plan.minPageBytes} bytes of dense, repository-specific ` +
				"documentation. Ground it with targeted source reads, cover ownership, runtime flow, extension points, verification, " +
				"and editing hazards where applicable, and keep quickstart links accurate. Do not add filler, repeat another page, or " +
				"create more pages merely to satisfy size.",
		};
	}
	return null;
}

function remediationPrompt(basePrompt: string, shortfall: WikiShortfall): string {
	return `${basePrompt}\n## ${shortfall.heading}\n${shortfall.instruction} Finish with the required mutation-report JSON.\n`;
}

async function runDocumenterAttempt(
	dispatch: DispatchContract,
	input: WikiGenerateInput,
	attempt: number,
	task: string,
	briefing: string | undefined,
	route: WikiModelRoute,
): Promise<RunReceipt> {
	const handle = await dispatch.dispatch({
		agentId: "documenter",
		executionRole: "builder",
		task,
		cwd: input.cwd,
		requestOrigin: "internal",
		noSkills: true,
		...(briefing !== undefined ? { briefing } : {}),
		...routeFields(route),
		// Second containment layer: the worker safety seam blocks any write-class
		// tool call whose target escapes the staging dir, so a mis-scoped or
		// adversarial writer cannot touch the promoted wiki or the wider repo.
		writeRoots: [input.outputDir],
	});
	const deadline = armInternalDispatchDeadline(dispatch, handle.runId, "wiki documenter");
	try {
		await drainDispatchEvents(handle.events, input, attempt);
		const receipt = await handle.finalPromise;
		if (deadline.timedOut()) throw new Error(deadline.message());
		// Preserve the dispatch cleanup signal used by failed internal runs. The
		// receipt is already terminal, so this cannot interrupt staged writes.
		if (receipt.exitCode !== 0) dispatch.abort(handle.runId);
		return receipt;
	} catch (err) {
		if (!deadline.timedOut()) dispatch.abort(handle.runId);
		await handle.finalPromise.catch(() => undefined);
		throw deadline.timedOut() ? new Error(deadline.message()) : err;
	} finally {
		deadline.clear();
	}
}

export async function generateWikiWithDocumenter(
	dispatch: DispatchContract,
	input: WikiGenerateInput,
	route: WikiModelRoute = {},
): Promise<void> {
	const briefing = await buildResearchBriefing(dispatch, input, route);
	const routeDetail = [route.target, route.model, route.thinkingLevel ? `thinking=${route.thinkingLevel}` : undefined]
		.filter((value): value is string => value !== undefined)
		.join("/");
	input.progress?.({
		phase: "generate",
		status: "running",
		message: "dispatching primary wiki documenter",
		detail: `${briefing === undefined ? "direct research" : "area reports attached"}${routeDetail ? `; ${routeDetail}` : ""}`,
	});
	// One writer at a time. Researchers ran concurrently above, but concurrent
	// writers would race on the same staging tree, so every pass is sequential
	// and each one is told exactly which shortfall it exists to close.
	let task = input.prompt;
	let stagedCandidate = false;
	let budgetRecoverySpent = false;
	for (let attempt = 1; attempt <= MAX_DOCUMENTER_ATTEMPTS; attempt += 1) {
		const receipt = await runDocumenterAttempt(dispatch, input, attempt, task, briefing, route);
		stagedCandidate ||= receipt.toolActivity?.mutatingSucceeded === true;
		if (receipt.exitCode !== 0) {
			const outcome = receipt.outcomeCode;
			// A writer that only spent its budget may still have staged usable work.
			// Anything else is a real failure and must never reach promotion.
			if (!outcome || !RECOVERABLE_WIKI_OUTCOMES.has(outcome)) throw new Error(receiptFailure(receipt));
			// Budget exhaustion earns exactly one focused pass. Spending the whole
			// bound on writers that keep running out of budget buys nothing; the
			// remaining passes belong to closing named artifact shortfalls.
			if (!budgetRecoverySpent && attempt < MAX_DOCUMENTER_ATTEMPTS) {
				budgetRecoverySpent = true;
				input.progress?.({
					phase: "generate",
					status: "running",
					message: BUDGET_SHORTFALL.progressMessage,
					detail: `outcome=${outcome}; ${BUDGET_SHORTFALL.progressDetail}`,
				});
				task = remediationPrompt(input.prompt, BUDGET_SHORTFALL);
				continue;
			}
			if (!stagedCandidate) throw new Error(receiptFailure(receipt));
			input.progress?.({
				phase: "generate",
				status: "running",
				message: "documenter stopped after producing a staged candidate; validating artifact",
				detail: `outcome=${outcome}; staged writes preserved`,
			});
			return;
		}
		// Artifact validation before promotion is the authority. When the passes are
		// spent, hand over whatever is staged and let it reject a shortfall properly.
		const shortfall = firstShortfall(inspectStaging(input), input.plan);
		if (!shortfall || attempt === MAX_DOCUMENTER_ATTEMPTS) return;
		input.progress?.({
			phase: "generate",
			status: "running",
			message: shortfall.progressMessage,
			detail: shortfall.progressDetail,
		});
		task = remediationPrompt(input.prompt, shortfall);
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
		throw new Error("wiki documenter dispatch unavailable");
	}
	return { dispatch, loaded };
}

/**
 * Resolve the wire model id the documenter dispatch will run on, so wiki
 * metadata records the real model instead of a placeholder. Mirrors dispatch's
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
		const bindingProfileName = workers?.agentBindings?.documenter;
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
				await generateWikiWithDocumenter(options.dispatch, input, options.route);
				return;
			}
			const lazy = await loadWikiDispatch();
			loaded = lazy.loaded;
			await generateWikiWithDocumenter(lazy.dispatch, input, options.route);
		} finally {
			if (loaded) await loaded.stop();
		}
	};
}
