/**
 * Which files under src/ ship loose and which ship inside dist/assets/source.pack.
 *
 * Loose: every file that is not `.ts` (prompt fragments, recipes, playbooks,
 * the extension child `.mjs` files, yazi assets, notices), the extension
 * scaffold templates (copied as a directory), and the whole type-import
 * closure of the public extension types. package.json `exports` points the
 * `types` of `./extensions` and `./extensions/testing` at src/, and the
 * scaffold writes tsconfig `paths` to the same files, so every file their
 * types reach must stay a real file or installed extension type-checking
 * breaks. Everything else packs.
 *
 * Shared by scripts/build-source-pack.ts, which writes the pack and the
 * src/.npmignore that keeps packed files out of the tarball, and by
 * scripts/check-release.mjs, which holds the tarball against this plan.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";

const TEMPLATES_PREFIX = "src/domains/extensions/authoring/templates/";
const SCAFFOLD = "src/domains/extensions/authoring/scaffold.ts";

function toPosix(path) {
	return path.split("\\").join("/");
}

function listSourceFiles(root) {
	return readdirSync(join(root, "src"), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name !== ".npmignore")
		.map((entry) => toPosix(relative(root, join(entry.parentPath, entry.name))))
		.sort();
}

/** The `src/...ts` files the extension types surface starts from. */
export function extensionTypeSeeds(root) {
	const seeds = new Set();
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	for (const target of Object.values(pkg.exports ?? {})) {
		if (target && typeof target === "object" && typeof target.types === "string")
			seeds.add(toPosix(target.types).replace(/^\.\//, ""));
	}
	for (const match of readFileSync(join(root, SCAFFOLD), "utf8").matchAll(/"(src\/[^"]+\.ts)"/g)) seeds.add(match[1]);
	return [...seeds].filter((seed) => seed.startsWith("src/")).sort();
}

function resolveRelative(root, fromFile, specifier) {
	const base = join(root, dirname(fromFile), specifier);
	const stem = base.replace(/\.(m?js|jsx)$/, "");
	for (const candidate of [
		base,
		`${stem}.ts`,
		`${stem}.tsx`,
		`${stem}.mts`,
		`${stem}.d.ts`,
		`${stem}.d.mts`,
		join(base, "index.ts"),
	]) {
		if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return toPosix(relative(root, candidate));
	}
	return null;
}

/** Every file under src/ the seeds reach through import, export-from, import() and reference paths. */
export function typeImportClosure(root, seeds) {
	const seen = new Set();
	const unresolved = [];
	const stack = [...seeds];
	while (stack.length > 0) {
		const file = stack.pop();
		if (seen.has(file)) continue;
		seen.add(file);
		const info = ts.preProcessFile(readFileSync(join(root, file), "utf8"), true, true);
		const specifiers = [...info.importedFiles, ...info.referencedFiles].map((ref) => ref.fileName);
		for (const specifier of specifiers) {
			if (!specifier.startsWith(".")) continue;
			const target = resolveRelative(root, file, specifier);
			if (target === null) unresolved.push(`${file} -> ${specifier}`);
			else if (target.startsWith("src/")) stack.push(target);
		}
	}
	if (unresolved.length > 0) throw new Error(`source-pack-plan: unresolved imports: ${unresolved.join(", ")}`);
	return [...seen].sort();
}

export function planSourcePack(root) {
	const files = listSourceFiles(root);
	const closure = new Set(typeImportClosure(root, extensionTypeSeeds(root)));
	const loose = [];
	const packed = [];
	for (const file of files) {
		if (!file.endsWith(".ts") || file.startsWith(TEMPLATES_PREFIX) || closure.has(file)) loose.push(file);
		else packed.push(file);
	}
	return { loose, packed, closure: [...closure].sort() };
}

/** The member paths of a built pack, parsed the way src/core/source-pack.ts reads it. */
export function readSourcePackMembers(packFile) {
	const bytes = readFileSync(packFile);
	if (bytes.toString("latin1", 0, 8) !== "CLIOSRC1") throw new Error(`not a source pack: ${packFile}`);
	const indexLength = bytes.readUInt32LE(8);
	const index = JSON.parse(bytes.toString("utf8", 12, 12 + indexLength));
	return index.files.map((entry) => entry.path);
}
