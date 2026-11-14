import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { claimRecordId } from "./capture.js";
import { claimLogRecordId } from "./edges.js";
import { appendImports, inferredFlag, readClaims } from "./store.js";
import {
	CLAIM_KINDS,
	CLAIM_RECORD_VERSION,
	CLAIMS_EXPORT_SCHEMA,
	type ClaimImportRecord,
	type ClaimOrigin,
	type ClaimRecord,
	type ClaimsExportBundle,
} from "./types.js";

/**
 * Explicit, operator-run sharing of claims between projects (#406). A claim is invisible outside its project key; an
 * export carries a project's own grounded claims with an origin that names no local path, and an import records them
 * in another project as `inferred` leads that never ground anything there.
 */

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function git(cwd: string, args: ReadonlyArray<string>): string | null {
	try {
		const out = execFileSync("git", [...args], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5_000,
		}).trim();
		return out.length > 0 ? out : null;
	} catch {
		return null;
	}
}

/** A remote URL without credentials: userinfo (`user:token@`) never leaves the machine in an export. */
function publicRemote(url: string): string {
	try {
		const parsed = new URL(url);
		parsed.username = "";
		parsed.password = "";
		return parsed.toString();
	} catch {
		// scp-like `git@host:owner/repo`: the user part names an account, not a secret, but is dropped all the same.
		return url.replace(/^[^@/]+@/u, "");
	}
}

/** Where a project's exports come from: the digest of its key, its first root commit and its `origin` remote. */
function claimsOrigin(project: string): ClaimOrigin {
	const root = git(project, ["rev-list", "--max-parents=0", "HEAD"])?.split("\n")[0]?.trim() ?? null;
	const remote = git(project, ["config", "--get", "remote.origin.url"]);
	return {
		projectDigest: sha256(project),
		rootCommit: root !== null && /^[0-9a-f]{40,64}$/u.test(root) ? root : null,
		...(remote !== null ? { remote: publicRemote(remote) } : {}),
	};
}

/**
 * The bundle `claims export` writes: the project's own grounded claims, flagged ones left out because their text is
 * withheld everywhere, optionally only those of one check.
 */
export function exportClaims(project: string, options: { check?: string; at?: Date } = {}): ClaimsExportBundle {
	const read = readClaims(project);
	const claims = read.records.filter(
		(claim) =>
			claim.project === project &&
			claim.flagged === undefined &&
			(options.check === undefined || claim.keys.check === options.check),
	);
	return {
		schema: CLAIMS_EXPORT_SCHEMA,
		origin: claimsOrigin(project),
		exportedAt: (options.at ?? new Date()).toISOString(),
		claims,
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A record shaped like a claim whose id still matches its content: what the origin's ledger wrote, unedited. */
function intactClaim(value: unknown): value is ClaimRecord {
	if (!isObject(value)) return false;
	if (
		value.v !== CLAIM_RECORD_VERSION ||
		value.type !== "claim" ||
		value.evidence !== "grounded" ||
		typeof value.id !== "string" ||
		typeof value.text !== "string" ||
		typeof value.project !== "string" ||
		!CLAIM_KINDS.some((kind) => kind === value.kind) ||
		(value.verdict !== "agrees" && value.verdict !== "disagrees") ||
		!isObject(value.keys) ||
		typeof value.keys.check !== "string" ||
		!isObject(value.conditions) ||
		!isObject(value.source)
	)
		return false;
	return claimRecordId(value as unknown as ClaimRecord) === value.id;
}

export interface ClaimsImportResult {
	imported: number;
	/** Already imported here earlier. */
	repeated: number;
	/** Not an intact claim record: edited after export, or not a claim at all. */
	rejected: number;
	/** Imported, with text that trips the instruction-marker screen, so it is withheld wherever it is shown. */
	flagged: number;
}

/**
 * Record an export bundle's claims in `project` as `inferred` imports. Refused outright for a bundle that is not an
 * export, or that came from this very project. Each claim is kept verbatim with its origin; its text is screened
 * again here, since the origin's own flag is not trusted.
 */
export async function importClaims(
	project: string,
	bundle: unknown,
	now: Date = new Date(),
): Promise<ClaimsImportResult> {
	if (!isObject(bundle) || bundle.schema !== CLAIMS_EXPORT_SCHEMA || !Array.isArray(bundle.claims))
		throw new Error(`not a claims export (schema ${CLAIMS_EXPORT_SCHEMA})`);
	const origin = bundle.origin;
	if (
		!isObject(origin) ||
		typeof origin.projectDigest !== "string" ||
		!(origin.rootCommit === null || typeof origin.rootCommit === "string") ||
		!(origin.remote === undefined || typeof origin.remote === "string")
	)
		throw new Error("the export names no valid origin");
	if (origin.projectDigest === sha256(project))
		throw new Error("this export came from this project; its claims are already here, grounded");
	const from: ClaimOrigin = {
		projectDigest: origin.projectDigest,
		rootCommit: origin.rootCommit as string | null,
		...(typeof origin.remote === "string" ? { remote: origin.remote } : {}),
	};
	const result: ClaimsImportResult = { imported: 0, repeated: 0, rejected: 0, flagged: 0 };
	const records: ClaimImportRecord[] = [];
	for (const claim of bundle.claims) {
		if (!intactClaim(claim)) {
			result.rejected += 1;
			continue;
		}
		const flag = inferredFlag(claim.text, claim.keys.check, ...(claim.keys.paths ?? []));
		const body: Omit<ClaimImportRecord, "id"> = {
			v: CLAIM_RECORD_VERSION,
			type: "import",
			at: now.toISOString(),
			project,
			origin: from,
			claim,
			evidence: "inferred",
			...flag,
		};
		records.push({ ...body, id: claimLogRecordId(body) });
		if (flag.flagged !== undefined) result.flagged += 1;
	}
	const written = await appendImports(project, records);
	result.imported = written;
	result.repeated = records.length - written;
	if (result.flagged > written) result.flagged = written;
	return result;
}

/** How an imported claim is named wherever it is shown: its origin and commit, and that it was not verified here. */
export function importOriginLabel(record: ClaimImportRecord): string {
	const where =
		record.origin.remote ??
		(record.origin.rootCommit !== null
			? `root ${record.origin.rootCommit.slice(0, 12)}`
			: `project ${record.origin.projectDigest.slice(0, 12)}`);
	const commit = record.claim.conditions.commit;
	return `imported from ${where}${commit === null ? "" : `@${commit.slice(0, 12)}`}, inferred, not verified here`;
}
