/** Shared trust API for safety callers; core owns persistence so settings can gate before domain startup. */
export {
	captureProjectSurface,
	type ProjectSurfaceSnapshot,
	type ProjectTrustSurface,
	projectSurfaceTrust,
	projectSurfaceTrustNotice,
	recordProjectSurfaceTrust,
	revokeProjectSurfaceTrust,
	type WorkspaceTrustVerdict,
	workspaceTrustDirectory,
} from "../../core/workspace-trust.js";

import { projectSurfaceTrust, safetySurfaceTrustHash } from "../../core/workspace-trust.js";
import type { LoadedProjectSafetyPolicy } from "./project-policy.js";

/** Keep discovered provenance visible while withholding unapproved project authority. */
export function gateProjectSafetyPolicy(
	workspaceRoot: string,
	policy: LoadedProjectSafetyPolicy,
): LoadedProjectSafetyPolicy {
	if (policy.path === null) return policy;
	const trustVerdict =
		policy.hash === null
			? "untrusted"
			: projectSurfaceTrust(workspaceRoot, "safety", safetySurfaceTrustHash(policy.path, policy.hash));
	if (trustVerdict === "trusted") return { ...policy, trustVerdict };
	return {
		...policy,
		trustVerdict,
		// This is the admitted empty policy, whose execution defaults are valid.
		// Unapproved parse failures retain diagnostics below but cannot acquire the
		// authority to block execution. An approved malformed policy stays invalid.
		valid: true,
		commands: [],
		pathPolicy: {},
		disableDefaultPathPolicy: false,
		errors: [
			...policy.errors,
			`${policy.path} is ${trustVerdict}; project safety ignored. Review with clio-coder config trust safety.`,
		],
	};
}
