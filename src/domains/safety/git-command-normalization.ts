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
			if (
				["clean", "reset", "push", "checkout", "restore", "branch", "stash", "reflog", "gc", "filter-branch"].includes(
					words[index] ?? "",
				)
			)
				candidates.push(["git", ...normalizeGitFlags(words.slice(index))].join(" "));
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

/** Review round 2 G: git parses combined flags and unique long-option prefixes before acting. */
function normalizeGitFlags(words: string[]): string[] {
	const subcommand = words[0] ?? "";
	const options =
		subcommand === "reset"
			? [
					"--soft",
					"--mixed",
					"--hard",
					"--merge",
					"--keep",
					"--recurse-submodules",
					"--no-recurse-submodules",
					"--pathspec-from-file",
					"--pathspec-file-nul",
				]
			: subcommand === "push"
				? ["--force", "--force-with-lease", "--force-if-includes", "--follow-tags", "--delete", "--dry-run"]
				: [];
	let operands = false;
	return words.flatMap((word, index) => {
		if (index === 0 || operands) return [word];
		if (word === "--") {
			operands = true;
			return [word];
		}
		if (/^-[a-zA-Z]{2,}$/u.test(word) && ["clean", "push", "checkout"].includes(subcommand))
			return [...word.slice(1)]
				.sort((left, right) => Number(right === "f" || right === "d") - Number(left === "f" || left === "d"))
				.map((flag) => `-${flag}`);
		const [name, ...value] = word.split("=");
		if (subcommand === "push" && name === "--forc") return ["--force"];
		const matches = options.filter((option) => option.startsWith(name ?? ""));
		if (word.startsWith("--") && matches.length === 1)
			return [`${matches[0]}${value.length > 0 ? `=${value.join("=")}` : ""}`];
		return [word];
	});
}
