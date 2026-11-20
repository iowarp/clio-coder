/**
 * Light command metadata (spec stubs) and the help request test (CLI
 * convention C1). A spec under `src/cli/specs/` holds what root help and
 * `help --json` need without importing the command's implementation.
 *
 * Leaf of the CLI kit: imports nothing.
 */
export interface CommandSpec {
	/** The command path after `clio-coder`, such as `["fleet"]` or `["session", "history"]`. */
	readonly path: readonly [string, ...string[]];
	/** One line, lower case, no trailing period. */
	readonly summary: string;
	/** Absent from the default root help; the command still resolves. */
	readonly hidden: boolean;
}

/** How a flag carries its value in `help --json`: a switch, free text, a number, a duration (C11), a path or one of a set. */
export type FlagValue = "boolean" | "string" | "number" | "duration" | "path" | readonly string[];

/**
 * One flag a spec curates for `help --json` (SPEC 6.4, review R08). `placement` says where the flag may stand;
 * `persistence` says how long what it carries lives: `persisted` when the command writes it to disk, `ephemeral` when
 * it lives in memory for this process. Absent means the spec does not say.
 */
export interface FlagSpec {
	readonly name: string;
	readonly aliases?: readonly string[];
	readonly value: FlagValue;
	readonly repeatable?: boolean;
	readonly placement?: "leaf" | "both";
	readonly persistence?: "ephemeral" | "persisted";
	readonly conflicts?: readonly string[];
	readonly deprecated?: string;
}

/**
 * Curated flags for one leaf path, exported by a spec module as `leafFlags`. `help --json` lays each row over the flag
 * of the same name it reads from the leaf's synopsis and adds the rows the synopsis does not name.
 */
export interface LeafFlagsSpec {
	readonly path: readonly [string, ...string[]];
	readonly flags: readonly FlagSpec[];
}

export function defineCommandSpec(spec: CommandSpec): CommandSpec {
	return Object.freeze({ ...spec, path: Object.freeze([...spec.path]) as CommandSpec["path"] });
}

/** `--help` or `-h` among a command's own arguments, before any `--`. */
export function helpRequested(args: ReadonlyArray<string>): boolean {
	const end = args.indexOf("--");
	const options = end === -1 ? args : args.slice(0, end);
	return options.includes("--help") || options.includes("-h");
}
