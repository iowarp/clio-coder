#!/usr/bin/env node
/**
 * Build step: generate the package's own code map, dist/assets/codemap.json.gz,
 * fresh from the exact tree being packed.
 *
 * This runs the same model-free, deterministic indexer as `clio-coder context
 * index` (tree-sitter wasm plus regex fallbacks; byte-identical across runs)
 * and serializes the result straight into dist/assets/. The file set is what
 * `npm pack --dry-run` reports plus the members of dist/assets/source.pack, so
 * every entry names a file the installed package actually contains or `read`
 * opens from the pack. Asking npm costs a few seconds per build and keeps
 * npm's own dependency tree out of this repository. It never reads or writes
 * `.clio-coder/`: a found, cached, or checked-in index would describe some
 * other tree, and `state.json` carries timestamps and mtimeMs fingerprints
 * that must never enter the tarball. Wired into `pnpm run build` after tsup and
 * the source pack, so the grammars it loads are the vendored ones and the pack
 * membership is final. Stored gzipped: code_nav inflates it once per process,
 * and the 5 MB of JSON costs under 1 MB on disk.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, constants as zlibConstants } from "node:zlib";
import { listPackedSources } from "../src/core/source-pack.js";
import { serializeCodewiki } from "../src/domains/context/codewiki/artifact.js";
import { buildCodewiki } from "../src/domains/context/codewiki/indexer.js";
import { detectProjectProfile } from "../src/domains/session/workspace/project-type.js";
import { buildVerbose, reportBuildStage } from "./build-output.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const target = join(root, "dist", "assets", "codemap.json.gz");
const startedAt = performance.now();

const report = JSON.parse(
	execFileSync("npm", ["pack", "--dry-run", "--json"], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		// npm is a .cmd on Windows, which execFile cannot start without a shell.
		shell: process.platform === "win32",
		stdio: ["ignore", "pipe", "ignore"],
	}),
)[0] as { files: { path: string }[] };
const packed = new Set([...report.files.map((file) => file.path), ...listPackedSources(root)]);

const profile = detectProjectProfile(root);
const codewiki = await buildCodewiki(
	{ cwd: root, language: profile.projectType },
	{
		// Only files the tarball ships enter the index; everything else reads as absent.
		readFile: (path) => (packed.has(relative(root, path).replaceAll("\\", "/")) ? readFileSync(path, "utf8") : null),
	},
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, gzipSync(serializeCodewiki(codewiki), { level: zlibConstants.Z_BEST_COMPRESSION }));
// Remove the superseded generated assets when rebuilding an existing dist.
rmSync(join(root, "dist", "assets", "codemap.json"), { force: true });
rmSync(join(root, "dist", "assets", "codewiki.json"), { force: true });
if (buildVerbose()) {
	process.stdout.write(
		`build-codewiki-asset: ${codewiki.files.length} files, ${codewiki.symbols.length} symbols, ${codewiki.edges.length} edges -> dist/assets/codemap.json.gz\n`,
	);
}
reportBuildStage("Code map", startedAt, statSync(target).size);
