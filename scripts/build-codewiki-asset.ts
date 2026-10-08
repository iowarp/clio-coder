#!/usr/bin/env node
/**
 * Build step: generate the package's own code map, dist/assets/codemap.json,
 * fresh from the exact tree being packed.
 *
 * This runs the same model-free, deterministic indexer as `clio-coder context
 * index` (tree-sitter wasm plus regex fallbacks; byte-identical across runs)
 * and serializes the result straight into dist/assets/. The file set is what
 * `npm pack` will ship, read through npm's official packlist and actual
 * dependency tree without compressing a throwaway tarball. Every entry names a
 * file the installed package actually contains. The API pins mirror Node 22's
 * bundled npm and must move with it. It never reads or writes
 * `.clio-coder/`: a found, cached, or checked-in index would describe some
 * other tree, and `state.json` carries timestamps and mtimeMs fingerprints
 * that must never enter the tarball. Wired into `pnpm run build` after tsup so
 * the grammars it loads are the vendored ones.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Arborist from "@npmcli/arborist";
import packlist from "npm-packlist";
import { serializeCodewiki } from "../src/domains/context/codewiki/artifact.js";
import { buildCodewiki } from "../src/domains/context/codewiki/indexer.js";
import { detectProjectProfile } from "../src/domains/session/workspace/project-type.js";
import { buildVerbose, reportBuildStage } from "./build-output.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const target = join(root, "dist", "assets", "codemap.json");
const startedAt = performance.now();

const tree = await new Arborist({ path: root }).loadActual();
const packOptions = { path: root, prefix: root };
const packed = new Set(await packlist(tree, packOptions));

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
// Remove the superseded generated asset when rebuilding an existing dist.
rmSync(join(root, "dist", "assets", "codewiki.json"), { force: true });
if (buildVerbose()) {
	process.stdout.write(
		`build-codewiki-asset: ${codewiki.files.length} files, ${codewiki.symbols.length} symbols, ${codewiki.edges.length} edges -> dist/assets/codemap.json\n`,
	);
}
reportBuildStage("Code map", startedAt, statSync(target).size);
