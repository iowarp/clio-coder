import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";

/** `major.minor` of a version, so a patch release keeps the same fingerprint. */
export function minorVersion(version: string): string {
	const match = /^v?(\d+)\.(\d+)/u.exec(version.trim());
	return match ? `${match[1]}.${match[2]}` : "unknown";
}

/**
 * The top frames of a crash as `function@package-relative-module`, without line numbers. A frame outside the package
 * keeps only `node:` module names; any other location reads `external`, so no path of the reporter's survives.
 */
export function crashFrames(stack: string, packageRoot: string, limit = 5): string[] {
	const frames: string[] = [];
	for (const line of stack.split("\n")) {
		const match = /^\s*at (?:(.+?) \()?(.+?)(?::\d+)?(?::\d+)?\)?$/u.exec(line);
		if (!match) continue;
		const fn = (match[1] ?? "<anonymous>").replace(/^async /u, "").trim() || "<anonymous>";
		let location = (match[2] ?? "").replace(/^file:\/\//u, "");
		if (location.startsWith("node:")) location = location.replace(/:\d+(?::\d+)?$/u, "");
		else if (isAbsolute(location)) {
			const rel = relative(packageRoot, location);
			location = rel.startsWith("..") || isAbsolute(rel) ? "external" : rel.split("\\").join("/");
		} else location = "external";
		frames.push(`${fn}@${location}`);
		if (frames.length >= limit) break;
	}
	return frames;
}

/**
 * The exact-match dedup key for a machine-triggered report: `fp_` and 12 hex of SHA-256 over the trigger, the
 * cause, the minor version and, for a crash, its top frames.
 */
export function reportFingerprint(input: {
	trigger: string;
	cause: string | null;
	version: string;
	frames?: ReadonlyArray<string>;
}): string {
	const parts = [input.trigger, input.cause ?? "none", minorVersion(input.version), ...(input.frames ?? []).slice(0, 5)];
	return `fp_${createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 12)}`;
}
