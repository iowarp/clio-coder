import { runningBuildIsStale } from "../core/running-build.js";

/**
 * Checks at a turn boundary whether the build this session loaded was
 * replaced on disk and tells the operator once. No timer: the check runs
 * only when called.
 */
export function createStaleBuildNotice(
	notify: (level: "warning", text: string, key: string) => void,
	check: () => { stale: boolean } = () => runningBuildIsStale(),
): () => void {
	let told = false;
	return () => {
		if (told || !check().stale) return;
		told = true;
		notify(
			"warning",
			"The build this session runs was replaced on disk. Loaded code is unchanged, features not yet loaded may fail, and /restart resumes this session on the new build.",
			"build:stale",
		);
	};
}
