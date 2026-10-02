import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { runCommandVector } from "../../core/safe-exec.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { shellQuote } from "../../core/shell-quote.js";
import { buildSshArgs, type SshNodeEndpoint } from "./transport.js";

export interface FleetProjectVerification {
	kind: "shared" | "independent" | "unverified";
	head: string | null;
	reason: string | null;
}

/** A transient client-side challenge proves shared files; independent trees require matching clean Git history. */
export async function verifyFleetProject(
	node: SshNodeEndpoint,
	root: string,
	sharedProbe = false,
): Promise<FleetProjectVerification> {
	const local = await runCommandVector("git", ["-C", root, "rev-parse", "HEAD"], { timeoutMs: 5000 });
	const head = local.exitCode === 0 ? local.stdout.trim() : null;
	const roots = head
		? await runCommandVector("git", ["-C", root, "rev-list", "--max-parents=0", "HEAD"], { timeoutMs: 5000 })
		: null;
	const status = head
		? await runCommandVector("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { timeoutMs: 5000 })
		: null;
	const token = randomUUID();
	const marker = join(root, `.clio-coder-fleet-probe-${token}`);
	let markerWritten = false;
	try {
		if (sharedProbe) {
			try {
				safeResourceWrite(marker, token, { mode: 0o600 });
				markerWritten = true;
			} catch {
				// A read-only client directory cannot prove shared writes; Git verification is still available.
			}
		}
		const command = [
			markerWritten
				? `if [ "$(cat ${shellQuote(marker)} 2>/dev/null)" = ${shellQuote(token)} ]; then echo shared=yes; else echo shared=no; fi`
				: "echo shared=no",
			`cd ${shellQuote(root)} && echo "head=$(git rev-parse HEAD 2>/dev/null)" && echo "roots=$(git rev-list --max-parents=0 HEAD 2>/dev/null | sort | tr '\\n' ',')" && if status=$(git status --porcelain --untracked-files=all 2>/dev/null) && [ -z "$status" ] && git rev-parse --git-dir >/dev/null 2>&1; then echo clean=yes; else echo clean=no; fi`,
		].join("; ");
		const remote = await runCommandVector("ssh", buildSshArgs(node, command), {
			timeoutMs: 15_000,
			maxOutputBytes: 64_000,
		});
		const lines = remote.stdout.split("\n").map((line) => line.trim());
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
			return { kind: "independent", head, reason: "matching clean checkout; remote mutations cannot be returned yet" };
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

export function assertFleetProjectAuthority(project: FleetProjectVerification, readOnly: boolean): void {
	if (project.kind === "unverified") throw new Error(`dispatch: admission denied: ${project.reason}`);
	if (project.kind === "independent" && !readOnly)
		throw new Error(
			"dispatch: admission denied: this node has an independent checkout; mutating workers require verified shared storage until the SSH change return path is supported. Use a read-only worker or node 'local'.",
		);
}
