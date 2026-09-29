import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WorkspaceFingerprint } from "../domains/turn-control/index.js";

const exec = promisify(execFile);

export async function workspaceFingerprint(cwd: string): Promise<WorkspaceFingerprint> {
	const [head, status, codemap] = await Promise.all([
		exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 2000 }).catch(() => null),
		exec("git", ["status", "--porcelain=v1", "-z"], { cwd, timeout: 2000, encoding: "buffer" }).catch(() => null),
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
