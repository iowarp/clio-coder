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

/** `run:` values from CI YAML, both inline and block scalars, one command per line. */
export function ciRunCommands(text: string): string[] {
	const commands: string[] = [];
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const match = /^(\s*)(?:-\s+)?(?:run|script):\s*(.*)$/.exec(lines[index] ?? "");
		if (!match) continue;
		const indent = (match[1] ?? "").length;
		const value = (match[2] ?? "").trim();
		if (value.length > 0 && !/^[|>][-+]?$/.test(value)) {
			commands.push(value.replace(/^["']|["']$/g, ""));
			continue;
		}
		for (let next = index + 1; next < lines.length; next += 1) {
			const line = lines[next] ?? "";
			if (line.trim().length === 0) continue;
			if (line.length - line.trimStart().length <= indent) break;
			const command = line.trim().replace(/^-\s+/, "");
			if (command.length > 0 && !command.startsWith("#")) commands.push(command);
			index = next;
		}
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
