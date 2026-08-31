import { spawnSync } from "node:child_process";

/**
 * Version reading and comparison for third-party binaries.
 *
 * Every tool in the registry answers `--version` with something different:
 * `herdr 0.8.2` on one line, `croc version 11.3.6`, and a six-line block from
 * yazi whose version sits on the second line after a label. Nothing here tries
 * to know those formats. The first dotted triple in the output is the version,
 * which is true of all three and of every convention they might move to.
 */

const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/;

/** How long a version probe may take before the binary is treated as unusable. */
const PROBE_TIMEOUT_MS = 2000;

/** The first dotted triple in some `--version` output. */
export function parseVersion(output: string): string | null {
	const match = VERSION_PATTERN.exec(output);
	if (!match) return null;
	return `${match[1]}.${match[2]}.${match[3]}`;
}

/**
 * Negative when `a` is older than `b`, zero when equal, positive when newer.
 * Unparseable input sorts oldest, so an unreadable version never satisfies a
 * minimum.
 */
export function compareVersions(a: string, b: string): number {
	const left = numericParts(a);
	const right = numericParts(b);
	for (let i = 0; i < 3; i += 1) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** True when `found` is at least `minimum`. A null `found` never satisfies. */
export function satisfiesMinimum(found: string | null, minimum: string): boolean {
	if (found === null) return false;
	return compareVersions(found, minimum) >= 0;
}

/**
 * Run a binary's version command and read the version out of it.
 *
 * Results are memoized per absolute path for the life of the process. The
 * resolution ladder is consulted every time a pane preset or a doctor row wants
 * a tool, and each miss would otherwise be a process spawn on the interactive
 * path. A binary replaced under a running Clio keeps its first answer until
 * restart, which is the same staleness every other PATH lookup here carries.
 */
export function probeBinaryVersion(binaryPath: string, args: ReadonlyArray<string>): string | null {
	const cached = probeCache.get(binaryPath);
	if (cached !== undefined) return cached;
	let version: string | null = null;
	try {
		const result = spawnSync(binaryPath, [...args], {
			timeout: PROBE_TIMEOUT_MS,
			encoding: "utf8",
			// A version probe must never inherit a terminal or wait on input: some
			// of these binaries are full-screen programs when given a tty.
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (result.error === undefined) {
			version = parseVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
		}
	} catch {
		version = null;
	}
	probeCache.set(binaryPath, version);
	return version;
}

/** Drop memoized probe results. Tests that swap binaries under a path need it. */
export function resetVersionProbeCache(): void {
	probeCache.clear();
}

const probeCache = new Map<string, string | null>();

function numericParts(value: string): number[] {
	const match = VERSION_PATTERN.exec(value);
	if (!match) return [0, 0, 0];
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}
