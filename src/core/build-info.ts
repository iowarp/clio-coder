import { readClioVersion } from "./package-root.js";

/**
 * Injected by tsup (`define`) when the bundle is built from a git checkout.
 * Source runs under tsx, tarball builds and tests leave both undeclared.
 */
declare const __CLIO_BUILD_COMMIT__: string | undefined;
declare const __CLIO_BUILD_DIRTY__: boolean | undefined;

interface BuildProvenance {
	/** Short commit hash the bundle was built from. */
	commit: string;
	/** The working tree had uncommitted changes at build time. */
	dirty: boolean;
}

/**
 * A `-dev` prerelease is a development tree that has no published artifact.
 * Other prereleases (`-rc.1`) are published under the `beta` dist-tag and are real releases.
 */
export function isDevVersion(version: string): boolean {
	return /^\d+\.\d+\.\d+-dev(?:[.+]|$)/.test(version);
}

/** The recorded commit of this bundle, or null when it was not built from a checkout. */
function readBuildProvenance(): BuildProvenance | null {
	if (typeof __CLIO_BUILD_COMMIT__ !== "string" || __CLIO_BUILD_COMMIT__.length === 0) return null;
	return { commit: __CLIO_BUILD_COMMIT__, dirty: typeof __CLIO_BUILD_DIRTY__ === "boolean" && __CLIO_BUILD_DIRTY__ };
}

/**
 * `0.6.0-dev (unreleased · 03923cf-dirty)` for a development version, the plain
 * version for everything else. A release build from a tagged commit carries no
 * `-dev`, so it never grows a suffix even though its commit is recorded.
 */
function describeVersion(version: string, build: BuildProvenance | null = readBuildProvenance()): string {
	if (!isDevVersion(version)) return version;
	const commit = build === null ? " · source" : ` · ${build.commit}${build.dirty ? "-dirty" : ""}`;
	return `${version} (unreleased${commit})`;
}

/** The version for display: banner, `--version`, doctor and the ACP handshake. */
export function readClioVersionLabel(): string {
	return describeVersion(readClioVersion());
}

/**
 * Version used to test extension and plugin ranges. SemVer ranges exclude every
 * prerelease unless the range names one, so `>=0.5.0` would reject `0.6.0-dev`
 * and mark every extension incompatible with the tree that is meant to run them.
 * A dev tree is judged as the release it is becoming.
 */
export function compatibilityVersion(version: string): string {
	return isDevVersion(version) ? (version.split("-")[0] ?? version) : version;
}
