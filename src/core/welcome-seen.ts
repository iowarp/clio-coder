/**
 * Whether a project has had its first launchpad. First boot per project shows the full wordmark at every tier; every
 * later launch picks its brand form by fit. The launchpad paints at Stage 0, so this module stays a leaf: one
 * `existsSync` to answer, one empty marker file to record, and nothing else.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "./safe-resource-write.js";
import { resolveClioDirs } from "./xdg.js";

function markerPath(root: string): string {
	return join(resolveClioDirs().state, "welcome", "seen", createHash("sha256").update(root).digest("hex"));
}

/**
 * The first answer per root holds for the process, so the boot frame and the hydrated launchpad agree on the form
 * even after the marker is written between them. An unreadable state root counts as seen: a misread then costs the
 * big wordmark, never a repeat of it.
 */
const answers = new Map<string, boolean>();

export function projectSeen(root: string): boolean {
	const known = answers.get(root);
	if (known !== undefined) return known;
	let seen = true;
	try {
		seen = existsSync(markerPath(root));
	} catch {
		seen = true;
	}
	answers.set(root, seen);
	return seen;
}

/** Records the first launchpad for `root`. A failed write only means the wordmark shows once more. */
export function markProjectSeen(root: string): void {
	try {
		const path = markerPath(root);
		if (!existsSync(path)) safeResourceWrite(path, "");
	} catch {
		// See the doc comment: the marker is a courtesy, never a reason to disturb the session.
	}
}
