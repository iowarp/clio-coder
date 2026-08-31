import { findExecutableOnPath, resolveToolBinary } from "../domains/toolchain/resolve.js";

export function resolveFdBinary(): string | null {
	return findExecutableOnPath("fd") ?? findExecutableOnPath("fdfind");
}

export function resolveRgBinary(): string | null {
	return findExecutableOnPath("rg");
}

/**
 * Resolve any executable Clio might run, through the toolchain ladder.
 *
 * For a name in the pinned registry the answer is PATH when the copy there
 * clears the pin's floor, then Clio's vendored copy, then null. For anything
 * else it is a plain PATH lookup, which is what `resolveFdBinary` and
 * `resolveRgBinary` above already do for the two search tools Clio never
 * vendors.
 *
 * Callers that need to explain the answer (doctor, `clio-coder tools status`)
 * want `resolveToolBinary` instead: this returns only the path to run.
 */
export function resolveBinary(name: string): string | null {
	return resolveToolBinary(name).binaryPath;
}
