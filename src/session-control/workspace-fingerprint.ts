import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { internalGitArgv } from "../core/internal-git.js";
import type { WorkspaceFingerprint } from "../domains/turn-control/index.js";

const exec = promisify(execFile);

/** Clio's own status, or null when it fails or Clio refused it after config drift. */
function gitStatus(cwd: string) {
	try {
		return exec("git", internalGitArgv(["status", "--porcelain=v1", "-z"], cwd), {
			cwd,
			timeout: 2000,
			encoding: "buffer",
		}).catch(() => null);
	} catch {
		return Promise.resolve(null);
	}
}

export async function workspaceFingerprint(cwd: string): Promise<WorkspaceFingerprint> {
	const [head, status, codemap] = await Promise.all([
		exec("git", internalGitArgv(["rev-parse", "HEAD"], cwd), { cwd, timeout: 2000 }).catch(() => null),
		gitStatus(cwd),
		readFile(join(cwd, ".clio-coder", "codemap.json")).catch(() => null),
	]);
	return {
		cwd,
		gitHead: head?.stdout.trim() ?? null,
		dirtyTreeHash:
			status === null || status.stdout.length > 0 ? null : createHash("sha256").update(status.stdout).digest("hex"),
		codemapHash: codemap === null ? null : createHash("sha256").update(codemap).digest("hex"),
	};
}
