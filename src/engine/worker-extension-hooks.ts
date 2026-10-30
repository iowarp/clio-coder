// The matcher module directly, so the worker loads no other part of the extensions domain.
import { extensionHookToolMatcher } from "../domains/extensions/hook-tool-match.js";
import type { MiddlewareEffect, MiddlewareHookRegistration } from "../domains/middleware/index.js";
import {
	WORKER_HOOK_ROUND_TRIP_MS,
	type WorkerExtensionHook,
	type WorkerHookEffect,
	type WorkerHookRequest,
} from "../worker/protocol.js";

/** Sends one hook request to the orchestrator and resolves with its answer, or rejects when none arrives. */
export type WorkerHookTransport = (
	request: Omit<WorkerHookRequest, "requestId">,
	timeoutMs: number,
) => Promise<ReadonlyArray<WorkerHookEffect>>;

function middlewareEffect(effect: WorkerHookEffect): MiddlewareEffect {
	switch (effect.kind) {
		case "block_tool":
			return { kind: "block_tool", reason: effect.reason, severity: "hard-block" };
		case "rewrite_tool_input":
			return { kind: "rewrite_tool_input", args: effect.args, reason: effect.reason, source: effect.source };
		case "annotate_tool_result":
			return {
				kind: "annotate_tool_result",
				message: effect.message,
				...(effect.severity === undefined ? {} : { severity: effect.severity }),
			};
		case "protect_path":
			return { kind: "protect_path", path: effect.path, reason: effect.reason };
		case "require_tool":
			return { kind: "require_tool", toolName: effect.toolName };
		case "lock_tools":
			return { kind: "lock_tools" };
	}
}

/**
 * One awaited registration per hook of the dispatching session. A worker runs
 * no extension runtime: the registration sends the call to the orchestrator,
 * which runs the hook on the session's own runtime under its deadline, failure
 * policy and receipts, and holds the call until the effects come back. Only a
 * lost round trip is decided here, by the stricter of the hook's two policies,
 * so a gate that blocks on failure stays closed when the orchestrator cannot
 * answer.
 */
export function createWorkerExtensionHookRegistrations(
	hooks: ReadonlyArray<WorkerExtensionHook>,
	transport: WorkerHookTransport,
): MiddlewareHookRegistration[] {
	return hooks.map((hook) => ({
		id: hook.id,
		description: `${hook.id}, run by the dispatching session`,
		hooks: [hook.point],
		evidence: `extension-hook:${hook.point}@worker`,
		...(hook.tools !== undefined
			? { toolNames: [...hook.tools], matchesTool: extensionHookToolMatcher(hook.tools) }
			: {}),
		awaited: true,
		evaluate: () => [],
		async evaluateAsync(input) {
			const durationMs = input.metadata?.durationMs;
			const request: Omit<WorkerHookRequest, "requestId"> = {
				hookId: hook.id,
				point: hook.point,
				tool: input.toolName ?? "",
				...(input.toolArgs !== undefined ? { args: { ...input.toolArgs } } : {}),
				...(input.toolLanding !== undefined ? { landing: structuredClone({ ...input.toolLanding }) } : {}),
				...(hook.point === "after_tool"
					? {
							outcome: input.metadata?.resultKind === "error" ? ("error" as const) : ("ok" as const),
							durationMs: typeof durationMs === "number" ? durationMs : 0,
							...(input.toolResultDigest !== undefined ? { result: input.toolResultDigest.text } : {}),
						}
					: {}),
			};
			let effects: ReadonlyArray<WorkerHookEffect>;
			try {
				effects = await transport(request, hook.timeoutMs + WORKER_HOOK_ROUND_TRIP_MS);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				// A lost answer is neither the hook's error nor its timeout, so the stricter policy decides.
				if (hook.onError !== "block" && hook.onTimeout !== "block") return [];
				const message = `${hook.id}: the dispatching session did not answer (${reason}); the gate fails closed`;
				return hook.point === "before_tool"
					? [{ kind: "block_tool", reason: message, severity: "hard-block" }]
					: [{ kind: "annotate_tool_result", message, severity: "warn" }];
			}
			return effects.map(middlewareEffect);
		},
	}));
}
