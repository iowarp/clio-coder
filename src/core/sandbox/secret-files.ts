import { execFileSync } from "node:child_process";
import { type Dirent, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { HOME_SECRET_RELATIVE_PATHS, WORKSPACE_SECRET_PATHS } from "../../domains/safety/secret-paths.js";
import { internalGitArgv } from "../internal-git.js";
import type { SandboxMaskedPath } from "./types.js";

/**
 * Secret files inside the trees a sandboxed command can read and write: the
 * workspace and the scratch roots of the main session, the worktree and
 * checkouts of a worker. The sandbox reads the whole filesystem and already
 * masks the home directory's credential stores, but a project's `.env`,
 * private keys and service-account files sit in the workspace itself. Each
 * launch masks the ones found here the way it masks the home credentials:
 * under bubblewrap `/dev/null` is bound over a secret file, which the bind's
 * `nodev` turns into a refused open, and an empty tmpfs over a secret
 * directory; Seatbelt denies reading either. The names come from the list
 * the typed tools refuse (`WORKSPACE_SECRET_PATHS`), matched by name at any
 * depth, plus the home credential stores when a copy sits inside a scanned
 * root.
 */

/** Masks past this many are not added; bubblewrap's argv and Seatbelt's profile grow with each one. */
const SECRET_MASK_LIMIT = 512;
/** Directory levels below a root a scan descends. */
const SCAN_DEPTH = 6;
/** Directory entries one root's walk may visit before it stops and reports itself capped. */
const WALK_ENTRY_BUDGET = 20_000;
/** A workspace's scan is reused this long, or until its top directory changes. */
const WORKSPACE_SCAN_TTL_MS = 10_000;
/** A scratch root such as /tmp changes all the time and is often large, so its scan lives longer. */
const SCRATCH_SCAN_TTL_MS = 30_000;
/**
 * Generated and dependency trees are never walked, and neither is a Python
 * environment found under another name (it holds `pyvenv.cfg` or
 * `conda-meta`): a secret kept in one is not masked.
 */
const SKIPPED_DIRS = new Set([
	"node_modules",
	".venv",
	"venv",
	".git",
	"target",
	"dist",
	"build",
	"__pycache__",
	"site-packages",
	"dist-packages",
	".tox",
	".nox",
]);
const ENVIRONMENT_MARKERS = ["pyvenv.cfg", "conda-meta"] as const;
/** Templates that document a secret's shape (`.env.example`) hold none. */
const EXAMPLE_FILE = /\.(?:example|sample|template)$/iu;
/** A literal npm registry credential; `${NPM_TOKEN}` names a variable and stays readable. */
const NPMRC_LITERAL_CREDENTIAL = /^\s*(?:\/\/\S*:)?_(?:authToken|auth|password)\s*=\s*(?!["']?\$\{)\S/mu;
const NPMRC_READ_BYTES = 64 * 1024;
/**
 * A `.pem` is masked only when it holds a private key. Certificate bundles
 * (certifi's cacert.pem, a test CA) are public, and an empty one breaks every
 * TLS client in the sandbox; a bundle past this size is taken for one.
 */
const PEM_READ_BYTES = 1024 * 1024;

interface SecretNameMatcher {
	/** Exact base names of secret files. */
	fileNames: ReadonlySet<string>;
	/** Exact base names of directories masked whole. `.env` is not one: it is a common virtualenv name. */
	dirNames: ReadonlySet<string>;
	/** Every single-segment glob as one expression over a base name. */
	glob: RegExp;
	/**
	 * Cheap gate in front of `glob`: the extensions its patterns end in, and the
	 * prefixes of the ones ending in `*`. Most base names pass neither.
	 */
	globExtensions: ReadonlySet<string>;
	globPrefixes: ReadonlyArray<string>;
	/** Multi-segment paths (`.docker/config.json`) keyed by their last segment, matched as a path suffix. */
	suffixes: ReadonlyMap<string, ReadonlyArray<string>>;
}

function globSource(pattern: string): string {
	return pattern
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
		.join("[^/]*");
}

function compileMatcher(): SecretNameMatcher {
	const fileNames = new Set<string>();
	const dirNames = new Set<string>();
	const globs: string[] = [];
	const globExtensions = new Set<string>();
	const globPrefixes: string[] = [];
	const suffixes = new Map<string, string[]>();
	const add = (raw: string, home: boolean): void => {
		const entry = raw.replace(/\/+$/u, "");
		// A project's .npmrc usually holds registry settings, so only a literal token masks it.
		if (entry === ".npmrc") return;
		if (entry.includes("/")) {
			const last = entry.slice(entry.lastIndexOf("/") + 1);
			suffixes.set(last, [...(suffixes.get(last) ?? []), entry]);
		} else if (entry.includes("*")) {
			globs.push(globSource(entry));
			if (entry.endsWith("*")) globPrefixes.push(entry.slice(0, entry.indexOf("*")));
			else globExtensions.add(entry.slice(entry.lastIndexOf(".") + 1));
		} else {
			// The home list names credential stores of either kind; the workspace list marks directories.
			if (home || raw.endsWith("/")) dirNames.add(entry);
			if (home || !raw.endsWith("/")) fileNames.add(entry);
		}
	};
	for (const entry of WORKSPACE_SECRET_PATHS) add(entry, false);
	for (const entry of HOME_SECRET_RELATIVE_PATHS) add(entry, true);
	return {
		fileNames,
		dirNames,
		glob: new RegExp(`^(?:${globs.join("|")})$`, "u"),
		globExtensions,
		globPrefixes,
		suffixes,
	};
}

let matcher: SecretNameMatcher | null = null;

function secretMatcher(): SecretNameMatcher {
	matcher ??= compileMatcher();
	return matcher;
}

/** What a matching path needs before it is masked: nothing, or a look at its content. */
type SecretPathKind = "secret" | "npmrc" | "pem";

/** `relative` ends with one of the multi-segment secret paths whose last segment is `base`. */
function suffixMatch(relative: string, base: string): boolean {
	const candidates = secretMatcher().suffixes.get(base);
	return candidates?.some((suffix) => relative === suffix || relative.endsWith(`/${suffix}`)) === true;
}

/**
 * Pure: how a path relative to a scanned root (`/`-separated) is treated.
 * `secret` masks it, `npmrc` and `pem` mask it when its content holds a
 * literal credential or a private key, and `null` leaves it readable. A
 * directory matches by exact name only, so a directory that happens to be
 * called `x.key` is walked instead of hidden.
 */
function secretPathKind(relative: string, directory = false): SecretPathKind | null {
	const base = relative.slice(relative.lastIndexOf("/") + 1);
	if (base.length === 0) return null;
	const { fileNames, dirNames, glob, globExtensions, globPrefixes } = secretMatcher();
	const globGate = (): boolean =>
		globExtensions.has(base.slice(base.lastIndexOf(".") + 1)) || globPrefixes.some((prefix) => base.startsWith(prefix));
	let kind: SecretPathKind | null;
	if (suffixMatch(relative, base)) kind = "secret";
	else if (directory) kind = dirNames.has(base) ? "secret" : null;
	else if (base.toLowerCase().endsWith(".pem")) kind = "pem";
	else if (fileNames.has(base) || (globGate() && glob.test(base))) kind = "secret";
	else kind = base === ".npmrc" ? "npmrc" : null;
	return kind !== null && EXAMPLE_FILE.test(base) ? null : kind;
}

/** The whole file when it is at most `bytes` long, else null. */
function readSmall(file: string, bytes: number): string | null {
	try {
		return statSync(file).size > bytes ? null : readFileSync(file, "utf8");
	} catch {
		// Unreadable here is unreadable in the sandbox too.
		return null;
	}
}

/** Content checks for the kinds that need one; a plain secret needs none. */
function contentIsSecret(kind: SecretPathKind, file: string): boolean {
	if (kind === "secret") return true;
	if (kind === "npmrc") return NPMRC_LITERAL_CREDENTIAL.test(readSmall(file, NPMRC_READ_BYTES) ?? "");
	return (readSmall(file, PEM_READ_BYTES) ?? "").includes("PRIVATE KEY");
}

/** A path the scan found, before link resolution. */
interface SecretCandidate {
	path: string;
	kind: SecretPathKind;
	/**
	 * Hidden whatever it resolves to: matched by a directory name, or inside a
	 * secret directory. A file-name match that resolves to a directory
	 * (`.env -> venv`) is left alone.
	 */
	anyKind: boolean;
}

interface RootScan {
	candidates: SecretCandidate[];
	capped: boolean;
}

/** Git with no repository overrides from Clio's own environment and no fsmonitor hook. */
function gitProbeEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith("GIT_")) env[key] = value;
	}
	return env;
}

function git(root: string, args: ReadonlyArray<string>): string[] | null {
	try {
		const output = execFileSync("git", internalGitArgv(["--literal-pathspecs", ...args], root), {
			cwd: root,
			env: gitProbeEnv(),
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2_000,
			maxBuffer: 64 * 1024 * 1024,
		});
		return output
			.toString("utf8")
			.split("\0")
			.filter((entry) => entry.length > 0);
	} catch {
		return null;
	}
}

interface GitEntry {
	/** `/`-separated, relative to the root; a wholly untracked directory keeps its trailing slash. */
	path: string;
	/** Tracked and, as far as the index says, unchanged (`ls-files -v` tag `H`). */
	clean: boolean;
}

/**
 * Tracked files plus every untracked one, ignored included (secrets usually
 * are), with each wholly untracked directory collapsed to one `dir/` entry.
 * Null outside a work tree. Lowercase tags (assume-unchanged) and
 * skip-worktree entries are not clean: their working copy may differ.
 */
function gitListing(root: string): GitEntry[] | null {
	const lines = git(root, ["ls-files", "-z", "-v", "--cached", "--others", "--directory"]);
	if (lines === null) return null;
	return lines.map((line) => ({ path: line.slice(2), clean: line.startsWith("H ") }));
}

interface WalkState {
	visited: number;
	capped: boolean;
	exclude: ReadonlySet<string>;
}

function isEnvironmentMarker(name: string): boolean {
	return (ENVIRONMENT_MARKERS as ReadonlyArray<string>).includes(name);
}

/** Bounded walk below `relativeDir`; links are tested by name and never followed. */
function walk(root: string, relativeDir: string, depth: number, state: WalkState, out: SecretCandidate[]): void {
	const stack: Array<{ relative: string; depth: number }> = [{ relative: relativeDir, depth }];
	while (stack.length > 0) {
		const frame = stack.pop();
		if (frame === undefined) break;
		const absolute = frame.relative.length === 0 ? root : path.join(root, frame.relative);
		let entries: Dirent[];
		try {
			entries = readdirSync(absolute, { withFileTypes: true });
		} catch {
			// Unreadable to this process is unreadable inside its sandbox too.
			continue;
		}
		if (frame.relative.length > 0 && entries.some((entry) => isEnvironmentMarker(entry.name))) continue;
		for (const entry of entries) {
			if (state.visited >= WALK_ENTRY_BUDGET) {
				state.capped = true;
				return;
			}
			state.visited += 1;
			const relative = frame.relative.length === 0 ? entry.name : `${frame.relative}/${entry.name}`;
			const childAbsolute = path.join(root, relative);
			if (entry.isDirectory()) {
				if (state.exclude.has(childAbsolute)) continue;
				if (secretPathKind(relative, true) !== null) out.push({ path: childAbsolute, kind: "secret", anyKind: true });
				else if (!SKIPPED_DIRS.has(entry.name) && frame.depth + 1 < SCAN_DEPTH) {
					stack.push({ relative, depth: frame.depth + 1 });
				}
				continue;
			}
			// A link under a directory name (`.aws -> /mnt/c/...`) hides whatever it resolves to.
			const anyKind = secretPathKind(relative, true) !== null;
			const kind = anyKind ? "secret" : secretPathKind(relative);
			if (kind !== null) out.push({ path: childAbsolute, kind, anyKind });
		}
	}
}

/** The secret directory an entry sits in, by the names that mask a directory whole. */
function secretAncestor(relative: string): string | null {
	const { dirNames, suffixes } = secretMatcher();
	let start = 0;
	let index = relative.indexOf("/");
	while (index !== -1) {
		const name = relative.slice(start, index);
		if (dirNames.has(name) || (suffixes.has(name) && suffixMatch(relative.slice(0, index), name))) {
			return relative.slice(0, index);
		}
		start = index + 1;
		index = relative.indexOf("/", start);
	}
	return null;
}

function scanRoot(root: string, exclude: ReadonlySet<string>): RootScan {
	const candidates: SecretCandidate[] = [];
	const state: WalkState = { visited: 0, capped: false, exclude };
	const listing = gitListing(root);
	if (listing === null) {
		walk(root, "", 0, state, candidates);
		return { candidates, capped: state.capped };
	}
	// A clean tracked file stays readable: its committed content is readable
	// through git objects in the sandbox anyway, and a masked tracked file
	// breaks `git add -A` and `git commit -a` there. A secret directory that
	// holds one is therefore masked file by file, never whole, or a contained
	// `git add -A` would stage the deletion of everything tracked inside it.
	const cleanTracked = new Map<string, SecretCandidate>();
	for (const { path: raw, clean } of listing) {
		const directory = raw.endsWith("/");
		const relative = directory ? raw.slice(0, -1) : raw;
		const absolute = path.join(root, relative);
		const inSecretDirectory = secretAncestor(relative) !== null;
		if (!directory) {
			const anyKind = inSecretDirectory || secretPathKind(relative, true) !== null;
			const kind = anyKind ? "secret" : secretPathKind(relative);
			if (kind === null) continue;
			const candidate = { path: absolute, kind, anyKind };
			if (clean) cleanTracked.set(relative, candidate);
			else candidates.push(candidate);
			continue;
		}
		// A wholly untracked directory: hidden whole when it is or sits in a secret directory, else walked.
		const name = relative.slice(relative.lastIndexOf("/") + 1);
		if (inSecretDirectory || secretPathKind(relative, true) !== null) {
			candidates.push({ path: absolute, kind: "secret", anyKind: true });
		} else if (!SKIPPED_DIRS.has(name) && !exclude.has(absolute)) {
			const depth = relative.split("/").length;
			if (depth < SCAN_DEPTH) walk(root, relative, depth, state, candidates);
		}
		if (state.capped) break;
	}
	if (cleanTracked.size > 0) {
		// Unknown modification state hides them all rather than none.
		const modified = git(root, ["ls-files", "-z", "--modified", "--", ...cleanTracked.keys()]) ?? [
			...cleanTracked.keys(),
		];
		for (const relative of modified) {
			const candidate = cleanTracked.get(relative);
			if (candidate !== undefined) candidates.push(candidate);
		}
	}
	return { candidates, capped: state.capped };
}

interface CachedScan {
	at: number;
	stamp: number | null;
	scan: RootScan;
}

const scanCache = new Map<string, CachedScan>();

function directoryStamp(root: string): number | null {
	try {
		return statSync(root).mtimeMs;
	} catch {
		return null;
	}
}

function cachedScan(root: string, workspace: boolean, exclude: ReadonlySet<string>, now: number): RootScan {
	const stamp = workspace ? directoryStamp(root) : null;
	const ttl = workspace ? WORKSPACE_SCAN_TTL_MS : SCRATCH_SCAN_TTL_MS;
	// The roots a scan skips change what it finds, so they are part of its key.
	const key = [root, ...[...exclude].sort()].join("\0");
	const cached = scanCache.get(key);
	if (cached !== undefined && now - cached.at < ttl && cached.stamp === stamp) return cached.scan;
	const scan = scanRoot(root, exclude);
	scanCache.set(key, { at: now, stamp, scan });
	return scan;
}

export interface SecretMaskScan {
	masks: SandboxMaskedPath[];
	/** True when a walk ran out of budget or more than {@link SECRET_MASK_LIMIT} secrets were found. */
	capped: boolean;
}

function isInside(parent: string, candidate: string): boolean {
	const rel = path.relative(parent, candidate);
	return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Impure: masks for the secret files under `workspaceRoots` and
 * `scratchRoots`. A workspace scan is redone when its top directory changes
 * (a new `.env` beside the project) or after 10 s; a scratch root such as
 * /tmp changes constantly, so only a 30 s TTL renews it. Each mask names the
 * physical path, since a mount over a link fails, and a file the scan found
 * that is gone by now is skipped. Masks inside a masked directory and paths
 * already in `existing` are dropped.
 */
export function discoverSecretMasks(
	roots: { workspaceRoots: ReadonlyArray<string>; scratchRoots?: ReadonlyArray<string> },
	existing: ReadonlyArray<SandboxMaskedPath> = [],
	now: number = Date.now(),
): SecretMaskScan {
	const physical = (entry: string): string | null => {
		try {
			return realpathSync(entry);
		} catch {
			return null;
		}
	};
	const workspaceRoots = [...new Set(roots.workspaceRoots.map(physical).filter((root) => root !== null))];
	const scratchRoots = [...new Set((roots.scratchRoots ?? []).map(physical).filter((root) => root !== null))];
	let capped = false;
	const candidates: SecretCandidate[] = [];
	for (const [index, root] of [...workspaceRoots, ...scratchRoots].entries()) {
		// A workspace under /tmp is scanned once, as the workspace.
		const exclude = new Set([...workspaceRoots, ...scratchRoots].filter((other) => other !== root));
		const scan = cachedScan(root, index < workspaceRoots.length, exclude, now);
		capped ||= scan.capped;
		candidates.push(...scan.candidates);
	}
	const taken = new Set(existing.map((mask) => mask.path));
	const directories = existing.filter((mask) => mask.kind === "directory").map((mask) => mask.path);
	const masks: SandboxMaskedPath[] = [];
	for (const candidate of candidates) {
		const target = physical(candidate.path);
		if (target === null || taken.has(target)) continue;
		if (directories.some((dir) => isInside(dir, target))) continue;
		let isDirectory: boolean;
		try {
			isDirectory = statSync(target).isDirectory();
		} catch {
			continue;
		}
		if (isDirectory ? !candidate.anyKind : !contentIsSecret(candidate.kind, target)) continue;
		if (masks.length >= SECRET_MASK_LIMIT) {
			capped = true;
			break;
		}
		taken.add(target);
		if (isDirectory) directories.push(target);
		masks.push({ path: target, kind: isDirectory ? "directory" : "file" });
	}
	// A directory found after a file inside it still hides that file; the file mask would only fail.
	return {
		masks: masks.filter((mask) => !directories.some((dir) => isInside(dir, mask.path))),
		capped,
	};
}
