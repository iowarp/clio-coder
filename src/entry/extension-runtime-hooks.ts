import { realpathSync } from "node:fs";
import { isAbsolute, join, relative as relativePath, resolve, sep } from "node:path";
import {
	capabilityEnvelope,
	type ExtensionContentAccess,
	type ExtensionEffect,
	type ExtensionHookDeclaration,
	type ExtensionHookEvent,
	type ExtensionRuntimeHookBridge,
	type ExtensionToolHookLanding,
	envelopeDigest,
	extensionHookToolMatcher,
	type InstalledExtension,
	isLoadableExtension,
	type LoadableExtension,
	type McpToolOwnerLookup,
	RUNTIME_V2_LIMITS,
} from "../domains/extensions/index.js";
import type {
	HookReceipt,
	HookReceiptSink,
	MiddlewareEffect,
	MiddlewareHookInput,
	MiddlewareHookRegistration,
	ToolCallLanding,
} from "../domains/middleware/index.js";
import {
	WORKER_EXTENSION_HOOKS_MAX,
	type WorkerExtensionHook,
	type WorkerHookEffect,
	type WorkerHookRequest,
	type WorkerHookRun,
} from "../worker/protocol.js";

/** A hook that misses this many deadlines in a row is disabled for the generation. */
const TIMEOUT_STREAK_LIMIT = 3;

/**
 * Dispatched workers' hook calls one extension runtime holds at once. The
 * runtime refuses a request past its cap as busy, which a gate reads as its
 * own failure, so worker calls queue for half the cap and leave the rest to
 * the session's own hooks, observations and tools.
 */
const WORKER_HOOK_CONCURRENCY = Math.max(1, Math.floor(RUNTIME_V2_LIMITS.concurrentRequests / 2));

/** Whose call a hook runs for: the session's own, or a dispatched worker's. */
type HookCallOrigin = "session" | "worker";

/** Runs `work` when a permit frees within `waitMs`; null when the wait ran out first. */
type WorkerPermits = <T>(work: () => Promise<T>, waitMs: number) => Promise<T | null>;

/**
 * One extension's worker hook calls, run at most `size` at a time in arrival
 * order. A call still queued at its deadline leaves the queue, so the wait
 * never outlasts the hook's timeout.
 */
function createPermits(size: number): WorkerPermits {
	let free = size;
	const waiting: Array<() => void> = [];
	return async (work, waitMs) => {
		if (free > 0) free -= 1;
		else {
			const admitted = await new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => {
					const at = waiting.indexOf(admit);
					if (at >= 0) waiting.splice(at, 1);
					resolve(false);
				}, waitMs);
				const admit = (): void => {
					clearTimeout(timer);
					resolve(true);
				};
				waiting.push(admit);
			});
			if (!admitted) return null;
		}
		try {
			return await work();
		} finally {
			const next = waiting.shift();
			if (next !== undefined) next();
			else free += 1;
		}
	};
}

type ToolOrTurnPoint = "before_tool" | "after_tool" | "turn_start" | "turn_end";

export interface ExtensionRuntimeHookOptions {
	generation: number;
	recordReceipt: HookReceiptSink;
	now?: () => number;
	/** The session gateway's MCP ownership, so an `mcp_<id>__*` hook guards the server a call reaches. */
	mcpOwner?: McpToolOwnerLookup;
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
	workspace?: WorkerLandingWorkspace,
): ExtensionHookEvent {
	const turnId = input.turnId ?? null;
	const tool = input.toolName ?? "";
	// The landing is derived from the arguments, so it crosses under the same class.
	const args =
		access.includes("tool-args") && input.toolArgs !== undefined
			? { args: { ...input.toolArgs }, ...landingFields(input.toolLanding, workspace) }
			: {};
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
 * Where a dispatched worker's tree sits in the session's: the worker's own
 * root (its task worktree, or its cwd) in the worker's filesystem, and the
 * directory of the session's checkout it stands for.
 */
export interface WorkerLandingWorkspace {
	workerRoot: string;
	sourceRoot: string;
}

function physicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		// A root that cannot be resolved here is compared as given; a landing under it still maps.
		return path;
	}
}

function relativeInside(from: string, to: string): string | null {
	const relative = relativePath(from, to);
	return relative !== ".." && !relative.startsWith(`..${sep}`) && !isAbsolute(relative) ? relative : null;
}

/** `path` relative to `root`, comparing both the physical and the given root, or null outside it. */
function insideRoot(root: string, path: string): string | null {
	return relativeInside(physicalPath(root), path) ?? relativeInside(root, path);
}

/**
 * A protected path a hook named for a worker's call, in the worker's
 * coordinates. The hook saw the call's landing as `landingFields` shows it:
 * `target.path` is the worker's own path and `workspacePath` is relative to
 * the session's workspace. A path already inside the worker's root names the
 * worker's file and stays, even when the worktree sits under the checkout
 * (`<checkout>/.clio-coder/worktrees/<run>`); a path under the checkout and
 * outside the worker's root lands at the same place under the worker's root.
 * A relative path means the session's workspace, so the worker gets it
 * absolute and its guard never resolves it against the worker's own cwd.
 */
function workerProtectedPath(path: string, worker: WorkerLandingWorkspace): string {
	const named = isAbsolute(path) ? path : resolve(physicalPath(process.cwd()), path);
	if (insideRoot(worker.workerRoot, named) !== null) return named;
	const fromSource = insideRoot(worker.sourceRoot, named);
	return fromSource === null ? named : join(worker.workerRoot, fromSource);
}

/**
 * The landing as api 2 hook events carry it; `workspacePath` is relative to
 * the session's workspace. A worker's landing under its own root counts as
 * the same place in the session's checkout, so a task worktree's write reads
 * as the checkout path it will merge into, wherever the worktree lives.
 */
function landingFields(
	landing: MiddlewareHookInput["toolLanding"],
	worker?: WorkerLandingWorkspace,
): Pick<ExtensionToolHookLanding, "target" | "dispatch"> {
	if (landing === undefined) return {};
	const fields: Pick<ExtensionToolHookLanding, "target" | "dispatch"> = {};
	if (landing.path !== undefined) {
		const workspace = physicalPath(process.cwd());
		let landed = landing.path.path;
		if (worker !== undefined) {
			const fromWorkerRoot = relativeInside(worker.workerRoot, landed);
			if (fromWorkerRoot !== null) landed = join(physicalPath(worker.sourceRoot), fromWorkerRoot);
		}
		// An unresolved landing is only text: `loop/../x` past a link loop is not `x`, so it has no workspace path.
		const relative = landing.path.resolved ? relativeInside(workspace, landed) : null;
		fields.target = {
			arg: landing.path.arg,
			path: landing.path.path,
			resolved: landing.path.resolved,
			workspacePath: relative === null ? null : relative === "" ? "." : relative.split(sep).join("/"),
		};
	}
	if (landing.dispatch !== undefined) {
		const dispatch = landing.dispatch;
		fields.dispatch =
			dispatch.kind === "tasks"
				? {
						kind: "tasks",
						mode: dispatch.mode,
						tasks: dispatch.tasks.map((task) => ({
							role: task.role,
							agent: task.agent,
							cwd: task.cwd,
							writeRoots: [...task.writeRoots],
							writeBoundaries: [...task.writeBoundaries],
							worktree: task.worktree,
							readOnly: task.readOnly,
						})),
						...(dispatch.candidates !== undefined ? { candidates: dispatch.candidates } : {}),
					}
				: dispatch.kind === "apply-winner"
					? { kind: "apply-winner", branch: dispatch.branch, cwd: dispatch.cwd }
					: { kind: "list" };
	}
	return fields;
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

type RunnerOutcome =
	| { kind: "ok"; effects: ExtensionEffect[] }
	| { kind: "failed"; reason: string; policy: "pass" | "block"; outcome: HookReceipt["outcome"] };
/** A runner's answer for one call, carrying that call's own turn for its receipt. */
type RunnerVerdict = RunnerOutcome & { turnId: string | null };

interface RuntimeHookRunner {
	/** A worker's missed deadline is the worker's round trip, so it never counts toward disabling the session's hook. */
	run(event: ExtensionHookEvent, origin?: HookCallOrigin, budgetMs?: number): Promise<RunnerVerdict>;
	/** Receipt for a finished run, with the effects the host will apply. */
	settle(
		verdict: RunnerVerdict,
		startedAt: number,
		effectKinds: ReadonlyArray<string>,
		toolName?: string,
		sessionId?: string,
		runId?: string,
	): void;
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
	const failed = (reason: string, policy: "pass" | "block", outcome: HookReceipt["outcome"]): RunnerOutcome => {
		notify(policy === "block" ? `${reason}; it fails closed` : `${reason}; skipped`);
		return { kind: "failed", reason, policy, outcome };
	};
	const evaluate = async (
		event: ExtensionHookEvent,
		origin: HookCallOrigin,
		budgetMs: number,
	): Promise<RunnerOutcome> => {
		if (disabled) return failed("is disabled after repeated missed deadlines", hook.onTimeout, "runtime-timeout");
		const executor = bridge.current();
		if (executor === null) return failed("has no running runtime", hook.onError, "runtime-failed");
		if (budgetMs <= 0)
			return failed(`missed its ${hook.timeoutMs} ms deadline queued for the runtime`, hook.onTimeout, "runtime-timeout");
		const outcome = await executor.hook(entry.id, event, budgetMs);
		if (outcome.kind === "timeout") {
			if (origin === "session") {
				streak += 1;
				if (streak >= TIMEOUT_STREAK_LIMIT) disabled = true;
			}
			return failed(`missed its ${hook.timeoutMs} ms deadline`, hook.onTimeout, "runtime-timeout");
		}
		if (origin === "session") streak = 0;
		if (outcome.kind === "error") return failed(`failed: ${outcome.message}`, hook.onError, "runtime-failed");
		reported.clear();
		return { kind: "ok", effects: outcome.effects };
	};
	return {
		async run(event, origin = "session", budgetMs = hook.timeoutMs) {
			// Session and worker calls overlap, so the turn rides each call's verdict, not the runner.
			const turnId = "turnId" in event ? event.turnId : null;
			return { ...(await evaluate(event, origin, budgetMs)), turnId };
		},
		settle(verdict, startedAt, effectKinds, toolName, sessionId, runId) {
			const turnId = verdict.turnId;
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
					...(sessionId ? { sessionId } : {}),
					...(runId ? { runId } : {}),
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

/** One hook run for a dispatched worker's call, with the session's deadline, policy and receipt. */
export type WorkerHookEvaluator = (
	input: MiddlewareHookInput,
	workspace?: WorkerLandingWorkspace,
) => Promise<MiddlewareEffect[]>;

export interface ExtensionRuntimeHooks {
	registrations: MiddlewareHookRegistration[];
	/** The tool hooks again by registration id, as dispatched workers' calls run them. */
	workerEvaluators: Map<string, WorkerHookEvaluator>;
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
	return buildExtensionRuntimeHooks(packages, bridge, options).registrations;
}

/**
 * The registrations, and for each tool hook the evaluator a dispatched
 * worker's call runs through. Both share one runner, so a worker call meets
 * the same deadline, failure policy and disabled state; worker calls queue
 * per extension runtime behind `WORKER_HOOK_CONCURRENCY`.
 */
export function buildExtensionRuntimeHooks(
	packages: ReadonlyArray<InstalledExtension>,
	bridge: ExtensionRuntimeHookBridge,
	options: ExtensionRuntimeHookOptions,
): ExtensionRuntimeHooks {
	const registrations: MiddlewareHookRegistration[] = [];
	const workerEvaluators = new Map<string, WorkerHookEvaluator>();
	const workerPermits = new Map<string, WorkerPermits>();
	eachRuntimeHook(packages, (entry, hook, index, digest) => {
		if (hook.on === "prompt_submit") return;
		const point: ToolOrTurnPoint = hook.on;
		const access = entry.runtimeV2?.access ?? [];
		const id = `extension:${entry.id}:${point}:${index}`;
		const runner = createRuntimeHookRunner(entry, hook, point, id, digest, bridge, options);
		const evaluate = async (
			input: MiddlewareHookInput,
			origin: HookCallOrigin,
			workspace?: WorkerLandingWorkspace,
			budgetMs?: number,
		): Promise<MiddlewareEffect[]> => {
			const startedAt = performance.now();
			const verdict = await runner.run(hookEvent(point, input, access, workspace), origin, budgetMs);
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
				input.sessionId,
				input.runId,
			);
			return effects;
		};
		registrations.push({
			id,
			description: `${entry.id} runtime ${point} hook`,
			hooks: [point],
			evidence: `extension-hook:${point}@session`,
			...(hook.tools !== undefined
				? { toolNames: [...hook.tools], matchesTool: extensionHookToolMatcher(hook.tools, options.mcpOwner) }
				: {}),
			awaited: true,
			evaluate: () => [],
			evaluateAsync: (input) => evaluate(input, "session"),
		});
		if (point !== "before_tool" && point !== "after_tool") return;
		let permits = workerPermits.get(entry.id);
		if (permits === undefined) {
			permits = createPermits(WORKER_HOOK_CONCURRENCY);
			workerPermits.set(entry.id, permits);
		}
		const queue = permits;
		// The queue wait spends the call's deadline, so a call answers within its timeout and
		// the runtime gets only what the wait left; one that never reached it is scored a timeout.
		workerEvaluators.set(id, async (input, workspace) => {
			const arrived = performance.now();
			const left = (): number => Math.floor(hook.timeoutMs - (performance.now() - arrived));
			const ran = await queue(() => evaluate(input, "worker", workspace, left()), hook.timeoutMs);
			return ran ?? evaluate(input, "worker", workspace, 0);
		});
	});
	return { registrations, workerEvaluators };
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

/**
 * The tool hooks of one generation as a native worker's spec carries them,
 * under the ids of their middleware registrations. Turn and prompt hooks are
 * the session's own; a worker has no turn of the session's to gate. A worker
 * refuses a spec past `WORKER_EXTENSION_HOOKS_MAX` hooks, so the spec keeps
 * that many, gates that fail closed first, in declaration order, and
 * `onDropped` hears the hooks left out.
 */
export function buildWorkerExtensionHooks(
	packages: ReadonlyArray<InstalledExtension>,
	onDropped?: (hooks: ReadonlyArray<WorkerExtensionHook>) => void,
): WorkerExtensionHook[] {
	const hooks: WorkerExtensionHook[] = [];
	eachRuntimeHook(packages, (entry, hook, index) => {
		if (hook.on !== "before_tool" && hook.on !== "after_tool") return;
		hooks.push({
			id: `extension:${entry.id}:${hook.on}:${index}`,
			point: hook.on,
			...(hook.tools !== undefined ? { tools: [...hook.tools] } : {}),
			timeoutMs: hook.timeoutMs,
			onTimeout: hook.onTimeout,
			onError: hook.onError,
		});
	});
	if (hooks.length <= WORKER_EXTENSION_HOOKS_MAX) return hooks;
	const gate = (hook: WorkerExtensionHook): boolean => hook.onError === "block" || hook.onTimeout === "block";
	const kept = new Set(
		[...hooks.filter(gate), ...hooks.filter((hook) => !gate(hook))].slice(0, WORKER_EXTENSION_HOOKS_MAX),
	);
	onDropped?.(hooks.filter((hook) => !kept.has(hook)));
	return hooks.filter((hook) => kept.has(hook));
}

function workerEffect(effect: MiddlewareEffect): WorkerHookEffect | null {
	if (effect.kind === "block_tool") return { kind: "block_tool", reason: effect.reason };
	if (effect.kind === "rewrite_tool_input")
		return { kind: "rewrite_tool_input", args: effect.args, reason: effect.reason, source: effect.source };
	if (effect.kind === "annotate_tool_result")
		return {
			kind: "annotate_tool_result",
			message: effect.message,
			...(effect.severity === "info" || effect.severity === "warn" ? { severity: effect.severity } : {}),
		};
	if (effect.kind === "protect_path") return { kind: "protect_path", path: effect.path, reason: effect.reason };
	if (effect.kind === "require_tool") return { kind: "require_tool", toolName: effect.toolName };
	if (effect.kind === "lock_tools") return { kind: "lock_tools" };
	return null;
}

/**
 * Run one hook for a worker's call through the session's own registration,
 * so its deadline, failure policy, content access and receipt are the ones a
 * main-session call gets. A hook the current generation no longer holds
 * answers by the policy the worker was dispatched with; one never declared
 * fails closed. Operator notices go to the session; the worker applies every
 * other tool-point effect, and anything else is reported, not dropped.
 */
export async function evaluateWorkerHookRequest(
	request: WorkerHookRequest,
	evaluator: WorkerHookEvaluator | undefined,
	declared: WorkerExtensionHook | undefined,
	run: WorkerHookRun,
	notify: (message: string) => void,
): Promise<WorkerHookEffect[]> {
	const closed = (reason: string): WorkerHookEffect[] => {
		const message = `${request.hookId} ${reason}; the gate fails closed`;
		// The stricter of the two policies, as the worker decides a lost answer.
		if (declared !== undefined && declared.onError !== "block" && declared.onTimeout !== "block") return [];
		return request.point === "before_tool"
			? [{ kind: "block_tool", reason: message }]
			: [{ kind: "annotate_tool_result", message, severity: "warn" }];
	};
	if (evaluator === undefined) return closed("is not installed in this session's current generation");
	const input: MiddlewareHookInput = {
		hook: request.point,
		toolName: request.tool,
		metadata:
			request.point === "after_tool"
				? { resultKind: request.outcome === "error" ? "error" : "ok", durationMs: request.durationMs ?? 0 }
				: {},
		...(request.args !== undefined ? { toolArgs: request.args } : {}),
		...(request.landing !== undefined ? { toolLanding: request.landing as ToolCallLanding } : {}),
		...(request.result !== undefined
			? {
					toolResultDigest: {
						text: request.result,
						provenance: { producer: "code", source: "legacy-fallback", algorithm: "redacted-legacy-digest-v1" },
					},
				}
			: {}),
		...(run.sessionId !== null ? { sessionId: run.sessionId } : {}),
		...(run.runId !== null ? { runId: run.runId } : {}),
	};
	const workspace: WorkerLandingWorkspace | undefined =
		request.workspaceRoot !== undefined && run.sourceRoot !== undefined
			? { workerRoot: request.workspaceRoot, sourceRoot: run.sourceRoot }
			: undefined;
	let effects: ReadonlyArray<MiddlewareEffect>;
	try {
		effects = await evaluator(input, workspace);
	} catch (error) {
		return closed(`failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const say = (message: string): void => {
		try {
			notify(message);
		} catch {
			// A notice sink has no authority over the call; a throw here must not lose the hook's verdict.
		}
	};
	const answer: WorkerHookEffect[] = [];
	for (const effect of effects) {
		if (effect.kind === "notify_operator") {
			say(effect.message);
			continue;
		}
		const mapped = workerEffect(effect);
		if (mapped !== null)
			answer.push(
				mapped.kind === "protect_path" && workspace !== undefined
					? { ...mapped, path: workerProtectedPath(mapped.path, workspace) }
					: mapped,
			);
		else
			say(`${request.hookId} returned ${effect.kind}, which a dispatched worker's call cannot apply; it was not applied`);
	}
	return answer;
}
