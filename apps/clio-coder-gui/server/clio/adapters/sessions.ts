import { existsSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { clioStateDir } from "../../../../../src/core/xdg.js";
import { endAbandonedSession, listSessionWorkspaces } from "../../../../../src/domains/session/history.js";
import { AppProblem } from "../../services/problem.js";

/** Fails closed when session storage links outside the state directory; false when there is no ledger yet. */
function preflightLedger() {
	const state = clioStateDir(),
		directory = join(state, "sessions");
	if (!existsSync(directory)) return false;
	const root = realpathSync(state);
	const inspect = (path: string, depth: number) => {
		const resolved = realpathSync(path),
			part = relative(root, resolved);
		if (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part))
			throw new AppProblem("validation", "Session storage escapes its state directory.");
		if (depth > 0)
			for (const child of readdirSync(path, { withFileTypes: true })) {
				const target = join(path, child.name);
				if (child.isDirectory()) inspect(target, depth - 1);
				else {
					const file = realpathSync(target),
						diff = relative(root, file);
					if (diff === ".." || diff.startsWith(`..${sep}`) || isAbsolute(diff))
						throw new AppProblem("validation", "Session storage escapes its state directory.");
				}
			}
	};
	// The domain owns cwd hashing; preflight its session tree without copying that identity algorithm.
	inspect(directory, 3);
	return true;
}
/** Every project the ledger knows, so the app shows the terminal's projects without a list of its own. */
export function sessionWorkspaces() {
	return preflightLedger() ? listSessionWorkspaces() : [];
}
/** Ends a session ledger record the caller has proven abandoned; the ops worker is its only caller. */
export function recoverSession(cwd: string, sessionId: string) {
	return preflightLedger() ? endAbandonedSession(cwd, sessionId) : false;
}
