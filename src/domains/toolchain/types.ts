/**
 * Shapes for the pinned external-tool registry.
 *
 * Clio uses a handful of third-party terminal programs (a pane multiplexer, a
 * file manager, a transfer tool). None of them is a dependency of the product:
 * every consumer degrades when the tool is absent. What the registry adds is a
 * single place where each tool's exact version, download location, checksum,
 * license, and acceptable PATH floor are written down, so an install is
 * reproducible and an operator can see which copy Clio would actually run.
 */

/** Platforms the registry can describe a download for. */
export type ToolPlatform = "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64" | "win32-x64";

/** How a downloaded asset is packed. `raw` is a bare executable. */
export type ToolArchiveKind = "raw" | "zip" | "tar.gz";

/**
 * One platform's asset for one pinned tool.
 *
 * `sha256` is the hash of the asset exactly as downloaded, before any
 * unpacking, so the verification happens on the bytes that crossed the network
 * rather than on whatever an extractor produced from them.
 */
export interface PinnedToolDownload {
	url: string;
	sha256: string;
	archive: ToolArchiveKind;
	/**
	 * Binary name to its path inside the archive. A `raw` download has exactly
	 * one entry whose value is the empty string: the asset is the binary.
	 */
	binaryMembers: Readonly<Record<string, string>>;
	/**
	 * Files copied beside the binaries, given as paths inside the archive. This
	 * is where a tool's own LICENSE comes from when upstream ships it in the
	 * release asset. Each lands under its basename in the version directory.
	 */
	documentMembers: ReadonlyArray<string>;
}

/**
 * A document fetched separately from the asset, for tools whose release asset
 * is a bare binary carrying no license text. Pinned by checksum like the asset.
 */
export interface PinnedToolDocument {
	name: string;
	url: string;
	sha256: string;
}

/** One row of the pinned table. */
export interface PinnedTool {
	id: string;
	version: string;
	summary: string;
	homepage: string;
	/** SPDX identifier of the upstream license. */
	license: string;
	/** Every executable the install places, in the order they are reported. */
	binaries: ReadonlyArray<string>;
	/** The executable whose `--version` answers for the whole tool. */
	primaryBinary: string;
	/**
	 * Lowest version Clio accepts from a copy already on PATH. Below this the
	 * resolution ladder falls through to the vendored copy, because the surface
	 * Clio drives is only known to exist at or above this version.
	 */
	minimumVersion: string;
	/** Arguments that make the primary binary print its version. */
	versionArgs: ReadonlyArray<string>;
	downloads: Readonly<Partial<Record<ToolPlatform, PinnedToolDownload>>>;
	/** Documents fetched alongside the asset. Usually empty. */
	documents: ReadonlyArray<PinnedToolDocument>;
}

/** Where a resolved binary came from. */
export type ToolSource = "path" | "vendored" | "none";

/** What a PATH candidate looked like, kept even when it was rejected. */
export interface ToolPathCandidate {
	path: string;
	version: string | null;
	satisfiesMinimum: boolean;
}

/** The answer of one trip down the resolution ladder. */
export interface ToolResolution {
	source: ToolSource;
	/** Absolute path of the binary Clio would run, or null when unresolved. */
	binaryPath: string | null;
	/** Version of the resolved binary when it could be read. */
	version: string | null;
	/** The registry row this resolution used, when the name is a pinned tool. */
	entry: PinnedTool | null;
	/** A PATH copy that was found, whether or not it was accepted. */
	pathCandidate: ToolPathCandidate | null;
	/** The vendored copy's path when the pinned version is installed. */
	vendoredPath: string | null;
}

/** Per-entry state, the shape the CLI and doctor both render. */
export interface ToolStatus {
	id: string;
	version: string;
	license: string;
	platform: ToolPlatform | null;
	/** False when the registry has no asset for the running platform. */
	supported: boolean;
	installed: boolean;
	installDir: string;
	resolution: ToolResolution;
}
