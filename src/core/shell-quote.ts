/**
 * POSIX single-quote escaping for one shell word.
 *
 * Every consumer here builds a command string that a POSIX shell will parse:
 * an eval runner's `sh -c`, the SSH transport's remote command, and an
 * external editor launched through `$SHELL -lc`. The escaping a
 * single-quoted POSIX word needs is fixed by the shell grammar rather than
 * chosen per caller, so there is one rule and it cannot drift per consumer
 * without that consumer having stopped targeting a POSIX shell.
 *
 * Inside single quotes a POSIX shell treats every byte literally, including
 * backslashes, so the only character that needs handling is the quote itself.
 * `'\''` closes the string, emits an escaped literal quote, and reopens it.
 *
 * The result always begins and ends with a single quote, including for the
 * empty string, which is what makes it exactly one word. `fleet-preflight.ts`
 * relies on that shape: it strips the outer pair to embed an already-escaped
 * value inside a `case` pattern, so an implementation that returned a bare
 * word for safe input would silently break that caller.
 *
 * This is quoting for a shell, never sanitization for a security boundary. A
 * quoted word is one argument; it is not a value that has been vetted.
 */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}
