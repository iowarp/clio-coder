import { type Stats, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { clioDataDir, resolveClioDirs } from "../../core/xdg.js";

/**
 * Vendored tools are durable artifacts Clio downloaded on request, so they live
 * under the data root beside memory and evidence, not under state (machine
 * output) or cache (disposable). The version is part of the path so a pin bump
 * installs beside the old copy instead of over it, and a rollback is a path
 * change rather than a re-download.
 *
 * Every reader resolves through `resolveClioDirs()` rather than `clioDataDir()`
 * because the latter creates the root, and doctor and the resolution ladder both
 * promise to create nothing. Only the installer creates.
 */

/** `<data>/tools`, without creating it. */
export function toolchainRoot(): string {
	return join(resolveClioDirs().data, "tools");
}

/** `<data>/tools/<id>/<version>`, without creating it. */
export function toolVersionDir(id: string, version: string): string {
	return join(toolchainRoot(), id, version);
}

/** `<data>/tools/<id>/<version>/<binary>`, without creating it. */
export function vendoredBinaryPath(id: string, version: string, binary: string): string {
	return join(toolVersionDir(id, version), process.platform === "win32" ? `${binary}.exe` : binary);
}

/**
 * The operator's toolchain root, set by `campaign run` for each entry. A vendored tool is an installation artifact,
 * not session data, so an entry whose own data root is empty and thrown away resolves the operator's vendored tools
 * from here, read-only: nothing installs into it.
 */
export const OPERATOR_TOOLS_ENV = "CLIO_CODER_OPERATOR_TOOLS_DIR";

function borrowedToolchainRoot(): string | null {
	const dir = process.env[OPERATOR_TOOLS_ENV];
	return dir && isAbsolute(dir) ? dir : null;
}

/** The toolchain root the operator's `clio-coder tools install` fills. */
export function operatorToolchainRoot(): string {
	return borrowedToolchainRoot() ?? toolchainRoot();
}

/** Every place a vendored binary at this pin may already be: this process's own `<data>/tools`, then the operator's. */
export function vendoredBinaryCandidates(id: string, version: string, binary: string): string[] {
	const own = vendoredBinaryPath(id, version, binary);
	const root = borrowedToolchainRoot();
	if (root === null) return [own];
	const operator = join(root, id, version, process.platform === "win32" ? `${binary}.exe` : binary);
	return operator === own ? [own] : [own, operator];
}

/** `<data>/tools`, creating the data root the way every other writer does. */
export function ensureToolchainRoot(): string {
	return join(clioDataDir(), "tools");
}

/**
 * stat that reports any failure as absent. `throwIfNoEntry: false` covers only
 * ENOENT and ENOTDIR; a path under an untraversable directory still throws
 * EACCES (ELOOP, ENAMETOOLONG likewise), which crashed TUI startup through the
 * fd PATH lookup (#437). Toolchain lookups never throw.
 */
export function statOrNull(file: string): Stats | null {
	try {
		return statSync(file, { throwIfNoEntry: false }) ?? null;
	} catch {
		return null;
	}
}
