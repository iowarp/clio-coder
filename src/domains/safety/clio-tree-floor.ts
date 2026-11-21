import { homedir, userInfo } from "node:os";
import path from "node:path";
import { canonicalizeRawPath, type PathWalkMemo } from "../../core/path-canonical.js";
import { xdgBaseDir } from "../../core/xdg.js";
import type { PathPolicyOperation } from "./path-policy.js";
import { extractCommandPathWalks, shellCommandSteps } from "./protected-artifacts.js";
import { commandAssignments, expandBraces, segmentNames } from "./yolo-floor.js";

/**
 * The yolo floor's own reading of where a shell command writes and deletes, for Clio's config, data, state and cache
 * trees (row 314). The general scanners place a path only as the command spells it; this reading adds what bash makes
 * of it: `$HOME`, `${HOME:-x}`, an XDG base, a doubled slash or a dot segment, brace alternatives and globs, the
 * directories every cd, pushd, `env -C`, CDPATH and `cd -` may leave the shell in, `/proc/self/cwd`, and the writers
 * and deleters the scanners do not list. Each reading only adds judged paths: it never clears one the floor holds.
 */

/** `$CLIO_CODER_CONFIG_DIR`, `$XDG_CONFIG_HOME/clio-coder` and their kin name a Clio tree at run time. */
export const CLIO_OWNED_VARIABLE = /\$\{?(?:CLIO_CODER_\w+|XDG_(?:CONFIG|DATA|STATE|CACHE)_HOME\}?\/clio-coder)/u;

/** A reference to a Clio variable however it is written, operators included. */
const CLIO_VARIABLE = /\$\{?CLIO_CODER_\w+/u;

const KNOWN_NAME = /^(HOME|XDG_(?:CONFIG|DATA|STATE|CACHE)_HOME|CLIO_CODER_\w+)(?![\w])/u;

const XDG_FALLBACKS: Readonly<Record<string, ReadonlyArray<string>>> = {
	XDG_CONFIG_HOME: [".config"],
	XDG_DATA_HOME: [".local", "share"],
	XDG_STATE_HOME: [".local", "state"],
	XDG_CACHE_HOME: [".cache"],
};

/** Most bases and spellings one reading keeps. */
const MAX_BASES = 64;
const MAX_SPELLINGS = 64;

/** What one command writes or deletes beyond the general scan, and whether it deletes what its input names. */
export interface ClioFloorReading {
	targets: Array<{ operation: PathPolicyOperation; path: string }>;
	/** `xargs rm` and its kin remove names read from input, which no scanner places. */
	fromInput: boolean;
	/** The text of each alias the command defines, which runs wherever its name is a command word. */
	aliases: string[];
}

/** The values a known variable may hold where the command runs: HOME, and an XDG base or its fallback. */
function variableValues(name: string): string[] {
	const home = homedir();
	if (name === "HOME") return [home];
	const fallback = XDG_FALLBACKS[name];
	if (fallback === undefined) return [];
	const spelled = path.join(home, ...fallback);
	return [...new Set([xdgBaseDir(process.env[name], spelled), spelled])];
}

/** The index of the `}` closing the `${` at `open`, or -1. */
function closingBrace(word: string, open: number): number {
	let depth = 0;
	for (let index = open; index < word.length; index += 1) {
		const char = word[index];
		if (char === "\\") index += 1;
		else if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return -1;
}

/**
 * The spellings bash may make of one word for a known variable: `${HOME:-x}`, `${HOME%/}` and every other operator
 * read as the variable itself (a default word also as itself), doubled slashes folded and `/.` segments dropped.
 */
function normalizedForms(word: string): string[] {
	const forms = new Set<string>();
	let text = word;
	for (let guard = 0; guard < 16; guard += 1) {
		const open = text.indexOf("${");
		let changed = false;
		for (let at = open; at !== -1; at = text.indexOf("${", at + 2)) {
			const close = closingBrace(text, at + 1);
			if (close === -1) break;
			const inner = text.slice(at + 2, close);
			const name = KNOWN_NAME.exec(inner)?.[1];
			if (name === undefined || inner === name) continue;
			const operator = /^(:?[-=+?])(.*)$/su.exec(inner.slice(name.length));
			if (operator !== null && operator[1] !== undefined && /[-=]/u.test(operator[1]))
				forms.add(`${text.slice(0, at)}${operator[2] ?? ""}${text.slice(close + 1)}`);
			text = `${text.slice(0, at)}\${${name}}${text.slice(close + 1)}`;
			changed = true;
			break;
		}
		if (!changed) break;
	}
	forms.add(text);
	return [...forms].map((form) => {
		let tidy = form.replace(/\/{2,}/gu, "/");
		for (let previous = ""; previous !== tidy; ) {
			previous = tidy;
			tidy = tidy.replace(/\/\.(?=\/|$)/u, "");
		}
		return tidy === "" && form.startsWith("/") ? "/" : tidy;
	});
}

/** `~` and `~name` for the running account, expanded; any other `~word` stays as written. */
function expandTilde(word: string): string {
	if (word === "~" || word.startsWith("~/")) return path.join(homedir(), word.slice(1));
	let account: { username: string; homedir: string } | null = null;
	try {
		account = userInfo();
	} catch {
		return word;
	}
	const prefix = `~${account.username}`;
	return word === prefix || word.startsWith(`${prefix}/`) ? path.join(account.homedir, word.slice(prefix.length)) : word;
}

/** Every spelling of a written word the floor judges: its brace words, normalized forms, and known values expanded. */
function clioFloorSpellings(word: string): string[] {
	const out = new Set<string>([word]);
	for (const braced of expandBraces(word) ?? [word]) {
		for (const form of normalizedForms(braced)) {
			out.add(form);
			const expanded = expandTilde(form);
			out.add(expanded);
			const leading = /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/u.exec(expanded);
			const name = leading?.[1] ?? leading?.[2];
			if (leading === null || name === undefined) continue;
			for (const value of variableValues(name)) out.add(`${value}${expanded.slice(leading[0].length)}`);
		}
		if (out.size > MAX_SPELLINGS) break;
	}
	return [...out].slice(0, MAX_SPELLINGS);
}

/** `/proc/self/cwd` (or `/proc/$$/cwd`, a PID's) is the shell's own directory; `/proc/self/root` is `/`. */
const PROC_CWD = /^\/proc\/(?:self|thread-self|\$\$|\$\{\$\}|\$BASHPID|\$\{BASHPID\}|\d+)\/cwd(?=\/|$)/u;
const PROC_ROOT = /^\/proc\/(?:self|thread-self|\$\$|\$\{\$\}|\$BASHPID|\$\{BASHPID\}|\d+)\/root(?=\/|$)/u;

/** Where one spelling lands from each base, lexically and through the links on disk; none for a run-time word. */
function placed(spelling: string, bases: ReadonlyArray<string>, memo: PathWalkMemo): string[] {
	const cwd = PROC_CWD.exec(spelling);
	if (cwd !== null) {
		const rest = `.${spelling.slice(cwd[0].length)}`;
		return bases.flatMap((base) => placed(rest, [base], memo));
	}
	const root = PROC_ROOT.exec(spelling);
	if (root !== null) return placed(`/${spelling.slice(root[0].length)}`, ["/"], memo);
	if (/[$`]/u.test(spelling) || spelling.startsWith("~")) return [];
	const from = path.isAbsolute(spelling) ? ["/"] : bases;
	return from.flatMap((base) => {
		const lexical = path.resolve(base, spelling);
		const real = /[*?[]/u.test(spelling) ? null : canonicalizeRawPath(spelling, base, memo);
		return real === null || real === lexical ? [lexical] : [lexical, real];
	});
}

const segments = (location: string): string[] => location.split("/").filter((part) => part !== "");

/**
 * Whether a placed path lies in one of the roots, or (a delete) holds one: segment by segment, a glob matching as bash
 * may (dotglob on, fail-closed), and case folded, since a case-insensitive filesystem reads another case as the tree.
 */
function reachesRoot(location: string, operation: PathPolicyOperation, roots: ReadonlyArray<string>): boolean {
	const written = segments(location.toLowerCase());
	return roots.some((root) => {
		const tree = segments(root.toLowerCase());
		const shared = Math.min(written.length, tree.length);
		for (let index = 0; index < shared; index += 1) {
			const segment = written[index] as string;
			if (segment === "**") return true;
			if (!segmentNames(segment, tree[index] as string, true)) return false;
		}
		return written.length >= tree.length || operation === "delete";
	});
}

/** The values the command assigns to `name`, unquoted, and the one the session holds. */
function assignedValues(command: string, name: string): string[] {
	const values = commandAssignments(command)
		.filter((assignment) => assignment.name === name)
		.map(({ text }) => text.replace(/["']/gu, ""));
	const inherited = process.env[name];
	return inherited === undefined || inherited === "" ? values : [...values, inherited];
}

/** `cd -` (or `pushd -`) returns to OLDPWD. */
const CD_BACK = /(?:^|[\s;&|({])(?:cd|pushd)\s+(?:-[LPe@]+\s+)*(?:--\s+)?-(?=$|[\s;&|)])/mu;

/**
 * Every directory the shell may stand in when a step runs: the call's directory and each cd, pushd or `env -C`
 * destination read from every base before it (a cd may fail, so the earlier bases stay), with CDPATH's entries for a
 * relative destination and OLDPWD after `cd -`. A destination naming a Clio variable lands in each of Clio's roots.
 */
export function clioFloorBases(
	command: string,
	cwd: string,
	roots: ReadonlyArray<string>,
	memo: PathWalkMemo,
): string[] {
	const bases = new Set<string>([cwd]);
	const add = (location: string) => {
		if (bases.size < MAX_BASES) bases.add(location);
	};
	const cdpath = assignedValues(command, "CDPATH").flatMap((value) => value.split(":").filter((entry) => entry !== ""));
	for (const walk of extractCommandPathWalks(command)) {
		for (const event of walk) {
			if (event.kind !== "cd") continue;
			const from = [...bases];
			for (const spelling of clioFloorSpellings(event.target)) {
				if (CLIO_OWNED_VARIABLE.test(spelling) || CLIO_VARIABLE.test(spelling)) {
					for (const root of roots) add(root);
					continue;
				}
				for (const landed of placed(spelling, from, memo)) add(landed);
				if (path.isAbsolute(spelling) || /^\.\.?(?:\/|$)/u.test(spelling)) continue;
				for (const entry of cdpath)
					for (const dir of clioFloorSpellings(entry))
						for (const landed of placed(path.join(dir, spelling), from, memo)) add(landed);
			}
		}
	}
	if (CD_BACK.test(command)) {
		for (const value of assignedValues(command, "OLDPWD"))
			for (const spelling of clioFloorSpellings(value)) for (const landed of placed(spelling, [cwd], memo)) add(landed);
	}
	return [...bases];
}

/** Whether any target, in any spelling, from any base, lands in Clio's trees or names one at run time. */
export function clioFloorReaches(
	targets: ReadonlyArray<{ operation: PathPolicyOperation; path: string }>,
	bases: ReadonlyArray<string>,
	roots: ReadonlyArray<string>,
	memo: PathWalkMemo,
): boolean {
	for (const target of targets) {
		if (target.operation === "read") continue;
		for (const spelling of clioFloorSpellings(target.path)) {
			if (CLIO_OWNED_VARIABLE.test(spelling)) return true;
			if (placed(spelling, bases, memo).some((location) => reachesRoot(location, target.operation, roots))) return true;
		}
	}
	return false;
}

/** The text of a command with each known variable's operators and doubled slashes read as {@link clioFloorSpellings}. */
export function clioFloorText(command: string): string[] {
	return [...new Set([command, ...normalizedForms(command)])];
}

/** A command's operands and option values, given which short and long options take a value. */
function readArgs(
	args: ReadonlyArray<string>,
	valuedShort: string,
	valuedLong: ReadonlyArray<string>,
): { operands: string[]; options: Array<{ name: string; value: string | null }> } {
	const operands: string[] = [];
	const options: Array<{ name: string; value: string | null }> = [];
	for (let index = 0, ended = false; index < args.length; index += 1) {
		const word = args[index] as string;
		if (ended || !word.startsWith("-") || word === "-") {
			operands.push(word);
			continue;
		}
		if (word === "--") {
			ended = true;
			continue;
		}
		if (word.startsWith("--")) {
			const eq = word.indexOf("=");
			const name = eq === -1 ? word : word.slice(0, eq);
			if (eq !== -1) options.push({ name, value: word.slice(eq + 1) });
			else if (valuedLong.includes(name)) {
				options.push({ name, value: args[index + 1] ?? null });
				index += 1;
			} else options.push({ name, value: null });
			continue;
		}
		for (let at = 1; at < word.length; at += 1) {
			const flag = word[at] as string;
			if (!valuedShort.includes(flag)) {
				options.push({ name: `-${flag}`, value: null });
				continue;
			}
			const rest = word.slice(at + 1);
			options.push({ name: `-${flag}`, value: rest.length > 0 ? rest : (args[index + 1] ?? null) });
			if (rest.length === 0) index += 1;
			break;
		}
	}
	return { operands, options };
}

const valuesOf = (options: ReadonlyArray<{ name: string; value: string | null }>, names: ReadonlyArray<string>) =>
	options.flatMap((option) => (names.includes(option.name) && option.value !== null ? [option.value] : []));

/**
 * A copy's destination, and each source as it lands inside the destination when that is a directory. A name only the
 * run fixes (`$X`) may be any entry there, so it is read as a glob; the source it names is only read.
 */
function copyTargets(sources: ReadonlyArray<string>, destination: string): string[] {
	return [
		destination,
		...sources.map((source) => {
			const name = path.posix.basename(source.replace(/\/+$/u, ""));
			return path.posix.join(destination, /[$`]/u.test(name) ? "*" : name);
		}),
	];
}

const RSYNC_VALUED = [
	"--address",
	"--backup-dir",
	"--block-size",
	"--bwlimit",
	"--checksum-choice",
	"--checksum-seed",
	"--chmod",
	"--chown",
	"--compare-dest",
	"--compress-choice",
	"--compress-level",
	"--contimeout",
	"--copy-as",
	"--copy-dest",
	"--debug",
	"--exclude",
	"--exclude-from",
	"--files-from",
	"--filter",
	"--groupmap",
	"--iconv",
	"--include",
	"--include-from",
	"--info",
	"--link-dest",
	"--log-file",
	"--log-file-format",
	"--max-alloc",
	"--max-delete",
	"--max-size",
	"--min-size",
	"--modify-window",
	"--only-write-batch",
	"--out-format",
	"--outbuf",
	"--partial-dir",
	"--password-file",
	"--port",
	"--protocol",
	"--read-batch",
	"--remote-option",
	"--rsh",
	"--rsync-path",
	"--skip-compress",
	"--sockopts",
	"--stop-after",
	"--stop-at",
	"--suffix",
	"--temp-dir",
	"--timeout",
	"--usermap",
	"--write-batch",
];
/** rsync options whose value is a path it writes. */
const RSYNC_WRITTEN = [
	"--backup-dir",
	"--log-file",
	"--only-write-batch",
	"--partial-dir",
	"--temp-dir",
	"-T",
	"--write-batch",
];

/** What one simple command writes that the general scan does not list. */
function stepTargets(executable: string, args: ReadonlyArray<string>): string[] {
	switch (executable) {
		case "cp":
		case "mv": {
			const { operands, options } = readArgs(args, "St", ["--suffix", "--target-directory"]);
			const into = valuesOf(options, ["-t", "--target-directory"]);
			if (into.length > 0) return into.flatMap((dir) => copyTargets(operands, dir));
			return operands.length >= 2 ? copyTargets(operands.slice(0, -1), operands.at(-1) as string) : [];
		}
		case "install": {
			const { operands, options } = readArgs(args, "gmoSt", [
				"--group",
				"--mode",
				"--owner",
				"--suffix",
				"--target-directory",
				"--strip-program",
			]);
			if (options.some((option) => option.name === "-d" || option.name === "--directory")) return operands;
			const into = valuesOf(options, ["-t", "--target-directory"]);
			if (into.length > 0) return into.flatMap((dir) => copyTargets(operands, dir));
			return operands.length >= 2 ? copyTargets(operands.slice(0, -1), operands.at(-1) as string) : [];
		}
		case "rsync": {
			const { operands, options } = readArgs(args, "BefMT@", RSYNC_VALUED);
			const written = valuesOf(options, RSYNC_WRITTEN);
			const destination = operands.at(-1);
			// `host:path` and `rsync://` are remote; a local destination is a path.
			if (operands.length < 2 || destination === undefined || /^[^/]*:/u.test(destination)) return written;
			return [...written, ...copyTargets(operands.slice(0, -1), destination)];
		}
		case "truncate":
			return readArgs(args, "sr", ["--size", "--reference"]).operands;
		case "shred":
			return readArgs(args, "ns", ["--iterations", "--size", "--random-source"]).operands;
		case "chmod":
		case "chown":
		case "chgrp": {
			const { operands, options } = readArgs(args, "", []);
			// The mode or owner is the first operand unless --reference names it; a mode may look like an option.
			return options.some((option) => option.name === "--reference") ? operands : operands.slice(1);
		}
		case "find": {
			const out: string[] = [];
			for (const [index, word] of args.entries()) {
				if (["-fprint", "-fprint0", "-fprintf", "-fls"].includes(word) && args[index + 1] !== undefined)
					out.push(args[index + 1] as string);
			}
			return out;
		}
		case "tar":
			return tarTargets(args);
		case "unzip": {
			const { options } = readArgs(args, "dx", []);
			const into = valuesOf(options, ["-d"]);
			if (into.length > 0) return into;
			return options.some((option) => ["-l", "-v", "-t", "-p", "-Z"].includes(option.name)) ? [] : ["."];
		}
		case "git":
			return gitTargets(args);
		default:
			return [];
	}
}

/** A tar's archive when it creates or updates one, and where it extracts: each -C directory, or the shell's. */
function tarTargets(args: ReadonlyArray<string>): string[] {
	const valued = "fCbTXgKNVLFH";
	let create = false;
	let extract = false;
	const files: string[] = [];
	const dirs: string[] = [];
	const take = (flag: string, value: string | undefined) => {
		if (value === undefined) return;
		if (flag === "f") files.push(value);
		if (flag === "C") dirs.push(value);
	};
	const modes = (flags: string) => {
		if (/[cruA]/u.test(flags)) create = true;
		if (/x/u.test(flags)) extract = true;
	};
	for (let index = 0; index < args.length; index += 1) {
		const word = args[index] as string;
		if (index === 0 && !word.startsWith("-")) {
			// Old-style options: each letter that takes a value takes the next word, in order.
			modes(word);
			for (const flag of word) if (valued.includes(flag)) take(flag, args[++index]);
			continue;
		}
		if (word.startsWith("--")) {
			const eq = word.indexOf("=");
			const name = eq === -1 ? word : word.slice(0, eq);
			if (["--create", "--append", "--update", "--concatenate"].includes(name)) create = true;
			if (name === "--extract" || name === "--get") extract = true;
			if (name === "--file" || name === "--directory") {
				const value = eq === -1 ? args[++index] : word.slice(eq + 1);
				take(name === "--file" ? "f" : "C", value);
			}
			continue;
		}
		if (!word.startsWith("-") || word === "-") continue;
		modes(word.slice(1));
		for (let at = 1; at < word.length; at += 1) {
			const flag = word[at] as string;
			if (!valued.includes(flag)) continue;
			const rest = word.slice(at + 1);
			take(flag, rest.length > 0 ? rest : args[++index]);
			break;
		}
	}
	return [...(create ? files : []), ...(extract ? (dirs.length > 0 ? dirs : ["."]) : [])];
}

/**
 * Where a git command writes: each `-C` directory (joined in turn), `--git-dir` and `--work-tree`, the directory
 * `init`, `clone` or `worktree add` makes, and the file `config --file` edits.
 */
function gitTargets(args: ReadonlyArray<string>): string[] {
	const out: string[] = [];
	let dir = ".";
	let index = 0;
	for (; index < args.length; index += 1) {
		const word = args[index] as string;
		if (!word.startsWith("-")) break;
		if (word === "-C" || (word.startsWith("-C") && word.length > 2)) {
			const value = word === "-C" ? args[++index] : word.slice(2);
			if (value === undefined) break;
			dir =
				path.posix.isAbsolute(value) || value.startsWith("~") || value.startsWith("$")
					? value
					: path.posix.join(dir, value);
			out.push(dir);
			continue;
		}
		const eq = word.indexOf("=");
		const name = eq === -1 ? word : word.slice(0, eq);
		if (name === "--git-dir" || name === "--work-tree") {
			const value = eq === -1 ? args[++index] : word.slice(eq + 1);
			if (value !== undefined) out.push(value);
			continue;
		}
		if (eq === -1 && ["-c", "--namespace", "--super-prefix", "--config-env", "--exec-path"].includes(name)) index += 1;
	}
	const at = (value: string) =>
		path.posix.isAbsolute(value) || value.startsWith("~") || value.startsWith("$") ? value : path.posix.join(dir, value);
	const subcommand = args[index];
	const rest = args.slice(index + 1);
	if (subcommand === "init") {
		const { operands, options } = readArgs(rest, "b", ["--initial-branch", "--separate-git-dir", "--template"]);
		out.push(...(operands.length > 0 ? operands : ["."]).map(at), ...valuesOf(options, ["--separate-git-dir"]).map(at));
	} else if (subcommand === "clone") {
		const { operands, options } = readArgs(rest, "bojuc", [
			"--branch",
			"--origin",
			"--jobs",
			"--upload-pack",
			"--config",
			"--depth",
			"--reference",
			"--separate-git-dir",
			"--template",
			"--filter",
			"--shallow-since",
			"--shallow-exclude",
		]);
		if (operands.length >= 2) out.push(at(operands.at(-1) as string));
		out.push(...valuesOf(options, ["--separate-git-dir"]).map(at));
	} else if (subcommand === "config") {
		const { options } = readArgs(rest, "f", ["--file"]);
		out.push(...valuesOf(options, ["-f", "--file"]).map(at));
	} else if (subcommand === "worktree" && rest[0] === "add") {
		const { operands } = readArgs(rest.slice(1), "bB", ["--reason"]);
		if (operands[0] !== undefined) out.push(at(operands[0]));
	}
	return out;
}

/**
 * What the general scan does not list a command writing or deleting: every write and delete its path walks find
 * (unlink, rmdir, `find -exec rm`, `xargs rm` fed a list, `env -C`, a here-document a shell reads), the writers above,
 * and the aliases it defines.
 */
export function clioFloorReading(command: string): ClioFloorReading {
	const targets: Array<{ operation: PathPolicyOperation; path: string }> = [];
	let fromInput = false;
	for (const walk of extractCommandPathWalks(command)) {
		for (const event of walk) {
			if (event.kind === "write") targets.push({ operation: "write", path: event.target });
			else if (event.kind === "delete") {
				if (event.scope === "input") fromInput = true;
				else if (event.scope !== "remote") targets.push({ operation: "delete", path: event.target });
			}
		}
	}
	const aliases: string[] = [];
	for (const step of shellCommandSteps(command)) {
		for (const target of stepTargets(step.executable, step.args)) targets.push({ operation: "write", path: target });
		if (step.executable === "alias") {
			for (const word of step.args) {
				const eq = word.indexOf("=");
				if (eq > 0 && aliases.length < 8) aliases.push(word.slice(eq + 1));
			}
		}
	}
	return { targets, fromInput, aliases };
}
