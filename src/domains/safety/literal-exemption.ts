import { isGitExecutable } from "./git-command-normalization.js";
import { scanShellLike } from "./protected-artifacts.js";

const EXECUTORS = new Set(
	"sh bash zsh dash ksh mksh fish busybox env command builtin sudo doas su ssh xargs find timeout nohup nice exec watch script trap source . python python3 node perl ruby php psql mysql sqlite3 eval".split(
		" ",
	),
);

/** Only proven inert spans can be exempted; executable quoted content still needs conservative scans. */
export function inertQuotedMatch(command: string, pattern: RegExp, ruleId = ""): boolean {
	if (ruleId.startsWith("sql-") || /\beval\b|\||<<|\$'|\$\(|`/iu.test(command)) return false;
	const tokens = scanShellLike(command);
	if (tokens.some((token) => EXECUTORS.has(token.value))) return false;
	const ranges: Array<[number, number]> = [];
	let words: typeof tokens = [];
	const flush = (): void => {
		const program = words[0]?.value;
		for (let i = 1; i < words.length; i++) {
			const token = words[i];
			if (!token?.quoted) continue;
			const raw = command.slice(token.start, token.end);
			if (!((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) continue;
			const previous = words[i - 1]?.value;
			const allowed =
				program === "echo" ||
				program === "printf" ||
				// A path-spelled Git runs the same program, and F2 made the Git scans see it.
				(isGitExecutable(program ?? "") &&
					["commit", "tag"].includes(words[1]?.value ?? "") &&
					["-m", "--message"].includes(previous ?? "")) ||
				(["grep", "rg"].includes(program ?? "") && (i === 1 || previous === "-e" || previous === "--regexp"));
			if (allowed) ranges.push([token.start + 1, token.end - 1]);
		}
		words = [];
	};
	for (const token of tokens) {
		if (token.operator) flush();
		else words.push(token);
	}
	flush();
	const matcher = new RegExp(pattern.source, `${pattern.flags.replace(/[gy]/gu, "")}g`);
	const matches = [...command.matchAll(matcher)];
	return (
		matches.length > 0 &&
		matches.every(
			(match) =>
				!/[|>;]/u.test(match[0]) &&
				ranges.some(([start, end]) => match.index >= start && match.index + match[0].length <= end),
		)
	);
}
