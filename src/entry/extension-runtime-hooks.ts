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
	type LoadableExtension,
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

function middlewareEffect(effect: ExtensionEffect, extensionId: string): MiddlewareEffect | null {
	switch (effect.kind) {
		case "rewrite_tool_input":
			return { kind: "rewrite_tool_input", args: effect.args, reason: effect.reason, source: extensionId };
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
			// Prompt effects never reach the middleware: buildExtensionPromptGate applies them.
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

type RuntimeHookPoint = ToolOrTurnPoint | "prompt_submit";

type RunnerVerdict =
	| { kind: "ok"; effects: ExtensionEffect[] }
	| { kind: "failed"; reason: string; policy: "pass" | "block"; outcome: HookReceipt["outcome"] };

interface RuntimeHookRunner {
	run(event: ExtensionHookEvent, toolName?: string): Promise<RunnerVerdict>;
	/** Receipt for a finished run, with the effects the host will apply. */
	settle(verdict: RunnerVerdict, startedAt: number, effectKinds: ReadonlyArray<string>, toolName?: string): void;
}

/**
 * The deadline, failure policy, streak and receipt of one declared hook. A
 * runner lives for one generation: a reload builds new runners, so a hook
 * disabled after repeated missed deadlines comes back with the next build.
 */
function createRuntimeHookRunner(
	entry: LoadableExtension,
	hook: ExtensionHookDeclaration,
	point: RuntimeHookPoint,
	id: string,
	digest: string,
	bridge: ExtensionRuntimeHookBridge,
	options: ExtensionRuntimeHookOptions,
): RuntimeHookRunner {
	const now = options.now ?? Date.now;
	const provenance = entry.provenance;
	let streak = 0;
	let disabled = false;
	let turnId: string | null = null;
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
	const failed = (reason: string, policy: "pass" | "block", outcome: HookReceipt["outcome"]): RunnerVerdict => {
		notify(policy === "block" ? `${reason}; it fails closed` : `${reason}; skipped`);
		return { kind: "failed", reason, policy, outcome };
	};
	return {
		async run(event) {
			turnId = "turnId" in event ? event.turnId : null;
			if (disabled) return failed("is disabled after repeated missed deadlines", hook.onTimeout, "runtime-timeout");
			const executor = bridge.current();
			if (executor === null) return failed("has no running runtime", hook.onError, "runtime-failed");
			const outcome = await executor.hook(entry.id, event, hook.timeoutMs);
			if (outcome.kind === "timeout") {
				streak += 1;
				if (streak >= TIMEOUT_STREAK_LIMIT) disabled = true;
				return failed(`missed its ${hook.timeoutMs} ms deadline`, hook.onTimeout, "runtime-timeout");
			}
			streak = 0;
			if (outcome.kind === "error") return failed(`failed: ${outcome.message}`, hook.onError, "runtime-failed");
			reported.clear();
			return { kind: "ok", effects: outcome.effects };
		},
		settle(verdict, startedAt, effectKinds, toolName) {
			try {
				options.recordReceipt({
					at: now(),
					...(turnId ? { turnId } : {}),
					hookId: id,
					origin: "extension",
					sourcePath: entry.manifestPath,
					hash: digest,
					hook: point,
					kind: "runtime",
					extensionVersion: entry.version,
					outcome: verdict.kind === "ok" ? "runtime-ok" : verdict.outcome,
					durationMs: Math.round(performance.now() - startedAt),
					...(effectKinds.length > 0 ? { effectKinds: [...effectKinds] } : {}),
					...(toolName !== undefined ? { toolName } : {}),
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
		},
	};
}

function eachRuntimeHook(
	packages: ReadonlyArray<InstalledExtension>,
	visit: (entry: LoadableExtension, hook: ExtensionHookDeclaration, index: number, digest: string) => void,
): void {
	for (const entry of packages) {
		if (!isLoadableExtension(entry) || entry.runtimeV2 === undefined) continue;
		const digest = envelopeDigest(capabilityEnvelope(entry.runtimeV2, entry.plugin));
		entry.runtimeV2.hooks.forEach((hook: ExtensionHookDeclaration, index) => {
			visit(entry, hook, index, digest);
		});
	}
}

/**
 * One owned middleware registration per declared api 2 tool or turn hook,
 * published with the extension generation through the reload coordinator.
 * Each runs only in the awaited phase: at tool points through the registry,
 * at turn points through the turn middleware. Prompt-submit hooks run through
 * `buildExtensionPromptGate` instead, because no middleware point carries the
 * prompt before a turn exists.
 */
export function buildExtensionRuntimeHookRegistrations(
	packages: ReadonlyArray<InstalledExtension>,
	bridge: ExtensionRuntimeHookBridge,
	options: ExtensionRuntimeHookOptions,
): MiddlewareHookRegistration[] {
	const registrations: MiddlewareHookRegistration[] = [];
	eachRuntimeHook(packages, (entry, hook, index, digest) => {
		if (hook.on === "prompt_submit") return;
		const point: ToolOrTurnPoint = hook.on;
		const access = entry.runtimeV2?.access ?? [];
		const id = `extension:${entry.id}:${point}:${index}`;
		const runner = createRuntimeHookRunner(entry, hook, point, id, digest, bridge, options);
		registrations.push({
			id,
			description: `${entry.id} runtime ${point} hook`,
			hooks: [point],
			...(hook.tools !== undefined ? { toolNames: [...hook.tools] } : {}),
			awaited: true,
			evaluate: () => [],
			async evaluateAsync(input) {
				const startedAt = performance.now();
				const verdict = await runner.run(hookEvent(point, input, access), input.toolName);
				const effects =
					verdict.kind === "ok"
						? verdict.effects.flatMap((effect) => {
								const mapped = middlewareEffect(effect, entry.id);
								return mapped === null ? [] : [mapped];
							})
						: verdict.policy === "block"
							? closedGate(point, entry.id, verdict.reason)
							: [];
				runner.settle(
					verdict,
					startedAt,
					effects.map((effect) => effect.kind),
					input.toolName,
				);
				return effects;
			},
		});
	});
	return registrations;
}

export type ExtensionPromptGateVerdict =
	| { kind: "pass"; text: string; notices: string[] }
	| { kind: "block"; reason: string; notices: string[] };

/** The prompt_submit hooks of one generation, run in package order. */
export interface ExtensionPromptGate {
	readonly size: number;
	/**
	 * `typed` is the line the operator typed; `rewritable` says whether the
	 * model would receive exactly that line. A rewrite of a line a template
	 * expanded is refused with a notice, since the body is not the line.
	 */
	run(typed: string, rewritable: boolean): Promise<ExtensionPromptGateVerdict>;
}

/**
 * The prompt gate for one extension generation. Each hook sees the prompt as
 * the previous hook left it (with `access: [prompt]`; otherwise metadata
 * only), the first block refuses the turn, and a hook whose failure policy is
 * `block` refuses it when the hook fails.
 */
export function buildExtensionPromptGate(
	packages: ReadonlyArray<InstalledExtension>,
	bridge: ExtensionRuntimeHookBridge,
	options: ExtensionRuntimeHookOptions,
): ExtensionPromptGate {
	const runners: Array<{
		extensionId: string;
		access: ReadonlyArray<ExtensionContentAccess>;
		runner: RuntimeHookRunner;
	}> = [];
	eachRuntimeHook(packages, (entry, hook, index, digest) => {
		if (hook.on !== "prompt_submit") return;
		const id = `extension:${entry.id}:prompt_submit:${index}`;
		runners.push({
			extensionId: entry.id,
			access: entry.runtimeV2?.access ?? [],
			runner: createRuntimeHookRunner(entry, hook, "prompt_submit", id, digest, bridge, options),
		});
	});
	return {
		size: runners.length,
		async run(typed, rewritable) {
			let text = typed;
			const notices: string[] = [];
			for (const { extensionId, access, runner } of runners) {
				const startedAt = performance.now();
				const verdict = await runner.run({ point: "prompt_submit", ...(access.includes("prompt") ? { text } : {}) });
				if (verdict.kind === "failed") {
					runner.settle(verdict, startedAt, verdict.policy === "block" ? ["block_prompt"] : []);
					if (verdict.policy === "block")
						return {
							kind: "block",
							reason: `extension ${extensionId} prompt_submit hook ${verdict.reason}; the gate fails closed`,
							notices,
						};
					continue;
				}
				const applied: string[] = [];
				for (const effect of verdict.effects) {
					if (effect.kind === "block_prompt") {
						runner.settle(verdict, startedAt, [...applied, "block_prompt"]);
						return { kind: "block", reason: `${extensionId}: ${effect.reason}`, notices };
					}
					if (effect.kind === "rewrite_prompt") {
						if (!rewritable) {
							notices.push(`${extensionId}: a prompt template's body cannot be rewritten; it was sent unchanged`);
							continue;
						}
						text = effect.text;
						applied.push("rewrite_prompt");
						notices.push(`${extensionId} rewrote the prompt: ${effect.reason}`);
					} else if (effect.kind === "notify_operator") {
						applied.push("notify_operator");
						notices.push(`${extensionId}: ${effect.message}`);
					}
				}
				runner.settle(verdict, startedAt, applied);
			}
			return { kind: "pass", text, notices };
		},
	};
}
