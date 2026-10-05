import {
	capabilityEnvelope,
	type ExtensionContentAccess,
	type ExtensionEffect,
	type ExtensionHookDeclaration,
	type ExtensionHookEvent,
	type ExtensionRuntimeHookBridge,
	envelopeDigest,
	type InstalledExtension,
	isLoadableExtension,
} from "../domains/extensions/index.js";
import type {
	HookReceipt,
	HookReceiptSink,
	MiddlewareEffect,
	MiddlewareHookInput,
	MiddlewareHookRegistration,
} from "../domains/middleware/index.js";

/** A hook that misses this many deadlines in a row is disabled for the generation. */
const TIMEOUT_STREAK_LIMIT = 3;

type ToolOrTurnPoint = "before_tool" | "after_tool" | "turn_start" | "turn_end";

export interface ExtensionRuntimeHookOptions {
	generation: number;
	recordReceipt: HookReceiptSink;
	now?: () => number;
}

function middlewareEffect(effect: ExtensionEffect): MiddlewareEffect | null {
	switch (effect.kind) {
		case "block_tool":
			return { kind: "block_tool", reason: effect.reason, severity: "hard-block" };
		case "annotate_tool_result":
			return {
				kind: "annotate_tool_result",
				message: effect.message,
				...(effect.severity !== undefined ? { severity: effect.severity } : {}),
			};
		case "inject_reminder":
			return {
				kind: "inject_reminder",
				message: effect.message,
				...(effect.severity !== undefined ? { severity: effect.severity } : {}),
				...(effect.audience !== undefined ? { audience: effect.audience } : {}),
			};
		case "require_tool":
			return { kind: "require_tool", toolName: effect.toolName };
		case "lock_tools":
			return { kind: "lock_tools" };
		case "notify_operator":
			return { kind: "notify_operator", message: effect.message, key: effect.key };
		case "protect_path":
			return { kind: "protect_path", path: effect.path, reason: effect.reason };
		case "request_continuation":
			return {
				kind: "request_continuation",
				message: effect.message,
				...(effect.note !== undefined ? { note: effect.note } : {}),
			};
		default:
			// Rewrites and prompt gates are applied by their own phases, not as middleware effects.
			return null;
	}
}

/**
 * What a hook may see. Metadata always crosses; tool arguments, tool results,
 * the prompt and assistant text cross only for the access classes the
 * manifest declares, so consent to the envelope is consent to the content.
 */
function hookEvent(
	point: ToolOrTurnPoint,
	input: MiddlewareHookInput,
	access: ReadonlyArray<ExtensionContentAccess>,
): ExtensionHookEvent {
	const turnId = input.turnId ?? null;
	const tool = input.toolName ?? "";
	const args = access.includes("tool-args") && input.toolArgs !== undefined ? { args: { ...input.toolArgs } } : {};
	switch (point) {
		case "before_tool":
			return { point, tool, turnId, ...args };
		case "after_tool": {
			const durationMs = input.metadata?.durationMs;
			return {
				point,
				tool,
				turnId,
				outcome: input.metadata?.resultKind === "error" ? "error" : "ok",
				durationMs: typeof durationMs === "number" ? durationMs : 0,
				...args,
				...(access.includes("tool-results") && input.toolResultDigest !== undefined
					? { result: input.toolResultDigest.text }
					: {}),
			};
		}
		case "turn_start":
			return {
				point,
				turnId: turnId ?? "",
				...(access.includes("prompt") && input.text !== undefined ? { text: input.text } : {}),
			};
		case "turn_end":
			return {
				point,
				turnId: turnId ?? "",
				outcome:
					input.metadata?.stopReason === "aborted"
						? "aborted"
						: input.metadata?.stopReason === "error"
							? "error"
							: "completed",
				...(access.includes("assistant-text") && input.text !== undefined ? { text: input.text } : {}),
			};
	}
}

/**
 * A gate that fails closed. Only a call not yet run can be refused; at the
 * other points a closed gate is said, not enforced.
 */
function closedGate(point: ToolOrTurnPoint, extensionId: string, reason: string): MiddlewareEffect[] {
	const message = `extension ${extensionId} ${point} hook ${reason}; the gate fails closed`;
	if (point === "before_tool") return [{ kind: "block_tool", reason: message, severity: "hard-block" }];
	if (point === "after_tool") return [{ kind: "annotate_tool_result", message, severity: "warn" }];
	return [];
}

/**
 * One owned middleware registration per declared api 2 hook, published with
 * the extension generation through the reload coordinator. Each runs only in
 * the awaited phase: at tool points through the registry, at turn points
 * through the turn middleware. Prompt-submit hooks are not wired yet.
 */
export function buildExtensionRuntimeHookRegistrations(
	packages: ReadonlyArray<InstalledExtension>,
	bridge: ExtensionRuntimeHookBridge,
	options: ExtensionRuntimeHookOptions,
): MiddlewareHookRegistration[] {
	const now = options.now ?? Date.now;
	const registrations: MiddlewareHookRegistration[] = [];
	for (const entry of packages) {
		if (!isLoadableExtension(entry) || entry.runtimeV2 === undefined) continue;
		const declared = entry.runtimeV2;
		const provenance = entry.provenance;
		const digest = envelopeDigest(capabilityEnvelope(declared));
		declared.hooks.forEach((hook: ExtensionHookDeclaration, index) => {
			if (hook.on === "prompt_submit") return;
			const point: ToolOrTurnPoint = hook.on;
			const id = `extension:${entry.id}:${point}:${index}`;
			let streak = 0;
			let disabled = false;
			const reported = new Set<string>();
			const notify = (reason: string): void => {
				if (reported.has(reason)) return;
				reported.add(reason);
				try {
					bridge.current()?.notify(`extension ${entry.id}: ${point} hook ${reason}`);
				} catch {
					// A notice sink has no authority over the call.
				}
			};
			const receipt = (
				input: MiddlewareHookInput,
				outcome: HookReceipt["outcome"],
				startedAt: number,
				effects: ReadonlyArray<MiddlewareEffect>,
			): void => {
				try {
					options.recordReceipt({
						at: now(),
						hookId: id,
						origin: "extension",
						sourcePath: entry.manifestPath,
						hash: digest,
						hook: point,
						kind: "runtime",
						outcome,
						durationMs: Math.round(performance.now() - startedAt),
						...(effects.length > 0 ? { effectKinds: effects.map((effect) => effect.kind) } : {}),
						...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
						extension: {
							id: entry.id,
							scope: entry.scope,
							canonicalRoot: provenance.canonicalRoot,
							manifestDigest: provenance.manifestDigest,
							contentDigest: provenance.contentDigest,
							declarationsDigest: digest,
							generation: options.generation,
						},
					});
				} catch {
					// Receipts are observability; a failed write changes no call.
				}
			};
			const fail = (
				input: MiddlewareHookInput,
				startedAt: number,
				reason: string,
				policy: "pass" | "block",
				outcome: HookReceipt["outcome"],
			): MiddlewareEffect[] => {
				const effects = policy === "block" ? closedGate(point, entry.id, reason) : [];
				notify(policy === "block" ? `${reason}; it fails closed` : `${reason}; skipped`);
				receipt(input, outcome, startedAt, effects);
				return effects;
			};
			registrations.push({
				id,
				description: `${entry.id} runtime ${point} hook`,
				hooks: [point],
				...(hook.tools !== undefined ? { toolNames: [...hook.tools] } : {}),
				awaitedAtTools: true,
				evaluate: () => [],
				async evaluateAsync(input) {
					const startedAt = performance.now();
					if (disabled)
						return fail(input, startedAt, "is disabled after repeated missed deadlines", hook.onTimeout, "runtime-timeout");
					const executor = bridge.current();
					if (executor === null) return fail(input, startedAt, "has no running runtime", hook.onError, "runtime-failed");
					const outcome = await executor.hook(entry.id, hookEvent(point, input, declared.access), hook.timeoutMs);
					if (outcome.kind === "timeout") {
						streak += 1;
						if (streak >= TIMEOUT_STREAK_LIMIT) disabled = true;
						return fail(input, startedAt, `missed its ${hook.timeoutMs} ms deadline`, hook.onTimeout, "runtime-timeout");
					}
					streak = 0;
					if (outcome.kind === "error")
						return fail(input, startedAt, `failed: ${outcome.message}`, hook.onError, "runtime-failed");
					reported.clear();
					const effects = outcome.effects.flatMap((effect) => {
						const mapped = middlewareEffect(effect);
						return mapped === null ? [] : [mapped];
					});
					receipt(input, "runtime-ok", startedAt, effects);
					return effects;
				},
			});
		});
	}
	return registrations;
}
