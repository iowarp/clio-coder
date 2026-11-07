import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { INTERNAL_GIT_BASE_OPTIONS, internalGitArgv } from "../../core/internal-git.js";
import { runCommandVector } from "../../core/safe-exec.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { shellQuote } from "../../core/shell-quote.js";
import { buildSshArgs, type SshNodeEndpoint } from "./transport.js";

export interface FleetProjectVerification {
	kind: "shared" | "independent" | "unverified";
	head: string | null;
	reason: string | null;
}

function remoteGit(args: ReadonlyArray<string>): string {
	return ["git", ...INTERNAL_GIT_BASE_OPTIONS, "-c", "status.submoduleSummary=false", ...args].map(shellQuote).join(" ");
}

// Unlike fsmonitor, configured clean/process filters cannot be neutralized by
// the shared fixed flags. Inspect the remote effective config, not our own.
const REMOTE_FILTER_CHECK = [
	`${remoteGit(["config", "--get-regexp", "^filter\\..*\\.(clean|process)$"])} >/dev/null 2>&1`,
	"config_status=$?",
	'[ "$config_status" -eq 1 ] || exit 1',
].join("; ");

/** A transient client-side challenge proves shared files; independent trees require matching clean Git history. */
export async function verifyFleetProject(
	node: SshNodeEndpoint,
	root: string,
	sharedProbe = false,
	readOnly = false,
): Promise<FleetProjectVerification> {
	const local = await runCommandVector("git", internalGitArgv(["-C", root, "rev-parse", "HEAD"]), { timeoutMs: 5000 });
	const head = local.exitCode === 0 ? local.stdout.trim() : null;
	const roots = head
		? await runCommandVector("git", internalGitArgv(["-C", root, "rev-list", "--max-parents=0", "HEAD"]), {
				timeoutMs: 5000,
			})
		: null;
	let status: Awaited<ReturnType<typeof runCommandVector>> | null = null;
	try {
		if (head)
			status = await runCommandVector(
				"git",
				internalGitArgv(["-C", root, "status", "--porcelain", "--untracked-files=all"]),
				{ timeoutMs: 5000 },
			);
	} catch {
		// Clio refused its own status after config drift (InternalGitRefusedError): the tree counts as unverified.
		status = null;
	}
	const token = randomUUID();
	const marker = join(root, `.clio-coder-fleet-probe-${token}`);
	let markerWritten = false;
	try {
		if (sharedProbe && !readOnly) {
			try {
				safeResourceWrite(marker, token, { mode: 0o600 });
				markerWritten = true;
			} catch {
				// A read-only client directory cannot prove shared writes; Git verification is still available.
			}
		}
		const command = [
			`cd ${shellQuote(root)} || exit 1`,
			`if ${remoteGit(["rev-parse", "--git-dir"])} >/dev/null 2>&1; then if ! ( ${REMOTE_FILTER_CHECK} ) || ! ${remoteGit(["submodule", "foreach", "--quiet", "--recursive", REMOTE_FILTER_CHECK])}; then echo refused=executable-config; exit 0; fi; fi`,
			markerWritten
				? `if [ "$(cat ${shellQuote(marker)} 2>/dev/null)" = ${shellQuote(token)} ]; then echo shared=yes; else echo shared=no; fi`
				: "echo shared=no",
			`echo "head=$(${remoteGit(["rev-parse", "HEAD"])} 2>/dev/null)" && echo "roots=$(${remoteGit(["rev-list", "--max-parents=0", "HEAD"])} 2>/dev/null | sort | tr '\\n' ',')" && if status=$(${remoteGit(["status", "--porcelain", "--untracked-files=all"])} 2>/dev/null) && [ -z "$status" ] && ${remoteGit(["rev-parse", "--git-dir"])} >/dev/null 2>&1; then echo clean=yes; else echo clean=no; fi`,
		].join("; ");
		const remote = await runCommandVector("ssh", buildSshArgs(node, command), {
			timeoutMs: 15_000,
			maxOutputBytes: 64_000,
		});
		const lines = remote.stdout.split("\n").map((line) => line.trim());
		if (lines.includes("refused=executable-config")) {
			return {
				kind: "unverified",
				head,
				reason: "remote Git verification refused executable filter configuration or could not verify it",
			};
		}
		if (remote.exitCode === 0 && markerWritten && lines.includes("shared=yes"))
			return { kind: "shared", head, reason: null };
		const identity = `${roots?.stdout.trim().split("\n").sort().join(",")},`;
		if (
			head &&
			roots?.exitCode === 0 &&
			status?.exitCode === 0 &&
			status.stdout.trim() === "" &&
			remote.exitCode === 0 &&
			lines.includes(`head=${head}`) &&
			lines.includes(`roots=${identity}`) &&
			lines.includes("clean=yes")
		) {
			return {
				kind: "independent",
				head,
				reason: "matching clean checkout; mutations require an isolated task worktree and SSH return",
			};
		}
		return {
			kind: "unverified",
			head,
			reason:
				"project files are not verified: use shared storage, or the same repository and commit with clean trees at this absolute path; record a check to verify shared storage",
		};
	} finally {
		if (markerWritten) rmSync(marker, { force: true });
	}
}

export function assertFleetProjectAuthority(
	project: FleetProjectVerification,
	readOnly: boolean,
	isolatedWorktree = false,
): void {
	if (project.kind === "unverified") throw new Error(`dispatch: admission denied: ${project.reason}`);
	if (project.kind === "independent" && !readOnly && !isolatedWorktree)
		throw new Error(
			"dispatch: admission denied: this node has an independent checkout; mutating workers require worktree: true for verified SSH change return. Use an isolated task worktree, a read-only worker or node 'local'.",
		);
}
