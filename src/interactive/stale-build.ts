import { runningBuildIsStale } from "../core/running-build.js";

/** One footer notice; `ttlMs: 0` pins it until the process ends. */
export type StaleBuildNotify = (notice: { level: "warning"; text: string; key: string; ttlMs?: number }) => void;

/**
 * Checks at a turn boundary whether the build this session loaded was
 * replaced on disk. The first time it says what that means; a short pinned
 * line then stays in the footer, and `/restart` clears it with the process.
 * No timer: the check runs only when called.
 */
export function createStaleBuildNotice(
	notify: StaleBuildNotify,
	check: () => { stale: boolean } = () => runningBuildIsStale(),
): () => void {
	let told = false;
	return () => {
		if (told || !check().stale) return;
		told = true;
		notify({
			level: "warning",
			text:
				"The build this session runs was replaced on disk. Loaded code is unchanged, features not yet loaded may fail, and /restart resumes this session on the new build.",
			key: "build:stale",
		});
		notify({ level: "warning", text: "build replaced · /restart", key: "build:stale:pin", ttlMs: 0 });
	};
}
