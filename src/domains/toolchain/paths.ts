import { join } from "node:path";
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

/** `<data>/tools`, creating the data root the way every other writer does. */
export function ensureToolchainRoot(): string {
	return join(clioDataDir(), "tools");
}
