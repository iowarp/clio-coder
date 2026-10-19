import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { canonicalizePath } from "../../core/path-canonical.js";
import { isSameOrDescendant } from "./path-policy.js";

/**
 * Operator scratch roots (#419). The main session's contained shell calls may
 * write them, and at autonomy default a delete that lands inside one is judged
 * like one inside the workspace. `safety.scratchRoots` adds to the built-in
 * temp roots and is honored only from the operator's own settings file.
 */

/**
 * Trees that hold the system, its state or other filesystems. No root inside
 * one is a scratch root, apart from the temp trees below: /var/lib, /opt,
 * /nix or /private/etc would hand yolo deletes the machine's own state.
 */
const SYSTEM_TREES: ReadonlyArray<string> = [
	"/etc",
	"/usr",
	"/bin",
	"/sbin",
	"/lib",
	"/lib32",
	"/lib64",
	"/libx32",
	"/boot",
	"/root",
	"/dev",
	"/proc",
	"/sys",
	"/run",
	"/snap",
	"/var",
	"/opt",
	"/srv",
	"/nix",
	"/private",
	"/cores",
	"/System",
	"/Library",
	"/Applications",
];

/** The conventional temp trees, which stay usable inside a system tree. */
const TEMP_TREES: ReadonlyArray<string> = ["/tmp", "/var/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];

/**
 * Where other filesystems mount. The parent and each mount root inside it
 * (`/mnt/c` is a whole Windows drive under WSL, `/media/<user>/<disk>` a
 * whole disk) are never scratch roots; a directory further down may be.
 */
const MOUNT_PARENTS: ReadonlyArray<{ parent: string; depth: number }> = [
	{ parent: "/mnt", depth: 1 },
	{ parent: "/media", depth: 2 },
	{ parent: "/Volumes", depth: 1 },
];

/** Why `root` can never be a scratch root, or null when it can. */
export function scratchRootProblem(root: string): string | null {
	if (!path.isAbsolute(root)) return "must be an absolute path";
	const resolved = path.resolve(root);
	if (resolved === path.parse(resolved).root) return "must not be the filesystem root";
	// $HOME itself, and anything above it (`/home`), would put every dotfile and
	// credential the operator owns inside a tree yolo may delete.
	if (isSameOrDescendant(homedir(), resolved)) return "must not be the home directory or one of its ancestors";
	if (TEMP_TREES.some((tree) => isSameOrDescendant(resolved, tree))) return null;
	if (SYSTEM_TREES.some((tree) => isSameOrDescendant(resolved, tree))) return "must not be inside a system tree";
	for (const { parent, depth } of MOUNT_PARENTS) {
		if (!isSameOrDescendant(resolved, parent)) continue;
		const below = path.relative(parent, resolved);
		if (below === "" || below.split(path.sep).length <= depth) return "must not be a mount point or its parent";
	}
	return null;
}

/** A configured root the runtime set leaves out for one workspace, and why. */
export interface DroppedScratchRoot {
	root: string;
	reason: string;
}

/**
 * The scratch roots in force for one workspace, canonical: the built-in temp
 * roots plus every configured root that still passes {@link scratchRootProblem}
 * once links are resolved and does not contain the workspace. A configured root
 * that names an ancestor of the workspace would let a delete reach the
 * workspace from above, so it is dropped here, where the workspace is known.
 */
export function effectiveScratchRoots(configured: ReadonlyArray<string>, workspace: string): string[] {
	return resolveScratchRoots(configured, workspace).roots;
}

/** The configured roots {@link effectiveScratchRoots} leaves out for `workspace`, so doctor can say so. */
export function droppedScratchRoots(configured: ReadonlyArray<string>, workspace: string): DroppedScratchRoot[] {
	return resolveScratchRoots(configured, workspace).dropped;
}

function resolveScratchRoots(
	configured: ReadonlyArray<string>,
	workspace: string,
): { roots: string[]; dropped: DroppedScratchRoot[] } {
	const roots = new Set<string>();
	const dropped: DroppedScratchRoot[] = [];
	// A $TMPDIR pointed at $HOME stays out of yolo's set as well.
	for (const builtin of builtinScratchRoots()) {
		const canonical = canonicalizePath(builtin);
		if (canonical !== null && scratchRootProblem(canonical) === null) roots.add(canonical);
	}
	const canonicalWorkspace = canonicalizePath(path.resolve(workspace));
	for (const root of configured) {
		const problem = scratchRootProblem(root);
		if (problem !== null) {
			dropped.push({ root, reason: problem });
			continue;
		}
		const canonical = canonicalizePath(path.resolve(root));
		const linkProblem = canonical === null ? "cannot be resolved" : scratchRootProblem(canonical);
		if (canonical === null || linkProblem !== null) {
			dropped.push({ root, reason: `resolves to ${canonical ?? root}, which ${linkProblem}` });
			continue;
		}
		if (canonicalWorkspace === null || isSameOrDescendant(canonicalWorkspace, canonical)) {
			dropped.push({ root, reason: `contains the workspace ${canonicalWorkspace ?? workspace}` });
			continue;
		}
		roots.add(canonical);
	}
	return { roots: [...roots], dropped };
}

/**
 * tmpdir() already follows $TMPDIR, which counts only while it passes
 * {@link scratchRootProblem}; the rest are the conventional temp trees, and
 * macOS adds its per-user temp tree.
 */
function builtinScratchRoots(platform: NodeJS.Platform = process.platform): string[] {
	return [tmpdir(), "/tmp", "/var/tmp", "/private/var/tmp", ...(platform === "darwin" ? ["/var/folders"] : [])];
}
