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
import { CI_FILE_RE, ciRunCommands } from "../../core/ci-commands.js";
import { enumerateWorkspaceFiles } from "../../core/workspace-files.js";

export interface EnforcementCheckFile {
	path: string;
	/** Check functions the file defines, in file order; empty when none are named that way. */
	checks: string[];
	/** Heads of the coded failure messages it emits (`rule6: ...`), with interpolations elided. */
	failures: string[];
	/** Each coded rule the file emits, stated as the file declares it. */
	rules?: EnforcementRule[];
}

export interface EnforcementRule {
	code: string;
	/** The rule in the checker's words, comment markers removed. */
	text: string;
	/**
	 * `declaration` is a numbered rule list item (`8. src/session-control/** never imports ...`),
	 * `doc` the doc comment of the function that reports it, `failure` its failure message
	 * when the file declares the rule nowhere else.
	 */
	source: "declaration" | "doc" | "failure";
}

export interface EnforcementInventory {
	ciCommands: string[];
	/** Package scripts that CI reaches or that lint, check, verify, gate or test. */
	scripts: Record<string, string>;
	/**
	 * The package scripts a CI command reaches, directly, through another
	 * reached script, or through a repository file CI runs by path. Every other
	 * entry in `scripts` is an available check that CI is not shown to run.
	 */
	ciScripts?: string[];
	checkFiles: EnforcementCheckFile[];
}

const HOOK_FILE_RE = /^(?:\.pre-commit-config\.ya?ml|lefthook\.ya?ml|\.husky\/[^/_][^/]*)$/;
const CHECK_NAME_RE = /(?:check|lint|verify|guard|hygiene|drift|gate|validate|boundar|conformance)/i;
const CHECK_DIR_RE = /^(?:scripts|tools|ci|hack|bin|build|\.github\/scripts)\//;
const CHECK_TEST_RE = /^tests?\/(?:[^/]+\/)*(?:boundar|architecture|conventions|lint|hygiene)[^/]*(?:\/|$)/i;
const SCRIPT_NAME_RE = /(?:^|:)(?:lint|check|verify|gate|validate|typecheck|test|ci)(?::|$)/;
const CHECK_FN_RE =
	/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function\s+|def\s+)((?:check|lint|verify|validate|guard)[A-Za-z0-9_]*)\s*\(/g;

/** A failure message that leads with a rule code: `rule6: ...`, `E501: ...`, `D14: ...`. */
// A body runs to the quote that opened it: stopping at any quote cut "the read model's quantity" at the apostrophe.
const FAILURE_RE = /([`'"])([A-Za-z]{0,12}\d{1,4}[a-z]?): ((?:(?!\1)[^\\]|\\.){8,600})/g;
/**
 * A failure reported through a helper that names its rule first:
 * `fail("documentation-links", \`missing heading anchor ...\`)`. Clio's own
 * hygiene script reports 111 failures this way, and the coded form alone
 * handed the bootstrap model 21 check names with none of their rules.
 */
const FAILURE_CALL_RE =
	/\b\w*(?:fail|error|report|violation|issue|problem)\w*\(\s*["'`]([a-z][\w.:-]{1,40})["'`]\s*,\s*(["'`])((?:(?!\2)[^\\]|\\.){8,600})/gi;
/**
 * A failure whose code comes from a variable: `${rule}: ...` after
 * `const rule = inSessionControl ? "rule8" : "rule9"`. Clio's boundary checker
 * reports its session-control and engine import rules this way, and the
 * literal form alone left both out of every generated handbook.
 */
const FAILURE_VAR_RE = /([`'"])\$\{(\w+)\}: ((?:(?!\1)[^\\]|\\.){8,600})/g;
const RULE_CODE_RE = /^[A-Za-z]{0,12}\d{1,4}[a-z]?$/;
const MAX_FAILURE_CHARS = 360;
/** One rule often fails in a few distinct ways; keep the first of each, not every variant. */
const MAX_FAILURES_PER_CODE = 2;

const MAX_CI_COMMANDS = 60;
const MAX_CHECK_FILES = 24;
const MAX_CHECKS_PER_FILE = 40;
/** A selector cut short reads as a broader glob; the full `test` script ran to 260 characters. */
const MAX_COMMAND_CHARS = 480;
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

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Repository files a command runs by path: `node scripts/release-candidate.mjs test`. */
function invokedFiles(command: string, visible: ReadonlySet<string>): string[] {
	return command
		.split(/\s+/)
		.map((word) => word.replace(/^["']|["']$/g, "").replace(/^\.\//, ""))
		.filter((word) => visible.has(word));
}

const QUOTED_RUN_RE = /["']run["']/;
const SPAWN_WINDOW_CHARS = 300;

/**
 * Whether a program spawns a package script by name: as the argument after a
 * quoted `"run"`, or as a member of a string array that a quoted `"run"` follows
 * closely (`["typecheck", "lint"].map((step) => spawn("pnpm", ["run", step]))`).
 * A bare literal is not enough: `["release", "dev"]` there names release modes.
 */
function spawnsScript(text: string, name: string): boolean {
	const quoted = escapeRegExp(name);
	if (new RegExp(`["']run["']\\s*,\\s*["']${quoted}["']`).test(text)) return true;
	const item = `["'][^"'\\n]+["']`;
	const array = new RegExp(`\\[\\s*(?:${item}\\s*,\\s*)*["']${quoted}["']\\s*(?:,\\s*${item}\\s*)*,?\\s*\\]`, "g");
	for (const match of text.matchAll(array)) {
		const after = (match.index ?? 0) + match[0].length;
		if (QUOTED_RUN_RE.test(text.slice(after, after + SPAWN_WINDOW_CHARS))) return true;
	}
	return false;
}

/**
 * Which package scripts CI reaches. A script is reached when a reached command
 * names it (`pnpm run lint`), or when a repository file a reached command runs
 * by path spawns it: Clio's CI runs
 * `node scripts/release-candidate.mjs`, which spawns `pnpm run` over
 * `["typecheck", "lint", "check:gui"]`. Listing every check script as reached
 * let the bootstrap model write that `skills:check` and `library:check` fail
 * CI, though no CI command runs either.
 */
function ciReachedScripts(
	root: string,
	ciCommands: ReadonlyArray<string>,
	scripts: Readonly<Record<string, string>>,
	visible: ReadonlySet<string>,
): string[] {
	const reached = new Set<string>();
	const readFiles = new Set<string>();
	const pending = [...ciCommands];
	while (pending.length > 0) {
		const command = pending.shift() ?? "";
		const texts = [command];
		for (const path of invokedFiles(command, visible)) {
			if (readFiles.has(path)) continue;
			readFiles.add(path);
			const text = readText(root, path);
			if (text !== null && !text.includes("\u0000")) texts.push(text);
		}
		for (const [name, body] of Object.entries(scripts)) {
			if (reached.has(name)) continue;
			const named = texts.some((text, index) =>
				index === 0 ? new RegExp(`\\brun\\s+${escapeRegExp(name)}(?:\\s|$)`).test(text) : spawnsScript(text, name),
			);
			if (!named) continue;
			reached.add(name);
			pending.push(body);
		}
	}
	return Object.keys(scripts).filter((name) => reached.has(name));
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

/**
 * The string literals the nearest assignment before `at` gives a variable,
 * when that is all it gives: `const owner = inSessionControl ? "the session
 * contract" : "the engine"`. An empty literal is an absent qualifier, not a
 * word, so a variable that can be empty resolves to nothing.
 */
function literalChoices(text: string, name: string, at: number): string[] {
	const assignment = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*([^;\\n]+)`, "g");
	const value = [...text.slice(0, at).matchAll(assignment)].at(-1)?.[1];
	if (value === undefined) return [];
	const literals = [...value.matchAll(/(["'])((?:(?!\1)[^\\\n])*)\1/g)].map((literal) => literal[2] ?? "");
	// Anything but a condition around the literals computes the value; it is not a choice.
	const rest = value.replace(/(["'])(?:(?!\1)[^\\\n])*\1/g, "").replace(/[\s?:()]/g, "");
	if (literals.length === 0 || literals.some((literal) => literal.trim().length === 0)) return [];
	return /^[\w.!&|=<>]*$/.test(rest) ? [...new Set(literals)] : [];
}

/** Text cut to `max` at the last sentence or clause end, marked with an ellipsis, never mid-clause. */
function clauseBounded(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max - 2);
	const sentence = cut.lastIndexOf(". ");
	if (sentence > max / 2) return `${cut.slice(0, sentence + 1)} …`;
	const clause = Math.max(cut.lastIndexOf("; "), cut.lastIndexOf(", "));
	if (clause > max / 2) return `${cut.slice(0, clause)} …`;
	return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 1))} …`;
}

function failureHeads(text: string): string[] {
	const heads: string[] = [];
	const perCode = new Map<string, number>();
	const bodies = new Set<string>();
	const plain = [
		...[...text.matchAll(FAILURE_RE)].map((match) => ({
			index: match.index ?? 0,
			code: match[2] ?? "",
			body: match[3] ?? "",
		})),
		...[...text.matchAll(FAILURE_CALL_RE)].map((match) => ({
			index: match.index ?? 0,
			code: match[1] ?? "",
			body: match[3] ?? "",
		})),
	];
	const coded = [...text.matchAll(FAILURE_VAR_RE)].flatMap((match) => {
		const codes = literalChoices(text, match[2] ?? "", match.index ?? 0);
		if (codes.length === 0 || !codes.every((code) => RULE_CODE_RE.test(code))) return [];
		return [{ index: match.index ?? 0, code: codes.join("/"), body: match[3] ?? "" }];
	});
	const matches = [...plain, ...coded].sort((a, b) => a.index - b.index);
	for (const match of matches) {
		const code = match.code;
		const count = perCode.get(code) ?? 0;
		if (count >= MAX_FAILURES_PER_CODE) continue;
		const body = match.body
			// A variable assigned only string literals reads as those literals.
			.replace(/\$\{(\w+)\}/g, (whole, name: string) => {
				const choices = literalChoices(text, name, match.index);
				return choices.length > 0 ? choices.join(" / ") : whole;
			})
			.replace(/\$\{[^}]*\}/g, "…")
			// The capture stops at the first quote, which can fall inside an
			// interpolation such as `${names.join(", ")}`; elide the fragment.
			.replace(/\$\{[^}]*$/, "…")
			.replace(/\\n/g, " ")
			.replace(/(?:…\s*[:,]?\s*)+/g, "… ")
			.replace(/\s+/g, " ")
			.trim();
		// A message that is only interpolation says nothing about the rule.
		if (body.replace(/[…\s:,]/g, "").length < 8 || bodies.has(`${code}\0${body}`)) continue;
		bodies.add(`${code}\0${body}`);
		perCode.set(code, count + 1);
		heads.push(clauseBounded(`${code}: ${body}`, MAX_FAILURE_CHARS));
		if (heads.length >= MAX_CHECKS_PER_FILE) break;
	}
	return heads;
}

const CODE_PARTS_RE = /^([A-Za-z]{0,12})(\d{1,4})([a-z]?)$/;
const COMMENT_ITEM_RE = /^\s*(?:\*|\/\/|#)\s*(\d{1,4})\.\s+(\S.*)$/;
const COMMENT_CONTINUATION_RE = /^\s*(?:\*|\/\/|#)\s{2,}(\S.*)$/;
const RULE_DOC_RE = /\b(?:never|only|must|may not|no|immutable|always|forbid\w*)\b/i;
const MAX_RULE_CHARS = 700;

/** Numbered list items in comments (`*   8. src/session-control/** never imports ...`), by number. */
function numberedCommentItems(text: string): Map<string, string> {
	const items = new Map<string, string>();
	let current: { number: string; parts: string[] } | null = null;
	const close = (): void => {
		if (current && !items.has(current.number)) items.set(current.number, current.parts.join(" "));
		current = null;
	};
	for (const line of text.split("\n")) {
		const item = COMMENT_ITEM_RE.exec(line);
		if (item?.[1] && item[2]) {
			close();
			current = { number: item[1], parts: [item[2].trim()] };
			continue;
		}
		const continuation = current ? COMMENT_CONTINUATION_RE.exec(line) : null;
		if (current && continuation?.[1] && !/^\*\/$/.test(continuation[1])) current.parts.push(continuation[1].trim());
		else close();
	}
	close();
	return items;
}

/** The doc comment directly above the function that encloses `at`, when it states a rule. */
function enclosingFunctionDoc(text: string, at: number): string | null {
	const before = text.slice(0, at);
	const declarations = [...before.matchAll(/(?:^|\n)[ \t]*(?:export\s+)?(?:async\s+)?function\s+\w+/g)];
	const start = declarations.at(-1)?.index;
	if (start === undefined) return null;
	const head = text.slice(0, start).trimEnd();
	if (!head.endsWith("*/")) return null;
	const open = head.lastIndexOf("/**");
	if (open < 0) return null;
	const doc = head
		.slice(open + 3, -2)
		.split("\n")
		.map((line) => line.replace(/^\s*\*\s?/, "").trim())
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	return RULE_DOC_RE.test(doc) ? doc : null;
}

/**
 * Each coded rule a check file emits, as the file declares it. A failure
 * message names the offending file and leaves the rule's subject to an
 * interpolation (`rule1: … outside src/engine (value import)`), so a reader
 * learned that something failed, not what the rule protects.
 */
function checkerRules(text: string, failures: ReadonlyArray<string>): EnforcementRule[] {
	const items = numberedCommentItems(text);
	const rules: EnforcementRule[] = [];
	const seen = new Set<string>();
	for (const failure of failures) {
		const head = /^([A-Za-z]{0,12}\d{1,4}[a-z]?(?:\/[A-Za-z]{0,12}\d{1,4}[a-z]?)*): (.+)$/.exec(failure);
		if (!head?.[1]) continue;
		for (const code of head[1].split("/")) {
			if (seen.has(code)) continue;
			seen.add(code);
			const number = CODE_PARTS_RE.exec(code)?.[2];
			const declared = number !== undefined ? items.get(number) : undefined;
			if (declared) {
				rules.push({ code, text: clauseBounded(declared, MAX_RULE_CHARS), source: "declaration" });
				continue;
			}
			const site = [`"${code}"`, `'${code}'`, `\`${code}:`, `"${code}:`, `'${code}:`]
				.map((needle) => text.indexOf(needle))
				.filter((index) => index >= 0)
				.sort((a, b) => a - b)[0];
			const doc = site !== undefined ? enclosingFunctionDoc(text, site) : null;
			rules.push(
				doc
					? { code, text: clauseBounded(doc, MAX_RULE_CHARS), source: "doc" }
					: { code, text: head[2] ?? "", source: "failure" },
			);
		}
	}
	return rules;
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
	const ciScripts = ciReachedScripts(root, ciCommands, allScripts, new Set(visible));
	const scripts: Record<string, string> = {};
	for (const [name, command] of Object.entries(allScripts)) {
		if (ciScripts.includes(name) || SCRIPT_NAME_RE.test(name)) scripts[name] = command.slice(0, MAX_COMMAND_CHARS);
	}
	const referenced = `${ciText}\n${Object.values(scripts).join("\n")}`;
	const candidates = visible.filter(isCheckFile);
	// Files that CI or a check script invokes by path come first: they are the ones that fail a change.
	candidates.sort((a, b) => Number(referenced.includes(b)) - Number(referenced.includes(a)) || a.localeCompare(b));
	const checkFiles: EnforcementCheckFile[] = [];
	for (const path of candidates.slice(0, MAX_CHECK_FILES)) {
		const text = readText(root, path);
		if (text === null || text.includes("\u0000")) continue;
		const failures = failureHeads(text);
		const rules = checkerRules(text, failures);
		checkFiles.push({ path, checks: checkNames(text), failures, ...(rules.length > 0 ? { rules } : {}) });
	}
	return {
		ciCommands: ciCommands.slice(0, MAX_CI_COMMANDS),
		scripts,
		...(ciScripts.length > 0 ? { ciScripts } : {}),
		checkFiles,
	};
}
