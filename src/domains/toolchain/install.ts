import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { type ArchiveEntry, readTarGzEntries, readZipEntries } from "./archive.js";
import { ensureToolchainRoot } from "./paths.js";
import { currentToolPlatform, findPinnedTool } from "./registry.js";
import { pruneSupersededVersions } from "./remove.js";
import type { PinnedTool, PinnedToolDownload, ToolPlatform } from "./types.js";

/**
 * Install a pinned tool into the vendor root.
 *
 * Three rules shape this file. Nothing downloads unless an operator or the
 * installer asked for this tool by name; the one startup path that reaches it is
 * the launcher re-provisioning herdr, which Clio requires to host its own panes
 * (src/cli/workspace-launch.ts). Nothing is written
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
 *
 * `CLIO_CODER_TOOLCHAIN_MIRROR` points every download at a mirror instead of
 * upstream, for airgapped and proxied machines: a base URL or a local directory
 * that holds the upstream assets under `<tool id>/<version>/<upstream name>`
 * (the upstream name is the last path segment of each pinned URL, e.g.
 * `herdr/0.9.5/LICENSE`). A flat `<upstream name>` at the mirror root is still
 * tried second, for mirrors laid out before the namespace existed. The mirror
 * is trusted for nothing: every byte it serves is checked against the same
 * pinned sha256 as upstream's, and a candidate that fails the check is passed
 * over for the next one.
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
	/**
	 * Base URL or local directory serving the pinned assets under
	 * `<id>/<version>/<upstream basename>`, or flat under the basename.
	 * Defaults to `CLIO_CODER_TOOLCHAIN_MIRROR`; null forces upstream.
	 */
	mirror?: string | null;
	/** Per-asset download timeout. Defaults to five minutes. */
	timeoutMs?: number;
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

	const installedBinaries = Object.keys(download.binaryMembers).map((name) => join(dir, executableName(name, platform)));
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

	const mirror = options.mirror === undefined ? toolchainMirror() : options.mirror;
	const sources = (url: string): string[] => (mirror ? mirroredSources(url, mirror, entry.id, entry.version) : [url]);
	const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
	const fetcher = options.fetch ?? ((url: string) => fetchAsset(url, timeoutMs));

	const asset = await fetchVerified(sources(download.url), download.sha256, fetcher, progress);
	if (!asset.ok) {
		const message = asset.mismatch ? asset.message : `download failed: ${asset.message}`;
		return failure(entry.id, entry.version, dir, message);
	}
	const assetBytes = asset.bytes;
	progress(`checksum verified (${download.sha256})`);

	const documentBytes = new Map<string, Buffer>();
	for (const doc of entry.documents) {
		const fetched = await fetchVerified(sources(doc.url), doc.sha256, fetcher, progress);
		if (!fetched.ok) {
			const message = fetched.mismatch ? fetched.message : `download failed for ${doc.name}: ${fetched.message}`;
			return failure(entry.id, entry.version, dir, message);
		}
		documentBytes.set(doc.name, fetched.bytes);
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
	for (const memberPath of [...download.documentMembers, ...(download.runtimeMembers ?? [])]) {
		if (!members.has(memberPath)) {
			return failure(entry.id, entry.version, dir, `the asset does not contain ${memberPath}`);
		}
	}
	for (const memberPath of download.runtimeMembers ?? []) {
		// The registry is trusted input, but a relative path is written under the
		// version directory verbatim, so one that climbs out is refused here.
		const clean = normalize(memberPath);
		if (isAbsolute(clean) || clean.startsWith("..")) {
			return failure(entry.id, entry.version, dir, `runtime member ${memberPath} escapes the install directory`);
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
			const target = join(staging, executableName(name, platform));
			writeFileSync(target, member.data);
			chmodSync(target, 0o755);
			binaries.push(join(dir, executableName(name, platform)));
		}
		for (const memberPath of download.documentMembers) {
			const member = members.get(memberPath);
			if (member === undefined) continue;
			const target = join(staging, basename(memberPath));
			writeFileSync(target, member.data, { mode: 0o644 });
			documents.push(join(dir, basename(memberPath)));
		}
		for (const memberPath of download.runtimeMembers ?? []) {
			const member = members.get(memberPath);
			if (member === undefined) continue;
			const target = join(staging, memberPath);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, member.data, { mode: 0o755 });
		}
		for (const [name, bytes] of documentBytes) {
			writeFileSync(join(staging, name), bytes, { mode: 0o644 });
			documents.push(join(dir, name));
		}
		if (entry.notice !== undefined) {
			safeResourceWrite(join(staging, "NOTICE"), `${entry.notice}\n`, { mode: 0o644 });
			documents.push(join(dir, "NOTICE"));
		}
		writeFileSync(
			join(staging, "clio-coder-install.json"),
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
	const parts: string[] = [];
	if (outcome.removed.length > 0) parts.push(`pruned ${outcome.removed.join(", ")}`);
	if (outcome.staleStaging.length > 0) {
		const count = outcome.staleStaging.length;
		parts.push(`swept ${count} abandoned install ${count === 1 ? "directory" : "directories"}`);
	}
	if (outcome.failed.length > 0) {
		parts.push(`could not prune ${outcome.failed.map((item) => `${item.version} (${item.error})`).join(", ")}`);
	}
	return { pruned: outcome.removed, note: parts.length === 0 ? "" : `; ${parts.join("; ")}` };
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

/** The configured mirror, or null for upstream. */
export function toolchainMirror(env: NodeJS.ProcessEnv = process.env): string | null {
	const value = env.CLIO_CODER_TOOLCHAIN_MIRROR?.trim();
	return value ? value : null;
}

/**
 * Where a pinned URL's asset may live on a mirror, in the order to try them:
 * `<mirror>/<id>/<version>/<name>` first, then the legacy flat `<mirror>/<name>`,
 * where `<name>` is the URL's last path segment. The namespace keeps tools whose
 * assets share a name (every `LICENSE`) from colliding. A mirror that is a URL
 * stays a URL; anything else is a local directory and becomes a file path.
 */
export function mirroredSources(url: string, mirror: string, id: string, version: string): string[] {
	const name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
	if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(mirror) && !mirror.startsWith("file:")) {
		const base = mirror.replace(/\/+$/u, "");
		const leaf = encodeURIComponent(name);
		return [`${base}/${encodeURIComponent(id)}/${encodeURIComponent(version)}/${leaf}`, `${base}/${leaf}`];
	}
	const dir = mirror.startsWith("file:") ? fileURLToPath(mirror) : mirror;
	return [join(dir, id, version, name), join(dir, name)];
}

type VerifiedFetch = { ok: true; bytes: Buffer } | { ok: false; mismatch: boolean; message: string };

/**
 * The first candidate whose bytes match the pinned sha256. A candidate that
 * cannot be fetched or hashes wrong is skipped, so a stale flat mirror file
 * never shadows a correct namespaced one or the reverse.
 */
async function fetchVerified(
	candidates: string[],
	expected: string,
	fetcher: ToolFetcher,
	progress: (message: string) => void,
): Promise<VerifiedFetch> {
	const mismatches: string[] = [];
	const errors: string[] = [];
	for (const source of candidates) {
		let bytes: Buffer;
		try {
			progress(`downloading ${source}`);
			bytes = await fetcher(source);
		} catch (error) {
			errors.push(candidates.length === 1 ? messageOf(error) : `${source}: ${messageOf(error)}`);
			continue;
		}
		const actual = sha256(bytes);
		if (actual === expected) return { ok: true, bytes };
		mismatches.push(`checksum mismatch for ${source}: expected ${expected}, got ${actual}`);
	}
	if (mismatches.length === 0) return { ok: false, mismatch: false, message: errors.join("; ") };
	return { ok: false, mismatch: true, message: `${[...mismatches, ...errors].join("; ")}. Nothing was written.` };
}

async function fetchAsset(url: string, timeoutMs: number): Promise<Buffer> {
	if (!/^https?:\/\//iu.test(url)) return readFileSync(url);
	const response = await fetch(url, {
		redirect: "follow",
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
	return Buffer.from(await response.arrayBuffer());
}

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * What a binary is called once installed, for the platform being installed.
 *
 * Keyed off the target rather than `process.platform`, because `--platform`
 * exists: installing the win32 asset from Linux has to write `herdr.exe`, and
 * writing `herdr` there would produce a directory Windows could never run and
 * that the resolution ladder on Windows would report as not installed.
 */
function executableName(name: string, platform: ToolPlatform): string {
	return platform.startsWith("win32") ? `${name}.exe` : name;
}

function failure(id: string, version: string, dir: string, message: string): ToolInstallResult {
	return { ok: false, id, version, dir, binaries: [], documents: [], skipped: false, pruned: [], message };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
