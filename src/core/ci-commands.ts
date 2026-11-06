/**
 * The commands a repository's CI runs, read from its pipeline files without a
 * YAML parser. The context bootstrap lists them as what a change must pass, and
 * the verify tool offers the repository scripts among them as checks, so both
 * read CI the same way.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const CI_FILE_RE =
	/^(?:\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.ya?ml|\.circleci\/config\.ya?ml|azure-pipelines\.ya?ml)$/;

const CI_ROOT_FILES = [
	".gitlab-ci.yml",
	".gitlab-ci.yaml",
	".circleci/config.yml",
	".circleci/config.yaml",
	"azure-pipelines.yml",
	"azure-pipelines.yaml",
];
const MAX_CI_FILE_BYTES = 512 * 1024;

/**
 * A shell line that opens, continues or closes a compound command. Inside a
 * block scalar it is script structure, not a command CI runs: Clio's own
 * workflow put `fi` into the handbook's list of CI gates.
 */
const SHELL_STRUCTURE_RE =
	/^(?:if|then|else|elif|fi|case|esac|for|while|until|do|done|select|function)\b|^(?:[{}()]|;;|\[\[|!\s)/;

/** The command a script line runs: a branch or loop condition is one, the keywords around it are not. */
function shellCommand(line: string): string | null {
	const condition = /^(?:if|elif|while|until)\s+(?:!\s+)?([^;]+)/.exec(line)?.[1]?.trim();
	if (condition) return SHELL_STRUCTURE_RE.test(condition) ? null : condition;
	return SHELL_STRUCTURE_RE.test(line) ? null : line;
}

/**
 * `run:` values from CI YAML, both inline and block scalars, one command per
 * line. A block scalar is a shell script: its compound-command keywords are
 * dropped and `\` continuations joined, while the commands inside a branch or
 * loop still count, because CI may run them. An empty `run:` opens a
 * mapping (GitHub's `defaults: run: shell: bash`) unless list items follow, as
 * in GitLab's `script:` sequences.
 */
export function ciRunCommands(text: string): string[] {
	const commands: string[] = [];
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const match = /^(\s*)(?:-\s+)?(?:run|script):\s*(.*)$/.exec(lines[index] ?? "");
		if (!match) continue;
		const indent = (match[1] ?? "").length;
		const value = (match[2] ?? "").trim();
		if (value.length > 0 && !/^[|>][-+]?$/.test(value)) {
			// Unwrap a quoted YAML scalar, never the quotes of a command that merely starts and ends with one.
			const quoted = /^(["'])(.*)\1$/.exec(value);
			commands.push(quoted?.[2] !== undefined && !quoted[2].includes(quoted[1] ?? "") ? quoted[2] : value);
			continue;
		}
		const blockScalar = value.length > 0;
		let pending = "";
		for (let next = index + 1; next < lines.length; next += 1) {
			const line = lines[next] ?? "";
			if (line.trim().length === 0) continue;
			const lineIndent = line.length - line.trimStart().length;
			if (lineIndent <= indent) break;
			index = next;
			const trimmed = line.trim();
			if (!blockScalar) {
				// A mapping under `run:` holds settings; only sequence items are commands.
				if (!trimmed.startsWith("- ")) continue;
				const command = trimmed.slice(2).trim();
				if (command.length > 0 && !command.startsWith("#")) commands.push(command);
				continue;
			}
			if (pending.length > 0) pending = `${pending} ${trimmed}`;
			else if (trimmed.startsWith("#")) continue;
			else pending = trimmed;
			if (pending.endsWith("\\")) {
				pending = pending.slice(0, -1).trimEnd();
				continue;
			}
			const command = shellCommand(pending);
			if (command) commands.push(command);
			pending = "";
		}
		const command = pending.length > 0 ? shellCommand(pending) : null;
		if (command) commands.push(command);
	}
	return commands;
}

/** Repository-relative CI pipeline files under `root`, found by the fixed locations CI services read. */
function ciFilesAt(root: string): string[] {
	const files: string[] = [];
	try {
		for (const name of readdirSync(join(root, ".github", "workflows")).sort()) {
			const relative = `.github/workflows/${name}`;
			if (CI_FILE_RE.test(relative)) files.push(relative);
		}
	} catch {
		// No workflows directory is the common case, not an error.
	}
	for (const relative of CI_ROOT_FILES) {
		try {
			if (statSync(join(root, relative)).isFile()) files.push(relative);
		} catch {
			// Absent pipeline files are skipped.
		}
	}
	return files;
}

/** Every CI run command under `root`, in file order and without duplicates. */
export function readCiRunCommands(root: string, files: ReadonlyArray<string> = ciFilesAt(root)): string[] {
	const commands: string[] = [];
	for (const relative of files) {
		let text: string;
		try {
			const full = join(root, relative);
			if (statSync(full).size > MAX_CI_FILE_BYTES) continue;
			text = readFileSync(full, "utf8");
		} catch {
			// An unreadable pipeline file contributes no commands.
			continue;
		}
		for (const command of ciRunCommands(text)) if (!commands.includes(command)) commands.push(command);
	}
	return commands;
}
