import { Type } from "typebox";
import type { JobCreateInput, JobOwner, JobRecord, JobRunner } from "../core/job-types.js";
import { ToolNames } from "../core/tool-names.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
import { snapshotTurnConstraints, turnAllowsTool } from "../core/turn-constraints.js";
import { normalizeJobSpec } from "../domains/scheduling/index.js";
import type { JobController, JobExecutionContext, JobRunResult } from "../domains/scheduling/job-types.js";
import { StringEnum } from "../engine/ai.js";
import {
	attestJobCommand,
	canonicalJobCwd,
	executeJobCommand,
	jobCommandEffect,
	prepareJobCommand,
} from "./job-command.js";
import type { ToolInvokeOptions, ToolRegistry, ToolResult, ToolSpec } from "./registry.js";

export interface JobToolDeps {
	controller: JobController;
	registry: Pick<ToolRegistry, "invoke">;
	owner(createSession?: boolean): JobOwner | null;
	constraints(): ToolInvokeOptions["turnConstraints"];
	hostRefusal(): string | null;
	admissionRefusal?(runner: JobRunner, owner: JobOwner, constraints: TurnConstraints | null): string | null;
}

type PreparedJob =
	| { kind: "create"; input: JobCreateInput; owner: JobOwner }
	| { kind: "control"; action: "pause" | "resume" | "stop" | "cancel"; id: string; owner: JobOwner; job: JobRecord }
	| { kind: "execution"; context: JobExecutionContext }
	| { kind: "error"; message: string };

function jobToolResult(job: JobRecord): ToolResult {
	const scope = `session ${job.owner.sessionId}; cwd=${job.owner.cwd}`;
	const bounds = `${job.spec.count === null ? "deadline bound" : `${job.spec.count} starts`}; timeout=${job.spec.timeoutMs}ms${job.spec.deadlineAt === null ? "" : `; deadline=${new Date(job.spec.deadlineAt).toISOString()}`}`;
	return {
		kind: "ok",
		output: `job ${job.id}: ${job.state}${job.reason ? ` (${job.reason})` : ""}; ${job.spec.runner.kind}; every=${job.spec.intervalMs}ms; ${bounds}; ${scope}${job.nextDueAt === null ? "" : `; next due=${new Date(job.nextDueAt).toISOString()}`}${job.delivery ? `; delivery=${job.delivery.state}` : ""}`,
		details: { job },
	};
}

/** One parent capability; prepared arguments carry authority, never model JSON (#411). */
export function createJobTool(deps: JobToolDeps): {
	spec: ToolSpec;
	invoke(args: Record<string, unknown>, options?: { sessionId?: string }): Promise<ToolResult>;
	runCommand(context: JobExecutionContext): Promise<JobRunResult>;
} {
	const prepared = new WeakMap<Record<string, unknown>, PreparedJob>();
	const fields = new Set([
		"action",
		"job_id",
		"runner",
		"every_ms",
		"count",
		"timeout_ms",
		"for_ms",
		"prompt",
		"argv",
		"cwd",
		"until",
		"on_match",
		"follow_up",
	]);
	const prepare = (raw: Record<string, unknown>): Record<string, unknown> => {
		if (prepared.has(raw)) return raw;
		const args = { ...raw };
		try {
			for (const field of Object.keys(args))
				if (!fields.has(field))
					throw new Error(
						`job: unsupported field '${field}'; model-supplied ownership, grants, scopes and unenforceable limits are refused.`,
					);
			const action = args.action;
			if (action !== "create" && action !== "pause" && action !== "resume" && action !== "stop" && action !== "cancel")
				throw new Error("job: action must be create, pause, resume, stop or cancel.");
			const refusal = action === "create" || action === "resume" ? deps.hostRefusal() : null;
			if (refusal !== null) throw new Error(refusal);
			const owner = deps.owner(action === "create");
			if (owner === null)
				throw new Error("job: open a conversation in an attended or ACP host before controlling session-owned jobs.");
			if (action !== "create") {
				for (const field of Object.keys(args))
					if (field !== "action" && field !== "job_id")
						throw new Error(`job: ${action} takes only job_id; widening a job requires a new create.`);
				if (typeof args.job_id !== "string" || !args.job_id.trim())
					throw new Error("job: control requires job_id from monitor or create.");
				const id = args.job_id.trim();
				const job = deps.controller.get(id, owner);
				if (job === null) throw new Error("job: unknown job or creator session/process/cwd ownership does not match.");
				if (action === "resume" && job.spec.runner.kind === "command") attestJobCommand(job.spec.runner);
				prepared.set(args, { kind: "control", action, id, owner, job });
				return args;
			}
			if (!turnAllowsTool(deps.constraints(), ToolNames.Job))
				throw new Error("job: the current task constraints do not allow scheduling jobs.");
			if (typeof args.every_ms !== "number" || !Number.isSafeInteger(args.every_ms) || args.every_ms < 1000)
				throw new Error("job: every_ms must be an exact integer interval of at least 1000 ms.");
			if (args.cwd !== undefined && typeof args.cwd !== "string")
				throw new Error("job: cwd must be a workspace path string.");
			canonicalJobCwd(owner.cwd, args.cwd as string | undefined);
			const runner =
				args.runner === "main"
					? typeof args.prompt === "string" && args.prompt.trim()
						? { kind: "main" as const, prompt: args.prompt }
						: null
					: args.runner === "command"
						? prepareJobCommand(args.argv, owner.cwd)
						: null;
			if (runner === null)
				throw new Error(
					"job: runner=main requires prompt; runner=command requires a literal argv array. Workers, events and cron are later scope.",
				);
			if (
				runner.kind === "main" &&
				(args.argv !== undefined || args.until !== undefined || args.follow_up !== undefined || args.on_match !== undefined)
			)
				throw new Error(
					"job: main repetition takes prompt and finite bounds; command predicates and match delivery require runner=command.",
				);
			if (runner.kind === "command" && args.prompt !== undefined)
				throw new Error(
					"job: command polling does not take prompt; use follow_up with on_match=main_turn for explicit analysis.",
				);
			if (runner.kind === "command" && !turnAllowsTool(deps.constraints(), ToolNames.Bash))
				throw new Error("job: the creating task does not allow executable command effects.");
			if (args.on_match !== undefined && args.on_match !== "notice" && args.on_match !== "main_turn")
				throw new Error("job: on_match must be notice or main_turn.");
			if ((args.on_match !== undefined || args.follow_up !== undefined) && args.until === undefined)
				throw new Error("job: a match action requires a typed until predicate.");
			if (args.on_match === "main_turn" && (typeof args.follow_up !== "string" || !args.follow_up.trim()))
				throw new Error("job: on_match=main_turn requires an explicit follow_up prompt.");
			if (args.follow_up !== undefined && args.on_match !== "main_turn")
				throw new Error("job: follow_up requires on_match=main_turn.");
			const duration = args.for_ms;
			if (
				duration !== undefined &&
				(typeof duration !== "number" ||
					!Number.isSafeInteger(duration) ||
					duration < 1000 ||
					duration > 7 * 24 * 60 * 60 * 1000)
			)
				throw new Error("job: for_ms must be 1000 ms through seven days.");
			const constraints = snapshotTurnConstraints(deps.constraints());
			const input: JobCreateInput = {
				intervalMs: args.every_ms,
				runner,
				...(args.count === undefined ? {} : { count: args.count as number }),
				...(args.timeout_ms === undefined ? {} : { timeoutMs: args.timeout_ms as number }),
				...(duration === undefined ? {} : { deadlineAt: Date.now() + (duration as number) }),
				...(args.until === undefined ? {} : { until: structuredClone(args.until) as NonNullable<JobCreateInput["until"]> }),
				...(args.on_match === "main_turn"
					? { onMatch: { kind: "main_turn" as const, prompt: args.follow_up as string } }
					: {}),
				...(constraints === undefined ? {} : { constraints }),
			};
			normalizeJobSpec(input, Date.now());
			prepared.set(args, { kind: "create", input: structuredClone(input), owner: { ...owner } });
		} catch (error) {
			prepared.set(args, { kind: "error", message: error instanceof Error ? error.message : String(error) });
		}
		return args;
	};
	const spec: ToolSpec = {
		name: ToolNames.Job,
		placement: "gateway",
		description:
			"Create and control bounded session-owned interval jobs. main repeats an explicit prompt; command polls exact argv without a shell. Bare main jobs default to five starts, first after one interval. Each occurrence rechecks current policy; scheduling approval never approves future effects. Observe with monitor(job_id=...).",
		parameters: Type.Object({
			action: StringEnum(["create", "pause", "resume", "stop", "cancel"]),
			job_id: Type.Optional(Type.String()),
			runner: Type.Optional(StringEnum(["main", "command"])),
			every_ms: Type.Optional(Type.Integer({ minimum: 1000 })),
			count: Type.Optional(Type.Integer({ minimum: 1 })),
			timeout_ms: Type.Optional(Type.Integer({ minimum: 1000 })),
			for_ms: Type.Optional(Type.Integer({ minimum: 1000 })),
			prompt: Type.Optional(Type.String()),
			argv: Type.Optional(Type.Array(Type.String())),
			cwd: Type.Optional(Type.String()),
			until: Type.Optional(
				Type.Object({
					path: Type.Array(Type.String()),
					op: StringEnum(["eq", "ne", "lt", "lte", "gt", "gte", "exists"]),
					value: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()])),
				}),
			),
			on_match: Type.Optional(StringEnum(["notice", "main_turn"])),
			follow_up: Type.Optional(Type.String()),
		}),
		baseActionClass: "dispatch",
		executionMode: "sequential",
		prepareAdmissionArguments: prepare,
		disposeAdmissionArguments: (args) => {
			prepared.delete(args);
		},
		hostEffectCalls(args) {
			const artifact = prepared.get(args);
			if (artifact?.kind === "create") return jobCommandEffect(artifact.input.runner, artifact.owner.cwd);
			if (artifact?.kind === "control" && artifact.action === "resume")
				return jobCommandEffect(artifact.job.spec.runner, artifact.owner.cwd);
			if (artifact?.kind === "execution")
				return jobCommandEffect(artifact.context.job.spec.runner, artifact.context.job.owner.cwd);
			return [];
		},
		async run(args, options) {
			const artifact = prepared.get(args);
			if (artifact === undefined)
				return {
					kind: "error",
					message: "job: admitted immutable arguments are required; invoke through the parent tool registry.",
				};
			if (artifact.kind === "error") return { kind: "error", message: artifact.message };
			try {
				if (artifact.kind === "execution") {
					const result = await executeJobCommand(artifact.context);
					return { kind: "ok", output: result.summary ?? result.outcome, details: { jobRunResult: result } };
				}
				const nowOwner = deps.owner();
				if (
					nowOwner === null ||
					nowOwner.sessionId !== artifact.owner.sessionId ||
					nowOwner.cwd !== artifact.owner.cwd ||
					nowOwner.generation !== artifact.owner.generation ||
					(options?.sessionId !== undefined && options.sessionId !== nowOwner.sessionId)
				)
					throw new Error(
						"job: creator session/generation changed during admission; submit the command in the current conversation.",
					);
				const job =
					artifact.kind === "create"
						? await deps.controller.create(
								{ ...artifact.input, ...(options?.turnId === undefined ? {} : { originTurnId: options.turnId }) },
								artifact.owner,
							)
						: await deps.controller.control(artifact.id, artifact.action, artifact.owner);
				return jobToolResult(job);
			} catch (error) {
				return { kind: "error", message: `job: ${error instanceof Error ? error.message : String(error)}` };
			}
		},
	};
	return {
		spec,
		async invoke(raw, options) {
			const args = prepare(raw);
			const artifact = prepared.get(args);
			try {
				if (!artifact || artifact.kind === "error")
					return {
						kind: "error",
						message: artifact?.kind === "error" ? artifact.message : "job: immutable preparation failed.",
					};
				// Retiring existing owned work creates no new effect and must remain available after narrowing (#411).
				if (artifact.kind === "control" && artifact.action !== "resume") return await spec.run(args, options);
				if (artifact.kind === "execution")
					return { kind: "error", message: "job: internal occurrences are not operator commands." };
				const runner = artifact.kind === "create" ? artifact.input.runner : artifact.job.spec.runner;
				const constraints =
					artifact.kind === "create" ? (artifact.input.constraints ?? null) : artifact.job.spec.constraints;
				const refusal = deps.admissionRefusal?.(runner, artifact.owner, constraints);
				if (refusal) return { kind: "error", message: `job: ${refusal}` };
				const verdict = await deps.registry.invoke(
					{ tool: ToolNames.Job, args },
					{ ...options, origin: "harness", ...(constraints === null ? {} : { turnConstraints: constraints }) },
				);
				return verdict.kind === "ok" ? verdict.result : { kind: "error", message: `job: ${verdict.reason}` };
			} finally {
				prepared.delete(args);
			}
		},
		async runCommand(context) {
			const args = { action: "execute_occurrence", job_id: context.job.id, execution_id: context.executionId };
			prepared.set(args, { kind: "execution", context });
			const verdict = await deps.registry.invoke(
				{ tool: ToolNames.Job, args },
				{
					sessionId: context.job.owner.sessionId,
					signal: context.signal,
					origin: "harness",
					nested: true,
					...(context.job.spec.constraints === null ? {} : { turnConstraints: context.job.spec.constraints }),
				},
			);
			if (verdict.kind !== "ok") return { outcome: "failed", summary: verdict.reason, errorClass: "permission" };
			const result = verdict.result.details?.jobRunResult;
			if (verdict.result.kind !== "ok" || !result || typeof result !== "object")
				return {
					outcome: "failed",
					summary:
						verdict.result.kind === "error" ? verdict.result.message : "Command occurrence did not return settled evidence.",
					errorClass: "execution",
				};
			return result as JobRunResult;
		},
	};
}
