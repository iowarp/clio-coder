import { type ClioSettings, readSettings } from "../core/config.js";
import { bootAuthStatus } from "../domains/providers/auth/boot-status.js";
import { findBuiltinRuntimeBootMetadata } from "../domains/providers/runtimes/boot-manifest.js";

/**
 * Why the configured chat target cannot be used, in the operator's terms
 * rather than as one boolean.
 *
 * The single boolean this replaced sent every cause to the same place: the
 * full "How will you connect Clio to a model?" wizard. Three of the four
 * causes below are genuinely a target-selection problem and belong there. The
 * fourth is not. A declared, present, orchestrator-eligible target whose
 * credential is merely unresolved is one `clio-coder auth login` away, and for a
 * local runtime that ignores keys it is not broken at all: a live LM Studio
 * target in exactly this state answers turns normally. Restarting runtime
 * selection for it told the operator their working installation was
 * unconfigured, on every launch, and the only way past it was to cancel the
 * wizard and watch the session start anyway.
 */
export type DefaultTargetVerdict =
	| { kind: "usable" }
	| { kind: "no-target" }
	| { kind: "ineligible-runtime"; targetId: string; runtime: string }
	| { kind: "missing-credential"; targetId: string; store: string };

export function classifyDefaultTarget(settings: Readonly<ClioSettings> = readSettings()): DefaultTargetVerdict {
	const targetId = settings.orchestrator.target;
	if (!targetId) return { kind: "no-target" };
	// A chat target naming an id that is not in `targets` cannot arrive here:
	// the schema normalizes dangling routing references to null so that
	// deleting a target does not brick every session mentioning it. Deletion
	// therefore reaches this function as `no-target`, and a fourth verdict for
	// it would be a case no settings file can produce.
	const target = settings.targets.find((entry) => entry.id === targetId);
	if (!target) return { kind: "no-target" };
	const runtime = findBuiltinRuntimeBootMetadata(target.runtime);
	if (runtime?.kind !== "http") {
		return { kind: "ineligible-runtime", targetId, runtime: target.runtime };
	}
	const auth = bootAuthStatus(target, runtime);
	if (auth.available) return { kind: "usable" };
	return { kind: "missing-credential", targetId, store: auth.providerId };
}

/** One sentence naming what is wrong, for the causes target selection can fix. */
export function describeVerdict(verdict: DefaultTargetVerdict): string {
	switch (verdict.kind) {
		case "no-target":
			return "No model target is configured.";
		case "ineligible-runtime":
			return `Target '${verdict.targetId}' runs on '${verdict.runtime}', which cannot drive the main agent.`;
		default:
			return "No usable default target is configured.";
	}
}
