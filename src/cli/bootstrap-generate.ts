import { loadDomains, type LoadResult } from "../core/domain-loader.js";
import { AgentsDomainModule } from "../domains/agents/index.js";
import { ConfigDomainModule } from "../domains/config/index.js";
import {
	type BootstrapFallbackMode,
	type BootstrapGenerate,
	type BootstrapGenerateInput,
	type BootstrapStructuredOutput,
	ContextDomainModule,
	fallbackBootstrapOutput,
} from "../domains/context/index.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { DispatchDomainModule } from "../domains/dispatch/index.js";
import type { RunReceipt } from "../domains/dispatch/types.js";
import { MiddlewareDomainModule } from "../domains/middleware/index.js";
import { createPromptsDomainModule } from "../domains/prompts/index.js";
import { ProvidersDomainModule } from "../domains/providers/index.js";
import { ResourcesDomainModule } from "../domains/resources/index.js";
import { SafetyDomainModule } from "../domains/safety/index.js";
import { buildBootstrapPrompt, parseBootstrapModelOutput } from "../domains/context/bootstrap-prompt.js";

/**
 * Model-driven CLIO.md generation. Dispatches Clio's internal `scout` shadow
 * agent with a bootstrap prompt grounded in the codewiki structure, then
 * validates the structured JSON the model returns. Shared by
 * `clio context-init` and the interactive `/context-init` command.
 */

export interface ModelBootstrapGenerateOptions {
	dispatch?: DispatchContract;
	onFallback?: (err: Error, mode: BootstrapFallbackMode) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assistantTextFromMessage(message: unknown): string {
	if (!isRecord(message) || message.role !== "assistant") return "";
	const content = message.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (typeof block === "string") return block;
			if (!isRecord(block)) return "";
			return typeof block.text === "string" ? block.text : "";
		})
		.join("")
		.trim();
}

function textDeltaFromEvent(event: unknown): string {
	if (!isRecord(event) || event.type !== "text_delta") return "";
	return typeof event.text === "string" ? event.text : "";
}

async function collectDispatchAssistantText(events: AsyncIterable<unknown>): Promise<string> {
	let streamedText = "";
	let lastAssistantText = "";
	for await (const event of events) {
		streamedText += textDeltaFromEvent(event);
		if (isRecord(event) && event.type === "message_end") {
			const text = assistantTextFromMessage(event.message);
			if (text.length > 0) lastAssistantText = text;
		}
	}
	const text = (lastAssistantText || streamedText).trim();
	if (text.length === 0) throw new Error("bootstrap scout did not return an assistant response");
	return text;
}

function receiptFailure(receipt: RunReceipt): string {
	const detail = receipt.failureMessage ? `: ${receipt.failureMessage}` : "";
	return `bootstrap scout failed with exit ${receipt.exitCode}${detail}`;
}

export async function generateBootstrapWithScout(
	dispatch: DispatchContract,
	input: BootstrapGenerateInput,
): Promise<BootstrapStructuredOutput> {
	const prompt = buildBootstrapPrompt(input);
	input.progress?.({
		phase: "generate",
		status: "running",
		message: "dispatching internal scout shadow agent",
		detail: "agent=scout",
	});
	const handle = await dispatch.dispatch({
		agentId: "scout",
		task: prompt,
		cwd: input.cwd,
		requestOrigin: "internal",
		thinkingLevel: "off",
		noSkills: true,
	});
	try {
		const text = await collectDispatchAssistantText(handle.events);
		const receipt = await handle.finalPromise;
		if (receipt.exitCode !== 0) throw new Error(receiptFailure(receipt));
		const output = parseBootstrapModelOutput(text);
		input.progress?.({
			phase: "generate",
			status: "running",
			message: "scout returned structured bootstrap JSON",
			detail: `${text.length} bytes`,
		});
		return output;
	} catch (err) {
		dispatch.abort(handle.runId);
		await handle.finalPromise.catch(() => undefined);
		throw err;
	}
}

async function loadBootstrapDispatch(): Promise<{ dispatch: DispatchContract; loaded: LoadResult }> {
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
		throw new Error("bootstrap scout dispatch unavailable");
	}
	return { dispatch, loaded };
}

/**
 * Wrap model-driven generation so any failure (no configured target, offline
 * endpoint, malformed output) degrades cleanly. Existing valid CLIO.md content
 * is preserved when possible; otherwise the deterministic heuristic is used.
 */
export function modelBootstrapGenerate(options: ModelBootstrapGenerateOptions = {}): BootstrapGenerate {
	return async (input) => {
		let loaded: LoadResult | null = null;
		try {
			if (options.dispatch) {
				return await generateBootstrapWithScout(options.dispatch, input);
			}
			{
				const lazy = await loadBootstrapDispatch();
				loaded = lazy.loaded;
				return await generateBootstrapWithScout(lazy.dispatch, input);
			}
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			const fallback = fallbackBootstrapOutput(input);
			input.progress?.({
				phase: "generate",
				status: "running",
				message:
					fallback.mode === "existing"
						? "scout unavailable; preserving existing CLIO.md"
						: "scout unavailable; using heuristic bootstrap",
				detail: error.message,
			});
			options.onFallback?.(error, fallback.mode);
			return fallback.output;
		} finally {
			if (loaded) await loaded.stop();
		}
	};
}
