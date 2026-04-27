import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Resolve the current git branch name for `cwd` (default: process.cwd()).
 * Wraps `git rev-parse --abbrev-ref HEAD` with a 1s timeout and a defensive
 * null fallback for non-repos, missing git on PATH, missing paths, and
 * timeouts. Returns the trimmed branch name on success, or null on any
 * failure mode.
 */
export async function getCurrentBranch(cwd?: string): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd,
			timeout: 1000,
		});
		const branch = stdout.trim();
		return branch.length > 0 ? branch : null;
	} catch {
		return null;
	}
}
