import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPinnedAsset, type PinnedAsset } from "../../core/pinned-asset.js";
import { resolveClioDirs } from "../../core/xdg.js";
import { extractPackageTarball } from "./tar-extract.js";

/**
 * The scientific-format readers are npm packages too large or too rarely used
 * to ship in Clio's package (h5wasm alone is 3.4 MB). Each is fetched on first
 * use as its exact registry tarball, accepted only when its sha256 matches the
 * pin below, kept in Clio's cache, and unpacked beside it into a private
 * node_modules tree that the reader worker imports by file URL. Nothing is
 * installed into the project or Clio's package, and an air-gapped host can
 * pre-seed the cache by copying the tarball to the path the refusal names.
 */

export interface ReaderPackage {
	name: string;
	version: string;
	sha256: string;
}

export interface ScientificReader {
	/** Plain name for messages: "HDF5 and NetCDF-4". */
	formats: string;
	main: ReaderPackage;
	/** The module the worker imports, relative to the package root. */
	entry: string;
	/** Packages the entry imports by bare name, unpacked into the same node_modules tree. */
	deps: ReadonlyArray<ReaderPackage>;
	/** What to use instead when the reader cannot be fetched. */
	fallback: string;
}

/** Registry tarballs, pinned by the sha256 of the exact bytes npm serves (cross-checked against npm's sha512 integrity). */
export const SCIENTIFIC_READERS = {
	hdf5: {
		formats: "HDF5 and NetCDF-4",
		main: {
			name: "h5wasm",
			version: "0.10.3",
			sha256: "2a9f35ab25c000c164e9dec5e61a0909d0884163ed5dc793e775603805d9570b",
		},
		entry: "dist/node/hdf5_hl.js",
		deps: [],
		fallback: "run_script with h5py (HDF5) or netCDF4 (NetCDF-4)",
	},
	parquet: {
		formats: "Parquet",
		main: {
			name: "hyparquet",
			version: "1.31.5",
			sha256: "5fb6b118fcbc4575771204acd0aa5cab532f40be92339094b7cc756d79830ab5",
		},
		entry: "src/node.js",
		deps: [],
		fallback: "run_script with pyarrow",
	},
} as const satisfies Record<string, ScientificReader>;

export type ScientificReaderId = keyof typeof SCIENTIFIC_READERS;

/** One tarball download may hold a tool call this long, connect phase included. */
export const READER_FETCH_TIMEOUT_MS = 20_000;

/**
 * After a failed download no process on the host retries that reader for this
 * long, so an air-gapped login node pays the timeout once per window instead
 * of once per data call.
 */
export const READER_FETCH_RETRY_MS = 10 * 60_000;

const MARKER = ".clio-coder-reader-pins.json";

function tarballUrl(pkg: ReaderPackage): string {
	return `https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`;
}

function readerDir(reader: ScientificReader): string {
	return join(resolveClioDirs().cache, "data-readers", `${reader.main.name}@${reader.main.version}`);
}

function tarballAsset(reader: ScientificReader, pkg: ReaderPackage): PinnedAsset {
	return {
		label: `${pkg.name} ${pkg.version} (the ${reader.formats} reader)`,
		url: tarballUrl(pkg),
		sha256: pkg.sha256,
		path: join(resolveClioDirs().cache, "data-readers", `${pkg.name}@${pkg.version}`, `${pkg.name}-${pkg.version}.tgz`),
	};
}

function expectedMarker(reader: ScientificReader): string {
	return JSON.stringify([reader.main, ...reader.deps].map((pkg) => `${pkg.name}@${pkg.version}#${pkg.sha256}`));
}

/** Raised when a reader is neither cached nor fetchable; the message is the whole operator-facing story. */
export class ReaderUnavailableError extends Error {
	constructor(reader: ScientificReader, pkg: ReaderPackage, reason: string) {
		const asset = tarballAsset(reader, pkg);
		super(
			`Clio reads ${reader.formats} with ${pkg.name} ${pkg.version}, which it downloads once on first use and caches, and that download is not available: ${reason}. ` +
				`No process on this host retries it for ${Math.round(READER_FETCH_RETRY_MS / 60_000)} minutes after a failure. ` +
				`On an offline host, copy ${asset.url} (sha256 ${pkg.sha256}) to ${asset.path}, or use ${reader.fallback}.`,
		);
		this.name = "ReaderUnavailableError";
	}
}

/**
 * The absolute path of the reader's entry module, fetching and unpacking the
 * pinned tarballs on first use. The unpacked tree appears by one rename with
 * its pin marker inside, so a concurrent process sees either nothing or a
 * complete tree for exactly these pins.
 */
export async function ensureScientificReader(reader: ScientificReader): Promise<string> {
	const dir = readerDir(reader);
	const modules = join(dir, "node_modules");
	const entry = join(modules, reader.main.name, reader.entry);
	const marker = expectedMarker(reader);
	const current = (): boolean => {
		try {
			return readFileSync(join(modules, MARKER), "utf8") === marker && existsSync(entry);
		} catch {
			// No marker yet: the tree is absent or was never completed.
			return false;
		}
	};
	if (current()) return entry;
	const tarballs: Array<[ReaderPackage, Buffer]> = [];
	for (const pkg of [reader.main, ...reader.deps]) {
		try {
			tarballs.push([
				pkg,
				await loadPinnedAsset(tarballAsset(reader, pkg), {
					timeoutMs: READER_FETCH_TIMEOUT_MS,
					retryAfterMs: READER_FETCH_RETRY_MS,
				}),
			]);
		} catch (error) {
			throw new ReaderUnavailableError(reader, pkg, error instanceof Error ? error.message : String(error));
		}
	}
	const staging = join(dir, `node_modules.tmp-${process.pid}-${Date.now().toString(36)}`);
	try {
		for (const [pkg, bytes] of tarballs) extractPackageTarball(bytes, join(staging, pkg.name));
		writeFileSync(join(staging, MARKER), marker);
		if (existsSync(modules) && !current()) rmSync(modules, { recursive: true, force: true });
		try {
			renameSync(staging, modules);
		} catch (error) {
			// Another process finished the same extraction first; its tree carries the same pins.
			if (!current()) throw error;
		}
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
	if (!current()) throw new Error(`unpacked ${reader.main.name} ${reader.main.version} but ${entry} is missing`);
	return entry;
}
