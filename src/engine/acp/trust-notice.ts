/**
 * Project files whose authority Clio withheld because the operator never
 * approved their bytes. The settings, hooks and safety loaders drop them
 * quietly, so a client whose project-level model "doesn't work" needs the
 * reason at session start (C-4).
 */
import {
	captureProjectSurface,
	type ProjectTrustSurface,
	type WorkspaceTrustVerdict,
} from "../../core/workspace-trust.js";

export const ACP_TRUST_META_KEY = "clio-coder/trust";

const TRUST_SURFACES: ReadonlyArray<ProjectTrustSurface> = ["settings", "hooks", "safety"];

export interface AcpIgnoredProjectSurface {
	surface: ProjectTrustSurface;
	file: string;
	verdict: Exclude<WorkspaceTrustVerdict, "trusted">;
	fix: string;
}

/** Capability entry: the surfaces this build reports and where the report lands. */
export const ACP_TRUST_CAPABILITY = {
	version: 1,
	meta: ACP_TRUST_META_KEY,
	surfaces: TRUST_SURFACES,
	results: ["session/new", "session/load", "session/resume"],
} as const;

/** Every present project file on an unapproved surface; empty when nothing was ignored. */
function ignoredProjectSurfaces(cwd: string): AcpIgnoredProjectSurface[] {
	const ignored: AcpIgnoredProjectSurface[] = [];
	for (const surface of TRUST_SURFACES) {
		let snapshot: ReturnType<typeof captureProjectSurface>;
		try {
			snapshot = captureProjectSurface(cwd, surface);
		} catch {
			// The report is advisory; a capture failure must not fail session creation.
			continue;
		}
		if (snapshot.verdict === "trusted") continue;
		for (const file of snapshot.files) {
			if (file.text === null && file.error === undefined) continue;
			ignored.push({
				surface,
				file: file.path,
				verdict: snapshot.verdict,
				fix: `clio-coder config trust ${surface}`,
			});
		}
	}
	return ignored;
}

export function trustResultMeta(cwd: string): Record<string, { ignored: AcpIgnoredProjectSurface[] }> {
	return { [ACP_TRUST_META_KEY]: { ignored: ignoredProjectSurfaces(cwd) } };
}
