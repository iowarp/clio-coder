import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ToolNames } from "../../core/tool-names.js";
import type { ClassifierCall } from "./action-classifier.js";
import type { AutonomyExposure } from "./autonomy.js";
import { autonomyCallInputs } from "./autonomy-inputs.js";
import { describeBashCallConsequences, type PathKind } from "./command-consequence.js";
import { outwardShellReason } from "./containment.js";
import type { SafetyDecision } from "./contract.js";

/** What exists at `path` once resolved against `cwd`; null when it does not, or cannot be read. */
function pathKindIn(cwd: string): (path: string) => PathKind {
	return (path) => {
		try {
			const stat = statSync(resolve(cwd, path));
			return stat.isDirectory() ? "dir" : stat.isFile() ? "file" : null;
		} catch {
			// A path that cannot be statted is not an existing file to overwrite.
			return null;
		}
	};
}

/**
 * The consequence sentences for a bash ask the main agent made, read from the
 * full command and checked against the filesystem it will run in. Card text
 * only: a failure here is no sentence, never a different admission. Every
 * approval surface (the terminal card and the ACP permission request) reads
 * it here so they describe one command the same way.
 */
export function describeMainCallConsequences(call: ClassifierCall): string[] {
	const cwd = typeof call.args?.cwd === "string" && call.args.cwd.length > 0 ? call.args.cwd : process.cwd();
	const described = describeBashCallConsequences(call.tool, call.args, {
		pathKind: pathKindIn(resolve(process.cwd(), cwd)),
		home: homedir,
	});
	if (described.length > 0) return described;
	// A step the sandbox refuses as outward says why, so a card titled outward names what reaches out.
	const outward = shellOutwardReason(call);
	return outward === null ? [] : [outward];
}

function shellOutwardReason(call: ClassifierCall): string | null {
	if (call.tool !== ToolNames.Bash && call.tool !== ToolNames.RunScript) return null;
	const command = call.args?.command;
	return typeof command === "string" ? outwardShellReason(command) : null;
}

/**
 * Whether a parked main-agent call reaches outside the workspace, for the words
 * and tone of its approval card. The classifier's own exposure comes first, then
 * the shell steps the sandbox already treats as outward, so `npm publish` is not
 * titled a workspace action beside an effect that says otherwise. Card text only:
 * admission reads none of this, and a false match only makes a card warier.
 */
export function mainCallExposure(call: ClassifierCall, decision: SafetyDecision): AutonomyExposure {
	if (autonomyCallInputs(call, decision).exposure === "outward") return "outward";
	return shellOutwardReason(call) === null ? "local" : "outward";
}
