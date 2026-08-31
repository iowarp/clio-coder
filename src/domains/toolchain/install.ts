import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type ArchiveEntry, readTarGzEntries, readZipEntries } from "./archive.js";
import { ensureToolchainRoot } from "./paths.js";
import { currentToolPlatform, findPinnedTool } from "./registry.js";
import { pruneSupersededVersions } from "./remove.js";
import type { PinnedTool, PinnedToolDownload, ToolPlatform } from "./types.js";

/**
 * Install a pinned tool into the vendor root.
 *
 * Three rules shape this file. Nothing downloads unless an operator asked for
 * this install by name, so no startup path can reach it. Nothing is written
 * until the asset's checksum matches the pin, and a mismatch leaves the disk
 * exactly as it was. And the version directory appears atomically, built in a
 * sibling staging directory and renamed into place, so a killed install leaves
 * a `.incomplete-` directory rather than a half-populated version that the
 * resolution ladder would happily run.
 *
 * A successful install then prunes, so a tool holds exactly the pinned version
 * and nothing else. Only the ladder's own version is ever resolved, so a
 * superseded directory is dead weight an operator would have to find and delete
 * by hand. Pruning runs on the already-installed path too, which is what
 * repairs a machine that bumped pins before this behavior existed.
 */

/** How a URL becomes bytes. Injectable so the contract tests never touch the network. */
export type ToolFetcher = (url: string) => Promise<Buffer>;

export interface ToolInstallOptions {
	/** Re-download and replace an already-installed version. */
	force?: boolean;
	/** Install the asset for a platform other than the running one. */
	platform?: ToolPlatform;
	/** Vendor root override. Defaults to the data root's `tools` directory. */
	root?: string;
	fetch?: ToolFetcher;
	onProgress?: (message: string) => void;
}

export interface ToolInstallResult {
	ok: boolean;
	id: string;
	version: string;
	/** Where the version directory is, whether or not this run created it. */
	dir: string;
	/** Absolute paths of the installed executables. */
	binaries: string[];
	/** Absolute paths of the license and notice files placed beside them. */
	documents: string[];
	/** True when the version was already installed and nothing was downloaded. */
	skipped: boolean;
	/** Superseded versions of the same tool this install deleted. */
	pruned: string[];
	message: string;
}

/** How long one asset download may take. */
const DOWNLOAD_TIMEOUT_MS = 300_000;

/** Install by registry id. */
export async function installTool(id: string, options: ToolInstallOptions = {}): Promise<ToolInstallResult> {
	const entry = findPinnedTool(id);
	if (entry === null) {
		return failure(id, "unknown", "", `unknown tool: ${id}`);
	}
	return installPinnedTool(entry, options);
}

/** Install a registry row. Exported so tests can drive a fabricated entry. */
export async function installPinnedTool(
	entry: PinnedTool,
	options: ToolInstallOptions = {},
): Promise<ToolInstallResult> {
	const root = options.root ?? ensureToolchainRoot();
	const dir = join(root, entry.id, entry.version);
	const platform = options.platform ?? currentToolPlatform();
	const progress = options.onProgress ?? (() => undefined);

	if (platform === null) {
		return failure(entry.id, entry.version, dir, `no pinned asset for ${process.platform}-${process.arch}`);
	}
	const download = entry.downloads[platform];
	if (download === undefined) {
		return failure(entry.id, entry.version, dir, `no pinned asset for ${platform}`);
	}

	const installedBinaries = Object.keys(download.binaryMembers).map((name) => join(dir, executableName(name)));
	if (!options.force && installedBinaries.every((path) => existsSync(path))) {
		const swept = prune(root, entry);
		return {
			ok: true,
			id: entry.id,
			version: entry.version,
			dir,
			binaries: installedBinaries,
			documents: [],
			skipped: true,
			pruned: swept.pruned,
			message: `${entry.id} ${entry.version} is already installed at ${dir}${swept.note}`,
		};
	}

	const fetcher = options.fetch ?? fetchAsset;
	let assetBytes: Buffer;
	try {
		progress(`downloading ${download.url}`);
		assetBytes = await fetcher(download.url);
	} catch (error) {
		return failure(entry.id, entry.version, dir, `download failed: ${messageOf(error)}`);
	}

	const actual = sha256(assetBytes);
	if (actual !== download.sha256) {
		return failure(
			entry.id,
			entry.version,
			dir,
			`checksum mismatch for ${download.url}: expected ${download.sha256}, got ${actual}. Nothing was written.`,
		);
	}
	progress(`checksum verified (${actual})`);

	const documentBytes = new Map<string, Buffer>();
	for (const doc of entry.documents) {
		let bytes: Buffer;
		try {
			progress(`downloading ${doc.url}`);
			bytes = await fetcher(doc.url);
		} catch (error) {
			return failure(entry.id, entry.version, dir, `download failed for ${doc.name}: ${messageOf(error)}`);
		}
		const docHash = sha256(bytes);
		if (docHash !== doc.sha256) {
			return failure(
				entry.id,
				entry.version,
				dir,
				`checksum mismatch for ${doc.url}: expected ${doc.sha256}, got ${docHash}. Nothing was written.`,
			);
		}
		documentBytes.set(doc.name, bytes);
	}

	let members: Map<string, ArchiveEntry>;
	try {
		members = unpack(assetBytes, download);
	} catch (error) {
		return failure(entry.id, entry.version, dir, `could not unpack the asset: ${messageOf(error)}`);
	}

	for (const memberPath of Object.values(download.binaryMembers)) {
		if (!members.has(memberPath)) {
			return failure(entry.id, entry.version, dir, `the asset does not contain ${memberPath || entry.primaryBinary}`);
		}
	}
	for (const memberPath of download.documentMembers) {
		if (!members.has(memberPath)) {
			return failure(entry.id, entry.version, dir, `the asset does not contain ${memberPath}`);
		}
	}

	const staging = join(root, entry.id, `.${entry.version}.incomplete-${process.pid}-${Date.now().toString(36)}`);
	// Where a `--force` replacement parks the old version directory while the new
	// one is renamed in. It is unlinked only once the new directory is in place,
	// so the window where neither copy exists is a single rename wide.
	const retired = join(root, entry.id, `.${entry.version}.replaced-${process.pid}-${Date.now().toString(36)}`);
	let retiredOld = false;
	const binaries: string[] = [];
	const documents: string[] = [];
	try {
		mkdirSync(staging, { recursive: true });
		for (const [name, memberPath] of Object.entries(download.binaryMembers)) {
			const member = members.get(memberPath);
			if (member === undefined) continue;
			const target = join(staging, executableName(name));
			writeFileSync(target, member.data);
			chmodSync(target, 0o755);
			binaries.push(join(dir, executableName(name)));
		}
		for (const memberPath of download.documentMembers) {
			const member = members.get(memberPath);
			if (member === undefined) continue;
			const target = join(staging, basename(memberPath));
			writeFileSync(target, member.data, { mode: 0o644 });
			documents.push(join(dir, basename(memberPath)));
		}
		for (const [name, bytes] of documentBytes) {
			writeFileSync(join(staging, name), bytes, { mode: 0o644 });
			documents.push(join(dir, name));
		}
		writeFileSync(
			join(staging, "clio-install.json"),
			`${JSON.stringify(
				{
					id: entry.id,
					version: entry.version,
					platform,
					license: entry.license,
					homepage: entry.homepage,
					url: download.url,
					sha256: download.sha256,
					installedAt: new Date().toISOString(),
				},
				null,
				2,
			)}\n`,
			{ mode: 0o644 },
		);
		if (options.force && existsSync(dir)) {
			renameSync(dir, retired);
			retiredOld = true;
		}
		renameSync(staging, dir);
		if (retiredOld) {
			rmSync(retired, { recursive: true, force: true });
			retiredOld = false;
		}
	} catch (error) {
		rmSync(staging, { recursive: true, force: true });
		// The new version never landed, so put the copy the operator had back.
		if (retiredOld && !existsSync(dir)) {
			try {
				renameSync(retired, dir);
				retiredOld = false;
			} catch {
				// Leave the retired directory in place: it is the only surviving copy.
			}
		}
		// A rename losing to a concurrent installer is not a failure: the version
		// directory the caller asked for exists and holds the same pinned bytes.
		if (!options.force && existsSync(dir)) {
			const swept = prune(root, entry);
			return {
				ok: true,
				id: entry.id,
				version: entry.version,
				dir,
				binaries: installedBinaries,
				documents: [],
				skipped: true,
				pruned: swept.pruned,
				message: `${entry.id} ${entry.version} was installed concurrently at ${dir}${swept.note}`,
			};
		}
		return failure(entry.id, entry.version, dir, `install failed: ${messageOf(error)}`);
	}

	const swept = prune(root, entry);
	return {
		ok: true,
		id: entry.id,
		version: entry.version,
		dir,
		binaries,
		documents,
		skipped: false,
		pruned: swept.pruned,
		message: `installed ${entry.id} ${entry.version} (${entry.license}) at ${dir}${swept.note}`,
	};
}

/**
 * Delete the versions this pin supersedes, and say what happened.
 *
 * A prune that cannot delete something never fails the install: the version the
 * operator asked for is in place and runnable, and a directory that resisted
 * `rm` is a disk problem to report, not a reason to claim the install did not
 * happen. It is named in the message so the operator can go look.
 */
function prune(root: string, entry: PinnedTool): { pruned: string[]; note: string } {
	const outcome = pruneSupersededVersions(entry.id, entry.version, { root });
	if (outcome.failed.length > 0) {
		const trouble = outcome.failed.map((item) => `${item.version} (${item.error})`).join(", ");
		return { pruned: outcome.removed, note: `; could not prune ${trouble}` };
	}
	if (outcome.removed.length === 0) return { pruned: [], note: "" };
	return { pruned: outcome.removed, note: `; pruned ${outcome.removed.join(", ")}` };
}

function unpack(bytes: Buffer, download: PinnedToolDownload): Map<string, ArchiveEntry> {
	if (download.archive === "raw") {
		// The asset is the binary. The registry names it with an empty member
		// path, so the synthetic map key matches what the caller looks up.
		return new Map([["", { path: "", data: bytes, mode: 0o755 }]]);
	}
	if (download.archive === "zip") return readZipEntries(bytes);
	return readTarGzEntries(bytes);
}

async function fetchAsset(url: string): Promise<Buffer> {
	const response = await fetch(url, {
		redirect: "follow",
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
	return Buffer.from(await response.arrayBuffer());
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function executableName(name: string): string {
	return process.platform === "win32" ? `${name}.exe` : name;
}

function failure(id: string, version: string, dir: string, message: string): ToolInstallResult {
	return { ok: false, id, version, dir, binaries: [], documents: [], skipped: false, pruned: [], message };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
