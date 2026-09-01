import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

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

/**
 * Hash an extension tree in stable relative-path order. File names, node kinds,
 * symlink targets, empty directories, and file bytes are all integrity-bound.
 * Symlinks must resolve within the package so their content cannot drift outside
 * the tree without changing the digest.
 */
export function extensionContentDigest(root: string): string {
	const resolvedRoot = path.resolve(root);
	const canonicalRoot = realpathSync(resolvedRoot);
	const hash = createHash("sha256");
	const visit = (absolutePath: string, relativePath: string): void => {
		const stat = lstatSync(absolutePath);
		if (stat.isSymbolicLink()) {
			const canonicalTarget = realpathSync(absolutePath);
			if (!contained(canonicalRoot, canonicalTarget)) {
				throw new Error(`symbolic link escapes the extension root: ${absolutePath}`);
			}
			digestFrame(hash, "link", relativePath, Buffer.from(readlinkSync(absolutePath), "utf8"));
			return;
		}
		if (stat.isDirectory()) {
			digestFrame(hash, "directory", relativePath);
			for (const entry of readdirSync(absolutePath).sort()) {
				visit(path.join(absolutePath, entry), relativePath ? path.join(relativePath, entry) : entry);
			}
			return;
		}
		if (stat.isFile()) {
			digestFrame(hash, "file", relativePath, readFileSync(absolutePath));
			return;
		}
		throw new Error(`unsupported filesystem entry in extension: ${absolutePath}`);
	};
	visit(resolvedRoot, "");
	return hash.digest("hex");
}
