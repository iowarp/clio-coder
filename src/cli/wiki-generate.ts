import { type LoadResult, loadDomains } from "../core/domain-loader.js";
import { AgentsDomainModule } from "../domains/agents/index.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import { ContextDomainModule, type WikiGenerate, type WikiGenerateInput } from "../domains/context/index.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { DispatchDomainModule } from "../domains/dispatch/index.js";
import type { RunReceipt } from "../domains/dispatch/types.js";
import { MiddlewareDomainModule } from "../domains/middleware/index.js";
import { createPromptsDomainModule } from "../domains/prompts/index.js";
import { ProvidersDomainModule } from "../domains/providers/index.js";
import { ResourcesDomainModule } from "../domains/resources/index.js";
import { SafetyDomainModule } from "../domains/safety/index.js";

export interface ModelWikiGenerateOptions {
	dispatch?: DispatchContract;
}

async function drainDispatchEvents(events: AsyncIterable<unknown>): Promise<void> {
	for await (const _event of events) {
		// Drain the event stream so finalization cannot block on an unread iterator.
	}
}

function receiptFailure(receipt: RunReceipt): string {
	const detail = receipt.failureMessage ? `: ${receipt.failureMessage}` : "";
	return `wiki documenter failed with exit ${receipt.exitCode}${detail}`;
}

export async function generateWikiWithDocumenter(dispatch: DispatchContract, input: WikiGenerateInput): Promise<void> {
	const handle = await dispatch.dispatch({
		agentId: "documenter",
		task: input.prompt,
		cwd: input.cwd,
		requestOrigin: "internal",
		thinkingLevel: "off",
		noSkills: true,
	});
	try {
		await drainDispatchEvents(handle.events);
		const receipt = await handle.finalPromise;
		if (receipt.exitCode !== 0) throw new Error(receiptFailure(receipt));
	} catch (err) {
		dispatch.abort(handle.runId);
		await handle.finalPromise.catch(() => undefined);
		throw err;
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
