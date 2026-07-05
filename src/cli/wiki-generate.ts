import { type LoadResult, loadDomains } from "../core/domain-loader.js";
import { AgentsDomainModule } from "../domains/agents/index.js";
import type { ConfigContract } from "../domains/config/contract.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { ContextDomainModule, type WikiGenerate, type WikiGenerateInput } from "../domains/context/index.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { DispatchDomainModule } from "../domains/dispatch/index.js";
import type { RunReceipt } from "../domains/dispatch/types.js";
import { MiddlewareDomainModule } from "../domains/middleware/index.js";
import { createPromptsDomainModule } from "../domains/prompts/index.js";
import { canonicalizeWireModelId, type ProvidersContract, ProvidersDomainModule } from "../domains/providers/index.js";
import { ResourcesDomainModule } from "../domains/resources/index.js";
import { SafetyDomainModule } from "../domains/safety/index.js";
import { armInternalDispatchDeadline } from "./internal-dispatch.js";

/**
 * Model id recorded on wiki metadata when the documenter target cannot be
 * resolved. It is only reached when no target is configured, in which case the
 * documenter dispatch also fails and no metadata is written, so it never lands
 * on a real artifact; it exists so the resolver never throws.
 */
const UNRESOLVED_DOCUMENTER_MODEL = "unresolved-documenter-target";

export interface ModelWikiGenerateOptions {
	dispatch?: DispatchContract;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolNameFromEvent(event: unknown): string | null {
	if (!isRecord(event)) return null;
	const payload = event.payload;
	if (!isRecord(payload)) return null;
	return typeof payload.tool === "string" && payload.tool.length > 0 ? payload.tool : null;
}

function toolOutcomeFromEvent(event: unknown): string | null {
	if (!isRecord(event)) return null;
	const payload = event.payload;
	if (!isRecord(payload)) return null;
	return typeof payload.outcome === "string" && payload.outcome.length > 0 ? payload.outcome : null;
}

function formatElapsed(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "elapsed unknown";
	if (ms < 1000) return `elapsed ${Math.round(ms)}ms`;
	return `elapsed ${Math.round(ms / 1000)}s`;
}

async function drainDispatchEvents(events: AsyncIterable<unknown>, input: WikiGenerateInput): Promise<void> {
	const startedAt = Date.now();
	for await (const event of events) {
		if (isRecord(event) && event.type === "agent_start") {
			input.progress?.({
				phase: "generate",
				status: "running",
				message: "documenter started wiki update",
				detail: formatElapsed(Date.now() - startedAt),
			});
		}
		if (isRecord(event) && event.type === "clio_tool_start") {
			const tool = toolNameFromEvent(event);
			if (tool) {
				input.progress?.({
					phase: "generate",
					status: "running",
					message: `documenter running ${tool}`,
					detail: formatElapsed(Date.now() - startedAt),
				});
			}
		}
		if (isRecord(event) && event.type === "clio_tool_finish") {
			const tool = toolNameFromEvent(event);
			const outcome = toolOutcomeFromEvent(event) ?? "done";
			if (tool) {
				input.progress?.({
					phase: "generate",
					status: "running",
					message: `documenter ${tool} ${outcome}`,
					detail: formatElapsed(Date.now() - startedAt),
				});
			}
		}
		// Drain the event stream so finalization cannot block on an unread iterator.
	}
}

function receiptFailure(receipt: RunReceipt): string {
	const detail = receipt.failureMessage ? `: ${receipt.failureMessage}` : "";
	return `wiki documenter failed with exit ${receipt.exitCode}${detail}`;
}

export async function generateWikiWithDocumenter(dispatch: DispatchContract, input: WikiGenerateInput): Promise<void> {
	input.progress?.({
		phase: "generate",
		status: "running",
		message: "dispatching internal documenter shadow agent",
		detail: "agent=documenter",
	});
	const handle = await dispatch.dispatch({
		agentId: "documenter",
		task: input.prompt,
		cwd: input.cwd,
		requestOrigin: "internal",
		thinkingLevel: "off",
		noSkills: true,
		// Second containment layer: the worker safety seam blocks any write-class
		// tool call whose target escapes the staging dir, so a mis-scoped or
		// adversarial writer cannot touch the promoted wiki or the wider repo.
		writeRoots: [input.outputDir],
	});
	const deadline = armInternalDispatchDeadline(dispatch, handle.runId, "wiki documenter");
	try {
		await drainDispatchEvents(handle.events, input);
		const receipt = await handle.finalPromise;
		if (deadline.timedOut()) throw new Error(deadline.message());
		if (receipt.exitCode !== 0) throw new Error(receiptFailure(receipt));
	} catch (err) {
		if (!deadline.timedOut()) dispatch.abort(handle.runId);
		await handle.finalPromise.catch(() => undefined);
		throw deadline.timedOut() ? new Error(deadline.message()) : err;
	} finally {
		deadline.clear();
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
export async function resolveDocumenterModelId(): Promise<string> {
	const loaded = await loadDomains([ConfigDomainModule, ResourcesDomainModule, ProvidersDomainModule]);
	try {
		const config = loaded.getContract<ConfigContract>("config");
		const providers = loaded.getContract<ProvidersContract>("providers");
		if (!config || !providers) return UNRESOLVED_DOCUMENTER_MODEL;
		const settings = config.get();
		const workers = settings.workers;
		const bindingProfileName = workers?.agentBindings?.documenter;
		const profile = bindingProfileName ? workers?.profiles?.[bindingProfileName] : undefined;
		const targetId = profile?.target ?? workers?.default?.target ?? settings.targets?.[0]?.id ?? null;
		if (!targetId) return UNRESOLVED_DOCUMENTER_MODEL;
		const target = providers.getTarget(targetId);
		const requestedModel = profile?.model ?? workers?.default?.model ?? target?.defaultModel ?? null;
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
				await generateWikiWithDocumenter(options.dispatch, input);
				return;
			}
			const lazy = await loadWikiDispatch();
			loaded = lazy.loaded;
			await generateWikiWithDocumenter(lazy.dispatch, input);
		} finally {
			if (loaded) await loaded.stop();
		}
	};
}
