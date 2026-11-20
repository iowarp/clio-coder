/**
 * Deprecated spellings and tombstones of the 0.8.x command line (CLI SPEC section 9, lane L12).
 *
 * Every deprecated spelling keeps working through 0.8.x and is removed in 0.9.0. Each row names its class:
 * `identical` spellings produce the same stdout and exit as the replacement and add one stderr line starting
 * `clio-coder: deprecated:`; `migration` spellings keep their v1 output, which the replacement does not reproduce.
 *
 * `notice` says who prints that line, so no invocation prints two:
 * - `dispatcher`: `src/cli/index.ts` prints it from `deprecatedSpelling` before the command loads.
 * - `module`: the command module prints it where it parses the spelling (`where`).
 * - `pending`: the replacement is not in this build, so nothing points at it yet; `where` names the owning lane.
 *
 * Tombstones are removed commands: every invocation, `--help` included, exits 2 with a pointer, and the dispatcher
 * checks them before any command's own help interceptor (C1).
 *
 * Imports nothing: the dispatcher loads it on every subcommand.
 */

export type DeprecationClass = "identical" | "migration";

export interface DeprecatedSpelling {
	/** The old spelling, as typed after `clio-coder`. */
	readonly old: string;
	/** The spelling that replaces it. */
	readonly replacement: string;
	readonly class: DeprecationClass;
	readonly notice: "dispatcher" | "module" | "pending";
	/** `module`: the file that prints the notice; `pending`: the lane that owns the replacement. */
	readonly where?: string;
	/** `dispatcher` rows: does this invocation (the words after `clio-coder`) use the old spelling? */
	readonly matches?: (words: ReadonlyArray<string>) => boolean;
}

/** The words before a `--`: after it everything is operand text. */
function options(words: ReadonlyArray<string>): ReadonlyArray<string> {
	const end = words.indexOf("--");
	return end === -1 ? words : words.slice(0, end);
}

/** `<command> <verb>`: the verb is the first word after the command that is not a flag. */
function verb(command: string, verbs: ReadonlyArray<string>): (words: ReadonlyArray<string>) => boolean {
	return (words) => {
		if (words[0] !== command) return false;
		const first = options(words.slice(1)).find((word) => !word.startsWith("-"));
		return first !== undefined && verbs.includes(first);
	};
}

function topLevel(command: string): (words: ReadonlyArray<string>) => boolean {
	return (words) => words[0] === command;
}

/** `semantic` reads its verb from the first argument, flag or not (`src/cli/semantic.ts`). */
function semanticVerb(name: string): (words: ReadonlyArray<string>) => boolean {
	return (words) => words[0] === "semantic" && words[1] === name;
}

const pending = (old: string, replacement: string, lane: string): DeprecatedSpelling => ({
	old,
	replacement,
	class: "identical",
	notice: "pending",
	where: lane,
});

const viaDispatcher = (
	old: string,
	replacement: string,
	matches: (words: ReadonlyArray<string>) => boolean,
): DeprecatedSpelling => ({ old, replacement, class: "identical", notice: "dispatcher", matches });

const viaModule = (old: string, replacement: string, where: string, kind: DeprecationClass): DeprecatedSpelling => ({
	old,
	replacement,
	class: kind,
	notice: "module",
	where,
});

/** One row per section 9 spelling, in the section's order. */
export const DEPRECATED_SPELLINGS: ReadonlyArray<DeprecatedSpelling> = [
	viaDispatcher("--acp", "acp", (words) => words[0] === "--acp"),
	viaModule("run --json", "run --output-format stream-json", "src/cli/run.ts", "migration"),
	viaModule("run --json-events full", "run --output-format stream-json", "src/cli/run.ts", "migration"),
	viaModule("run --json-events terminal", "run --output-format json", "src/cli/run.ts", "migration"),
	// The warning also feeds the run's failure record, so it keeps run's own `clio-coder run:` prefix.
	viaModule("run --session <id>", "run --resume <id>", "src/cli/args.ts", "identical"),
	viaModule("run <task> with piped stdin and no -", "run <task> -", "src/cli/initial-message.ts", "identical"),
	viaModule("fleet run --json", "fleet run --output-format stream-json", "src/cli/fleet.ts", "migration"),
	viaDispatcher("fleet drain", "fleet admission drain", verb("fleet", ["drain"])),
	viaDispatcher("fleet resume", "fleet admission open", verb("fleet", ["resume"])),
	viaDispatcher("ext", "extensions", topLevel("ext")),
	pending("extensions list", "library list --kind extension", "L10"),
	pending("extensions install", "library install --kind extension", "L10"),
	pending("extensions enable", "library enable --kind extension", "L10"),
	pending("extensions disable", "library disable --kind extension", "L10"),
	pending("extensions remove", "library remove --kind extension", "L10"),
	viaDispatcher("export", "share export", topLevel("export")),
	viaDispatcher("import", "share import", topLevel("import")),
	viaDispatcher("targets add", "configure", verb("targets", ["add"])),
	viaDispatcher("targets fleet", "targets profile list", verb("targets", ["fleet"])),
	viaDispatcher("targets workers", "targets profile list", verb("targets", ["workers"])),
	viaModule("targets worker <tail...>", "targets profile <tail...>", "src/cli/targets.ts", "identical"),
	pending("configure --orchestrator-model", "configure --chat-model", "L8"),
	pending("configure --set-orchestrator", "configure --set-chat", "L8"),
	pending("configure --background-model", "configure --memory-model", "L8"),
	pending("configure --set-background", "configure --set-memory", "L8"),
	viaModule("reset --force", "reset --yes", "src/cli/reset.ts", "identical"),
	viaModule("uninstall --force", "uninstall --yes", "src/cli/uninstall.ts", "identical"),
	viaModule("tools status --reset-profile", "tools reset-profile <id>", "src/cli/tools.ts", "identical"),
	pending("context init --preview", "context init --dry-run", "L10"),
	viaModule("verifiers --cwd", "verifiers --check-cwd", "src/cli/verifiers.ts", "identical"),
	pending("acp --permission-timeout <bare number>", "acp --permission-timeout <duration>", "L4"),
	pending("research --max-wall-minutes", "research --timeout <duration>", "L11"),
	viaDispatcher("semantic inbox-add", "semantic inbox add", semanticVerb("inbox-add")),
	viaDispatcher("semantic inbox-list", "semantic inbox list", semanticVerb("inbox-list")),
	viaDispatcher("semantic inbox-remove", "semantic inbox remove", semanticVerb("inbox-remove")),
	viaDispatcher("semantic inbox-preview", "semantic inbox preview", semanticVerb("inbox-preview")),
	viaDispatcher("components", "dev components", topLevel("components")),
	viaDispatcher("evolve", "dev evolve", topLevel("evolve")),
	viaDispatcher("flywheel", "dev flywheel", topLevel("flywheel")),
	pending("--user", "--scope user", "L10"),
	pending("--project", "--scope project", "L10"),
	pending("--both", "--scope both", "L10"),
];

/** The dispatcher row this invocation spells, if any; at most one notice per process. */
export function deprecatedSpelling(words: ReadonlyArray<string>): DeprecatedSpelling | undefined {
	return DEPRECATED_SPELLINGS.find((row) => row.notice === "dispatcher" && row.matches?.(words) === true);
}

/** The one stderr line for a deprecated spelling. */
export function deprecationNotice(row: DeprecatedSpelling): string {
	return `clio-coder: deprecated: ${row.old}; use clio-coder ${row.replacement} (removed in 0.9.0)\n`;
}

/** True when `path` is a deprecated spelling with a live replacement, which help listings leave out. */
export function isDeprecatedPath(path: ReadonlyArray<string>): boolean {
	const words = path.join(" ");
	return DEPRECATED_SPELLINGS.some((row) => row.notice === "dispatcher" && row.old === words);
}

export interface Tombstone {
	/** The removed command path. */
	readonly path: ReadonlyArray<string>;
	readonly reason: string;
	/** What to run instead, printed as `use: <pointer>`. */
	readonly pointer: string;
}

const TOMBSTONES: ReadonlyArray<Tombstone> = [
	{ path: ["context-init"], reason: "this command was removed", pointer: "clio-coder context init" },
	{ path: ["context-index"], reason: "this command was removed", pointer: "clio-coder context index" },
	{ path: ["context-clear"], reason: "this command was removed", pointer: "clio-coder context reset" },
	{
		path: ["fleet", "inspect"],
		reason: "this command was removed; the run board and the read model serve what it carried",
		pointer: "clio-coder fleet status --json [--all], or clio-coder telemetry inspect --run <runId> --json",
	},
	{
		path: ["evidence", "build"],
		reason: "this command was removed; every run is assessed when it settles",
		pointer: "clio-coder evidence inspect <runId>",
	},
];

/** The top-level tombstone names, which stay command-shaped so a root value flag never swallows one. */
export const TOMBSTONE_COMMANDS: ReadonlySet<string> = new Set(
	TOMBSTONES.filter((tombstone) => tombstone.path.length === 1).map((tombstone) => tombstone.path[0] ?? ""),
);

/** The tombstone this invocation names: the command and, for a nested one, its first non-flag word. */
export function tombstoneFor(words: ReadonlyArray<string>): Tombstone | undefined {
	return TOMBSTONES.find((tombstone) => {
		if (tombstone.path[0] !== words[0]) return false;
		if (tombstone.path.length === 1) return true;
		return verb(words[0] ?? "", [tombstone.path[1] ?? ""])(words);
	});
}
