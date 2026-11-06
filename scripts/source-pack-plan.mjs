/**
 * Which files under src/ ship loose and which ship inside dist/assets/source.pack.
 *
 * Loose: every file that is not `.ts` (prompt fragments, recipes, playbooks,
 * the extension child `.mjs` files, yazi assets, notices) and the extension
 * scaffold templates (copied as a directory). Everything else packs. The
 * public extension types need no loose source: package.json `exports` and the
 * scaffold's tsconfig paths name the bundled declarations under
 * dist/extensions/, which tsup builds (tsup.config.ts `dts`).
 *
 * Shared by scripts/build-source-pack.ts, which writes the pack and the
 * src/.npmignore that keeps packed files out of the tarball, and by
 * scripts/check-release.mjs, which holds the tarball against this plan.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const TEMPLATES_PREFIX = "src/domains/extensions/authoring/templates/";

function toPosix(path) {
	return path.split("\\").join("/");
}

function listSourceFiles(root) {
	return readdirSync(join(root, "src"), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name !== ".npmignore")
		.map((entry) => toPosix(relative(root, join(entry.parentPath, entry.name))))
		.sort();
}

export function planSourcePack(root) {
	const loose = [];
	const packed = [];
	for (const file of listSourceFiles(root)) {
		if (!file.endsWith(".ts") || file.startsWith(TEMPLATES_PREFIX)) loose.push(file);
		else packed.push(file);
	}
	return { loose, packed };
}

/** The member paths of a built pack, parsed the way src/core/source-pack.ts reads it. */
export function readSourcePackMembers(packFile) {
	const bytes = readFileSync(packFile);
	if (bytes.toString("latin1", 0, 8) !== "CLIOSRC1") throw new Error(`not a source pack: ${packFile}`);
	const indexLength = bytes.readUInt32LE(8);
	const index = JSON.parse(bytes.toString("utf8", 12, 12 + indexLength));
	return index.files.map((entry) => entry.path);
}
