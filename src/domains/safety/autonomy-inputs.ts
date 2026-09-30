import { ToolNames } from "../../core/tool-names.js";
import type { ClassifierCall } from "./action-classifier.js";
import { webFetchIsOutward } from "./action-classifier.js";
import type { AutonomyExposure, AutonomyMappingOptions } from "./autonomy.js";
import { DEFAULT_AUTONOMY_EXPOSURE } from "./autonomy.js";
import type { SafetyDecision } from "./contract.js";

/**
 * The axes the autonomy mapping reads from a net-passed call. Native
 * registry admission, the Claude SDK bridge, and the ACP mediator all derive
 * them here so a recognized outward command asks on every runtime (F4).
 */
export interface AutonomyCallInputs {
	exposure: AutonomyExposure;
	readOutsideWorkspace: boolean;
	options: AutonomyMappingOptions;
}

/** Classifier-declared outward exposure, plus write-shaped HTTP requests. */
function autonomyCallExposure(call: ClassifierCall, decision: SafetyDecision): AutonomyExposure {
	return decision.classification.exposure === "outward" ||
		(call.tool === ToolNames.WebFetch && webFetchIsOutward(call.args))
		? "outward"
		: DEFAULT_AUTONOMY_EXPOSURE;
}

/**
 * `exposure` overrides the derived tier for a tool that declares its own
 * (ask_user); `dispatchPlanScale` is native-only because worker runtimes do
 * not mediate nested dispatch.
 */
export function autonomyCallInputs(
	call: ClassifierCall,
	decision: SafetyDecision,
	extra: { exposure?: AutonomyExposure; dispatchPlanScale?: boolean } = {},
): AutonomyCallInputs {
	const exposure = extra.exposure ?? autonomyCallExposure(call, decision);
	const readOutsideWorkspace = decision.policy?.readScope === "outside-workspace";
	return {
		exposure,
		readOutsideWorkspace,
		options: {
			executeRecognized: decision.policy?.execRecognition !== "unrecognized",
			...(readOutsideWorkspace ? { readOutsideWorkspace: true } : {}),
			...(extra.dispatchPlanScale === true ? { dispatchPlanScale: true } : {}),
			...(exposure === "outward" ? { exposure } : {}),
		},
	};
}
