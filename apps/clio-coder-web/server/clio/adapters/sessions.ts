import { existsSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { clioStateDir } from "../../../../../src/core/xdg.js";
import { listSessionsForCwd } from "../../../../../src/domains/session/history.js";
import { AppProblem } from "../../services/problem.js";
export function sessionHistory(cwd: string) {
	const state = clioStateDir(),
		directory = join(state, "sessions");
	if (!existsSync(directory)) return [];
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
	return listSessionsForCwd(cwd);
}
