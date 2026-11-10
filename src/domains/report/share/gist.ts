import { rmSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { type ReportCommandRunner, runReportCommand } from "../command.js";
import { reportsDirectory } from "../store.js";
import { ghEnvironment, REPORT_GH_TIMEOUT_MS } from "../transport.js";
import { expiredShares, readShareReceipts, updateShareReceipt } from "./receipts.js";
import { type SealedShare, type SealOptions, SHARE_PLAIN_FORMAT, type ShareKind, sealShare } from "./seal.js";

/**
 * A sealed share travels as one secret gist in the sender's own GitHub account, through their own `gh`, pinned to
 * github.com. The sender can delete it at any time; deleting it is how a share is forgotten.
 */
export const GIST_ID = /^[0-9a-f]{20,40}$/u;
const SCOPE_HINT = "if gh lacks the gist scope, run: gh auth refresh -s gist";

export interface GistDeps {
	gh: string;
	run?: ReportCommandRunner;
	env?: NodeJS.ProcessEnv;
}

export function shareGistFile(shareId: string): string {
	return `clio-share-${shareId}.json`;
}

function options(deps: GistDeps) {
	return { timeoutMs: REPORT_GH_TIMEOUT_MS, env: ghEnvironment(deps.env ?? process.env) };
}

function firstLine(stdout: string, stderr: string, timedOut: boolean): string {
	if (timedOut) return "timed out";
	return (stderr.trim() || stdout.trim()).split("\n")[0] ?? "";
}

/** Create the secret gist; returns its id or the reason it failed. */
async function createShareGist(
	stateDir: string,
	envelope: SealedShare,
	deps: GistDeps,
): Promise<{ gistId: string } | { failed: string }> {
	const request = {
		description: `Clio Coder encrypted share ${envelope.shareId}`,
		public: false,
		files: { [shareGistFile(envelope.shareId)]: { content: `${JSON.stringify(envelope, null, 2)}\n` } },
	};
	// The request names only ciphertext, but it is still written owner-only and removed straight after.
	const path = join(reportsDirectory(stateDir), `${envelope.shareId}.gist.json`);
	safeResourceWrite(path, JSON.stringify(request), { mode: 0o600 });
	try {
		const result = await (deps.run ?? runReportCommand)(
			deps.gh,
			["api", "--hostname", "github.com", "-X", "POST", "gists", "--input", path, "--jq", ".id"],
			options(deps),
		);
		const gistId = result.stdout.trim();
		if (result.exitCode === 0 && GIST_ID.test(gistId)) return { gistId };
		return {
			failed: `gh could not create the gist: ${firstLine(result.stdout, result.stderr, result.timedOut)} (${SCOPE_HINT})`,
		};
	} finally {
		rmSync(path, { force: true });
	}
}

/** Delete a share gist. A gist already gone counts as deleted. */
export async function deleteShareGist(gistId: string, deps: GistDeps): Promise<{ deleted: true } | { failed: string }> {
	if (!GIST_ID.test(gistId)) return { failed: `not a gist id: ${gistId}` };
	const result = await (deps.run ?? runReportCommand)(
		deps.gh,
		["api", "--hostname", "github.com", "-X", "DELETE", `gists/${gistId}`],
		options(deps),
	);
	if (result.exitCode === 0 || /HTTP 404/u.test(result.stderr)) return { deleted: true };
	return { failed: `gh could not delete gist ${gistId}: ${firstLine(result.stdout, result.stderr, result.timedOut)}` };
}

/** The envelope text a share gist holds; null when the gist or its file is gone. */
export async function readShareGist(gistId: string, shareId: string, deps: GistDeps): Promise<string | null> {
	if (!GIST_ID.test(gistId)) throw new Error(`not a gist id: ${gistId}`);
	const result = await (deps.run ?? runReportCommand)(
		deps.gh,
		[
			"api",
			"--hostname",
			"github.com",
			`gists/${gistId}`,
			"--jq",
			`.files["${shareGistFile(shareId)}"].content // empty`,
		],
		{ ...options(deps), timeoutMs: 120_000 },
	);
	if (result.exitCode !== 0) {
		if (/HTTP 404/u.test(result.stderr)) return null;
		throw new Error(`gh could not read gist ${gistId}: ${firstLine(result.stdout, result.stderr, result.timedOut)}`);
	}
	return result.stdout.trim() === "" ? null : result.stdout;
}

export interface ShareUpload {
	kind: ShareKind;
	shareId: string;
	clio: string;
	consent: ReadonlyArray<"debug" | "dataset">;
	digest: unknown;
	archiveFormat: string;
	archive: Buffer;
	now?: Date;
	seal?: SealOptions;
}

/** Seal a share to the maintainers and upload it as a secret gist. Nothing but the envelope leaves the machine. */
export async function uploadShare(
	stateDir: string,
	upload: ShareUpload,
	deps: GistDeps,
): Promise<{ gistId: string } | { failed: string }> {
	const envelope = sealShare(
		{
			format: SHARE_PLAIN_FORMAT,
			v: 1,
			kind: upload.kind,
			shareId: upload.shareId,
			day: (upload.now ?? new Date()).toISOString().slice(0, 10),
			clio: upload.clio,
			consent: [...upload.consent],
			digest: upload.digest,
			archiveFormat: upload.archiveFormat,
			archive: upload.archive.toString("base64"),
		},
		upload.seal,
	);
	return createShareGist(stateDir, envelope, deps);
}

/**
 * Delete the gists of this machine's shares sent more than 180 days ago; every `report` and `telemetry share` run calls
 * it, never startup, as the consent text says. Best effort and quiet: it asks `gh` nothing when no share has expired, and a gist that cannot be deleted now is tried next time.
 */
export async function sweepShareGists(
	stateDir: string,
	deps: { findGh: () => string | null; run?: ReportCommandRunner; env?: NodeJS.ProcessEnv; now?: Date },
): Promise<number> {
	let expired: string[];
	try {
		expired = expiredShares(stateDir, deps.now);
	} catch {
		return 0;
	}
	if (expired.length === 0) return 0;
	const gh = deps.findGh();
	if (gh === null) return 0;
	const receipts = readShareReceipts(stateDir);
	let deleted = 0;
	for (const shareId of expired) {
		const gistId = receipts[shareId]?.gistId;
		if (gistId === undefined) continue;
		const result = await deleteShareGist(gistId, {
			gh,
			...(deps.run !== undefined ? { run: deps.run } : {}),
			...(deps.env !== undefined ? { env: deps.env } : {}),
		});
		if ("deleted" in result) {
			updateShareReceipt(stateDir, shareId, { deletedAt: (deps.now ?? new Date()).toISOString() });
			deleted += 1;
		}
	}
	return deleted;
}
