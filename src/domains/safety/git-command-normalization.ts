import { scanShellLike } from "./protected-artifacts.js";

/**
 * Words a shell runs as a wrapper around the command that follows them, with
 * the options each wrapper reads before that command. A wrapped or path-spelled
 * Git (`/usr/bin/git -C . push --force`, `env git -C . reset --hard`) used to
 * reach ordinary unrecognized execution and was admitted at yolo (F2). The
 * list only adds candidates, so an unrecognized wrapper option can make a scan
 * stricter but never hides a raw match.
 */
const WRAPPER_VALUE_OPTIONS: Readonly<Record<string, ReadonlyArray<string>>> = {
	env: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"],
	command: [],
	exec: ["-a"],
	nice: ["-n", "--adjustment"],
	nohup: [],
	time: ["-f", "--format", "-o", "--output"],
	sudo: [
		"-u",
		"--user",
		"-g",
		"--group",
		"-h",
		"--host",
		"-p",
		"--prompt",
		"-C",
		"--close-from",
		"-D",
		"--chdir",
		"-R",
		"--chroot",
		"-T",
		"--command-timeout",
		"-r",
		"--role",
		"-t",
		"--type",
		"-U",
		"--other-user",
	],
	doas: ["-u", "-C"],
	timeout: ["-s", "--signal", "-k", "--kill-after"],
};

/** Global options Git reads with a separate value word before the subcommand. */
const GIT_VALUE_OPTIONS = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--super-prefix"];

/** Git named bare, by path, or as the Windows executable. */
export function isGitExecutable(word: string): boolean {
	return /^git(?:\.exe)?$/iu.test(word.split(/[\\/]/u).pop() ?? "");
}

/** Index of the command word once shell wrappers and assignments are stripped. */
function commandWordIndex(words: ReadonlyArray<string>): number {
	let index = 0;
	while (index < words.length) {
		const word = words[index] ?? "";
		if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) {
			index++;
			continue;
		}
		const wrapper = word.split("/").pop() ?? "";
		const valueOptions = Object.hasOwn(WRAPPER_VALUE_OPTIONS, wrapper) ? WRAPPER_VALUE_OPTIONS[wrapper] : undefined;
		if (valueOptions === undefined) return index;
		index++;
		while (index < words.length) {
			const option = words[index] ?? "";
			if (option === "--") {
				index++;
				break;
			}
			if (wrapper === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(option)) {
				index++;
				continue;
			}
			// A lone `-` is env's spelling of -i.
			if (wrapper === "env" && option === "-") {
				index++;
				continue;
			}
			if (!option.startsWith("-")) break;
			index += valueOptions.includes(option) ? 2 : 1;
		}
		// timeout names its duration before the command it runs.
		if (wrapper === "timeout") index++;
	}
	return index;
}

/** Canonical Git scans cover alternate spellings while retaining the original conservative candidates. */
export function normalizedGitCommands(command: string): string[] {
	const candidates: string[] = [];
	let words: string[] = [];
	const flush = (): void => {
		const start = commandWordIndex(words);
		if (isGitExecutable(words[start] ?? "")) {
			let index = start + 1;
			while (index < words.length) {
				const word = words[index] ?? "";
				if (GIT_VALUE_OPTIONS.includes(word)) {
					index += 2;
					continue;
				}
				// Every other word Git reads as a global option is one word: `-C.`,
				// `-ck=v`, `--git-dir=.git`, `--no-pager` and options this list has
				// never heard of. Skipping an unknown one can only expose a subcommand.
				if (word.startsWith("-") && word !== "-" && word !== "--") {
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

/** Git parses combined flags and unique long-option prefixes before acting. */
function normalizeGitFlags(words: string[]): string[] {
	const subcommand = words[0] ?? "";
	// Clean and checkout each have one --f... option, so Git accepts its force prefixes.
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
				: subcommand === "clean" || subcommand === "checkout"
					? ["--force"]
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
