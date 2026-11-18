import path from "node:path";

/**
 * True when a `path.relative` result leaves its base: exactly `..`, a `..`
 * segment followed by a separator, or another root. A child named `..x` stays
 * inside. Pass `path.posix` when the relative path came from `path.posix`.
 */
export function relativePathEscapes(relative: string, pathImpl: path.PlatformPath = path): boolean {
	return (
		relative === ".." ||
		relative.startsWith("../") ||
		relative.startsWith(`..${pathImpl.sep}`) ||
		pathImpl.isAbsolute(relative)
	);
}
