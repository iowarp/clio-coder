import { type LoadResult, loadDomains } from "../core/domain-loader.js";
import { AgentsDomainModule } from "../domains/agents/index.js";
import type { ConfigContract } from "../domains/config/contract.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { ContextDomainModule, type WikiGenerate, type WikiGenerateInput } from "../domains/context/index.js";
import { validateWikiLayoutInDir } from "../domains/context/wiki/layout.js";
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
/** One normal pass plus one bounded recovery for budget exhaustion or validation failure. */
const MAX_DOCUMENTER_ATTEMPTS = 2;
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

function validationShortfall(input: WikiGenerateInput): WikiShortfall | null {
	const validation = validateWikiLayoutInDir(input.outputDir, { sourceRoot: input.cwd });
	if (validation.ok) return null;
	return {
		heading: "Validation repair pass",
		progressMessage: "wiki failed deterministic validation; starting repair pass",
		progressDetail: validation.problems.slice(0, 5).join("; "),
		instruction:
			`The staged wiki failed deterministic validation:\n- ${validation.problems.join("\n- ")}\n` +
			"Inspect each problem, correct unsupported source citations, repair or remove broken internal wiki links, ensure quickstart.md links every page, and add any missing pages. " +
			"Do not silence a check with vague prose or by creating a page whose only purpose is satisfying a link.",
	};
}

function remediationPrompt(basePrompt: string, shortfall: WikiShortfall): string {
	return `${basePrompt}\n## ${shortfall.heading}\n${shortfall.instruction} Finish with the required mutation-report JSON.\n`;
}

async function runDocumenterAttempt(
	dispatch: DispatchContract,
	input: WikiGenerateInput,
	attempt: number,
	task: string,
	route: WikiModelRoute,
): Promise<RunReceipt> {
	const handle = await dispatch.dispatch({
		agentId: "documenter",
		executionRole: "builder",
		task,
		cwd: input.cwd,
		requestOrigin: "internal",
		noSkills: true,
		...routeFields(route),
		// Containment: the worker safety seam blocks any write-class tool call
		// whose target escapes the staging dir.
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
	const routeDetail = [route.target, route.model, route.thinkingLevel ? `thinking=${route.thinkingLevel}` : undefined]
		.filter((value): value is string => value !== undefined)
		.join("/");
	input.progress?.({
		phase: "generate",
		status: "running",
		message: "dispatching wiki documenter",
		detail: `single-owner direct research${routeDetail ? `; ${routeDetail}` : ""}`,
	});
	// One documenter pass. A second attempt is allowed only for budget exhaustion
	// or deterministic validation failure.
	let task = input.prompt;
	let budgetRecoverySpent = false;
	for (let attempt = 1; attempt <= MAX_DOCUMENTER_ATTEMPTS; attempt += 1) {
		const receipt = await runDocumenterAttempt(dispatch, input, attempt, task, route);
		if (receipt.exitCode !== 0) {
			const outcome = receipt.outcomeCode;
			if (!outcome || !RECOVERABLE_WIKI_OUTCOMES.has(outcome)) throw new Error(receiptFailure(receipt));
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
			// The writer ran out of budget, not out of correctness. Whatever it
			// staged is a candidate like any other, so validation decides, and a
			// wiki that passes every deterministic check is promoted rather than
			// deleted for the way its author stopped. A staged tree that fails
			// validation fails the run carrying the writer's own diagnosis.
			const remaining = validationShortfall(input);
			if (remaining !== null) {
				throw new Error(`${receiptFailure(receipt)}; staged wiki also failed validation: ${remaining.progressDetail}`);
			}
			input.progress?.({
				phase: "generate",
				status: "running",
				message: "documenter ended on its budget; staged wiki passed validation",
				detail: `outcome=${outcome}`,
			});
			return;
		}
		const shortfall = validationShortfall(input);
		if (!shortfall) return;
		if (attempt === MAX_DOCUMENTER_ATTEMPTS) return;
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
