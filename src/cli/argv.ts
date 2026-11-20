/**
 * Dependency-light CLI argument parsing and terminal formatting. This module
 * imports nothing from the domain graph (only `chalk` and a leaf of core), so `cli/index.ts` can
 * parse argv and dispatch without dragging provider/auth code (and its
 * transitive pi-* externals) into the eagerly loaded startup chunk. `shared.ts`
 * re-exports everything here for the command modules, which already pay for the
 * heavier graph.
 */

import { resolve } from "node:path";
import chalk from "chalk";
import { colorDisabled } from "../core/terminal-preferences.js";
import type { SessionToolLimits } from "../core/tool-limit-flags.js";
import { parseToolLimitList, toolLimitConflict, toolLimitConstraints } from "../core/tool-limit-flags.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";
import type { StartupResume } from "../entry/boot-options.js";

// Chalk reads only FORCE_COLOR, so a terminal asking for no color still got cyan rails and markers from every CLI
// presenter (first-run configure, select lists). The CLI follows the same rule the TUI theme does.
if (colorDisabled()) chalk.level = 0;

export function printError(message: string, detail?: string): void {
	const head = chalk.red("error:");
	process.stderr.write(`${head} ${message}\n`);
	if (detail) process.stderr.write(`  ${detail}\n`);
}

/** An expected condition worth a line on stderr that is neither an error nor a success. */
export function printNote(message: string): void {
	process.stderr.write(`${chalk.yellow("note:")} ${message}\n`);
}

export function printOk(message: string): void {
	process.stdout.write(`${chalk.green("ok:")} ${message}\n`);
}

export function columnWidths(rows: ReadonlyArray<ReadonlyArray<string>>): number[] {
	const widths: number[] = [];
	for (const row of rows) {
		for (let i = 0; i < row.length; i += 1) {
			widths[i] = Math.max(widths[i] ?? 0, row[i]?.length ?? 0);
		}
	}
	return widths;
}

export function formatColumnRow(row: ReadonlyArray<string>, widths: ReadonlyArray<number>, gap = 2): string {
	return row
		.map((cell, index) => {
			if (index === row.length - 1) return cell;
			return cell.padEnd((widths[index] ?? cell.length) + gap);
		})
		.join("")
		.trimEnd();
}

export function formatColumns(rows: ReadonlyArray<ReadonlyArray<string>>, gap = 2): string {
	if (rows.length === 0) return "";
	const widths = columnWidths(rows);
	return `${rows.map((row) => formatColumnRow(row, widths, gap)).join("\n")}\n`;
}

export function parseFlags(argv: string[]): { flags: Set<string>; positional: string[] } {
	const flags = new Set<string>();
	const positional: string[] = [];
	for (const arg of argv) {
		if (arg.startsWith("--")) flags.add(arg.slice(2));
		else if (arg.startsWith("-") && arg.length > 1) flags.add(arg.slice(1));
		else positional.push(arg);
	}
	return { flags, positional };
}

export interface GlobalCliFlags {
	demo?: boolean;
	apiKey?: string;
	noContextFiles: boolean;
	noSkills: boolean;
	skillPaths: string[];
	/** `--with-panes`: join the current pane host as a guest. */
	panes?: "with";
	/** `--autonomy <level>` before any subcommand: one interactive session at that level. */
	autonomy?: AutonomyLevel;
	/** `--allow-tools`/`--delegate-tools`/`--deny-tools` before any subcommand: the interactive session's tool limits. */
	toolLimits?: SessionToolLimits;
	/** `--session-file <path>` before any subcommand, made absolute: where the interactive session keeps its live lane record and writes its exit record. */
	sessionFile?: string;
	/** `--max-context-tokens <N>` before any subcommand: the interactive session's planning ceiling, as `run` reads it. */
	maxContextTokens?: number;
	/** `--resume [id]`/`-r` or `--continue`/`-c` before any subcommand: the session the interactive app opens on. */
	resume?: StartupResume;
	/**
	 * The boot-option flags (`--api-key`, `--skill`, `--no-context-files`/`-nc`,
	 * `--no-skills`, `--with-panes`) as typed, in order, so a
	 * command that cannot honor one can refuse it by the name the operator used.
	 */
	bootFlags: string[];
	/**
	 * `--help`, `-h`, `--all`, `--version` and `-v` as typed before the
	 * subcommand. They also stay in `rest`, but only these are root flags: the
	 * same tokens after the subcommand or after `--` belong to the command.
	 */
	rootFlags: string[];
	rest: string[];
	error?: string;
}

const ROOT_FLAG_TOKENS = new Set(["--help", "-h", "--all", "--version", "-v"]);

/**
 * Startup flags a subcommand parser will never accept, mapped to the form the
 * hint should show. `--no-skills` and `--skill` are deliberately absent: both
 * are also `clio-coder run` options, so either position works and no hint is owed.
 */
const GLOBAL_ONLY_FLAGS: ReadonlyMap<string, string> = new Map([
	["--api-key", "--api-key <key>"],
	["--no-context-files", "--no-context-files"],
	["-nc", "-nc"],
]);

/** Startup flags only the interactive session reads; no subcommand accepts them in either position. */
const INTERACTIVE_ONLY_FLAGS: ReadonlySet<string> = new Set(["--with-panes"]);

/**
 * Explain the ordering rule when a rejected option is a global one in the
 * wrong position. `clio-coder run --no-context-files` failed with nothing but
 * "unknown option" while `clio-coder --no-context-files run` worked, which leaves the
 * user guessing at a rule the help text states only by where it lists the flag.
 */
export function globalFlagPositionHint(arg: string, command: string): string | null {
	if (INTERACTIVE_ONLY_FLAGS.has(arg)) {
		return `${arg} applies only to the interactive session; start it with clio-coder ${arg}`;
	}
	const usage = GLOBAL_ONLY_FLAGS.get(arg);
	if (usage === undefined) return null;
	return `${arg} is a global option and must come before the subcommand: clio-coder ${usage} ${command} ...`;
}

/** `--max-context-tokens <N>` as both `run` and the interactive session read it: N, or the error both print. */
export function parseMaxContextTokens(value: string | undefined): number | { error: string } {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : { error: "--max-context-tokens must be a positive integer" };
}

/**
 * Extract every global startup flag in one order-independent pass. Only flags
 * before the first positional command are global; later occurrences belong to
 * the subcommand. Keeping the value-taking flags in the same state machine is
 * important: three sequential extractors used to mistake one another's values
 * for the command boundary, so `--skill path --api-key SECRET paths` treated
 * SECRET as a subcommand and printed it in an error.
 */
export function extractGlobalFlags(
	argv: ReadonlyArray<string>,
	isSubcommand: (token: string) => boolean = () => false,
): GlobalCliFlags {
	const rest: string[] = [];
	let apiKey: string | undefined;
	let noContextFiles = false;
	let noSkills = false;
	let demo: boolean | undefined;
	let panes: "with" | undefined;
	let autonomy: AutonomyLevel | undefined;
	let toolLimits: SessionToolLimits | undefined;
	let sessionFile: string | undefined;
	let maxContextTokens: number | undefined;
	let resume: StartupResume | undefined;
	let fork = false;
	const skillPaths: string[] = [];
	const bootFlags: string[] = [];
	const rootFlags: string[] = [];
	const failed = (error: string): GlobalCliFlags => ({
		noContextFiles,
		noSkills,
		skillPaths,
		bootFlags,
		rootFlags,
		rest,
		error,
		...(apiKey === undefined ? {} : { apiKey }),
		...(panes === undefined ? {} : { panes }),
	});
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		if (arg === "--") {
			rest.push(...argv.slice(i + 1));
			break;
		}
		if (!arg.startsWith("-")) {
			rest.push(...argv.slice(i));
			break;
		}
		if (arg === "--acp") {
			// Treat the global spelling as a command boundary. Rewriting only the
			// sentinel keeps every trailing ACP option on the exact same dispatcher
			// and parser path as `clio-coder acp`, without importing that command into
			// the dependency-light startup graph.
			rest.push("acp", ...argv.slice(i + 1));
			break;
		}
		if (ROOT_FLAG_TOKENS.has(arg)) {
			rootFlags.push(arg);
			rest.push(arg);
			continue;
		}
		if (arg === "--no-context-files" || arg === "-nc") {
			noContextFiles = true;
			bootFlags.push(arg);
			continue;
		}
		if (arg === "--demo" || arg === "--no-demo") {
			demo = arg === "--demo";
			continue;
		}
		if (arg === "--no-skills") {
			noSkills = true;
			bootFlags.push(arg);
			continue;
		}
		if (arg === "--with-panes") {
			panes = "with";
			bootFlags.push(arg);
			continue;
		}
		if (arg === "--autonomy") {
			const value = argv[i + 1];
			if (value !== "default" && value !== "yolo") return failed("--autonomy must be default|yolo");
			autonomy = value;
			i += 1;
			continue;
		}
		if (arg === "--allow-tools" || arg === "--delegate-tools" || arg === "--deny-tools") {
			const value = argv[i + 1];
			const names = value === undefined || isSubcommand(value) ? null : parseToolLimitList(arg, value);
			if (names === null || "error" in names) return failed(names?.error ?? `${arg} requires a value`);
			toolLimits = { ...toolLimits, ...toolLimitConstraints(arg, names) };
			i += 1;
			continue;
		}
		if (arg === "--session-file") {
			const value = argv[i + 1];
			if (value === undefined || value.trim() === "" || value.startsWith("-") || isSubcommand(value))
				return failed("--session-file requires a path");
			sessionFile = resolve(value);
			i += 1;
			continue;
		}
		if (arg === "--max-context-tokens" || arg.startsWith("--max-context-tokens=")) {
			const inline = arg !== "--max-context-tokens";
			const n = parseMaxContextTokens(inline ? arg.slice("--max-context-tokens=".length) : argv[i + 1]);
			if (typeof n !== "number") return failed(n.error);
			maxContextTokens = n;
			if (!inline) i += 1;
			continue;
		}
		// The interactive app opens on a session the way every other agent CLI spells it (#191): `--resume <id|prefix>`
		// resolves like `/resume <id|prefix>`, a bare `--resume` opens the picker, and `--continue` takes the latest.
		if (arg === "--resume" || arg === "-r" || arg.startsWith("--resume=") || arg === "--continue" || arg === "-c") {
			if (resume !== undefined) return failed("--resume and --continue cannot be combined");
			const value = arg.startsWith("--resume=") ? arg.slice("--resume=".length) : undefined;
			const next = argv[i + 1];
			if (value === "") return failed("--resume= requires a session id");
			if (arg === "--continue" || arg === "-c") resume = { kind: "latest" };
			else if (value !== undefined) resume = { kind: "id", id: value };
			else if (next === undefined || next.startsWith("-") || isSubcommand(next)) resume = { kind: "picker" };
			else {
				resume = { kind: "id", id: next };
				i += 1;
			}
			continue;
		}
		if (arg === "--fork") {
			// Branch the session `--resume <id>` or `--continue` names; the parent is read and never written (SPEC L3).
			fork = true;
			continue;
		}
		if (arg === "--api-key" || arg === "--skill") {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("-") || isSubcommand(value)) return failed(`${arg} requires a value`);
			if (arg === "--api-key") apiKey = value;
			else skillPaths.push(value);
			bootFlags.push(arg);
			i += 1;
			continue;
		}
		if (arg === "-p" || arg === "--print" || arg === "--prompt") {
			return failed(`unknown global option: ${arg}; for one headless task use clio-coder run "<task>"`);
		}
		if (arg === "--session" || arg.startsWith("--session=")) {
			// CLI-1: `run --session` spells resume headless; the interactive app spells it --resume.
			return failed(`unknown global option: ${arg}; to open on a session use clio-coder --resume <id|prefix|name>`);
		}
		return failed(`unknown global option: ${arg}`);
	}
	if (fork) {
		if (resume === undefined || resume.kind === "picker")
			return failed("--fork branches the session --resume <id> or --continue names; pass one of them");
		resume = { ...resume, fork: true };
	}
	const toolConflict = toolLimits === undefined ? undefined : toolLimitConflict(toolLimits);
	if (toolConflict !== undefined) return failed(toolConflict);
	return {
		noContextFiles,
		noSkills,
		skillPaths,
		bootFlags,
		rootFlags,
		rest,
		...(apiKey === undefined ? {} : { apiKey }),
		...(panes === undefined ? {} : { panes }),
		...(autonomy === undefined ? {} : { autonomy }),
		...(toolLimits === undefined ? {} : { toolLimits }),
		...(sessionFile === undefined ? {} : { sessionFile }),
		...(maxContextTokens === undefined ? {} : { maxContextTokens }),
		...(resume === undefined ? {} : { resume }),
		...(demo === undefined ? {} : { demo }),
	};
}
