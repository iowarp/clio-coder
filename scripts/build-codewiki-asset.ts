#!/usr/bin/env node
/**
 * Build step: generate the package's own code map, dist/assets/codewiki.json,
 * fresh from the exact tree being packed.
 *
 * This runs the same model-free, deterministic indexer as `clio-coder context
 * index` (tree-sitter wasm plus regex fallbacks; byte-identical across runs)
 * and serializes the result straight into dist/assets/. The file set is what
 * `npm pack` will ship, read off `npm pack --dry-run`, so every entry names a
 * file the installed package actually contains. It never reads or writes
 * `.clio-coder/`: a found, cached, or checked-in index would describe some
 * other tree, and `state.json` carries timestamps and mtimeMs fingerprints
 * that must never enter the tarball. Wired into `npm run build` after tsup so
 * the grammars it loads are the vendored ones.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCodewiki, serializeCodewiki } from "../src/domains/context/codewiki/indexer.js";
import { detectProjectProfile } from "../src/domains/session/workspace/project-type.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const target = join(root, "dist", "assets", "codewiki.json");

const report = JSON.parse(
	execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		stdio: ["ignore", "pipe", "ignore"],
	}),
) as Array<{ files: Array<{ path: string }> }>;
const packed = new Set(report[0].files.map((file) => file.path));

const profile = detectProjectProfile(root);
const codewiki = await buildCodewiki(
	{ cwd: root, language: profile.projectType },
	{
		// Only files the tarball ships enter the index; everything else reads as absent.
		readFile: (path) => (packed.has(relative(root, path).replaceAll("\\", "/")) ? readFileSync(path, "utf8") : null),
	},
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, serializeCodewiki(codewiki), "utf8");
process.stdout.write(
	`build-codewiki-asset: ${codewiki.files.length} files, ${codewiki.symbols.length} symbols, ${codewiki.edges.length} edges -> dist/assets/codewiki.json\n`,
);
