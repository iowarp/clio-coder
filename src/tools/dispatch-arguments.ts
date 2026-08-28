/** Pure model-argument parsing; every returned DispatchRequest has a concrete agent id. */

import { pathBoundaryCovers } from "../core/path-boundary.js";
import type { AgentAutomationAuthority } from "../domains/agents/spec.js";
import { type AgentTaskType, classifyAgentTask } from "../domains/dispatch/agent-candidates.js";
import { cloneDispatchBudgetRequest } from "../domains/dispatch/budget-envelope.js";
import type { DispatchRequest } from "../domains/dispatch/contract.js";
import { type AgentRoleFactsResolver, requestExecutionRole } from "../domains/dispatch/execution-role.js";
import type { DispatchIntent } from "../domains/dispatch/intent.js";
import { parseRoutingIntent } from "../domains/dispatch/routing-intent.js";
import { DISPATCH_BRIEFING_MAX_BYTES, type JobThinkingLevel } from "../domains/dispatch/validation.js";
import { isToolProfileName, TOOL_PROFILE_NAMES } from "./profiles.js";

const DEFAULT_AGENT_ID = "coder";
/**
 * The agent a council seats when the caller names none. Council admission pins
 * every member to the `council-read-only` tool profile, and `coder` requires a
 * write tool, so the ordinary default would fail admission for every member.
 * `researcher` is the builtin read-only answerer.
 */
const COUNCIL_DEFAULT_AGENT_ID = "researcher";

/**
 * Baseline recipe per task shape for `agent:"auto"`.
 *
 * The active router is supposed to upgrade this baseline, but it only engages
 * with an approved failover, an active posture, and enough quality labels to
 * score a candidate; a default install has none of those, so the baseline IS
 * the executed route. A single hard-coded baseline therefore has to be right
 * for every task shape, and `scout` (read-only reconnaissance) was wrong for
 * every mutation: "fix the bug in cache.ts" came back as findings, twice,
 * because no worker on that route may edit a file.
 *
 * The mapping keeps capability class ahead of specialization: anything that
 * has to change the tree baselines to a workspace-edit recipe, read-shaped
 * work to the read-only specialist that exists for it.
 */
const AUTO_BASELINE_BY_TASK_TYPE: Readonly<Record<AgentTaskType, string>> = {
	// Mutating shapes: capability class first, specialization second.
	code_write: "coder",
	debug: "coder",
	refactor: "coder",
	config: "coder",
	test: "tester",
	docs: "documenter",
	// Read-only shapes.
	code_review: "verifier",
	research: "researcher",
	code_read: "scout",
	unknown: "scout",
};

/** Last-resort baseline when the mapped recipe is not installed. */
const AUTO_BASELINE_FALLBACK_AGENT_ID = "scout";

/**
 * Resolve the `agent:"auto"` baseline from the task text. Falls back whenever
 * the mapped recipe is not present in this install, so a trimmed recipe set
 * can never produce a dispatch against an agent id that does not resolve.
 */
export function autoBaselineAgentId(task: string, hasAgent?: (id: string) => boolean): string {
	const mapped = AUTO_BASELINE_BY_TASK_TYPE[classifyAgentTask(task).taskType] ?? AUTO_BASELINE_FALLBACK_AGENT_ID;
	if (hasAgent === undefined) return mapped;
	if (hasAgent(mapped)) return mapped;
	if (hasAgent(AUTO_BASELINE_FALLBACK_AGENT_ID)) return AUTO_BASELINE_FALLBACK_AGENT_ID;
	return mapped;
}
const DEFAULT_MAX_OUTPUT_BYTES = 20_000;
const PERSONA_MAX_CHARS = 8_000;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const VALID_THINKING = new Set<JobThinkingLevel>(THINKING_LEVELS);

export interface DispatchArgumentParserOptions {
	resolveFacts?: AgentRoleFactsResolver;
	/** Installed recipe ids, so an `auto` baseline never names an agent this install lacks. */
	hasAgent?: (id: string) => boolean;
	auto: {
		approvedAuthorities: ReadonlyArray<AgentAutomationAuthority>;
		authorityBasis: "operator-plan-approval" | "full-auto-policy";
	};
	resolveIntent?: (
		rawIntent: unknown,
		cwd: string | undefined,
	) =>
		| { ok: true; intent: DispatchIntent; resolvedVerification: NonNullable<DispatchRequest["resolvedVerification"]> }
		| { ok: false; message: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringArg(args: Record<string, unknown>, ...names: string[]): string | undefined {
	for (const name of names) {
		const value = args[name];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

export function maxOutputBytesArg(args: Record<string, unknown>): number {
	const value = args.max_output_bytes;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_MAX_OUTPUT_BYTES;
}

export function timeoutMsArg(args: Record<string, unknown>): number | undefined {
	const value = args.timeout_ms;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function dispatchRequestFromArgs(
	args: Record<string, unknown>,
	options: DispatchArgumentParserOptions,
): { ok: true; request: DispatchRequest } | { ok: false; message: string } {
	const task = stringArg(args, "task");
	if (!task) return { ok: false, message: "missing task (pass list:true to see available agents)" };
	if (Object.hasOwn(args, "agent_id")) return { ok: false, message: "agent_id is unsupported; use agent" };
	const requestedAgent =
		stringArg(args, "agent") ?? (args.mode === "council" ? COUNCIL_DEFAULT_AGENT_ID : DEFAULT_AGENT_ID);
	const auto = requestedAgent === "auto";
	const agentId = auto ? autoBaselineAgentId(task, options.hasAgent) : requestedAgent;
	const request: DispatchRequest = {
		agentId,
		executionRole: requestExecutionRole({
			agentId,
			...(options.resolveFacts ? { resolveFacts: options.resolveFacts } : {}),
		}),
		task,
		...(auto
			? {
					agentSelection: {
						version: 1 as const,
						mode: "auto" as const,
						baselineAgentId: agentId,
						approvedAuthorities: [...options.auto.approvedAuthorities],
						authorityBasis: options.auto.authorityBasis,
					},
				}
			: {}),
	};
	if ("briefing" in args && args.briefing !== undefined) {
		if (typeof args.briefing !== "string") return { ok: false, message: "briefing must be a string" };
		const briefing = args.briefing.trim();
		if (Buffer.byteLength(briefing, "utf8") > DISPATCH_BRIEFING_MAX_BYTES) {
			return { ok: false, message: `briefing must be ${DISPATCH_BRIEFING_MAX_BYTES} UTF-8 bytes or fewer` };
		}
		if (briefing.length > 0) request.briefing = briefing;
	}
	const target = stringArg(args, "target");
	if (target) request.target = target;
	const model = stringArg(args, "model");
	if (model) request.model = model;
	const node = stringArg(args, "node");
	if (node) request.node = node;
	if (args.failover !== undefined || args.allowed_candidates !== undefined || args.allowedCandidates !== undefined) {
		return { ok: false, message: "use routing.failover; model-authored candidate envelopes are not accepted" };
	}
	const routing = parseRoutingIntent(args.routing, {
		...(target ? { target } : {}),
		...(model ? { model } : {}),
		...(node ? { node } : {}),
	});
	if (!routing.ok) return { ok: false, message: routing.errors.join("; ") };
	request.routingIntent = routing.intent;
	request.failover = routing.intent.failover;
	request.requiredCapabilities = routing.intent.requiredCapabilities;
	const cwd = stringArg(args, "cwd");
	if (cwd) request.cwd = cwd;
	if (args.worktree !== undefined) {
		if (args.worktree !== true) return { ok: false, message: "worktree must be true when present" };
		request.worktree = true;
	}
	if (args.apply !== undefined) {
		if (args.apply !== "merge" && args.apply !== "preserve")
			return { ok: false, message: "apply must be merge or preserve" };
		if (request.worktree !== true) return { ok: false, message: "apply requires worktree: true" };
		request.apply = args.apply;
	}
	if (Object.hasOwn(args, "gate") && isRecord(args.intent) && Object.hasOwn(args.intent, "verification")) {
		return { ok: false, message: "gate_and_intent_verification_conflict: gate cannot combine with intent.verification" };
	}
	let rawIntent = args.intent;
	if (Object.hasOwn(args, "gate")) {
		if (typeof args.gate !== "string" || args.gate.trim().length === 0) {
			return { ok: false, message: "gate must be a non-empty declared check id" };
		}
		rawIntent = { ...(isRecord(rawIntent) ? rawIntent : {}), verification: [{ check: args.gate.trim() }] };
	}
	if (rawIntent !== undefined) {
		if (options.resolveIntent === undefined) return { ok: false, message: "intent resolver is unavailable" };
		const resolved = options.resolveIntent(rawIntent, cwd);
		if (!resolved.ok) return resolved;
		request.intent = resolved.intent;
		if (resolved.resolvedVerification.length > 0) request.resolvedVerification = resolved.resolvedVerification;
		if (resolved.intent.writeRoots.length > 0) {
			const legacy = Array.isArray(args.writeRoots)
				? args.writeRoots.filter((entry): entry is string => typeof entry === "string")
				: undefined;
			if (legacy !== undefined) {
				const left = [...new Set(legacy)].sort();
				if (JSON.stringify(left) !== JSON.stringify(resolved.intent.writeRoots)) {
					return { ok: false, message: "intent_write_roots_contradiction" };
				}
				request.writeRoots = legacy;
			} else {
				request.writeRoots = resolved.intent.writeRoots;
			}
		}
	}
	if ("persona" in args && args.persona !== undefined) {
		if (typeof args.persona !== "string") return { ok: false, message: "persona must be a string" };
		const persona = args.persona.trim();
		if (persona.length > PERSONA_MAX_CHARS) {
			return { ok: false, message: `persona must be ${PERSONA_MAX_CHARS} characters or fewer` };
		}
		if (persona.length > 0) request.systemPrompt = persona;
	}
	const toolProfile = stringArg(args, "tool_profile");
	if (toolProfile) {
		if (!isToolProfileName(toolProfile)) {
			return { ok: false, message: `tool_profile must be one of ${TOOL_PROFILE_NAMES.join("|")}` };
		}
		request.toolProfile = toolProfile;
	}
	const thinkingLevel = stringArg(args, "thinking_level");
	if (thinkingLevel) {
		if (!VALID_THINKING.has(thinkingLevel as JobThinkingLevel)) {
			return { ok: false, message: "thinking_level must be one of off|minimal|low|medium|high|xhigh|max" };
		}
		request.thinkingLevel = thinkingLevel as JobThinkingLevel;
	}
	if (args.budget !== undefined) {
		try {
			request.budget = cloneDispatchBudgetRequest(args.budget);
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
	}
	return { ok: true, request };
}

export function dispatchRequestsFromArgs(
	args: Record<string, unknown>,
	options: DispatchArgumentParserOptions,
): { ok: true; requests: DispatchRequest[] } | { ok: false; message: string } {
	if (Object.hasOwn(args, "task") && Object.hasOwn(args, "tasks")) {
		return { ok: false, message: "dispatch: pass either task for one run or tasks for a batch, not both" };
	}
	const tasks = args.tasks;
	if (!Array.isArray(tasks) || tasks.length === 0) {
		return {
			ok: false,
			message:
				args.tasks === undefined
					? 'dispatch: missing task; pass task="..." for one run or tasks=[...] for a batch. briefing is optional context and cannot replace task. Example: {"agent":"auto","task":"map the modules that read fleet config and cite file paths"}'
					: "dispatch: tasks must be a non-empty array of task strings or {agent, task} objects",
		};
	}
	const shared = { ...args };
	Reflect.deleteProperty(shared, "tasks");
	const requests: DispatchRequest[] = [];
	for (let index = 0; index < tasks.length; index += 1) {
		const item = tasks[index];
		const itemArgs: Record<string, unknown> = isRecord(item) ? { ...shared, ...item } : { ...shared, task: item };
		const sharedIntent = isRecord(shared.intent) ? shared.intent : null;
		const itemIntent = isRecord(item) && Object.hasOwn(item, "intent") && isRecord(item.intent) ? item.intent : null;
		if (sharedIntent !== null && itemIntent !== null) itemArgs.intent = { ...sharedIntent, ...itemIntent };
		const parsed = dispatchRequestFromArgs(itemArgs, options);
		if (!parsed.ok) return { ok: false, message: `dispatch: task ${index + 1}: ${parsed.message}` };
		if (sharedIntent !== null && itemIntent !== null) {
			if (options.resolveIntent === undefined) {
				return { ok: false, message: `dispatch: task ${index + 1}: intent resolver is unavailable` };
			}
			const ceiling = options.resolveIntent(sharedIntent, parsed.request.cwd);
			if (!ceiling.ok) return { ok: false, message: `dispatch: task ${index + 1}: ${ceiling.message}` };
			const pathCeilings = {
				readRoots: [...ceiling.intent.readRoots, ...ceiling.intent.writeRoots],
				writeRoots: ceiling.intent.writeRoots,
				relevantPaths: [...ceiling.intent.readRoots, ...ceiling.intent.writeRoots, ...ceiling.intent.relevantPaths],
			};
			for (const field of ["readRoots", "writeRoots", "relevantPaths"] as const) {
				const outside = parsed.request.intent?.[field].find(
					(candidate) => !pathBoundaryCovers(pathCeilings[field], candidate),
				);
				if (outside !== undefined) {
					return {
						ok: false,
						message: `dispatch: task ${index + 1}: intent_scope_widening: ${field} entry '${outside}' is outside the top-level intent ceiling`,
					};
				}
			}
		}
		requests.push(parsed.request);
	}
	return { ok: true, requests };
}

/** Normalize weak-model task containers. Pure and idempotent. */
export function prepareDispatchArguments(args: Record<string, unknown>): Record<string, unknown> {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const next: Record<string, unknown> = { ...args };
	if (typeof next.tasks === "string") {
		const raw = next.tasks.trim();
		if (raw.startsWith("[") || raw.startsWith("{")) {
			try {
				next.tasks = JSON.parse(raw) as unknown;
			} catch {
				// Leave the string; run() reports the shape error.
			}
		}
	}
	if (isRecord(next.tasks)) next.tasks = [next.tasks];
	if (typeof next.tasks === "string") next.tasks = [next.tasks];
	if (next.tasks === undefined && typeof next.task === "string") {
		const { task: _task, ...rest } = next;
		return { ...rest, tasks: [{ task: next.task }] };
	}
	return next;
}
