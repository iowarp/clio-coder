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

export function defineCommandSpec(spec: CommandSpec): CommandSpec {
	return Object.freeze({ ...spec, path: Object.freeze([...spec.path]) as CommandSpec["path"] });
}

/** `--help` or `-h` among a command's own arguments, before any `--`. */
export function helpRequested(args: ReadonlyArray<string>): boolean {
	const end = args.indexOf("--");
	const options = end === -1 ? args : args.slice(0, end);
	return options.includes("--help") || options.includes("-h");
}
