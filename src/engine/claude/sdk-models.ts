import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { withClaudeCredential } from "../../core/claude-environment.js";
import { resolveClaudeLaunchCredential } from "../../domains/providers/auth/index.js";
import type { ProbeContext } from "../../domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../domains/providers/types/target-descriptor.js";
import { findExecutableOnPath } from "../../domains/toolchain/resolve.js";
import { loadClaudeAgentSdk } from "./sdk-module.js";

/** #416: one initialization-only subprocess, with no user message or inference turn. */
export async function listClaudeSdkModels(
	target: TargetDescriptor,
	ctx: ProbeContext,
	loadSdk = loadClaudeAgentSdk,
): Promise<Array<{ id: string; label: string; catalogId: string }>> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (ctx.signal?.aborted) abort();
	else ctx.signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(abort, ctx.httpTimeoutMs);
	let handle: Pick<Query, "supportedModels" | "close"> | undefined;
	let releaseInput: () => void = () => {};
	const inputClosed = new Promise<void>((resolve) => {
		releaseInput = resolve;
	});
	// #416: holding stdin open lets initialization finish without submitting a prompt.
	const idleInput: AsyncIterable<SDKUserMessage> = {
		[Symbol.asyncIterator]: () => ({
			next: async () => {
				await inputClosed;
				return { done: true, value: undefined };
			},
		}),
	};
	let rejectAbort: () => void = () => {};
	const cancelled = new Promise<never>((_resolve, reject) => {
		rejectAbort = () => reject(new Error("Claude SDK model listing cancelled or timed out"));
		if (controller.signal.aborted) rejectAbort();
		else controller.signal.addEventListener("abort", rejectAbort, { once: true });
	});
	try {
		return await Promise.race([
			(async () => {
				controller.signal.throwIfAborted();
				const { query } = await loadSdk();
				controller.signal.throwIfAborted();
				const credential = ctx.authToken
					? null
					: await resolveClaudeLaunchCredential(target.auth, process.env, { signal: controller.signal });
				controller.signal.throwIfAborted();
				const executable = process.env.CLAUDE_CODE_EXECUTABLE ?? findExecutableOnPath("claude");
				handle = query({
					prompt: idleInput,
					options: {
						abortController: controller,
						persistSession: false,
						settingSources: [],
						tools: [],
						mcpServers: {},
						env: withClaudeCredential({ ...process.env }, ctx.authToken ?? credential?.apiKey),
						...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
					},
				});
				const models = await handle.supportedModels();
				controller.signal.throwIfAborted();
				return models.map((model) => ({
					id: model.value,
					label: model.displayName,
					catalogId: model.resolvedModel ?? model.value,
				}));
			})(),
			cancelled,
		]);
	} finally {
		clearTimeout(timer);
		ctx.signal?.removeEventListener("abort", abort);
		controller.signal.removeEventListener("abort", rejectAbort);
		try {
			handle?.close();
		} finally {
			releaseInput();
			controller.abort();
		}
	}
}
