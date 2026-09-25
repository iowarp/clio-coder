import type { ActionClass } from "./action-classifier.js";
import type { RejectionMessage } from "./rejection-feedback.js";

/**
 * The autonomy axis (sd-01 §2.2/§2.3). An ordered operator-set dial that
 * controls exactly one thing: which action classes trigger the approval flow
 * versus run immediately versus auto-deny. It runs AFTER the safety net: a
 * net `block` is final at every level and damage-control `confirm` always
 * asks; this mapping applies only to level-dependent rows after the net passed.
 * The policy engine clears ordinary confirmation rails in yolo before the
 * action class reaches this mapping.
 *
 * An outward-facing gate parks in default mode and runs in yolo mode.
 *
 * The mapping is pure. The registry (orchestrator and worker) and the ACP
 * delegation mediator are the only consumers; each resolves an `ask`
 * disposition through its own approvals context (interactive park, headless
 * deterministic deny, workers.onPermission, delegation non-stall deny).
 */

export const AUTONOMY_LEVELS = ["default", "yolo"] as const;

export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = "default";

export function isAutonomyLevel(value: unknown): value is AutonomyLevel {
	return typeof value === "string" && (AUTONOMY_LEVELS as ReadonlyArray<string>).includes(value);
}

/** Operator input accepts only the two current modes. Saved settings migrate separately. */
export function autonomyFromUserInput(value: string): AutonomyLevel | null {
	return isAutonomyLevel(value) ? value : null;
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
	 * approving the parked call approves the whole plan. Yolo skips the
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

/** A read-only dispatch does not let the model activate skills. */
export function modelMayActivateSkills(readOnly = false): boolean {
	return !readOnly;
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
	// Default grants workspace action without granting outward publication.
	if (level === "default" && options.exposure === "outward") return "ask";
	// The workspace is what the operator handed over. A read, listing, or
	// search aimed outside it asks at every supervised level and runs at
	// yolo.
	if (actionClass === "read" && options.readOutsideWorkspace === true && level !== "yolo") {
		return "ask";
	}
	if (actionClass === "read") return "allow";
	// Default and yolo from here.
	switch (actionClass) {
		case "write":
			return "allow";
		case "dispatch":
			if (options.dispatchPlanScale === true && level !== "yolo") return "ask";
			return "allow";
		case "execute": {
			if (options.executeRecognized !== false) return "allow";
			return level === "yolo" ? "allow" : "ask";
		}
		case "unknown":
			// Registered tools that classify as unknown are substituted to their
			// baseActionClass in the registry after safety.evaluate(). Keeping
			// unknown here prevents read-class domain tools from becoming a net
			// confirm rail before that substitution can happen.
			return level === "yolo" ? "allow" : "ask";
		case "system_modify":
			// The safety engine has already checked protected paths and damage
			// control. Its ordinary system-change confirmation belongs to default.
			return level === "yolo" ? "allow" : "ask";
	}
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
				"Yolo reads outside the workspace without asking; zero-access paths stay refused at every level.",
			],
		};
	}
	if (exposure === "outward") {
		return {
			short: `${tool} needs approval: outward-facing gate at autonomy ${level}`,
			detail:
				`The call declared exposure=outward, so answering it publishes or sends something outside the workspace. ` +
				`Autonomy ${level} auto-answers local gates and parks outward-facing ones for the operator.`,
			hints: ["Approving resumes only this call.", "Yolo answers outward gates too; the safety net still applies there."],
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
						'For a declared check, use verify(check="<id>"). Recognized test commands can run without an autonomy prompt; other checks may still require safety-net confirmation.',
						"Workspace inspection can use the ls, read, grep, and find tools; path protections and safety-net rules still apply.",
					]
				: []),
		],
	};
}
