import {
	captureProjectSurface,
	type ProjectTrustSurface,
	recordProjectSurfaceTrust,
	revokeProjectSurfaceTrust,
} from "../core/workspace-trust.js";
import { printError } from "./shared.js";

const SURFACES: ReadonlyArray<ProjectTrustSurface> = ["safety", "hooks", "settings"];

/** Review is read-only. Approval names the digest the operator reviewed, so edits cannot borrow stale consent. */
export function runConfigTrustCommand(args: ReadonlyArray<string>, cwd = process.cwd()): number {
	const surface = args[0] as ProjectTrustSurface | undefined;
	if (surface === undefined || !SURFACES.includes(surface)) {
		printError("usage: clio-coder config trust safety|hooks|settings [--json | --hash SHA256 | --revoke]");
		return 2;
	}
	const rest = args.slice(1);
	const preview = rest.length === 0 || (rest.length === 1 && rest[0] === "--json");
	const revoke = rest.length === 1 && rest[0] === "--revoke";
	const approve = rest.length === 2 && rest[0] === "--hash" && /^[a-f0-9]{64}$/.test(rest[1] ?? "");
	if (!preview && !revoke && !approve) {
		printError("trust expects --json, --revoke, or --hash followed by the full reviewed SHA-256 digest");
		return 2;
	}
	try {
		if (revoke) {
			revokeProjectSurfaceTrust(cwd, surface);
			process.stdout.write(
				`Project ${surface} trust revoked. Restart to reload settings and safety; project hooks stop before their next execution.\n`,
			);
			return 0;
		}
		const snapshot = captureProjectSurface(cwd, surface);
		if (preview) {
			// JSON escapes terminal control sequences in repository-controlled text.
			process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
			if (rest[0] !== "--json" && snapshot.contentHash !== null && snapshot.files.some((file) => file.text !== null)) {
				process.stdout.write(
					`Review the captured files above. Approve exactly these bytes with:\nclio-coder config trust ${surface} --hash ${snapshot.contentHash}\n`,
				);
			}
			return 0;
		}
		if (snapshot.contentHash === null || !snapshot.files.some((file) => file.text !== null)) {
			printError(`no readable project ${surface} files to approve`);
			return 1;
		}
		if (snapshot.contentHash !== rest[1]) {
			printError(`project ${surface} changed since review; inspect it again before approving`);
			return 1;
		}
		recordProjectSurfaceTrust(snapshot.workspaceRoot, surface, snapshot.contentHash);
		process.stdout.write(
			`Project ${surface} approved for ${snapshot.workspaceRoot} at ${snapshot.contentHash}. Restart to reload settings and safety; reload extensions to register newly approved hooks.\n`,
		);
		return 0;
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
