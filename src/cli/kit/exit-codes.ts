/**
 * Process exit codes shared by every CLI command (CLI convention C7, headless
 * contract table 6.5). `fleet events` keeps its own documented codes and is the
 * one named exception.
 *
 * Leaf of the CLI kit: imports nothing.
 */
export const EXIT_CODES = {
	/** The operation completed; a verdict command puts its verdict in the document (C19). */
	success: 0,
	/** The work started and did not succeed, or the named resource does not exist. */
	failed: 1,
	/** Usage, configuration, admission or authority: nothing started and no model was called. */
	notStarted: 2,
	approvalRequired: 3,
	limitReached: 4,
	inputRequired: 5,
	/** A lock is held or the awaited work is still live: retry later. */
	notReady: 75,
	/** `--timeout` expired. */
	deadline: 124,
	sighup: 129,
	sigint: 130,
	/** stdout's reader closed (SIGPIPE status). */
	readerClosed: 141,
	sigterm: 143,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
