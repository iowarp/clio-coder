import type { ActionClass } from "./action-classifier.js";
import type { RejectionMessage } from "./rejection-feedback.js";

/**
 * The autonomy axis (sd-01 §2.2/§2.3). An ordered operator-set dial that
 * controls exactly one thing: which action classes trigger the approval flow
 * versus run immediately versus auto-deny. It runs AFTER the safety net: a
 * net `block` is final at every level and a net `confirm` always asks; this
 * mapping applies only to level-dependent rows after the net passed.
 * Level-independent rails such as system_modify belong to the policy engine.
 *
 * One call-level tier crosses the action classes: a gate can declare its
 * exposure, and an `outward` gate parks at `auto-edit` (#32) and at the
 * stricter `suggest` (#50).
 *
 * The mapping is pure. The registry (orchestrator and worker) and the ACP
 * delegation mediator are the only consumers; each resolves an `ask`
 * disposition through its own approvals context (interactive park, headless
 * deterministic deny, workers.onPermission, delegation non-stall deny).
 */

export const AUTONOMY_LEVELS = ["read-only", "suggest", "auto-edit", "full-auto"] as const;

export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = "auto-edit";

export function isAutonomyLevel(value: unknown): value is AutonomyLevel {
	return typeof value === "string" && (AUTONOMY_LEVELS as ReadonlyArray<string>).includes(value);
}

export type AutonomyDisposition = "allow" | "ask" | "deny";

/**
 * Exposure tier of a call, orthogonal to its action class. `local` is the
 * default and means the effect stays inside the workspace, where the operator
 * can undo it. `outward` means answering the call publishes or sends something
 * the operator cannot quietly take back: a filed issue, a pushed branch, a
 * posted comment, a cut release. Only the caller knows which it is, so the
 * tier is declared on the call (today: the `exposure` argument of `ask_user`),
 * not inferred by the classifier.
 */
export const AUTONOMY_EXPOSURES = ["local", "outward"] as const;

export type AutonomyExposure = (typeof AUTONOMY_EXPOSURES)[number];

export const DEFAULT_AUTONOMY_EXPOSURE: AutonomyExposure = "local";

export interface AutonomyMappingOptions {
	/**
	 * Execute-class calls only: true when the command is in the no-prompt set
	 * (built-in allowlist or approved project policy command). Typed verify
	 * calls also pass their underlying command through the safety net.
	 */
	executeRecognized?: boolean;
	/**
	 * Dispatch-class calls only: true when the call is a plan-scale dispatch
	 * (multi-task fan-out, compete topology, remote node placement, or winner
	 * application). Supervised levels route these through ONE plan approval;
	 * approving the parked call approves the whole plan. full-auto skips the
	 * stop (the dispatch tool logs the plan into the receipt chain instead).
	 */
	dispatchPlanScale?: boolean;
	/**
	 * Exposure tier declared by the call. Absent means `local`, which is the
	 * behavior every call had before the tier existed.
	 */
	exposure?: AutonomyExposure;
	/**
	 * Read-class path tools only (read, ls, grep, find): true when the path the
	 * call names resolves outside the workspace and outside Clio's own readable
	 * roots. The policy engine decides it and carries it as `readScope`.
	 */
	readOutsideWorkspace?: boolean;
}

/**
 * Whether the model may activate an installed skill itself rather than
 * emitting the suggestion anchor and waiting for the operator to type
 * `/skill <name>`.
 *
 * At `read-only` and `suggest` the operator asked to be consulted before the
 * agent acts, and activation is an action. At `auto-edit` and `full-auto` they
 * already said otherwise, and a skill can only narrow the tool surface, never
 * widen it, so the gate buys no safety there. The level is the opt-in; there is
 * no per-skill frontmatter flag for this.
 */
export function modelMayActivateSkills(level: AutonomyLevel): boolean {
	return level === "auto-edit" || level === "full-auto";
}

/**
 * The §2.3 level-dependent matrix. `git_destructive` never reaches this
 * mapping in practice (the safety net blocks it first); it maps to deny
 * defensively.
 */
export function mapAutonomy(
	level: AutonomyLevel,
	actionClass: ActionClass,
	options: AutonomyMappingOptions = {},
): AutonomyDisposition {
	if (actionClass === "git_destructive") return "deny";
	// The exposure tier. `auto-edit` means "act on the workspace without
	// asking", not "publish without asking", so an outward gate parks for the
	// operator here even though its action class would have run. `suggest` parks
	// it too (#50): the dial is ordered, so a stricter level cannot gate less
	// than auto-edit at the same surface, and a read-class gate would otherwise
	// have been auto-answered there by the row below. `full-auto` is untouched
	// (auto means auto), and `read-only` keeps answering the gate, because the
	// level it describes is "inspect and answer" and the outward effect it is
	// confirming is itself denied there.
	if ((level === "auto-edit" || level === "suggest") && options.exposure === "outward") return "ask";
	// The workspace is what the operator handed over. A read, listing, or
	// search aimed outside it asks at every supervised level and runs at
	// full-auto. `read-only` never invokes approvals, so the ask is its deny.
	if (actionClass === "read" && options.readOutsideWorkspace === true && level !== "full-auto") {
		return level === "read-only" ? "deny" : "ask";
	}
	if (actionClass === "read") return "allow";
	if (level === "read-only") return "deny";
	if (level === "suggest") return "ask";
	// auto-edit and full-auto from here.
	switch (actionClass) {
		case "write":
			return "allow";
		case "dispatch":
			if (options.dispatchPlanScale === true && level !== "full-auto") return "ask";
			return "allow";
		case "execute": {
			if (options.executeRecognized !== false) return "allow";
			return level === "full-auto" ? "allow" : "ask";
		}
		case "unknown":
			// Registered tools that classify as unknown are substituted to their
			// baseActionClass in the registry after safety.evaluate(). Keeping
			// unknown here prevents read-class domain tools from becoming a net
			// confirm rail before that substitution can happen.
			return "ask";
		default:
			return "ask";
	}
}

/**
 * Rejection text for autonomy `deny` dispositions. Only `read-only` produces
 * denies, so the message is the propose-instead contract from §2.3, or the
 * search-scope text when the denied call is a read outside the workspace.
 */
export function autonomyDenyRejection(
	level: AutonomyLevel,
	tool: string,
	actionClass: ActionClass,
	readOutsideWorkspace = false,
): RejectionMessage {
	if (readOutsideWorkspace) {
		return {
			short: `${tool} denied: the path is outside the workspace at autonomy ${level}`,
			detail:
				`The path resolves outside the workspace. Autonomy ${level} reads, lists, and searches inside the workspace ` +
				"and denies a path outside it without prompting.",
			hints: [
				"Work from paths inside the workspace, or name the outside path to the operator as text.",
				"The operator can raise the level in interactive /settings or with clio-coder run --autonomy <level>.",
			],
		};
	}
	return {
		short: `${tool} denied: autonomy level is ${level}`,
		detail:
			`Clio is at autonomy ${level}: ${actionClass} actions are denied without prompting. ` +
			"Describe the change you would make instead, so the operator can apply it or raise the autonomy level.",
		hints: [
			...(level === "read-only" && actionClass === "execute"
				? [
						"For independent permitted inspection, use the native read, grep, find, or ls tools when available. " +
							"Do not use them to reproduce the denied execution or write; each call still follows its safety policy.",
					]
				: []),
			"Propose the exact edit or command as text.",
			"The operator can change the level in interactive /settings or start a new headless run with clio-coder run --autonomy <level>.",
		],
	};
}

/**
 * Rejection text for autonomy `ask` dispositions. Carried on the parked
 * decision so overlays and non-interactive deniers can explain which axis
 * asked (the level, not a safety-net rail).
 */
export function autonomyAskRejection(
	level: AutonomyLevel,
	tool: string,
	actionClass: ActionClass,
	exposure: AutonomyExposure = DEFAULT_AUTONOMY_EXPOSURE,
	readOutsideWorkspace = false,
): RejectionMessage {
	if (readOutsideWorkspace && exposure !== "outward") {
		return {
			short: `${tool} needs approval: the path is outside the workspace at autonomy ${level}`,
			detail:
				`The path resolves outside the workspace, through a link, a \`..\`, or an absolute path. ` +
				`Autonomy ${level} reads, lists, and searches inside the workspace without asking and parks a path outside it for the operator.`,
			hints: [
				"Approving resumes only this call.",
				"Autonomy full-auto reads outside the workspace without asking; zero-access paths stay refused at every level.",
			],
		};
	}
	if (exposure === "outward") {
		return {
			short: `${tool} needs approval: outward-facing gate at autonomy ${level}`,
			detail:
				`The call declared exposure=outward, so answering it publishes or sends something outside the workspace. ` +
				`Autonomy ${level} auto-answers local gates and parks outward-facing ones for the operator.`,
			hints: [
				"Approving resumes only this call.",
				"Autonomy full-auto answers outward gates too; the safety net still applies there.",
			],
		};
	}
	return {
		short: `${tool} needs approval (${actionClass}) at autonomy ${level}`,
		detail:
			`Autonomy ${level} routes ${actionClass} actions through operator approval. ` +
			"The call is parked until the operator approves it once or cancels it.",
		hints: [
			"Approving resumes only this call.",
			"The operator can approve command declarations in .clio-coder/safety.yaml; declarations do not bypass the autonomy level or safety net.",
			// Offer available tools without promising that changing the tool
			// spelling bypasses the execution approval or a safety-net rail.
			...(actionClass === "execute"
				? [
						level === "suggest"
							? 'Declared checks can use verify(check="<id>"), but execution still requires approval at autonomy suggest.'
							: 'For a declared check, use verify(check="<id>"). Recognized test commands can run without an autonomy prompt; other checks may still require safety-net confirmation.',
						"Workspace inspection can use the ls, read, grep, and find tools; path protections and safety-net rules still apply.",
					]
				: []),
		],
	};
}
