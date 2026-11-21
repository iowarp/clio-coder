import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { SandboxMaskedPath } from "./types.js";

/** One `/proc/self/mountinfo` line: where a filesystem subtree (`root` of `device`) is mounted. */
export interface MountRecord {
	device: string;
	root: string;
	mountPoint: string;
}

const MOUNTINFO = "/proc/self/mountinfo";

function decodeMountField(field: string): string {
	return field.replace(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** Parses mountinfo text; throws on a line without the fields a record needs. */
function parseMountInfo(text: string): MountRecord[] {
	const records: MountRecord[] = [];
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		const fields = line.split(" ");
		const [device, root, mountPoint] = [fields[2], fields[3], fields[4]];
		if (device === undefined || root === undefined || mountPoint === undefined || !/^\d+:\d+$/u.test(device)) {
			throw new Error(`unrecognized mountinfo line: ${line}`);
		}
		records.push({ device, root: decodeMountField(root), mountPoint: decodeMountField(mountPoint) });
	}
	return records;
}

function isDeviceNode(entry: string): boolean {
	try {
		const stat = statSync(entry);
		return stat.isCharacterDevice() || stat.isBlockDevice();
	} catch {
		return false;
	}
}

/** `child` relative to `parent` when it is `parent` or inside it, else null. */
function within(parent: string, child: string): string | null {
	const rel = path.posix.relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith("../") && !path.posix.isAbsolute(rel)) ? rel : null;
}

/**
 * Every other path that reaches a masked path's file through another mount of
 * the same filesystem, such as WSL2's `/mnt/wslg/distro` second mount of the
 * root, with the mount it goes through. A mask covers one path, so each alias
 * needs its own. A mount of a subtree inside a masked directory is an alias
 * too. Masks are realpaths.
 */
function maskAliases(
	masks: ReadonlyArray<SandboxMaskedPath>,
	mounts: ReadonlyArray<MountRecord>,
): Array<SandboxMaskedPath & { via: MountRecord }> {
	const aliases: Array<SandboxMaskedPath & { via: MountRecord }> = [];
	for (const mask of masks) {
		let serving: MountRecord | undefined;
		for (const mount of mounts) {
			// The last of equal mount points is the one stacked on top, so visible.
			if (
				within(mount.mountPoint, mask.path) !== null &&
				(serving === undefined || mount.mountPoint.length >= serving.mountPoint.length)
			) {
				serving = mount;
			}
		}
		if (serving === undefined) continue;
		const fsPath = path.posix.join(serving.root, within(serving.mountPoint, mask.path) ?? "");
		for (const mount of mounts) {
			if (mount === serving || mount.device !== serving.device) continue;
			const inside = within(mount.root, fsPath);
			const alias =
				inside !== null
					? path.posix.join(mount.mountPoint, inside)
					: mask.kind === "directory" && within(fsPath, mount.root) !== null
						? mount.mountPoint
						: null;
			if (alias !== null && alias !== mask.path) aliases.push({ path: alias, kind: mask.kind, via: mount });
		}
	}
	return aliases;
}

/**
 * A second mount of the whole root filesystem, such as WSL2's
 * `/mnt/wslg/distro`, that holds none of `roots`: everything in it is reachable
 * at `/`, so a command loses nothing when it is hidden as one directory.
 */
function collapsibleRootView(
	mount: MountRecord,
	mounts: ReadonlyArray<MountRecord>,
	roots: ReadonlyArray<string>,
): boolean {
	return (
		mount.root === "/" &&
		mount.mountPoint !== "/" &&
		mounts.some((other) => other.mountPoint === "/" && other.root === "/" && other.device === mount.device) &&
		!roots.some((root) => within(mount.mountPoint, root) !== null || within(root, mount.mountPoint) !== null)
	);
}

/**
 * The masks plus every existing alias of them on this host, or an Error when
 * the mount table cannot be read: a sandbox that cannot see its aliases would
 * leave secrets readable, so callers refuse the command instead. An alias
 * through a second mount of the root that encloses none of `roots` (the
 * workspace, scratch and writable roots, the cwd) is covered by masking that
 * mount once as a directory instead of binding over each file in it: every
 * file bind is one more mount a host program renaming the file can break
 * (C-38), and the directory hides every alias at once. Without `roots` no
 * mount is known to be safe to hide, and every alias keeps its own mask.
 */
export function withMountAliases(
	masks: ReadonlyArray<SandboxMaskedPath>,
	mountinfo: string = MOUNTINFO,
	roots?: ReadonlyArray<string>,
): SandboxMaskedPath[] | Error {
	let mounts: MountRecord[];
	try {
		mounts = parseMountInfo(readFileSync(mountinfo, "utf8"));
	} catch (error) {
		return new Error(
			`could not read the mount table ${mountinfo}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const result = [...masks];
	const seen = new Set(masks.map((mask) => mask.path));
	const hiddenBy = masks.filter((mask) => mask.kind === "directory").map((mask) => mask.path);
	// Inside an enclosing sandbox a secret file is already a bind of /dev/null.
	// Its "aliases" would be every other bind of that device, /dev/null itself
	// included, and a mask there leaves the command a read-only /dev/null.
	const secretBearing = masks.filter((mask) => !isDeviceNode(mask.path));
	const aliases = maskAliases(secretBearing, mounts).map((alias) =>
		roots !== undefined && collapsibleRootView(alias.via, mounts, roots)
			? { path: alias.via.mountPoint, kind: "directory" as const }
			: { path: alias.path, kind: alias.kind },
	);
	// Directory masks go first, so the file aliases they enclose need no mask of their own.
	aliases.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory"));
	for (const alias of aliases) {
		if (seen.has(alias.path) || hiddenBy.some((dir) => within(dir, alias.path) !== null)) continue;
		seen.add(alias.path);
		try {
			// bwrap cannot create a mount point on the read-only root, so only
			// existing aliases are masked, each by what it is.
			const kind = statSync(alias.path).isDirectory() ? "directory" : "file";
			result.push({ path: alias.path, kind });
			if (kind === "directory") hiddenBy.push(alias.path);
		} catch {
			// An alias shadowed by another mount or gone since is not reachable there.
		}
	}
	return result;
}
