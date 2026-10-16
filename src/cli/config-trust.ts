import { realpathSync } from "node:fs";
import {
	captureProjectSurface,
	type ProjectPackageEntry,
	type ProjectTrustSurface,
	projectPackageEntries,
	recordProjectPackageTrust,
	recordProjectSurfaceTrust,
	revokeProjectSurfaceTrust,
} from "../core/workspace-trust.js";
import { forgetApprovedFlowPolicy } from "../domains/safety/flow-policy-snapshot.js";
import { printError } from "./shared.js";

const SURFACES: ReadonlyArray<ProjectTrustSurface> = ["safety", "hooks", "settings", "extensions", "plugins"];

const PACKAGE_RELOAD: Partial<Record<ProjectTrustSurface, string>> = {
	extensions: "Reload extensions (/extensions reload) to apply it.",
	plugins: "Reload the library (/library reload) to apply it.",
};

/** C1 controls, which JSON escaping leaves raw. */
function escapeC1(text: string): string {
	return text.replace(/[\u007f-\u009f]/gu, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** JSON string escaping plus C1 controls, since ids and sources are repository-controlled text. */
function printable(text: string): string {
	return escapeC1(JSON.stringify(text).slice(1, -1));
}

function packageLines(surface: ProjectTrustSurface, packages: ReadonlyArray<ProjectPackageEntry>): string {
	if (packages.length === 0) return `No project ${surface} are installed.\n`;
	const text = (value: string | null): string => (value === null ? "(none)" : printable(value));
	const lines = packages.map(
		(item) =>
			`  ${item.enabled ? "enabled " : "disabled"}  ${printable(item.id)}  source ${text(item.source)}  origin ${item.origin === null ? "(none)" : escapeC1(item.origin)}  trust ${text(item.trust)}${surface === "plugins" ? `  kind ${text(item.kind)}` : ""}  content ${item.contentDigest?.slice(0, 12) ?? "(unpinned)"}  envelope ${item.envelopeDigest?.slice(0, 12) ?? "(none)"}`,
	);
	// A disabled record can still shadow a user copy of its id, so approval covers it too.
	return `Project ${surface} to approve. Approval covers every package listed, the disabled ones included:\n${lines.join("\n")}\n`;
}

/** Review is read-only. Approval names the digest the operator reviewed, so edits cannot borrow stale consent. */
export function runConfigTrustCommand(args: ReadonlyArray<string>, cwd = process.cwd()): number {
	const surface = args[0] as ProjectTrustSurface | undefined;
	if (surface === undefined || !SURFACES.includes(surface)) {
		printError(
			"usage: clio-coder config trust safety|hooks|settings|extensions|plugins [--json | --hash SHA256 | --revoke]",
		);
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
			if (surface === "safety") {
				const failure = forgetApprovedFlowPolicy(realpathSync(cwd));
				if (failure !== null) throw new Error(failure);
			}
			process.stdout.write(
				`Project ${surface} trust revoked. ${PACKAGE_RELOAD[surface] ?? "Restart to reload settings and safety; project hooks stop before their next execution."}\n`,
			);
			return 0;
		}
		const snapshot = captureProjectSurface(cwd, surface);
		if (preview) {
			const packages = projectPackageEntries(snapshot);
			const json = rest[0] === "--json";
			// JSON escapes terminal control sequences in repository-controlled text.
			if (json || packages === null)
				process.stdout.write(`${JSON.stringify(packages === null ? snapshot : { ...snapshot, packages }, null, 2)}\n`);
			else process.stdout.write(packageLines(surface, packages));
			if (!json && snapshot.contentHash !== null && snapshot.files.some((file) => file.text !== null)) {
				process.stdout.write(
					packages !== null
						? `Review the packages above. Approve these package identities with:\nclio-coder config trust ${surface} --hash ${snapshot.contentHash}\n`
						: surface === "extensions" || surface === "plugins"
							? `Project ${surface} install state cannot be parsed, so it cannot be approved.\n`
							: `Review the captured files above. Approve exactly these bytes with:\nclio-coder config trust ${surface} --hash ${snapshot.contentHash}\n`,
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
		if (surface === "extensions" || surface === "plugins") recordProjectPackageTrust(snapshot);
		else recordProjectSurfaceTrust(snapshot.workspaceRoot, surface, snapshot.contentHash);
		process.stdout.write(
			`Project ${surface} approved for ${snapshot.workspaceRoot} at ${snapshot.contentHash}. ${PACKAGE_RELOAD[surface] ?? "Restart to reload settings and safety; reload extensions to register newly approved hooks."}\n`,
		);
		return 0;
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
