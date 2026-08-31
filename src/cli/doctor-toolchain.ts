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
 */
export function toolchainFindings(): DoctorFinding[] {
	const tools = toolStatuses().map((status) => ({
		ok: true,
		name: `external tool ${status.id}`,
		detail: describeResolution(status),
		level: status.resolution.source === "none" ? ("warn" as const) : ("ok" as const),
	}));
	return [...tools, yaziProfileFinding()];
}
