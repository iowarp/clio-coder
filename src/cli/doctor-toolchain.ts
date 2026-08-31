import type { DoctorFinding } from "../domains/lifecycle/doctor.js";
import {
	describeYaziProfile,
	inspectCurrentYaziProfile,
	userYaziConfigDir,
	yaziProfileDir,
} from "../domains/mux/index.js";
import { describeResolution, toolStatuses } from "../domains/toolchain/index.js";

function yaziProfileFinding(): DoctorFinding {
	try {
		const profile = inspectCurrentYaziProfile();
		return {
			ok: true,
			name: "yazi managed profile",
			detail: describeYaziProfile(profile),
			level: profile.state === "current" ? "ok" : "warn",
		};
	} catch (error) {
		return {
			ok: true,
			name: "yazi managed profile",
			level: "warn",
			detail: `${yaziProfileDir()} could not be inspected (${error instanceof Error ? error.message : String(error)}); user config ${userYaziConfigDir()} is separate and untouched`,
		};
	}
}

/**
 * One row per pinned external tool: where it resolves, and how the version
 * found compares to the pin.
 *
 * Every one of these tools is optional, so no row is ever an error. A missing
 * tool is a WARN with the command that installs it, because doctor's exit code
 * answers "is this Clio install healthy", and an operator who never wanted
 * panes has a healthy install without them.
 *
 * A PATH copy Clio rejected for being below the registry floor is never
 * reported as an absent one. The row says which binary was found, what version
 * it reported, and which floor it missed, and adds the install command only
 * when there is no vendored copy already answering for the tool. Doctor is the
 * surface an operator reaches for when a tool they installed themselves is not
 * being used, and a row that only said "not found" would send them looking for
 * a binary that is right there on their PATH.
 */
export function toolchainFindings(): DoctorFinding[] {
	const tools = toolStatuses().map((status) => ({
		ok: true,
		name: `external tool ${status.id}`,
		// The rejection and the remedy both live inside the shared resolution
		// sentence, so this row and `clio-coder tools status` cannot describe the
		// same machine differently.
		detail: describeResolution(status),
		level: status.resolution.source === "none" ? ("warn" as const) : ("ok" as const),
	}));
	return [...tools, yaziProfileFinding()];
}
