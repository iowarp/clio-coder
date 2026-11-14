import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import type { PluginCandidate } from "./types.js";

/**
 * A verified plugin tree stays verified while nothing in it has changed.
 *
 * Every listing re-verifies each installed tree against its recorded digest: it reads and hashes every file and
 * canonicalizes every directory, about 5 ms a plugin. Listings happen on every discovery, every reload and every
 * turn start, so a home with 39 plugins spent 200 ms of blocked main thread on each, and several of them in a
 * session's first seconds. Whether a tree changed can be answered from `lstat` alone, as git's index does: an
 * unprivileged process cannot rewrite a file, replace it, or add or remove an entry without moving that entry's or
 * its directory's inode, size, mtime or ctime. So a listing first takes the tree's stamp (one `lstat` per entry,
 * 7 ms for all 39 trees) and reads the tree again only when the stamp differs from the one its last verification
 * was taken under. Revocation and drift still take effect on the next read.
 *
 * The stamp names every entry by path with its device, inode, mode, link count, size, mtime and ctime, and a link
 * by its target. ctime cannot be set from userland, so a rewrite that puts the old mtime back is still caught, and
 * an added, removed or renamed entry moves its directory. Nothing is kept across processes: each process hashes a
 * tree in full the first time it verifies it.
 */

interface Verified {
	stamp: string;
	candidate: PluginCandidate;
}

/**
 * An entry changed this recently can change again inside one tick of a coarse timestamp, so a tree is verified from
 * its bytes on every listing until it has been still this long. FAT keeps mtime to two seconds.
 */
const SETTLED_NS = 3_000_000_000n;
/** Installs are few; a process that walks many scratch homes just verifies again. */
const MAX_KEPT = 512;

const verified = new Map<string, Verified>();
/**
 * Trees seen with an entry still settling, and when that entry will have been still long enough. Until then a
 * listing hashes without walking for a stamp nobody could use: a tree installed a moment ago costs one `lstat` more
 * than it did, once.
 */
const settling = new Map<string, bigint>();

function bounded<K, V>(map: Map<K, V>): void {
	const oldest = map.keys().next();
	if (map.size > MAX_KEPT && !oldest.done) map.delete(oldest.value);
}

class Unsettled extends Error {
	constructor(readonly until: bigint) {
		super("unsettled");
	}
}

/**
 * The identity of every entry under `root`; or the time its first unsettled entry will have settled; or null when
 * the tree cannot be read, which the verification that follows reports.
 */
function treeStamp(root: string, now: bigint): string | bigint | null {
	try {
		const hash = createHash("sha256");
		const visit = (absolute: string, relative: string): void => {
			const stat = lstatSync(absolute, { bigint: true });
			const changed = stat.mtimeNs > stat.ctimeNs ? stat.mtimeNs : stat.ctimeNs;
			if (now - changed < SETTLED_NS) throw new Unsettled(changed + SETTLED_NS);
			hash.update(
				`\0${relative}\0${stat.mode}:${stat.dev}:${stat.ino}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
			);
			// A link's own identity already moves when it is replaced; its target is named so the reason is in the stamp.
			if (stat.isSymbolicLink()) hash.update(`\0->${readlinkSync(absolute)}`);
			if (!stat.isDirectory()) return;
			for (const entry of readdirSync(absolute).sort()) visit(path.join(absolute, entry), `${relative}/${entry}`);
		};
		visit(root, "");
		// A swapped ancestor symlink leaves every entry's own identity alone on a copied tree.
		hash.update(`\0@${realpathSync.native(root)}`);
		return hash.digest("hex");
	} catch (error) {
		return error instanceof Unsettled ? error.until : null;
	}
}

/**
 * `read(root)`, skipped when the tree is entry-for-entry the one a previous read verified. Only a valid candidate
 * is kept: a failure may not last, and its diagnostics should come from the disk each time.
 */
export function verifiedPluginCandidate(
	root: string,
	read: (root: string) => PluginCandidate,
	/** The clock the settle window is measured on; a contract test moves it instead of waiting. */
	nowMs: number = Date.now(),
): PluginCandidate {
	const key = path.resolve(root);
	const now = BigInt(Math.trunc(nowMs)) * 1_000_000n;
	const until = settling.get(key);
	if (until !== undefined && now < until) {
		verified.delete(key);
		return read(root);
	}
	settling.delete(key);
	const before = treeStamp(key, now);
	const kept = verified.get(key);
	if (typeof before === "string" && kept?.stamp === before) return structuredClone(kept.candidate);
	verified.delete(key);
	if (typeof before === "bigint") {
		settling.set(key, before);
		bounded(settling);
	}
	const candidate = read(root);
	// Taken on both sides of the read: a tree that moved while it was hashed is not kept under either stamp.
	if (candidate.valid && typeof before === "string" && treeStamp(key, now) === before) {
		verified.set(key, { stamp: before, candidate: structuredClone(candidate) });
		bounded(verified);
	}
	return candidate;
}
