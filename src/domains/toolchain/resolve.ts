import { statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { toolVersionDir, vendoredBinaryPath } from "./paths.js";
import { currentToolPlatform, findPinnedTool, findPinnedToolByBinary, PINNED_TOOLS } from "./registry.js";
import type { PinnedTool, ToolPathCandidate, ToolResolution, ToolStatus } from "./types.js";
import { probeBinaryVersion, satisfiesMinimum } from "./version.js";

/**
 * The shared resolution ladder: PATH, then the vendored pin, then nothing.
 *
 * PATH comes first because a tool the operator installed themselves is the one
 * they maintain, and Clio downloading a second copy of a program already on the
 * machine is a surprise. It only wins when its version clears the registry's
 * floor, because the alternative is Clio driving a surface that release does not
 * have and reporting the resulting failure as a bug in the feature.
 *
 * Nothing here downloads, spawns a server, or writes to disk. It is safe on the
 * interactive startup path and inside doctor, both of which promise to create
 * nothing.
 */

/** First executable named `name` on PATH, or null. */
export function findExecutableOnPath(name: string): string | null {
	const pathEnv = process.env.PATH;
	if (!pathEnv) return null;
	const candidates = process.platform === "win32" ? [`${name}.exe`, name] : [name];
	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) continue;
		for (const candidate of candidates) {
			const full = join(dir, candidate);
			const stat = statSync(full, { throwIfNoEntry: false });
			if (stat?.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0)) return full;
		}
	}
	return null;
}

/**
 * Resolve one executable name through the ladder.
 *
 * A name that is not in the registry gets a plain PATH lookup: there is no pin
 * to compare against and nothing vendored to fall back to, so the answer is
 * whatever PATH says.
 */
export function resolveToolBinary(name: string): ToolResolution {
	const entry = findPinnedToolByBinary(name) ?? findPinnedTool(name);
	if (entry === null) {
		const found = findExecutableOnPath(name);
		return {
			source: found === null ? "none" : "path",
			binaryPath: found,
			version: null,
			entry: null,
			pathCandidate: found === null ? null : { path: found, version: null, satisfiesMinimum: true },
			vendoredPath: null,
		};
	}
	// An entry asked for by tool id resolves its primary binary; asked for by
	// binary name it resolves that binary, so `ya` does not silently become `yazi`.
	const binary = entry.binaries.includes(name) ? name : entry.primaryBinary;
	return resolveEntryBinary(entry, binary);
}

/** The ladder for a known registry row and one of its binaries. */
export function resolveEntryBinary(entry: PinnedTool, binary: string): ToolResolution {
	const pathCandidate = probePathCandidate(entry, binary);
	const vendored = vendoredBinaryPath(entry.id, entry.version, binary);
	const vendoredStat = statSync(vendored, { throwIfNoEntry: false });
	const vendoredPath = vendoredStat?.isFile() ? vendored : null;

	if (pathCandidate?.satisfiesMinimum) {
		return {
			source: "path",
			binaryPath: pathCandidate.path,
			version: pathCandidate.version,
			entry,
			pathCandidate,
			vendoredPath,
		};
	}
	if (vendoredPath !== null) {
		return {
			source: "vendored",
			binaryPath: vendoredPath,
			version: entry.version,
			entry,
			pathCandidate,
			vendoredPath,
		};
	}
	return { source: "none", binaryPath: null, version: null, entry, pathCandidate, vendoredPath: null };
}

/** Per-entry state for the CLI and doctor. */
export function toolStatus(entry: PinnedTool): ToolStatus {
	const platform = currentToolPlatform();
	const supported = platform !== null && entry.downloads[platform] !== undefined;
	const resolution = resolveEntryBinary(entry, entry.primaryBinary);
	return {
		id: entry.id,
		version: entry.version,
		license: entry.license,
		platform,
		supported,
		installed: resolution.vendoredPath !== null,
		installDir: toolVersionDir(entry.id, entry.version),
		resolution,
	};
}

/** Per-entry state for every row, in registry order. */
export function toolStatuses(): ToolStatus[] {
	return PINNED_TOOLS.map((entry) => toolStatus(entry));
}

/**
 * One sentence describing where a tool resolved and how its version compares to
 * the pin. Shared by `clio-coder tools status` and the doctor rows so the two
 * cannot drift into describing the same machine differently.
 */
export function describeResolution(status: ToolStatus): string {
	const { resolution } = status;
	if (resolution.source === "path") {
		const version = resolution.version ?? "unreadable version";
		return `PATH ${resolution.binaryPath} (${version}, pin ${status.version})`;
	}
	if (resolution.source === "vendored") {
		const rejected =
			resolution.pathCandidate === null
				? ""
				: `; PATH copy ${resolution.pathCandidate.path} is ${resolution.pathCandidate.version ?? "unreadable"}, below the ${status.resolution.entry?.minimumVersion ?? status.version} floor`;
		return `vendored ${resolution.binaryPath} (${status.version})${rejected}`;
	}
	if (!status.supported) {
		return `not installed and no pinned asset for this platform (${status.platform ?? `${process.platform}-${process.arch}`})`;
	}
	const rejected =
		resolution.pathCandidate === null
			? ""
			: `; PATH copy ${resolution.pathCandidate.path} is ${resolution.pathCandidate.version ?? "unreadable"}, below the ${status.resolution.entry?.minimumVersion ?? status.version} floor`;
	return `not found${rejected} (install with \`clio-coder tools install ${status.id}\`)`;
}

function probePathCandidate(entry: PinnedTool, binary: string): ToolPathCandidate | null {
	const found = findExecutableOnPath(binary);
	if (found === null) return null;
	// The floor is a property of the tool, and only the primary binary is asked
	// for its version, so a secondary binary inherits the primary's verdict from
	// the same install root rather than being probed with flags it may not have.
	const probeTarget = binary === entry.primaryBinary ? found : (findExecutableOnPath(entry.primaryBinary) ?? found);
	const version = probeBinaryVersion(probeTarget, entry.versionArgs);
	return { path: found, version, satisfiesMinimum: satisfiesMinimum(version, entry.minimumVersion) };
}
