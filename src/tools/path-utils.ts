import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, sep } from "node:path";
import { canonicalizeRawPath } from "../core/path-canonical.js";

/**
 * Render a path with forward slashes for a tool's observation.
 *
 * Tool output is read by the model and matched against patterns the model
 * writes, so it must not change shape with the host's separator. This is
 * presentation only: it never touches a path used to reach the filesystem.
 */
export function toPosixPath(value: string): string {
	return value.split(sep).join("/");
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";

function normalizeUnicodeSpaces(value: string): string {
	return value.replace(UNICODE_SPACES, " ");
}

function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function normalizeAtPrefix(filePath: string): string {
	return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function tryMacOSScreenshotPath(filePath: string): string {
	return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNfdVariant(filePath: string): string {
	return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
	return filePath.replace(/'/g, "\u2019");
}

/**
 * The spelling changes every path-taking tool applies before it resolves a
 * path: a leading `@` is dropped and Unicode spaces become plain ones. Safety
 * admission applies the same changes first, so it judges the path the tool
 * opens: `@../x` is `../x`, not a directory named `@..`.
 */
export function normalizeToolPath(filePath: string): string {
	return normalizeUnicodeSpaces(normalizeAtPrefix(filePath));
}

export function expandPath(filePath: string): string {
	const normalized = normalizeToolPath(filePath);
	if (normalized === "~") return homedir();
	if (normalized.startsWith("~/")) return homedir() + normalized.slice(1);
	return normalized;
}

/**
 * Where the kernel lands a path, resolved by the same walk safety admission
 * uses, so the file a tool touches is the file admission judged: `link/..`
 * steps up from the link's target, not from the link's own directory. A path
 * that cannot be canonicalized comes back joined but not normalized, so the
 * syscall that follows fails on it the way the kernel would and a mutation
 * refuses it.
 */
export function resolveToCwd(filePath: string, cwd: string = process.cwd()): string {
	return resolveMutationTarget(filePath, cwd).path;
}

/**
 * resolveToCwd, plus the physical target when the walk finished. A mutation
 * passes physical to withFileMutationQueue in the same synchronous step, so
 * the queue keys the path this walk found instead of walking it again.
 */
export function resolveMutationTarget(
	filePath: string,
	cwd: string = process.cwd(),
): { path: string; physical: string | undefined } {
	const expanded = expandPath(filePath);
	const physical = canonicalizeRawPath(expanded, cwd);
	if (physical !== null) return { path: physical, physical };
	return { path: isAbsolute(expanded) ? expanded : `${cwd}${sep}${expanded}`, physical: undefined };
}

/**
 * The other spellings resolveReadPath tries, in order, when the resolved path
 * does not exist: the macOS screenshot AM/PM space, NFD, a curly apostrophe,
 * and NFD with the curly apostrophe. Read admission judges each of them too,
 * because any of them can name a link the plain spelling does not.
 */
export function readPathVariants(resolved: string): string[] {
	const nfd = tryNfdVariant(resolved);
	const variants = [tryMacOSScreenshotPath(resolved), nfd, tryCurlyQuoteVariant(resolved), tryCurlyQuoteVariant(nfd)];
	return [...new Set(variants)].filter((variant) => variant !== resolved);
}

export function resolveReadPath(filePath: string, cwd: string = process.cwd()): string {
	const resolved = resolveToCwd(filePath, cwd);
	if (fileExists(resolved)) return resolved;
	for (const variant of readPathVariants(resolved)) {
		if (fileExists(variant)) return variant;
	}
	return resolved;
}
