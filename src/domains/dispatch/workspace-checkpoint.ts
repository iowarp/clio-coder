import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSafeToolEnv } from "../../core/safe-exec.js";

/** Stable recovery namespace; labels never enter Git's ref grammar unchecked. */
export function workspaceCheckpointRef(kind: "loop" | "compete", identity: string): string {
	return `refs/clio-coder/${kind}/${createHash("sha256").update(identity).digest("hex")}`;
}

/** Capture tracked and nonignored untracked state without modifying HEAD or the user's index.
 * The immutable ref makes retries idempotent and keeps the object alive across GC. */
export function captureWorkspaceCheckpoint(cwd: string, ref: string, message: string): string {
	if (!/^refs\/clio-coder\/(loop|compete)\/[a-f0-9]{64}$/.test(ref)) throw new Error("invalid workspace checkpoint ref");
	const directory = mkdtempSync(join(tmpdir(), "clio-coder-checkpoint-index-"));
	const env = buildSafeToolEnv({
		GIT_INDEX_FILE: join(directory, "index"),
		GIT_AUTHOR_NAME: "Clio checkpoint",
		GIT_AUTHOR_EMAIL: "checkpoint@clio.invalid",
		GIT_COMMITTER_NAME: "Clio checkpoint",
		GIT_COMMITTER_EMAIL: "checkpoint@clio.invalid",
	});
	const config = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
	const git = (args: string[]) =>
		execFileSync("git", ["-C", cwd, ...config, ...args], {
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30000,
			maxBuffer: 1024 * 1024,
		}).trim();
	try {
		try {
			git(["rev-parse", "--verify", ref]);
			return ref;
		} catch {
			/* First capture owns this immutable reference. */
		}
		const head = git(["rev-parse", "HEAD"]);
		// Automatic preservation must not run repository-configured filter commands.
		// Names stay argv values; Git's ordinary text normalization still applies.
		const filterKeys = git(["config", "--null", "--name-only", "--list"])
			.split("\0")
			.filter((key) => /^filter\..*\.(?:clean|process|required)$/.test(key));
		for (const key of filterKeys) config.push("-c", `${key}=${key.endsWith(".required") ? "false" : ""}`);
		git(["read-tree", head]);
		git(["add", "-A", "--", "."]);
		const tree = git(["write-tree"]);
		const commit = git(["commit-tree", tree, "-p", head, "-m", message]);
		git(["update-ref", ref, commit, ""]);
		return ref;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}
