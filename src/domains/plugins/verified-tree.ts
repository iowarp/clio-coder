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

/** The identity of every entry under `root`, or null when the tree cannot be vouched for by stamp. */
function treeStamp(root: string, nowMs: number): string | null {
	try {
		const now = BigInt(Math.trunc(nowMs)) * 1_000_000n;
		const hash = createHash("sha256");
		// A swapped ancestor symlink leaves every entry's own identity alone on a copied tree.
		hash.update(realpathSync.native(root));
		let settled = true;
		const visit = (absolute: string, relative: string): void => {
			const stat = lstatSync(absolute, { bigint: true });
			if (now - stat.mtimeNs < SETTLED_NS || now - stat.ctimeNs < SETTLED_NS) settled = false;
			hash.update(
				`\0${relative}\0${stat.mode}:${stat.dev}:${stat.ino}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
			);
			// A link's own identity already moves when it is replaced; its target is named so the reason is in the stamp.
			if (stat.isSymbolicLink()) hash.update(`\0->${readlinkSync(absolute)}`);
			if (!stat.isDirectory()) return;
			for (const entry of readdirSync(absolute).sort()) visit(path.join(absolute, entry), `${relative}/${entry}`);
		};
		visit(root, "");
		return settled ? hash.digest("hex") : null;
	} catch {
		// The verification that follows reports why the tree cannot be read.
		return null;
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
	const before = treeStamp(key, nowMs);
	const kept = verified.get(key);
	if (before !== null && kept?.stamp === before) return structuredClone(kept.candidate);
	verified.delete(key);
	const candidate = read(root);
	// Taken on both sides of the read: a tree that moved while it was hashed is not kept under either stamp.
	if (candidate.valid && before !== null && treeStamp(key, nowMs) === before) {
		verified.set(key, { stamp: before, candidate: structuredClone(candidate) });
		const oldest = verified.keys().next();
		if (verified.size > MAX_KEPT && !oldest.done) verified.delete(oldest.value);
	}
	return candidate;
}
