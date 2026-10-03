import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";

/**
 * Approve a scratch workspace's installed project extensions or plugins the way
 * `clio-coder config trust <surface> --hash` does, so a project install loads.
 * Any later install, enable, disable or remove changes the state bytes and
 * needs another call. Use it inside an isolated Clio env.
 */
export function trustProjectPackages(cwd: string, ...surfaces: Array<"extensions" | "plugins">): void {
	for (const surface of surfaces) {
		const snapshot = captureProjectSurface(cwd, surface);
		if (snapshot.contentHash !== null && snapshot.files.some((file) => file.text !== null))
			recordProjectSurfaceTrust(snapshot.workspaceRoot, surface, snapshot.contentHash);
	}
}
