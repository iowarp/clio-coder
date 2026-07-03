/**
 * Shared styling for bracketed transcript notices (replay and system lines
 * such as `[retry]`, `[model]`, `[thinking]`, `[file ...]`, `[skill]`,
 * `[checkpoint]`, and `[session]`). The leading bracketed tag renders in dim
 * and the message body in muted so these lines read as quiet scaffolding rather
 * than agent output. The `[retry]` tag takes warning instead of dim because a
 * retry is a real warning state. Lines without a leading bracketed tag are
 * returned unchanged, so `system:` prefixes and free-form content stay plain.
 *
 * Pure: no I/O, no module-level mutable state beyond the shared theme handle.
 */
import { clioTheme } from "../theme/index.js";

const theme = clioTheme();

// A leading bracketed tag is `[` then any run of non-`]` characters then `]`,
// capturing the whole tag (including inner spaces like `[file read]`) and the
// remainder as the message body.
const LEADING_TAG = /^(\[[^\]]+\])([\s\S]*)$/u;

export function styleTaggedNotice(line: string): string {
	const match = LEADING_TAG.exec(line);
	if (!match) return line;
	const tag = match[1] ?? "";
	const body = match[2] ?? "";
	const styledTag = theme.fg(tag === "[retry]" ? "warning" : "dim", tag);
	return body.length > 0 ? `${styledTag}${theme.fg("muted", body)}` : styledTag;
}
