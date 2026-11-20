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
import { parseCommandFlags } from "./kit/flags.js";
import { writeCliFailure } from "./kit/json-out.js";
import type { ErrorSlug } from "./kit/slugs.js";

const TRUST_PATH = ["config", "trust"] as const;

function fail(slug: ErrorSlug, message: string, json: boolean): void {
	writeCliFailure({ path: TRUST_PATH, slug, message, json });
}

const SURFACES: ReadonlyArray<ProjectTrustSurface> = [
	"safety",
	"hooks",
	"settings",
	"extensions",
	"plugins",
	"handbook",
];

const PACKAGE_RELOAD: Partial<Record<ProjectTrustSurface, string>> = {
	extensions: "Reload extensions (/reload extensions) to apply it.",
	plugins: "Reload the library (/reload library) to apply it.",
	handbook: "Runs from another repository's session receive this handbook in full from their next dispatch.",
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

/**
 * Review is read-only. Approval names the digest the operator reviewed, so edits cannot borrow stale consent.
 * The surface and its one flag may come in either order (I-12).
 */
export function runConfigTrustCommand(args: ReadonlyArray<string>, cwd = process.cwd()): number {
	const parsed = parseCommandFlags(args, {
		json: { kind: "boolean" },
		revoke: { kind: "boolean" },
		hash: { kind: "value" },
	});
	const jsonAsked = args.includes("--json");
	if (!parsed.ok) {
		fail(parsed.slug, parsed.message, jsonAsked);
		return 2;
	}
	const surface = parsed.positional[0] as ProjectTrustSurface | undefined;
	if (surface === undefined || !SURFACES.includes(surface) || parsed.positional.length > 1) {
		fail("usage", `expects one surface: ${SURFACES.join("|")}`, jsonAsked);
		return 2;
	}
	const { json = false, revoke = false, hash } = parsed.flags;
	if ([json, revoke, hash !== undefined].filter(Boolean).length > 1) {
		fail("flag_conflict", "--json, --revoke and --hash are exclusive", jsonAsked);
		return 2;
	}
	if (hash !== undefined && !/^[a-f0-9]{64}$/.test(hash)) {
		fail("usage", "--hash expects the full reviewed SHA-256 digest", false);
		return 2;
	}
	const approve = hash !== undefined;
	const preview = !approve && !revoke;
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
			fail("not_found", `no readable project ${surface} files to approve`, false);
			return 1;
		}
		if (snapshot.contentHash !== hash) {
			fail("io", `project ${surface} changed since review; inspect it again before approving`, false);
			return 1;
		}
		if (surface === "extensions" || surface === "plugins") recordProjectPackageTrust(snapshot);
		else recordProjectSurfaceTrust(snapshot.workspaceRoot, surface, snapshot.contentHash);
		process.stdout.write(
			`Project ${surface} approved for ${snapshot.workspaceRoot} at ${snapshot.contentHash}. ${PACKAGE_RELOAD[surface] ?? "Restart to reload settings and safety; reload extensions to register newly approved hooks."}\n`,
		);
		return 0;
	} catch (error) {
		fail("io", error instanceof Error ? error.message : String(error), json);
		return 1;
	}
}
