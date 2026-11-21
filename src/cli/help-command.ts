/**
 * `clio-coder help [<path>...] [--json]` (SPEC 6.15, review R09).
 *
 * `help --json` prints the command manifest: one entry per canonical leaf path, built from the light specs in
 * `src/cli/specs/` alone, so it loads no command implementation. `help <path>` prints that path's own help by running
 * `clio-coder <path> --help` in a child, which keeps this module free of every command graph too.
 *
 * Fields the specs do not declare yet are derived: `positionals` and `flags` from the leaf's synopsis, `effects`
 * from its verb. Such an entry says `"source": "usage"`; a curated entry says `"source": "spec"`.
 */
import { spawnSync } from "node:child_process";
import { EXIT_CODES } from "./kit/exit-codes.js";
import { type FlagSpec, helpRequested, type LeafFlagsSpec } from "./kit/help.js";
import { jsonDocument, writeCliFailure, writeJson } from "./kit/json-out.js";
import { ERROR_SLUGS } from "./kit/slugs.js";
import { type ManifestFlag, type ManifestValue, NESTED_LEAVES, RUN_FLAGS, TOP_LEVEL_USAGE } from "./specs/manifest.js";
import { SCHEMA_NAMES } from "./specs/schema.js";
import { COMMAND_SPECS } from "./specs/table.js";

const HELP_PATH = ["help"] as const;

const HELP = `clio-coder help [<command> [<subcommand>...]] [--all]
clio-coder help --json [<command> [<subcommand>...]]
clio-coder help run --topics

Print a command's help, as clio-coder <command> --help does. With no command, the root help;
--all adds every command under 'clio-coder dev'.

--json prints the command manifest as one JSON document (version 1, schema: clio-coder schema help):
every canonical leaf path with its aliases, summary, positionals, stdin use, flags (value type,
placement, which run mode a flag applies to, conflicts, deprecation), effects, outputs and the
schema of each, exit codes, whether it runs long, and what a zero exit means. A path narrows it
to that path and the leaves under it. Reading the manifest loads no command implementation.

--topics prints run's full reference prose.
`;

type Effect = "read" | "write-local" | "network" | "model" | "destructive";
type StdinUse = "none" | "task" | "secret" | "data";
type SuccessMeans = "completed" | "accepted" | "allChildrenPassed";

interface ManifestPositional {
	name: string;
	required: boolean;
	variadic: boolean;
}

/** A leaf's flag row; `persistence` comes only from a spec's curated `leafFlags` (SPEC 6.4, review R08). */
type LeafFlag = ManifestFlag & { readonly persistence?: FlagSpec["persistence"] };

interface ManifestOutput {
	format: "text" | "json" | "stream-json";
	schema?: string;
}

interface ManifestLeaf {
	path: string[];
	aliases: string[][];
	hidden: boolean;
	kind: "leaf" | "group";
	/** C2: a group that runs a read when given no subcommand. */
	defaultAction?: boolean;
	/** C1: a private wire entry that need not answer `--help`. */
	exempt?: string;
	summary: string;
	usage?: string;
	positionals: ManifestPositional[];
	stdin: StdinUse;
	flags: LeafFlag[];
	effects: Effect[];
	outputs: ManifestOutput[];
	exit: { codes: number[]; exitCodeMap?: Record<string, number> };
	longRunning: boolean;
	successMeans: SuccessMeans;
	source: "spec" | "usage";
}

/** C2: groups that run a read when bare. */
const DEFAULT_ACTION_GROUPS = new Set([
	"context",
	"targets",
	"agents",
	"tasks",
	"claims",
	"research",
	"components",
	"semantic",
	"auth",
	"config",
	"models",
]);

/** C1: private wire entries, exempt from the `--help` rule. */
const EXEMPT: Readonly<Record<string, string>> = {
	setup: "private wire entry: accepts exactly --next",
	worker: "private wire entry: WorkerSpec on stdin, NDJSON on stdout",
};

const LONG_RUNNING = new Set([
	"acp",
	"gui",
	"run",
	"worker",
	"arena run",
	"campaign run",
	"research start",
	"research resume",
	"fleet run",
	"fleet wait",
	"fleet events",
]);

const MODEL_WORK = new Set([
	"run",
	"acp",
	"arena run",
	"campaign run",
	"research start",
	"research resume",
	"fleet run",
]);
const READ_VERBS = new Set([
	"list",
	"show",
	"status",
	"inspect",
	"get",
	"view",
	"search",
	"stat",
	"ls",
	"tags",
	"history",
	"where",
	"standings",
	"bindings",
	"diff",
	"validate",
	"graph",
	"decisions",
	"code-steps",
	"events",
	"calls",
	"cost",
	"tokens",
	"timeline",
	"why-stopped",
	"quota",
	"health",
	"runs",
	"explain",
	"insights",
	"drift",
	"inventory",
	"components",
	"report",
	"dry-run",
	"wait",
	"version",
	"paths",
	"doctor",
	"models",
	"agents",
	"claims",
	"tasks",
	"help",
	"schema",
]);
const DESTRUCTIVE_VERBS = new Set([
	"remove",
	"rm",
	"rm-tag",
	"reset",
	"uninstall",
	"forget",
	"prune",
	"terminate",
	"drop",
]);
const NETWORK_VERBS = new Set([
	"send",
	"sweep",
	"login",
	"install",
	"update",
	"sync",
	"push",
	"upgrade",
	"share",
	"test",
]);

const RUN_EXIT = [0, 1, 2, 3, 4, 5, 124, 129, 130, 141, 143];

function effectsFor(key: string, verb: string): Effect[] {
	if (MODEL_WORK.has(key)) return ["read", "write-local", "network", "model"];
	if (DESTRUCTIVE_VERBS.has(verb)) return ["write-local", "destructive"];
	if (NETWORK_VERBS.has(verb)) return ["read", "write-local", "network"];
	if (READ_VERBS.has(verb)) return ["read"];
	return ["read", "write-local"];
}

function outputsFor(key: string, usage: string | undefined): ManifestOutput[] {
	switch (key) {
		case "run":
			return [
				{ format: "text" },
				{ format: "json", schema: "run-result" },
				{ format: "stream-json", schema: "run-events" },
			];
		case "fleet run":
			return [
				{ format: "text" },
				{ format: "json", schema: "fleet-result" },
				{ format: "stream-json", schema: "fleet-result" },
			];
		case "fleet wait":
			return [{ format: "text" }, { format: "json", schema: "fleet-result" }];
		case "help":
			return [{ format: "text" }, { format: "json", schema: "help" }];
		case "schema":
			return [{ format: "json" }];
		default:
			return usage?.includes("--json") === true ? [{ format: "text" }, { format: "json" }] : [{ format: "text" }];
	}
}

function exitFor(key: string): ManifestLeaf["exit"] {
	switch (key) {
		case "run":
			return { codes: RUN_EXIT };
		case "fleet verify":
			return { codes: [0, 1, 2, 75], exitCodeMap: { verified: 0, failed: 1, unavailable: 1, pending: 75 } };
		case "evidence inspect":
			return { codes: [0, 1, 2], exitCodeMap: { sealed: 0, failedSeal: 1, unsettled: 1 } };
		case "campaign run":
			return { codes: [0, 1, 2], exitCodeMap: { pass: 0, partial: 1, fail: 1 } };
		case "fleet run":
		case "fleet wait":
			return { codes: [0, 1, 2, 4, 124, 129, 130, 141, 143] };
		case "fleet cancel":
			return { codes: [0, 1, 2, 75] };
		default:
			return { codes: [0, 1, 2] };
	}
}

/**
 * Synopsis tokens. A space-free `a|b` word run stays one token, so a value set after a flag (`--method browser|device`)
 * reaches the flag as its choices; a `|` with spaces around it, or before a flag (`[--json|--text]`), stays its own
 * token and separates alternatives as before. `(` and `)` group alternatives that share what follows them
 * (`(--session | --verify) <id|path>`). An inline `=value` stops at a closing bracket.
 */
const TOKEN =
	/\[|\]|\(|\)|\||--[a-z][a-z0-9-]*(?:=[^\s\]]+)?|<[^>]+>(?:\.\.\.)?|\.\.\.|[^\s[\]|()]+(?:\|[^\s[\]|()-][^\s[\]|()]*)*/gu;
/** A value set word: `a|b|c`, each choice a plain word such as `user-managed`. */
const VALUE_SET = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\|[A-Za-z0-9][A-Za-z0-9-]*)+$/u;
/** A metavariable spelled in capitals, such as `SHA256` or `N`. */
const CAPS_VALUE = /^[A-Z][A-Z0-9_]*$/u;

function synopsisValue(valueText: string): ManifestValue {
	const bare = valueText.replace(/^<|>(?:\.\.\.)?$/gu, "");
	return bare.includes("|") ? bare.split("|") : "string";
}

/**
 * Positionals and flags read from a synopsis such as `store put <tag> <file> [--blob <name>] [--json]`. A `( a | b )`
 * group's flags conflict with each other and take the value that follows the group; a positional on either side of
 * a top-level ` | ` is one alternative, so it is not required (`<session> | --run <run-id>`).
 */
function fromUsage(usage: string, pathLength: number): { positionals: ManifestPositional[]; flags: ManifestFlag[] } {
	const tokens = usage.split(/\s+/u).slice(pathLength).join(" ").match(TOKEN) ?? [];
	const positionals: ManifestPositional[] = [];
	const flags = new Map<string, ManifestFlag>();
	const groups: Array<{ names: string[]; alternatives: boolean }> = [];
	let depth = 0;
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i] ?? "";
		if (token === "[") depth += 1;
		else if (token === "]") depth = Math.max(0, depth - 1);
		else if (token === "(") groups.push({ names: [], alternatives: false });
		else if (token === ")") {
			const group = groups.pop();
			if (group === undefined) continue;
			const next = tokens[i + 1];
			const shared = next?.startsWith("<") ? synopsisValue(next) : undefined;
			if (shared !== undefined) i += 1;
			for (const name of group.names) {
				const flag = flags.get(name);
				if (flag === undefined) continue;
				const conflicts = group.alternatives ? group.names.filter((other) => other !== name) : [];
				flags.set(name, {
					...flag,
					...(shared !== undefined && flag.value === "boolean" ? { value: shared } : {}),
					...(conflicts.length > 0 ? { conflicts } : {}),
				});
			}
			groups.at(-1)?.names.push(...group.names);
		} else if (token === "|") {
			const group = groups.at(-1);
			if (group !== undefined) group.alternatives = true;
			else if (depth === 0 && tokens[i - 1]?.startsWith("<")) {
				const last = positionals.at(-1);
				if (last !== undefined) last.required = false;
			}
		} else if (token === "...") {
			const last = positionals.at(-1);
			if (last !== undefined) last.variadic = true;
		} else if (/^--?[a-z]/u.test(token)) {
			const [name = token, inline] = token.split("=", 2);
			let value: ManifestValue = "boolean";
			const next = tokens[i + 1];
			const valueText =
				inline ??
				(next !== undefined && (next.startsWith("<") || VALUE_SET.test(next) || CAPS_VALUE.test(next)) ? next : undefined);
			if (valueText !== undefined) {
				if (inline === undefined) i += 1;
				value = synopsisValue(valueText);
			}
			if (!flags.has(name)) flags.set(name, { name, value });
			groups.at(-1)?.names.push(name);
		} else if (token.startsWith("<")) {
			positionals.push({
				name: token.replace(/^<|>(?:\.\.\.)?$/gu, ""),
				required: depth === 0 && !(groups.length === 0 && tokens[i - 1] === "|"),
				variadic: token.endsWith("..."),
			});
		}
	}
	flags.set("--help", { name: "--help", aliases: ["-h"], value: "boolean" });
	return { positionals, flags: [...flags.values()] };
}

function leafEntry(
	path: string[],
	summary: string,
	usage: string | undefined,
	options: { hidden: boolean; kind: "leaf" | "group" },
): ManifestLeaf {
	const key = path.join(" ");
	const verb = path.at(-1) ?? "";
	const top = path[0] ?? "";
	const parsed =
		key === "run"
			? { positionals: [{ name: "task", required: false, variadic: true }], flags: RUN_FLAGS }
			: usage !== undefined
				? fromUsage(usage, path.length)
				: { positionals: [], flags: [{ name: "--help", aliases: ["-h"], value: "boolean" as const }] };
	return {
		path,
		aliases: [],
		hidden: options.hidden,
		kind: options.kind,
		...(options.kind === "group" ? { defaultAction: DEFAULT_ACTION_GROUPS.has(top) && path.length === 1 } : {}),
		...(EXEMPT[key] !== undefined ? { exempt: EXEMPT[key] } : {}),
		summary,
		...(usage !== undefined ? { usage } : {}),
		positionals: parsed.positionals,
		stdin: key === "run" ? "task" : key === "worker" ? "data" : "none",
		flags: [...parsed.flags],
		effects: effectsFor(key, verb),
		outputs: outputsFor(key, usage),
		exit: exitFor(key),
		longRunning: LONG_RUNNING.has(key),
		successMeans: key === "fleet run" || key === "fleet wait" ? "allChildrenPassed" : "completed",
		source: key === "run" || key === "help" || key === "schema" ? "spec" : "usage",
	};
}

/** A spec's curated rows over the flags read from the synopsis: a named flag is refined, a new one goes before `--help`. */
function withCuratedFlags(derived: ReadonlyArray<LeafFlag>, curated: ReadonlyArray<FlagSpec>): LeafFlag[] {
	const flags = new Map(derived.map((flag) => [flag.name, flag]));
	const help = flags.get("--help");
	flags.delete("--help");
	for (const flag of curated) flags.set(flag.name, { ...flags.get(flag.name), ...flag });
	return help !== undefined ? [...flags.values(), help] : [...flags.values()];
}

/** Every canonical leaf, top-level commands first in table order, then nested leaves by path. */
async function buildManifest(): Promise<ManifestLeaf[]> {
	const nested = new Map<string, readonly [string, string, string]>();
	for (const row of NESTED_LEAVES) nested.set(row[0], row);
	const tops: Array<{ name: string; summary: string; hidden: boolean }> = [];
	const curated = new Map<string, ReadonlyArray<FlagSpec>>();
	for (const [name, load] of Object.entries(COMMAND_SPECS)) {
		const module: { spec: { summary: string; hidden: boolean } } & Record<string, unknown> = await load();
		if (Array.isArray(module.leafFlags))
			for (const item of module.leafFlags as ReadonlyArray<LeafFlagsSpec>) curated.set(item.path.join(" "), item.flags);
		tops.push({ name, summary: module.spec.summary, hidden: module.spec.hidden });
		// Leaves a lane already declared in the command's own spec module.
		for (const list of [module.leaves, module.leafSpecs]) {
			if (!Array.isArray(list)) continue;
			for (const item of list as Array<{ path: string[]; summary: string }>) {
				const key = item.path.join(" ");
				const known = nested.get(key);
				nested.set(key, [key, item.summary, known?.[2] ?? ""]);
			}
		}
	}
	const hiddenTop = new Set(tops.filter((top) => top.hidden).map((top) => top.name));
	const parents = new Set<string>();
	for (const key of nested.keys()) {
		const words = key.split(" ");
		for (let end = 1; end < words.length; end += 1) parents.add(words.slice(0, end).join(" "));
	}
	const entries: ManifestLeaf[] = tops.map((top) =>
		leafEntry([top.name], top.summary, TOP_LEVEL_USAGE[top.name], {
			hidden: top.hidden,
			kind: parents.has(top.name) ? "group" : "leaf",
		}),
	);
	for (const key of [...nested.keys()].sort()) {
		const [, summary, usage] = nested.get(key) ?? [key, "", ""];
		const path = key.split(" ");
		entries.push(
			leafEntry(path, summary, usage.length > 0 ? usage : undefined, {
				hidden: hiddenTop.has(path[0] ?? ""),
				kind: parents.has(key) ? "group" : "leaf",
			}),
		);
	}
	const byKey = new Map(entries.map((entry) => [entry.path.join(" "), entry]));
	for (const [key, flags] of curated) {
		const entry = byKey.get(key);
		if (entry !== undefined) entry.flags = withCuratedFlags(entry.flags, flags);
	}
	return entries;
}

/** The flags the root accepts before a subcommand (SPEC 6.4, C18): where each goes and how long it lives. */
const ROOT_FLAGS = [
	{ name: "--api-key", value: "string", placement: "root", persistence: "ephemeral", appliesTo: ["run", "acp"] },
	{
		name: "--no-context-files",
		aliases: ["-nc"],
		value: "boolean",
		placement: "both",
		persistence: "ephemeral",
		appliesTo: ["run", "acp"],
	},
	{ name: "--skill", value: "string", placement: "both", persistence: "ephemeral", appliesTo: ["run", "acp"] },
	{ name: "--no-skills", value: "boolean", placement: "both", persistence: "ephemeral", appliesTo: ["run", "acp"] },
] as const;

function runChildHelp(path: ReadonlyArray<string>, extra: ReadonlyArray<string>): number {
	const entry = process.argv[1];
	if (entry === undefined) return EXIT_CODES.failed;
	const child = spawnSync(process.execPath, [...process.execArgv, entry, ...path, "--help", ...extra], {
		stdio: "inherit",
	});
	if (child.error !== undefined) {
		writeCliFailure({ path: HELP_PATH, slug: "io", message: child.error.message, json: false });
		return EXIT_CODES.failed;
	}
	return child.status ?? EXIT_CODES.failed;
}

export async function runHelpCommand(args: ReadonlyArray<string>): Promise<number> {
	const words: string[] = [];
	let json = false;
	let all = false;
	let topics = false;
	for (const arg of args) {
		if (arg === "--json") json = true;
		else if (arg === "--all") all = true;
		else if (arg === "--topics") topics = true;
		else if (arg === "--help" || arg === "-h") continue;
		else if (arg.startsWith("-")) {
			writeCliFailure({ path: HELP_PATH, slug: "unknown_flag", message: `unknown option: ${arg}`, json });
			return EXIT_CODES.notStarted;
		} else words.push(arg);
	}
	if (helpRequested(args) && words.length === 0) {
		process.stdout.write(HELP);
		return EXIT_CODES.success;
	}
	if (topics && (words.join(" ") !== "run" || json)) {
		writeCliFailure({ path: HELP_PATH, slug: "usage", message: "--topics applies only to help run", json });
		return EXIT_CODES.notStarted;
	}
	if (all && (json || words.length > 0)) {
		writeCliFailure({ path: HELP_PATH, slug: "usage", message: "--all applies only to the root help", json });
		return EXIT_CODES.notStarted;
	}
	const manifest = words.length > 0 || json ? await buildManifest() : [];
	const key = words.join(" ");
	if (words.length > 0) {
		const known = manifest.some(
			(entry) => entry.path.join(" ") === key || entry.aliases.some((alias) => alias.join(" ") === key),
		);
		if (!known) {
			writeCliFailure({ path: HELP_PATH, slug: "unknown_command", message: `unknown command: ${key}`, json });
			return EXIT_CODES.notStarted;
		}
	}
	if (topics) {
		process.stdout.write((await import("./run-help.js")).RUN_TOPICS);
		return EXIT_CODES.success;
	}
	if (json) {
		const leaves =
			words.length === 0
				? manifest
				: manifest.filter((entry) => entry.path.join(" ") === key || entry.path.join(" ").startsWith(`${key} `));
		writeJson(
			process.stdout,
			jsonDocument({
				schema: "help",
				leaves,
				rootFlags: ROOT_FLAGS,
				errorSlugs: ERROR_SLUGS,
				exitCodes: EXIT_CODES,
				schemas: SCHEMA_NAMES,
			}),
		);
		return EXIT_CODES.success;
	}
	if (words.length === 0) return runChildHelp([], all ? ["--all"] : []);
	return runChildHelp(words, []);
}
