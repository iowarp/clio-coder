/**
 * The one diagnostic shape every CLI command prints (CLI convention C3):
 * `clio-coder <path>: <message>` on stderr, plus `see: clio-coder <path> --help`
 * for a usage error, and never the full help.
 *
 * Leaf of the CLI kit: imports types only.
 */
import type { ErrorSlug } from "./slugs.js";

const CLI_NAME = "clio-coder";

/** Slugs that mean the caller asked wrongly; their diagnostic points at the command's help. */
export const USAGE_SLUGS: ReadonlySet<ErrorSlug> = new Set<ErrorSlug>([
	"usage",
	"unknown_command",
	"unknown_flag",
	"flag_conflict",
	"empty_task",
	"task_file_conflict",
	"task_flag_conflict",
]);

function commandName(path: ReadonlyArray<string>): string {
	return [CLI_NAME, ...path].join(" ");
}

/** `clio-coder fleet run: <message>`, one line without a trailing newline. */
export function formatDiagnostic(path: ReadonlyArray<string>, message: string): string {
	return `${commandName(path)}: ${message}`;
}

/** The C3 diagnostic and the line that points at the command's help, joined by a newline. */
export function formatUsageError(path: ReadonlyArray<string>, message: string): string {
	return `${formatDiagnostic(path, message)}\nsee: ${commandName(path)} --help`;
}

/**
 * A caller's mistake raised from deep inside a command. The class name ends in
 * `UsageError`, which the CLI entry's last-resort handler reads to skip the
 * crash record it writes for a real failure.
 */
export class CliUsageError extends Error {
	readonly path: ReadonlyArray<string>;
	readonly slug: ErrorSlug;

	constructor(path: ReadonlyArray<string>, slug: ErrorSlug, message: string) {
		super(message);
		this.name = "CliUsageError";
		this.path = path;
		this.slug = slug;
	}
}
