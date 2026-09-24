/**
 * What a repository enforces, gathered without a model: the commands CI runs,
 * the package scripts those commands reach, and the custom check files with
 * the checks they define.
 *
 * Generated handbooks paraphrased the contributor guide, which the agent can
 * already read, and missed the rules that decided real changes: each of those
 * rules lived in a custom check that fails only after the change is made. The
 * bootstrap model reads this inventory as its list of rules to explain.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { enumerateWorkspaceFiles } from "../../core/workspace-files.js";

export interface EnforcementCheckFile {
	path: string;
	/** Check functions the file defines, in file order; empty when none are named that way. */
	checks: string[];
	/** Heads of the coded failure messages it emits (`rule6: ...`), with interpolations elided. */
	failures: string[];
}

export interface EnforcementInventory {
	ciCommands: string[];
	/** Package scripts that CI reaches or that lint, check, verify, gate or test. */
	scripts: Record<string, string>;
	checkFiles: EnforcementCheckFile[];
}

const CI_FILE_RE =
	/^(?:\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.ya?ml|\.circleci\/config\.ya?ml|azure-pipelines\.ya?ml)$/;
const HOOK_FILE_RE = /^(?:\.pre-commit-config\.ya?ml|lefthook\.ya?ml|\.husky\/[^/_][^/]*)$/;
const CHECK_NAME_RE = /(?:check|lint|verify|guard|hygiene|drift|gate|validate|boundar|conformance)/i;
const CHECK_DIR_RE = /^(?:scripts|tools|ci|hack|bin|build|\.github\/scripts)\//;
const CHECK_TEST_RE = /^tests?\/(?:[^/]+\/)*(?:boundar|architecture|conventions|lint|hygiene)[^/]*(?:\/|$)/i;
const SCRIPT_NAME_RE = /(?:^|:)(?:lint|check|verify|gate|validate|typecheck|test|ci)(?::|$)/;
const CHECK_FN_RE =
	/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function\s+|def\s+)((?:check|lint|verify|validate|guard)[A-Za-z0-9_]*)\s*\(/g;

/** A failure message that leads with a rule code: `rule6: ...`, `E501: ...`, `D14: ...`. */
const FAILURE_RE = /[`'"]([A-Za-z]{0,12}\d{1,4}[a-z]?): ((?:[^`'"\\]|\\.){8,})/g;
const MAX_FAILURE_CHARS = 160;

const MAX_CI_COMMANDS = 60;
const MAX_CHECK_FILES = 24;
const MAX_CHECKS_PER_FILE = 40;
const MAX_COMMAND_CHARS = 200;
const MAX_CHECK_FILE_BYTES = 512 * 1024;

function readText(root: string, path: string, maxBytes = MAX_CHECK_FILE_BYTES): string | null {
	try {
		const full = join(root, path);
		if (statSync(full).size > maxBytes) return null;
		return readFileSync(full, "utf8");
	} catch {
		return null;
	}
}

/** `run:` values from CI YAML, both inline and block scalars, one command per line. */
function ciRunCommands(text: string): string[] {
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

function packageScripts(root: string): Record<string, string> {
	const text = readText(root, "package.json");
	if (!text) return {};
	try {
		const scripts = (JSON.parse(text) as { scripts?: unknown }).scripts;
		if (!scripts || typeof scripts !== "object") return {};
		return Object.fromEntries(
			Object.entries(scripts as Record<string, unknown>).filter(
				(entry): entry is [string, string] => typeof entry[1] === "string",
			),
		);
	} catch {
		return {};
	}
}

function isCheckFile(path: string): boolean {
	const name = path.split("/").at(-1) ?? path;
	if (HOOK_FILE_RE.test(path)) return true;
	if (CHECK_TEST_RE.test(path)) return true;
	return CHECK_DIR_RE.test(path) && CHECK_NAME_RE.test(name);
}

function checkNames(text: string): string[] {
	const names: string[] = [];
	for (const match of text.matchAll(CHECK_FN_RE)) {
		const name = match[1];
		if (name && !names.includes(name)) names.push(name);
		if (names.length >= MAX_CHECKS_PER_FILE) break;
	}
	return names;
}

function failureHeads(text: string): string[] {
	const heads: string[] = [];
	const seen = new Set<string>();
	for (const match of text.matchAll(FAILURE_RE)) {
		const code = match[1] ?? "";
		if (seen.has(code)) continue;
		seen.add(code);
		const body = (match[2] ?? "")
			.replace(/\$\{[^}]*\}/g, "…")
			.replace(/(?:…\s*)+/g, "… ")
			.replace(/\s+/g, " ")
			.trim();
		heads.push(`${code}: ${body}`.slice(0, MAX_FAILURE_CHARS));
		if (heads.length >= MAX_CHECKS_PER_FILE) break;
	}
	return heads;
}

export function collectEnforcementInventory(root: string, files?: ReadonlyArray<string>): EnforcementInventory {
	let visible: ReadonlyArray<string> = files ?? [];
	if (!files) {
		try {
			visible = enumerateWorkspaceFiles(root);
		} catch {
			// An unreadable tree has no inventory; the bootstrap still reads the code.
			visible = [];
		}
	}
	const ciCommands: string[] = [];
	for (const path of visible.filter((file) => CI_FILE_RE.test(file) || HOOK_FILE_RE.test(file)).sort()) {
		const text = readText(root, path);
		if (!text) continue;
		for (const command of ciRunCommands(text)) {
			const bounded = command.slice(0, MAX_COMMAND_CHARS);
			if (!ciCommands.includes(bounded)) ciCommands.push(bounded);
		}
	}
	const allScripts = packageScripts(root);
	const ciText = ciCommands.join("\n");
	const scripts: Record<string, string> = {};
	for (const [name, command] of Object.entries(allScripts)) {
		const reachedByCi = new RegExp(`\\brun\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`).test(ciText);
		if (reachedByCi || SCRIPT_NAME_RE.test(name)) scripts[name] = command.slice(0, MAX_COMMAND_CHARS);
	}
	const referenced = `${ciText}\n${Object.values(scripts).join("\n")}`;
	const candidates = visible.filter(isCheckFile);
	// Files that CI or a check script invokes by path come first: they are the ones that fail a change.
	candidates.sort((a, b) => Number(referenced.includes(b)) - Number(referenced.includes(a)) || a.localeCompare(b));
	const checkFiles: EnforcementCheckFile[] = [];
	for (const path of candidates.slice(0, MAX_CHECK_FILES)) {
		const text = readText(root, path);
		if (text === null || text.includes("\u0000")) continue;
		checkFiles.push({ path, checks: checkNames(text), failures: failureHeads(text) });
	}
	return { ciCommands: ciCommands.slice(0, MAX_CI_COMMANDS), scripts, checkFiles };
}
