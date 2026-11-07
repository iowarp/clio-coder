/**
 * The commands a repository's CI runs, read from its pipeline files without a
 * YAML parser. The context bootstrap lists each workflow's steps as evidence of
 * what it runs and when, and the verify tool offers the repository scripts among
 * them as checks, so both read CI the same way.
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

function readCiFile(root: string, relative: string): string | null {
	try {
		const full = join(root, relative);
		if (statSync(full).size > MAX_CI_FILE_BYTES) return null;
		return readFileSync(full, "utf8");
	} catch {
		// An unreadable pipeline file contributes no commands.
		return null;
	}
}

/** Every CI run command under `root`, in file order and without duplicates. */
export function readCiRunCommands(root: string, files: ReadonlyArray<string> = ciFilesAt(root)): string[] {
	const commands: string[] = [];
	for (const relative of files) {
		const text = readCiFile(root, relative);
		if (text === null) continue;
		for (const command of ciRunCommands(text)) if (!commands.includes(command)) commands.push(command);
	}
	return commands;
}

export interface WorkflowTrigger {
	event: string;
	/** A `push` filtered to tags with no branch filter: it runs on a tag, never on a branch push. */
	tagsOnly: boolean;
}

/** The text of a flow collection's top-level entries, split on commas outside nested brackets and quotes. */
function flowEntries(inner: string): string[] {
	const entries: string[] = [];
	let depth = 0;
	let quote: string | null = null;
	let from = 0;
	for (let index = 0; index < inner.length; index++) {
		const char = inner[index] ?? "";
		if (quote) {
			if (char === quote) quote = null;
		} else if (char === '"' || char === "'") quote = char;
		else if (char === "[" || char === "{") depth++;
		else if (char === "]" || char === "}") depth--;
		else if (char === "," && depth === 0) {
			entries.push(inner.slice(from, index));
			from = index + 1;
		}
	}
	entries.push(inner.slice(from));
	return entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

const unquote = (value: string): string => value.trim().replace(/^(["'])(.*)\1$/, "$2");

function trigger(event: string, body: string): WorkflowTrigger {
	const tagsOnly =
		event === "push" &&
		/(?:^|[\s{,])tags(?:-ignore)?\s*:/.test(body) &&
		!/(?:^|[\s{,])branches(?:-ignore)?\s*:/.test(body);
	return { event, tagsOnly };
}

/** Triggers from a flow value: `push`, `[push, pull_request]` or `{ push: { tags: [v*] } }`. */
function flowTriggers(value: string): WorkflowTrigger[] {
	const inner = /^[[{](.*)[\]}]$/s.exec(value)?.[1];
	if (inner === undefined) return [trigger(unquote(value), "")];
	return flowEntries(inner).map((entry) => {
		const colon = /^(["']?[\w-]+["']?)\s*:(.*)$/s.exec(entry);
		return colon ? trigger(unquote(colon[1] ?? ""), colon[2] ?? "") : trigger(unquote(entry), "");
	});
}

/**
 * A GitHub workflow's triggers from its top-level `on:` key, read without a
 * YAML parser, or null when the file declares none this reader understands.
 */
function workflowTriggers(text: string): WorkflowTrigger[] | null {
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((line) => /^["']?on["']?\s*:/.test(line));
	if (start === -1) return null;
	const inline = (lines[start] ?? "")
		.replace(/^["']?on["']?\s*:/, "")
		.replace(/\s+#.*$/, "")
		.trim();
	if (inline.length > 0) {
		const triggers = flowTriggers(inline);
		return triggers.length > 0 ? triggers : null;
	}
	const block: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
		if (!/^\s/.test(line)) break;
		block.push(line);
	}
	const keyIndent = Math.min(...block.map((line) => line.length - line.trimStart().length));
	const triggers: WorkflowTrigger[] = [];
	let current: { event: string; body: string[] } | null = null;
	const flush = (): void => {
		if (current) triggers.push(trigger(current.event, current.body.join("\n")));
		current = null;
	};
	for (const line of block) {
		const indent = line.length - line.trimStart().length;
		const trimmed = line.trim().replace(/\s+#.*$/, "");
		if (indent > keyIndent) {
			current?.body.push(trimmed);
			continue;
		}
		flush();
		const item = /^-\s+(.+)$/.exec(trimmed)?.[1];
		if (item !== undefined) {
			triggers.push(trigger(unquote(item), ""));
			continue;
		}
		const key = /^(["']?[\w-]+["']?)\s*:(.*)$/.exec(trimmed);
		if (key) current = { event: unquote(key[1] ?? ""), body: [key[2] ?? ""] };
	}
	flush();
	return triggers.length > 0 ? triggers : null;
}

/**
 * A workflow that runs only to publish: every trigger is a release or a tag
 * push, apart from a manual dispatch. Its steps say nothing about a change.
 */
export function isReleaseOnlyWorkflow(triggers: ReadonlyArray<WorkflowTrigger> | null): boolean {
	if (triggers === null) return false;
	const automatic = triggers.filter((entry) => entry.event !== "workflow_dispatch");
	return automatic.length > 0 && automatic.every((entry) => entry.event === "release" || entry.tagsOnly);
}

export interface CiFileRuns {
	/** Repository-relative pipeline file. */
	file: string;
	/** The file's run commands, in order and without duplicates. */
	commands: string[];
	/** The events that start a GitHub workflow, or null when the file declares none this reader understands. */
	triggers: WorkflowTrigger[] | null;
}

/** Each CI pipeline file under `root` with its run commands and, for a GitHub workflow, its triggers. */
export function readCiFileRuns(root: string): CiFileRuns[] {
	const result: CiFileRuns[] = [];
	for (const file of ciFilesAt(root)) {
		const text = readCiFile(root, file);
		if (text === null) continue;
		const commands = [...new Set(ciRunCommands(text))];
		if (commands.length === 0) continue;
		result.push({ file, commands, triggers: file.startsWith(".github/") ? workflowTriggers(text) : null });
	}
	return result;
}
