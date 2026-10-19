import { isAbsolute, resolve } from "node:path";
import type { PendingSkillToolPolicy, SkillToolSurfaceViolation } from "../../core/skill-activation.js";
import { evaluateSkillToolSurface } from "../../core/skill-activation.js";
import { ToolNames } from "../../core/tool-names.js";
import type { TurnConstraints } from "../../core/turn-constraints.js";
import { turnAllowsTool } from "../../core/turn-constraints.js";
import type { ActionClass, ClassifierCall } from "./action-classifier.js";
import type { AutonomyExposure, AutonomyLevel } from "./autonomy.js";
import { autonomyAskRejection, DEFAULT_AUTONOMY_LEVEL, mapAutonomy } from "./autonomy.js";
import { autonomyCallInputs } from "./autonomy-inputs.js";
import { GIT_CONTROL_FILE_RULE_ID, gitControlFileReason, SNAPSHOT_RECOVERABLE_REASON_CODE } from "./containment.js";
import type { SafetyContract, SafetyDecision } from "./contract.js";
import { CONFIRMED_POSTURE, MAIN_GRANT_POSTURE } from "./contract.js";
import { classifyBashGit } from "./git-policy.js";
import type { OperatorDefaultScope, OperatorYoloScope } from "./policy-engine.js";
import { SESSION_CODE_CONSENT_RULE_ID } from "./session-code-consent.js";
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
 *   4. autonomy (main, with an attended session's test-runner consent) or the
 *      worker's standing allowance, Git included;
 *   5. a matching authorization, which clears only what it is allowed to clear.
 *
 * True yolo (#407) stops after step 2: its net holds only the floor,
 * operator-authored rules and the run's ceilings, so steps 3 to 5 never ask.
 *
 * The operator's own default (Phase 2c) runs every step, with three changes:
 * a contained call (its decision carries `shellSandbox`) is admitted by
 * autonomy whatever its command recognition and owes no test-runner consent;
 * a lone discard or delete a workspace snapshot undoes runs; and any other
 * destructive git asks instead of being refused, so the safety judge decides
 * it.
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
 * which means the main agent may answer it through the grant broker
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
	/**
	 * The main session's own yolo (#407, #419). Only the session's registry
	 * passes it, and it reaches the net only for the main principal at yolo,
	 * where it makes admission true yolo: nothing asks, and only the floor,
	 * operator-authored rules and the run's ceilings refuse. Scheduled `main`
	 * jobs and `main_turn` deliveries are turns of the operator's own session
	 * through that registry, so they get it. A worker grant and a scheduled
	 * command job are judged as main without it and keep the rails.
	 */
	operatorYolo?: OperatorYoloScope;
	/**
	 * The main session's own default (Phase 2c). Only the session's registry
	 * passes it, beside its containment, and it reaches the net only for the
	 * main principal at default: the floor blocks first, contained shell calls
	 * run without the asks their command text would raise, damage control a
	 * snapshot undoes runs, and every other former damage-control block asks.
	 * Workers, grants and scheduled command jobs are judged without it.
	 */
	operatorDefault?: OperatorDefaultScope;
	/**
	 * The operator's yolo, bound by the host permit for every action class
	 * (#407) and independent of model fields. The permit field keeps its
	 * historical name `executeAutonomy`. A worker under it is admitted the true
	 * yolo way, still bounded by its dispatch scope (read-only, tool scope,
	 * write roots), its OS sandbox and the floor.
	 */
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
	 * Main principal at default only. True while the operator of an attended
	 * session has not consented to test runners, so a net-tagged test runner
	 * asks once instead of running. A headless run never sets it.
	 */
	sessionCodeConsentPending?: boolean;
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

export type AdmissionAskSource = "safety-net" | "tool-confirmation" | "autonomy" | "git-policy" | "session-consent";

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

/**
 * The scope a worker inherits with the operator's yolo (#407): no scratch
 * roots of its own and no yolo script sandbox, because its dispatch scope and
 * its OS sandbox already bound where it writes.
 */
const WORKER_YOLO_SCOPE: OperatorYoloScope = Object.freeze({ scratchRoots: [], scriptSandbox: "unsandboxed" });

/** Classes a contained call is admitted at by autonomy default; the sandbox stands in for their asks. */
const CONTAINED_CLASSES: ReadonlySet<ActionClass> = new Set<ActionClass>(["execute", "system_modify", "destructive"]);

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
			: input.workerExecuteAutonomy === "yolo"
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
	// True yolo (#407): the operator's session at yolo, or a worker whose permit
	// inherited it. Nothing parks under it, so no authorization ever arrives.
	const operatorYolo =
		level !== "yolo" || issuer !== undefined ? undefined : principal === "main" ? input.operatorYolo : WORKER_YOLO_SCOPE;
	// The operator's default holds through an operator's own approval, so an
	// approved contained call still runs contained.
	const operatorDefault =
		level === "default" && principal === "main" && issuer !== "main" ? input.operatorDefault : undefined;
	const evaluate = (call: ClassifierCall): SafetyDecision =>
		normalize(input.safety.evaluate(withCwd(call, input.cwd), posture, operatorYolo ?? operatorDefault));
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
		(constraints.readOnly === true || constraints.turnConstraints?.readOnly === true) &&
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

	// Under true yolo the net already held only the floor, operator-authored
	// rules and the run's ceilings, and the hard limits above held the rest, so
	// no confirmation rail, Git allowance or autonomy mapping asks (#407).
	if (operatorYolo !== undefined) return { kind: "allow", decision: primary, authorized: false };

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
	// admitted by any rail and stays hard-blocked on every runtime. The
	// operator's default runs one a workspace snapshot undoes and asks for any
	// other, so the safety judge decides it.
	const destructive = effectDecisions.find(
		(d) =>
			d.classification.actionClass === "git_destructive" &&
			!(operatorDefault !== undefined && d.policy?.reasonCode === SNAPSHOT_RECOVERABLE_REASON_CODE),
	);
	if (destructive !== undefined && operatorDefault !== undefined) {
		const ask: SafetyDecision = {
			kind: "ask",
			classification: destructive.classification,
			rejection: {
				short: `${call.tool} needs approval: destructive git at autonomy default`,
				detail:
					"The command can rewrite or discard git history no workspace snapshot keeps. At autonomy default it is reviewed against the operator's request instead of being refused.",
				hints: ["Approving resumes only this call."],
			},
			...(destructive.policy !== undefined ? { policy: destructive.policy } : {}),
		};
		return {
			kind: "ask",
			source: "safety-net",
			approvalAuthority: "operator",
			reason: ask.rejection.short,
			decision: ask,
			netDecision: destructive,
			level,
			exposure: "local",
			readOutsideWorkspace: false,
		};
	}
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
		// The operator's default: a contained call runs in the main-session
		// sandbox, which bounds what it writes and hides credentials, so neither
		// its recognition nor a test runner's consent asks; a lone discard or
		// delete the snapshot taken right before it undoes runs.
		if (operatorDefault !== undefined) {
			if (effectDecision.policy?.reasonCode === SNAPSHOT_RECOVERABLE_REASON_CODE) continue;
			const actionClass = effectDecision.classification.actionClass;
			if (effectDecision.policy?.shellSandbox !== undefined && CONTAINED_CLASSES.has(actionClass)) continue;
		}
		// A worker's typed write to a git hook, config or git dir pointer plants
		// code that runs outside its sandbox on the operator's or the main
		// session's next git command, so at default it asks the main agent; a
		// main grant for the call discharges it.
		const gitControl = principal === "worker" && level === "default" ? effectDecision.policy?.gitControl : undefined;
		if (gitControl !== undefined && !mainAuthorized) {
			return workerGitControlAsk(call.tool, gitControl, effectDecision, level);
		}
		const inputs = autonomyCallInputs(effect, effectDecision, input.autonomyExtra ?? {});
		const disposition = mapAutonomy(level, effectDecision.classification.actionClass, inputs.options);
		if (disposition === "allow") {
			if (
				principal === "main" &&
				level === "default" &&
				input.sessionCodeConsentPending === true &&
				effectDecision.policy?.runsWorkspaceCode === true
			) {
				return sessionCodeConsentAsk(call.tool, effectDecision, level);
			}
			continue;
		}
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

/**
 * The once-per-session ask before a test runner runs repository code the
 * operator has not confirmed. It carries its own rail id and a policy in ask
 * form, so the card shows why it asks and the grant names the rail; an
 * operator approval re-admits the call at step 3 and the host records the
 * consent.
 */
function sessionCodeConsentAsk(tool: string, netDecision: SafetyDecision, level: AutonomyLevel): AdmissionDisposition {
	const detail =
		"This test command runs repository code, whoever wrote it: this session, an earlier one, a worker or a checkout. Approve once to allow test runners for the rest of this session.";
	const ask: SafetyDecision = {
		kind: "ask",
		classification: netDecision.classification,
		confirmationRuleId: SESSION_CODE_CONSENT_RULE_ID,
		rejection: {
			short: `${tool} needs approval: a test runner runs repository code this session has not confirmed`,
			detail,
			hints: [
				"Approving runs this call and lets test runners run without asking for the rest of this session.",
				"A denial leaves consent ungiven, so the next test runner asks again.",
			],
		},
		...(netDecision.policy !== undefined
			? {
					policy: {
						...netDecision.policy,
						kind: "ask" as const,
						ruleId: SESSION_CODE_CONSENT_RULE_ID,
						reasonCode: SESSION_CODE_CONSENT_RULE_ID,
						reasons: [detail, ...netDecision.policy.reasons],
					},
				}
			: {}),
	};
	return {
		kind: "ask",
		source: "session-consent",
		approvalAuthority: "operator",
		reason: ask.rejection.short,
		decision: ask,
		netDecision,
		level,
		exposure: "local",
		readOutsideWorkspace: false,
	};
}

/** The main-authority ask for a worker's typed write to a git control path. */
function workerGitControlAsk(
	tool: string,
	controlPath: string,
	netDecision: SafetyDecision,
	level: AutonomyLevel,
): AdmissionDisposition {
	const detail = gitControlFileReason(controlPath);
	const ask: SafetyDecision = {
		kind: "ask",
		classification: netDecision.classification,
		rejection: {
			short: `${tool} needs approval: it writes a git control file of the repository`,
			detail,
			hints: ["Approving resumes only this call."],
		},
		...(netDecision.policy !== undefined
			? {
					policy: {
						...netDecision.policy,
						kind: "ask" as const,
						ruleId: GIT_CONTROL_FILE_RULE_ID,
						reasonCode: GIT_CONTROL_FILE_RULE_ID,
						reasons: [detail, ...netDecision.policy.reasons],
					},
				}
			: {}),
	};
	return {
		kind: "ask",
		source: "autonomy",
		approvalAuthority: "main",
		reason: ask.rejection.short,
		decision: ask,
		netDecision,
		level,
		exposure: "local",
		readOutsideWorkspace: false,
	};
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
