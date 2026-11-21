/**
 * The `cd <dir> &&` or `cd <dir>;` a model puts in front of a command it means
 * to run where the shell already starts (XR-9). Exit 0 from `cd <dir> && x` or
 * `cd <dir>; x` speaks for `x` alone when `<dir>` is the directory the call
 * already runs in, because that cd cannot move the shell and does not fail. So
 * one reader strips that prefix, and only that one, for every consumer that
 * names a command: memory's evidence identity, the shell receipt's exit scope,
 * and the finish gate's check identity. Nothing here changes what runs.
 *
 * The directory word is read by the same strict argv reader memory uses, so a
 * quoted or expanded word means the same thing everywhere; any expansion
 * (`$HOME`, `~`, a substitution), option, backslash or unquoted glob or brace
 * character refuses the reading. Only `.`, a `./` path or an absolute path is
 * read, because CDPATH can send any other relative operand elsewhere.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { shellLikeInvocation } from "./shell-argv.js";

interface LeadingCd {
	/** The cd operand as the shell reads it, not yet resolved. */
	readonly directory: string;
	/** The exact text after the separator. */
	readonly rest: string;
}

/** A leading `cd <word> &&` or `cd <word>;`: one word of quoted or unquoted text, then the separator. */
const LEADING_CD = /^\s*cd[ \t]+((?:'[^'\n]*'|"[^"\n]*"|\\[^\n]|[^\s;&|'"\\])+)[ \t]*(?:&&(?!&)|;(?!;))[ \t]*/u;

/** A plain leading `cd <dir> &&` or `cd <dir>;` and the text after it, or null for anything else. */
function leadingCd(command: string): LeadingCd | null {
	const match = LEADING_CD.exec(command);
	if (match === null) return null;
	const rest = command.slice(match[0].length);
	if (rest.trim().length === 0 || /^[;&|)]/u.test(rest)) return null;
	const word = match[1] ?? "";
	// The argv reader drops a backslash inside double quotes that the shell keeps (`"\."` is `\.` to bash), and an
	// unquoted glob or brace expands at run time, so either leaves the operand unknown.
	if (word.includes("\\") || /[*?[\]{}]/u.test(word.replace(/'[^']*'|"[^"]*"/gu, ""))) return null;
	const parsed = shellLikeInvocation(`cd ${word}`, { rejectComments: true });
	if (parsed instanceof Error || parsed.argv.length !== 2) return null;
	const directory = parsed.argv[1] ?? "";
	if (directory.length === 0 || directory.startsWith("-") || directory.startsWith("~")) return null;
	// CDPATH redirects any relative operand but `.` and one starting with `./` or `../`.
	if (directory !== "." && !directory.startsWith("./") && !isAbsolute(directory)) return null;
	// The shell walks each component, so `cd pkg/..` fails without `pkg` although it names the same directory.
	if (directory.split("/").includes("..")) return null;
	return { directory, rest };
}

/** Whether two paths name one existing directory; one that does not exist is no directory at all. */
export function sameDirectory(left: string, right: string): boolean {
	try {
		return realpathSync(left) === realpathSync(right);
	} catch {
		return false;
	}
}

/**
 * The command with a leading `cd` into `directory`, the directory it already runs in, removed; every other command
 * comes back unchanged. Only one prefix is read, so `cd <dir> && cd <dir> && x` keeps its second cd.
 */
export function withoutLeadingCdTo(command: string, directory: string | undefined): string {
	if (directory === undefined) return command;
	const cd = leadingCd(command);
	if (cd === null || !sameDirectory(resolve(directory, cd.directory), directory)) return command;
	return cd.rest;
}
