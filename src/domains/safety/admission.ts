import { isAbsolute, resolve } from "node:path";
import type { PendingSkillToolPolicy, SkillToolSurfaceViolation } from "../../core/skill-activation.js";
import { evaluateSkillToolSurface } from "../../core/skill-activation.js";
import { ToolNames } from "../../core/tool-names.js";
import type { TurnConstraints } from "../../core/turn-constraints.js";
import { turnAllowsTool } from "../../core/turn-constraints.js";
import type { ActionClass, ClassifierCall } from "./action-classifier.js";
import { classify } from "./action-classifier.js";
import type { AutonomyExposure, AutonomyLevel } from "./autonomy.js";
import { autonomyAskRejection, DEFAULT_AUTONOMY_LEVEL, mapAutonomy } from "./autonomy.js";
import { autonomyCallInputs } from "./autonomy-inputs.js";
import type { SafetyContract, SafetyDecision } from "./contract.js";
import { CONFIRMED_POSTURE, MAIN_GRANT_POSTURE } from "./contract.js";
import { classifyBashGit } from "./git-policy.js";
import type { WorkerGitAllowance } from "./worker-permit.js";

/**
 * The one admission evaluator (Codex review, "One shared admission
 * evaluator"). Native registry admission, the Claude SDK bridge and the ACP
 * mediator all decide a call here; each adapter only translates its transport
 * into an {@link AdmissionInput} and its answer back out. Parking, prompting,
 * audit rows and wire events stay in the adapters.
 *
 * Evaluation order, each step dominating every later one:
 *   1. the safety net over every effect: any hard block wins;
 *   2. hard permit limits: read-only, tool scope, skill surface, git_destructive;
 *   3. confirmation obligations the net or the tool raises;
 *   4. autonomy (main) or the worker's standing allowance, Git included;
 *   5. a matching authorization, which clears only what it is allowed to clear.
 */

export type AdmissionPrincipal = "main" | "worker";

/** Hard limits the run carries, independent of autonomy. */
export interface AdmissionConstraints {
	/** Dispatch-owned read-only restriction. */
	readOnly?: boolean;
	/** Host-owned task scope. */
	turnConstraints?: TurnConstraints;
	/** The tool surface this run was admitted to, when narrower than the adapter's inventory. */
	allowedTools?: ReadonlyArray<string> | ReadonlySet<string>;
	/** Skill-declared tool narrowing armed for this session or run. */
	pendingSkillPolicy?: PendingSkillToolPolicy;
}

/**
 * Who may discharge an ask. Every safety-net rail and tool confirmation is
 * `operator`: only a person clears it. Only a worker's autonomy ask is `main`,
 * which means the main agent may answer it once the grant broker exists
 * (Phase D); the operator can always answer it too.
 */
export type ApprovalAuthority = "main" | "operator";

/**
 * A structured one-shot authorization for exactly one parked call. The issuer
 * is checked here, never inferred from free-form provenance text: a `main`
 * authorization evaluates the net without the operator `confirmed` posture, so
 * it cannot clear an operator rail.
 */
export interface AdmissionAuthorization {
	issuer: ApprovalAuthority;
	/** Action class the approver saw; a different class is not covered. */
	actionClass: ActionClass;
}

export interface AdmissionInput {
	principal: AdmissionPrincipal;
	/**
	 * Executable effects of the call, each judged as the direct call it stands
	 * for. Must be non-empty: a call with no evaluable effect fails closed.
	 */
	effects: ReadonlyArray<ClassifierCall>;
	/**
	 * The public capability, when the effects are a trusted projection of it.
	 * Its own hard blocks and confirmation rails apply; autonomy maps the
	 * effects, which is what actually runs.
	 */
	capability?: ClassifierCall;
	/**
	 * Explicit execution cwd for command effects that do not name one. Never
	 * derived from the evaluating process; absent means the policy engine's own
	 * bound cwd.
	 */
	cwd?: string;
	safety: Pick<SafetyContract, "evaluate">;
	/** Operator autonomy. Read for the main principal only; workers never inherit it. */
	autonomy?: AutonomyLevel;
	/** Standing execute authority bound by the host permit, independent of model fields. */
	workerExecuteAutonomy?: "yolo";
	constraints?: AdmissionConstraints;
	/** A tool-level confirmation rail required at every autonomy level. */
	confirmationRuleId?: string;
	/** What the confirmation rail tells the operator and a denied model; absent keeps the Slurm wording. */
	confirmationText?: { detail: string; hints: ReadonlyArray<string> };
	authorization?: AdmissionAuthorization;
	/** Adapter translation of each net decision (a registered tool's base action class). */
	normalize?: (decision: SafetyDecision) => SafetyDecision;
	/** Autonomy inputs a tool declares for itself: ask_user exposure, plan-scale dispatch. */
	autonomyExtra?: { exposure?: AutonomyExposure; dispatchPlanScale?: boolean };
	/**
	 * The worker's Git context (Phase C). Read for the worker principal only;
	 * absent means the permit's allowance is `inspect` and no task worktree is
	 * attested, so every Git mutation asks.
	 */
	git?: AdmissionGitContext;
}

/** Result of re-attesting a task worktree for one call. */
export type TaskWorktreeAttestation = { ok: true } | { ok: false; detail: string };

/**
 * What the worker's standing Git allowance needs to know at call time. The
 * callbacks read the repository, so admission stays pure apart from them and
 * the policy engine's audit.
 */
export interface AdmissionGitContext {
	/** The permit's standing Git allowance. */
	allowance: WorkerGitAllowance;
	/**
	 * True when the permit's tools already execute arbitrary code (bash,
	 * run_script), so a repository hook adds no authority the worker lacks.
	 */
	executePermitted: boolean;
	/** Absolute run cwd for a command effect that names none. */
	cwd: string;
	/**
	 * Whether the hooks directory a Git mutation in `cwd` would run resolves
	 * inside that working tree, where the worker can author it. Unresolvable
	 * counts as inside.
	 */
	hooksInsideWorkingTree(cwd: string): boolean;
	/** The task worktree this run owns; absent when the run works in a shared checkout. */
	taskWorktree?: {
		/** Host-resolved metadata writes used only by the typed Git execution seam. */
		typedGitWritablePaths?: ReadonlyArray<string>;
		/** Re-checks ownership, the common Git directory and HEAD on the task branch for a command run in `cwd`. */
		attest(cwd: string): TaskWorktreeAttestation;
	};
}

export type AdmissionDenyCode =
	| "safety_net"
	| "context"
	| "no_effects"
	| "read_only"
	| "tool_scope"
	| "skills_disabled"
	| "skill_surface"
	| "git_destructive";

export type AdmissionAskSource = "safety-net" | "tool-confirmation" | "autonomy" | "git-policy";

export type AdmissionDisposition =
	| {
			kind: "allow";
			/** The net decision of the call that runs. */
			decision: SafetyDecision;
			/** True when a matching authorization, not policy, admitted the call. */
			authorized: boolean;
	  }
	| {
			kind: "deny";
			code: AdmissionDenyCode;
			reason: string;
			/** Hard denials never park and no authorization clears them. */
			hard: true;
			/** The net decision the denial was judged against. */
			decision: SafetyDecision;
			skillViolation?: SkillToolSurfaceViolation;
	  }
	| {
			kind: "ask";
			source: AdmissionAskSource;
			approvalAuthority: ApprovalAuthority;
			reason: string;
			/** The parked decision: the net rail, or an autonomy ask naming the level. */
			decision: SafetyDecision;
			/** The net decision behind an autonomy ask. */
			netDecision: SafetyDecision;
			level: AutonomyLevel;
			exposure: AutonomyExposure;
			readOutsideWorkspace: boolean;
	  };

function deny(
	code: AdmissionDenyCode,
	reason: string,
	decision: SafetyDecision,
	extra: { skillViolation?: SkillToolSurfaceViolation } = {},
): AdmissionDisposition {
	return { kind: "deny", code, reason, hard: true, decision, ...extra };
}

function syntheticBlock(reason: string): SafetyDecision {
	return {
		kind: "block",
		classification: { actionClass: "unknown", reasons: [reason] },
		rejection: { short: reason, detail: reason, hints: [] },
	};
}

function withCwd(call: ClassifierCall, cwd: string | undefined): ClassifierCall {
	if (cwd === undefined || call.tool !== ToolNames.Bash) return call;
	const args = call.args ?? {};
	if (typeof args.cwd === "string" && args.cwd.length > 0) return call;
	return { ...call, args: { ...args, cwd } };
}

/** Same list semantics as a turn's allowed tools: naming a gateway capability admits its wrapper. */
function toolInScope(allowed: ReadonlyArray<string> | ReadonlySet<string>, tool: string): boolean {
	const allowedTools = [...allowed] as NonNullable<TurnConstraints["allowedTools"]>;
	return turnAllowsTool({ allowedTools }, tool);
}

function activatesSkill(call: ClassifierCall): boolean {
	return call.tool === ToolNames.Context && call.args?.scope === "skills" && typeof call.args?.name === "string";
}

/** Decide one call. Pure apart from the policy engine's own audit side effects. */
export function evaluateAdmission(input: AdmissionInput): AdmissionDisposition {
	const principal = input.principal;
	const level: AutonomyLevel =
		principal === "main"
			? (input.autonomy ?? DEFAULT_AUTONOMY_LEVEL)
			: input.workerExecuteAutonomy === "yolo" &&
					input.effects.length > 0 &&
					input.effects.every((effect) => classify(effect).actionClass === "execute")
				? "yolo"
				: DEFAULT_AUTONOMY_LEVEL;
	const issuer = input.authorization?.issuer;
	const posture =
		issuer === "operator"
			? CONFIRMED_POSTURE
			: issuer === "main"
				? MAIN_GRANT_POSTURE
				: level === "yolo"
					? "yolo"
					: undefined;
	const normalize = input.normalize ?? ((decision: SafetyDecision) => decision);
	const evaluate = (call: ClassifierCall): SafetyDecision =>
		normalize(input.safety.evaluate(withCwd(call, input.cwd), posture));
	if (input.cwd !== undefined && !isAbsolute(input.cwd)) {
		const reason = `admission cwd must be absolute: ${input.cwd}`;
		return deny("context", reason, syntheticBlock(reason));
	}

	// Step 1: the safety net over the capability and every effect. A hard block
	// anywhere dominates an ask or allow elsewhere, in any order.
	const capabilityDecision = input.capability !== undefined ? evaluate(input.capability) : undefined;
	if (capabilityDecision?.kind === "block") {
		return deny("safety_net", capabilityDecision.rejection.short, capabilityDecision);
	}
	const effectDecisions: SafetyDecision[] = [];
	for (const effect of input.effects) {
		const decision = evaluate(effect);
		if (decision.kind === "block") return deny("safety_net", decision.rejection.short, decision);
		effectDecisions.push(decision);
	}
	const primary = effectDecisions[0];
	if (primary === undefined) {
		const reason = "call has no policy-evaluable effects";
		return deny("no_effects", reason, syntheticBlock(reason));
	}
	const netAsk = capabilityDecision?.kind === "ask" ? capabilityDecision : effectDecisions.find((d) => d.kind === "ask");
	const decision = netAsk ?? primary;
	const call = input.capability ?? input.effects[0] ?? { tool: "unknown" };
	const actionClass = decision.classification.actionClass;
	const readOutside = effectDecisions.some((d) => d.policy?.readScope === "outside-workspace");

	// Step 2: hard permit limits. None of them parks and no approval clears them.
	const constraints = input.constraints ?? {};
	if (
		constraints.readOnly === true &&
		(effectDecisions.some((d) => d.classification.actionClass !== "read") ||
			input.confirmationRuleId !== undefined ||
			readOutside ||
			netAsk !== undefined ||
			activatesSkill(call))
	) {
		return deny("read_only", `${call.tool} denied: this run is read-only`, decision);
	}
	const outsideTurn = !turnAllowsTool(constraints.turnConstraints, call.tool);
	const outsideRun = constraints.allowedTools !== undefined && !toolInScope(constraints.allowedTools, call.tool);
	if (outsideTurn || outsideRun) {
		return deny("tool_scope", `${call.tool} is outside this task's admitted tool scope.`, decision);
	}
	if (
		constraints.turnConstraints?.skills === "disabled" &&
		call.tool === ToolNames.Context &&
		call.args?.scope === "skills"
	) {
		return deny("skills_disabled", "Skills are disabled for this task.", decision);
	}
	const surfaceViolation = evaluateSkillToolSurface(constraints.pendingSkillPolicy, call.tool);
	if (surfaceViolation) {
		return deny("skill_surface", `${call.tool} blocked: outside active skill tool surface`, decision, {
			skillViolation: surfaceViolation,
		});
	}

	const covers = input.authorization !== undefined && input.authorization.actionClass === actionClass;
	const authorized = covers && issuer === "operator";
	const mainAuthorized = covers && issuer === "main";

	// Step 3: confirmation obligations raised by the net or by the tool itself.
	if (netAsk !== undefined) {
		if (authorized) return { kind: "allow", decision, authorized: true };
		return {
			kind: "ask",
			source: "safety-net",
			approvalAuthority: "operator",
			reason: netAsk.kind === "ask" ? netAsk.rejection.short : "confirmation required",
			decision: netAsk,
			netDecision: netAsk,
			level,
			exposure: "local",
			readOutsideWorkspace: readOutside,
		};
	}
	if (input.confirmationRuleId !== undefined && !authorized) {
		const ask: SafetyDecision = {
			kind: "ask",
			classification: decision.classification,
			confirmationRuleId: input.confirmationRuleId,
			rejection: {
				short: `${call.tool} needs operator confirmation`,
				detail:
					input.confirmationText?.detail ??
					`${call.tool} changes a Slurm allocation and requires approval before it reaches the scheduler.`,
				hints: ["Approving resumes only this call.", ...(input.confirmationText?.hints ?? [])],
			},
			...(decision.policy !== undefined ? { policy: decision.policy } : {}),
		};
		return {
			kind: "ask",
			source: "tool-confirmation",
			approvalAuthority: "operator",
			reason: ask.rejection.short,
			decision: ask,
			netDecision: decision,
			level,
			exposure: "local",
			readOutsideWorkspace: readOutside,
		};
	}
	// An operator-confirmed rail (an authored git ask rule included) admits the
	// exact call it approved without re-entering the autonomy mapping.
	if (authorized) return { kind: "allow", decision, authorized: true };

	// Step 2, continued: a git_destructive class that reached here was not
	// admitted by any rail and stays hard-blocked on every runtime.
	const destructive = effectDecisions.find((d) => d.classification.actionClass === "git_destructive");
	if (destructive !== undefined) {
		return deny("git_destructive", "action git_destructive is hard-blocked", destructive);
	}

	// Step 4: operator autonomy or the worker's bound standing allowance.
	// Every effect must be admitted; the first that is not decides. A
	// main agent's own ask goes to the operator; a worker's may go to the main.
	const autonomyAuthority: ApprovalAuthority = principal === "worker" ? "main" : "operator";
	for (let index = 0; index < effectDecisions.length; index += 1) {
		const effectDecision = effectDecisions[index] as SafetyDecision;
		const effect = input.effects[index] as ClassifierCall;
		// A worker's Git is decided by its standing Git allowance, not by command
		// recognition: a project policy that recognizes `git commit` does not
		// give a worker the right to commit.
		const git = principal === "worker" ? workerGitObligation(effect, input) : null;
		if (git?.kind === "deny") return deny("git_destructive", git.reason, effectDecision);
		if (git?.kind === "admit") continue;
		if (git?.kind === "ask") {
			if (git.authority === "main" && mainAuthorized) continue;
			const ask: SafetyDecision = {
				kind: "ask",
				classification: effectDecision.classification,
				rejection: {
					short: `${call.tool} needs approval: ${git.reason}`,
					detail: `${git.reason}. A worker's Git mutations are admitted by its permit's Git allowance: git worktree admits git add of literal paths and git commit -m on its own attested task branch; every other Git mutation needs approval.`,
					hints: [
						"Approving resumes only this call.",
						"In an owned task worktree under git worktree, stage and commit with the git tool: op add with paths, op commit with message.",
					],
				},
				...(effectDecision.policy !== undefined ? { policy: effectDecision.policy } : {}),
			};
			return {
				kind: "ask",
				// An ordinary Git ask is the worker's standing allowance, the same
				// step and authority as any other autonomy ask; only the hooks rail
				// the operator must decide is reported as its own source.
				source: git.authority === "operator" ? "git-policy" : "autonomy",
				approvalAuthority: git.authority,
				reason: ask.rejection.short,
				decision: ask,
				netDecision: effectDecision,
				level,
				exposure: git.outward ? "outward" : "local",
				readOutsideWorkspace: false,
			};
		}
		const inputs = autonomyCallInputs(effect, effectDecision, input.autonomyExtra ?? {});
		const disposition = mapAutonomy(level, effectDecision.classification.actionClass, inputs.options);
		if (disposition === "allow") continue;
		// Step 5 for a main grant: it discharges only the ordinary worker ask.
		if (disposition === "ask" && mainAuthorized && autonomyAuthority === "main") continue;
		const ask: SafetyDecision = {
			kind: "ask",
			classification: effectDecision.classification,
			rejection: autonomyAskRejection(
				level,
				call.tool,
				effectDecision.classification.actionClass,
				inputs.exposure,
				inputs.readOutsideWorkspace,
			),
			...(effectDecision.policy !== undefined ? { policy: effectDecision.policy } : {}),
		};
		return {
			kind: "ask",
			source: "autonomy",
			approvalAuthority: autonomyAuthority,
			reason: ask.rejection.short,
			decision: ask,
			netDecision: effectDecision,
			level,
			exposure: inputs.exposure,
			readOutsideWorkspace: inputs.readOutsideWorkspace,
		};
	}
	return { kind: "allow", decision: primary, authorized: mainAuthorized };
}

type WorkerGitObligation =
	| { kind: "admit" }
	| { kind: "deny"; reason: string }
	| { kind: "ask"; authority: ApprovalAuthority; reason: string; outward: boolean };

/**
 * The worker's standing Git allowance for one command effect (Codex review,
 * "Task-worktree Git contract"). Null when the effect runs no Git or only
 * inspects, so ordinary recognition decides it. Every Git mutation asks main
 * unless the typed Git tool projects a task mutation (add of literal paths,
 * commit -m) under `git: worktree` in the run's own task worktree, re-attested now. A mutation that
 * would run hooks the worker can author, by a worker with no execute
 * capability, asks the operator (operator decision Q5).
 */
function workerGitObligation(effect: ClassifierCall, input: AdmissionInput): WorkerGitObligation | null {
	if (effect.tool !== ToolNames.Bash) return null;
	const command = effect.args?.command;
	if (typeof command !== "string") return null;
	const verdict = classifyBashGit(command);
	if (verdict === null || verdict.class === "inspect") return null;
	if (verdict.class === "destructive") return { kind: "deny", reason: `${verdict.reason} is hard-blocked` };
	const context = input.git;
	const outward = verdict.class === "outward";
	const ask = (reason: string, authority: ApprovalAuthority = "main"): WorkerGitObligation => ({
		kind: "ask",
		authority,
		reason,
		outward,
	});
	const base = input.cwd ?? context?.cwd;
	const rawCwd = effect.args?.cwd;
	const cwd =
		typeof rawCwd === "string" && rawCwd.length > 0 ? (base !== undefined ? resolve(base, rawCwd) : rawCwd) : base;
	const subcommand = verdict.subcommand ?? "";
	if (context !== undefined && !context.executePermitted && (cwd === undefined || context.hooksInsideWorkingTree(cwd))) {
		return ask(
			`git ${subcommand} would run repository hooks from inside the working tree, which this worker can author, and its permit has no execute capability`,
			"operator",
		);
	}
	if (verdict.class !== "task-mutation") return ask(verdict.reason);
	if (input.capability?.tool !== ToolNames.Git) {
		return ask(`git ${subcommand} is allowed without approval only through the typed git tool`);
	}
	if (context?.allowance !== "worktree")
		return ask(`git ${subcommand} needs git worktree; this permit grants git inspect`);
	if (context.taskWorktree === undefined || cwd === undefined) {
		return ask(`git ${subcommand} is allowed only in this run's own task worktree, and this run has none`);
	}
	const attested = context.taskWorktree.attest(cwd);
	if (!attested.ok) return ask(attested.detail);
	return { kind: "admit" };
}
