/**
 * Names, project identity and on-disk paths for the store.
 *
 * The vocabulary is clio-core's: a tag is a named container and a blob is a
 * named byte sequence inside one tag. Names stay ASCII because one undecodable
 * name breaks a whole listing on the clio-core backend, and a tag never starts
 * with `/` because clio-core splits such a name into a hierarchy.
 *
 * Every function here is pure apart from `realpath` and reading `.git` and
 * `commondir`: the safety layer predicts where a store call writes from its
 * arguments alone, the way it predicts the `artifact` default path
 * (`src/core/artifact-paths.ts`).
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { clioProjectRoot } from "./project-root.js";
import { clioDataPath } from "./xdg.js";

export const STORE_TAG_MAX_BYTES = 200;
export const STORE_BLOB_MAX_BYTES = 480;
export const STORE_RECORDS_SUFFIX = "/.records";
/** Physical prefix a clio-core backend will use: `agentspace/<projectKey>/<tag>`. */
export const STORE_NATIVE_PREFIX = "agentspace";

const TAG_CHARS = /^[A-Za-z0-9._/-]+$/u;
// Printable ASCII without `#` (reserved for record names) and `\`.
const BLOB_CHARS = /^[\x20-\x22\x24-\x5b\x5d-\x7e]+$/u;

function pathShapeProblem(kind: string, name: string): string | null {
	if (name.startsWith("/")) return `A ${kind} name must not start with "/".`;
	if (name.endsWith("/")) return `A ${kind} name must not end with "/".`;
	for (const segment of name.split("/")) {
		if (segment === "") return `A ${kind} name must not contain an empty segment ("//").`;
		if (segment === "." || segment === "..") return `A ${kind} name must not contain a "." or ".." segment.`;
	}
	return null;
}

/**
 * null when valid, else a sentence naming the rule broken. Judges names the
 * model or operator supplies; internal callers pass `allowRecords` to also
 * accept `recordsTag(t)` for a valid `t`.
 */
export function validateTagName(tag: string, options: { allowRecords?: boolean } = {}): string | null {
	if (options.allowRecords === true && isRecordsTag(tag))
		return validateTagName(tag.slice(0, -STORE_RECORDS_SUFFIX.length));
	const bytes = Buffer.byteLength(tag, "utf8");
	if (bytes === 0) return "A tag name must not be empty.";
	if (bytes > STORE_TAG_MAX_BYTES) return `A tag name must be at most ${STORE_TAG_MAX_BYTES} bytes.`;
	if (!TAG_CHARS.test(tag)) return "A tag name may contain only letters, digits, '.', '_', '-' and '/'.";
	const shape = pathShapeProblem("tag", tag);
	if (shape !== null) return shape;
	if (tag.split("/").some((segment) => segment.startsWith(".")))
		return 'A tag name segment must not start with "." (reserved for records tags).';
	return null;
}

/** null when valid, else a sentence naming the rule broken. */
export function validateBlobName(blob: string): string | null {
	const bytes = Buffer.byteLength(blob, "utf8");
	if (bytes === 0) return "A blob name must not be empty.";
	if (bytes > STORE_BLOB_MAX_BYTES) return `A blob name must be at most ${STORE_BLOB_MAX_BYTES} bytes.`;
	if (!BLOB_CHARS.test(blob)) return "A blob name may contain only printable ASCII characters other than '#' and '\\'.";
	return pathShapeProblem("blob", blob);
}

export function recordsTag(tag: string): string {
	return `${tag}${STORE_RECORDS_SUFFIX}`;
}

export function isRecordsTag(tag: string): boolean {
	return tag.endsWith(STORE_RECORDS_SUFFIX);
}

export function encodeTagSegment(tag: string): string {
	return encodeURIComponent(tag);
}

export function decodeTagSegment(segment: string): string {
	return decodeURIComponent(segment);
}

/**
 * Main checkout for a linked worktree, else `clioProjectRoot(cwd)`, so workers
 * in task worktrees key the same store as the session that dispatched them.
 * The same `.git` then `commondir` walk exists in `taskWorktreeOrigin`
 * (`src/core/task-worktree-claim.ts`) and `linkedWorktreeMainRoot`
 * (`src/domains/memory/operations.ts`); each also checks an ownership claim or
 * back link this lookup does not need, so they are not merged here.
 */
export function storeProjectRoot(cwd: string): string {
	const root = clioProjectRoot(cwd);
	try {
		const dotGit = join(root, ".git");
		if (!lstatSync(dotGit).isFile()) return root;
		const gitdir = /^gitdir:\s*(.+?)\s*$/mu.exec(readFileSync(dotGit, "utf8"))?.[1];
		if (gitdir === undefined) return root;
		const linkedGitDir = resolve(root, gitdir);
		const commonDir = resolve(linkedGitDir, readFileSync(join(linkedGitDir, "commondir"), "utf8").trim());
		if (basename(commonDir) !== ".git") return root;
		return realpathSync(dirname(commonDir));
	} catch {
		// Not a linked worktree, or an unreadable one: the store keys on this checkout.
		return root;
	}
}

/** First 16 hex of sha256(realpath(root)). */
export function storeProjectKey(root: string): string {
	let physical: string;
	try {
		physical = realpathSync(root);
	} catch {
		physical = resolve(root);
	}
	return createHash("sha256").update(physical).digest("hex").slice(0, 16);
}

export function storeRoot(): string {
	return join(clioDataPath(), "store");
}

export function storeProjectDir(cwd: string): string {
	return join(storeRoot(), "projects", storeProjectKey(storeProjectRoot(cwd)));
}

export function storeTagDir(cwd: string, tag: string): string {
	return join(storeProjectDir(cwd), "tags", encodeTagSegment(tag));
}

export function storeBlobPath(cwd: string, tag: string, blob: string): string {
	return join(storeTagDir(cwd, tag), "blobs", blob);
}

/**
 * Directory boundaries a dispatch grant of `tags` adds to a worker's write
 * scope: each tag's blob directory and its records tag (M-31).
 */
export function storeGrantBoundaries(cwd: string, tags: ReadonlyArray<string>): string[] {
	return tags.flatMap((tag) => [`${storeTagDir(cwd, tag)}/`, `${storeTagDir(cwd, recordsTag(tag))}/`]);
}

/** True when an absolute path lies inside the store root. */
export function isStorePath(candidate: string): boolean {
	const root = storeRoot();
	return candidate === root || candidate.startsWith(`${root}/`);
}

/** Trees outside the workspace the model may read: this project's store directory. */
export function storeReadRoots(cwd: string): string[] {
	return [storeProjectDir(cwd)];
}

/** Where a store write lands, from tool arguments alone; null for read ops and malformed calls. */
export function storeWriteTarget(cwd: string, args: Record<string, unknown> | undefined): string | null {
	if (args === undefined) return null;
	const tag = args.tag;
	if (typeof tag !== "string" || validateTagName(tag) !== null) return null;
	const blobTarget = (blob: unknown): string | null =>
		typeof blob === "string" && validateBlobName(blob) === null ? storeBlobPath(cwd, tag, blob) : null;
	switch (args.op) {
		case "create":
			return storeTagDir(cwd, tag);
		case "note":
			return storeTagDir(cwd, recordsTag(tag));
		case "remove":
			return blobTarget(args.blob);
		case "put":
			// The tool treats an empty blob as absent and stores under the source's basename, so the target does too.
			return blobTarget(
				typeof args.blob === "string" && args.blob.length > 0
					? args.blob
					: typeof args.path === "string"
						? basename(args.path)
						: undefined,
			);
		default:
			return null;
	}
}
