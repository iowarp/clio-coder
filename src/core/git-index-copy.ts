import { copyFileSync, statSync, utimesSync } from "node:fs";

/**
 * Copy a Git index so the copy judges the work tree as the original does. Git
 * trusts an entry's cached stat only when the entry is older than the index
 * file, and rehashes the rest (racily clean entries). A plain copy has a fresh
 * mtime, so an entry edited in the second the original was written would look
 * safely clean and a same-size edit would be skipped. The copy keeps the
 * original's mtime floored to the second, which errs toward rehashing.
 */
export function copyGitIndex(from: string, to: string): void {
	copyFileSync(from, to);
	const written = Math.floor(statSync(from).mtimeMs / 1000);
	utimesSync(to, written, written);
}
