/**
 * `--json` output for commands that print one document (CLI convention C6):
 * one compact object with `version: 1`, or, when the command cannot produce
 * its document, `{"version":1,"ok":false,"error":{"code","message"}}` on stdout
 * with the C3 diagnostic on stderr. NDJSON streams (`run`, `fleet run`,
 * `fleet events`) follow the headless contract instead.
 *
 * Leaf of the CLI kit: imports only other kit modules.
 */
import type { ErrorSlug } from "./slugs.js";
import { formatDiagnostic, formatUsageError, USAGE_SLUGS } from "./usage-error.js";

export const JSON_DOCUMENT_VERSION = 1;

export interface JsonFailureDocument {
	readonly version: typeof JSON_DOCUMENT_VERSION;
	readonly ok: false;
	readonly error: { readonly code: ErrorSlug; readonly message: string };
}

interface TextSink {
	write(chunk: string): unknown;
}

/** The document a `--json` command prints, with the schema version first. */
export function jsonDocument<T extends object & { version?: never }>(
	fields: T,
): { version: typeof JSON_DOCUMENT_VERSION } & T {
	return { version: JSON_DOCUMENT_VERSION, ...fields };
}

function jsonFailure(slug: ErrorSlug, message: string): JsonFailureDocument {
	return { version: JSON_DOCUMENT_VERSION, ok: false, error: { code: slug, message } };
}

/** One compact JSON line. */
export function writeJson(sink: TextSink, value: unknown): void {
	sink.write(`${JSON.stringify(value)}\n`);
}

export interface CliFailure {
	/** The command path after `clio-coder`, such as `["fleet", "verify"]`. */
	readonly path: ReadonlyArray<string>;
	readonly slug: ErrorSlug;
	readonly message: string;
	/** `--json` was given: the failure document goes to stdout as well. */
	readonly json: boolean;
}

/**
 * Report a command that could not produce its document. The exit code is the
 * caller's: the same slug exits 1 from an inspection and 2 from a command that
 * starts work (C7).
 */
export function writeCliFailure(
	failure: CliFailure,
	streams: { readonly stdout: TextSink; readonly stderr: TextSink } = {
		stdout: process.stdout,
		stderr: process.stderr,
	},
): void {
	if (failure.json) writeJson(streams.stdout, jsonFailure(failure.slug, failure.message));
	const line = USAGE_SLUGS.has(failure.slug)
		? formatUsageError(failure.path, failure.message)
		: formatDiagnostic(failure.path, failure.message);
	streams.stderr.write(`${line}\n`);
}
