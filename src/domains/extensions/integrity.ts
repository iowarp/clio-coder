import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	type Stats,
} from "node:fs";
import path from "node:path";

export interface ExtensionContentDigestOptions {
	/** Root-relative regular files whose exact hashed bytes should be returned. */
	capture?: ReadonlyArray<string>;
}

export interface ExtensionContentDigestResult {
	digest: string;
	captured: ReadonlyMap<string, Buffer>;
}

function contained(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function digestFrame(hash: ReturnType<typeof createHash>, kind: string, relativePath: string, payload?: Buffer): void {
	const header = Buffer.from(
		`${kind}\0${relativePath.replaceAll(path.sep, "/")}\0${payload?.byteLength ?? 0}\0`,
		"utf8",
	);
	hash.update(header);
	if (payload) hash.update(payload);
	hash.update("\0");
}

function sameFileState(left: Stats, right: Stats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.mode === right.mode &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

function readStableRegularFile(filePath: string, inspected: Stats): Buffer {
	const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const opened = fstatSync(fd);
		if (!opened.isFile() || opened.nlink !== 1 || !sameFileState(inspected, opened)) {
			throw new Error(`extension file changed while being opened: ${filePath}`);
		}
		const payload = readFileSync(fd);
		if (!sameFileState(opened, fstatSync(fd))) {
			throw new Error(`extension file changed while being hashed: ${filePath}`);
		}
		return payload;
	} finally {
		closeSync(fd);
	}
}

function readStableContainedLink(linkPath: string, inspected: Stats, canonicalRoot: string): Buffer {
	const canonicalTarget = realpathSync(linkPath);
	if (!contained(canonicalRoot, canonicalTarget)) {
		throw new Error(`symbolic link escapes the extension root: ${linkPath}`);
	}
	const target = readlinkSync(linkPath);
	const after = lstatSync(linkPath);
	if (!after.isSymbolicLink() || !sameFileState(inspected, after)) {
		throw new Error(`symbolic link changed while being hashed: ${linkPath}`);
	}
	const canonicalAfter = realpathSync(linkPath);
	if (canonicalAfter !== canonicalTarget || !contained(canonicalRoot, canonicalAfter)) {
		throw new Error(`symbolic link changed or escapes the extension root: ${linkPath}`);
	}
	return Buffer.from(target, "utf8");
}

function assertStableDirectory(
	directoryPath: string,
	inspected: Stats,
	canonicalDirectory: string,
	canonicalRoot: string,
	expectedEntries?: readonly string[],
): void {
	const after = lstatSync(directoryPath);
	if (!after.isDirectory() || !sameFileState(inspected, after)) {
		throw new Error(`extension directory changed while being hashed: ${directoryPath}`);
	}
	const canonicalAfter = realpathSync(directoryPath);
	if (canonicalAfter !== canonicalDirectory || !contained(canonicalRoot, canonicalAfter)) {
		throw new Error(`extension directory changed or escapes the extension root: ${directoryPath}`);
	}
	if (expectedEntries !== undefined) {
		const currentEntries = readdirSync(directoryPath).sort();
		if (
			currentEntries.length !== expectedEntries.length ||
			currentEntries.some((entry, index) => entry !== expectedEntries[index])
		) {
			throw new Error(`extension directory entries changed while being hashed: ${directoryPath}`);
		}
	}
}

function readStableDirectory(
	directoryPath: string,
	inspected: Stats,
	canonicalRoot: string,
): { canonicalDirectory: string; entries: string[] } {
	const canonicalDirectory = realpathSync(directoryPath);
	if (!contained(canonicalRoot, canonicalDirectory)) {
		throw new Error(`extension directory escapes the extension root: ${directoryPath}`);
	}
	const entries = readdirSync(directoryPath).sort();
	assertStableDirectory(directoryPath, inspected, canonicalDirectory, canonicalRoot);
	return { canonicalDirectory, entries };
}

/**
 * Hash an extension tree in stable relative-path order. File names, node kinds,
 * symlink targets, empty directories, and file bytes are all integrity-bound.
 * Symlinks must resolve within the package so their content cannot drift outside
 * the tree without changing the digest.
 */
export function extensionContentDigestWithCapture(
	root: string,
	options: ExtensionContentDigestOptions = {},
): ExtensionContentDigestResult {
	const resolvedRoot = path.resolve(root);
	const rootStat = lstatSync(resolvedRoot);
	if (rootStat.isSymbolicLink()) {
		throw new Error(`extension root must be a directory, not a symbolic link: ${resolvedRoot}`);
	}
	if (!rootStat.isDirectory()) {
		throw new Error(`extension root must be a directory: ${resolvedRoot}`);
	}
	const canonicalRoot = realpathSync(resolvedRoot);
	const canonicalizedRootStat = lstatSync(resolvedRoot);
	if (!canonicalizedRootStat.isDirectory() || !sameFileState(rootStat, canonicalizedRootStat)) {
		throw new Error(`extension root changed while being canonicalized: ${resolvedRoot}`);
	}
	const hash = createHash("sha256");
	const requested = new Set((options.capture ?? []).map((entry) => entry.replaceAll(path.sep, "/")));
	const captured = new Map<string, Buffer>();
	const visit = (absolutePath: string, relativePath: string): void => {
		const stat = lstatSync(absolutePath);
		if (stat.isSymbolicLink()) {
			if (relativePath === "") {
				throw new Error(`extension root changed to a symbolic link while being hashed: ${absolutePath}`);
			}
			digestFrame(hash, "link", relativePath, readStableContainedLink(absolutePath, stat, canonicalRoot));
			return;
		}
		if (stat.isDirectory()) {
			digestFrame(hash, "directory", relativePath);
			const { canonicalDirectory, entries } = readStableDirectory(absolutePath, stat, canonicalRoot);
			for (const entry of entries) {
				visit(path.join(absolutePath, entry), relativePath ? path.join(relativePath, entry) : entry);
			}
			assertStableDirectory(absolutePath, stat, canonicalDirectory, canonicalRoot, entries);
			return;
		}
		if (stat.isFile()) {
			if (stat.nlink !== 1) {
				throw new Error(`hard-linked file is unsupported in an extension: ${absolutePath}`);
			}
			const payload = readStableRegularFile(absolutePath, stat);
			digestFrame(hash, "file", relativePath, payload);
			const key = relativePath.replaceAll(path.sep, "/");
			if (requested.has(key)) captured.set(key, payload);
			return;
		}
		throw new Error(`unsupported filesystem entry in extension: ${absolutePath}`);
	};
	visit(resolvedRoot, "");
	return { digest: hash.digest("hex"), captured };
}

export function extensionContentDigest(root: string): string {
	return extensionContentDigestWithCapture(root).digest;
}
