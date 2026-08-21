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
	 * (built-in allowlist, project policy command) or is a typed execution tool
	 * (verify). Raw bash outside that set is unrecognized.
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
 * denies, so the message is the propose-instead contract from §2.3.
 */
export function autonomyDenyRejection(level: AutonomyLevel, tool: string, actionClass: ActionClass): RejectionMessage {
	return {
		short: `${tool} denied: autonomy level is ${level}`,
		detail:
			`Clio is at autonomy ${level}: ${actionClass} actions are denied without prompting. ` +
			"Describe the change you would make instead, so the operator can apply it or raise the autonomy level.",
		hints: ["Propose the exact edit or command as text.", "The operator can change the level in /settings."],
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
): RejectionMessage {
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
			"Recognized commands can be added to .clio-coder/safety.yaml.",
			// The sanctioned pivots for a gated shell command: typed verification
			// and read-class observe tools run without approval at this level,
			// and models otherwise stall retrying denied bash for checks or
			// directory listings.
			...(actionClass === "execute"
				? [
						'A declared package or project-catalog check runs without approval through the verify tool: verify(check="<id>").',
						"Read-only inspection runs without approval through the ls, read, grep, and find tools.",
					]
				: []),
		],
	};
}
