import { scanShellLike } from "./protected-artifacts.js";

/** Review round 2 G: add canonical git scans without removing original conservative candidates. */
export function normalizedGitCommands(command: string): string[] {
	const candidates: string[] = [];
	let words: string[] = [];
	const flush = (): void => {
		if (words[0] === "git") {
			let index = 1;
			while (index < words.length) {
				const word = words[index] ?? "";
				if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(word)) {
					index += 2;
					continue;
				}
				if (
					/^--(?:git-dir|work-tree|namespace|config-env|exec-path)=/u.test(word) ||
					[
						"--no-pager",
						"--paginate",
						"-p",
						"-P",
						"--bare",
						"--no-replace-objects",
						"--literal-pathspecs",
						"--glob-pathspecs",
						"--noglob-pathspecs",
						"--icase-pathspecs",
						"--no-optional-locks",
					].includes(word)
				) {
					index++;
					continue;
				}
				break;
			}
			if (["clean", "reset", "push", "checkout", "restore", "branch", "stash", "reflog", "gc", "filter-branch"].includes(words[index] ?? "")) candidates.push(["git", ...words.slice(index)].join(" "));
		}
		words = [];
	};
	for (const token of scanShellLike(command.replace(/\\\r?\n/gu, ""))) {
		if (token.operator) flush();
		else words.push(token.value);
	}
	flush();
	return candidates;
}
