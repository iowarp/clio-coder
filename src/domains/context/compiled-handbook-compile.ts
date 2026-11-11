/**
 * The compile behind `refreshCompiledHandbook`, run on its worker thread: list
 * the tree, fingerprint what the compile reads, and rewrite the cache under
 * `.clio-coder/state/` only when the fingerprint moved.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { ensureProjectIgnore } from "../../core/project-root.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { enumerateWorkspaceFiles } from "../../core/workspace-files.js";
import { scanAgentConfigs } from "./adoption.js";
import { compileHandbookFromTree } from "./bootstrap.js";
import {
	COMPILE_VERSION,
	type CompiledHandbookSidecar,
	compiledHandbookPath,
	compiledHandbookSidecarPath,
	type InputStamp,
	readCompiledHandbookCache,
	stampOf,
} from "./compiled-handbook.js";
import { collectEnforcementInventory } from "./enforcement-inventory.js";

/** Root files whose content the compile reads beyond the checkers and handbooks. */
const MANIFESTS: ReadonlyArray<string> = [
	"package.json",
	"tsconfig.json",
	"biome.json",
	"biome.jsonc",
	".prettierrc",
	".prettierrc.json",
	"Cargo.toml",
	"go.mod",
	"pyproject.toml",
	"setup.cfg",
	"CMakeLists.txt",
];

function writeSidecar(root: string, sidecar: CompiledHandbookSidecar): void {
	safeResourceWrite(compiledHandbookSidecarPath(root), `${JSON.stringify(sidecar, null, 2)}\n`, { encoding: "utf8" });
}

/** Compile the handbook of the repository at `root` into its cache; returns the files it read, stamped. */
export function compileHandbookCache(root: string): InputStamp[] {
	let files: string[];
	try {
		files = enumerateWorkspaceFiles(root);
	} catch {
		files = [];
	}
	const adoption = scanAgentConfigs({ cwd: root, includeGlobal: false, workspaceFiles: files });
	const enforcement = collectEnforcementInventory(root, files);
	const read = [
		...new Set([
			...adoption.sources.map((source) => source.path),
			...enforcement.checkFiles.map((file) => join(root, file.path)),
			...MANIFESTS.map((name) => join(root, name)),
		]),
	].sort();
	// Stamped before they are read, so an edit made while the compile runs retires its result.
	const inputs = read.map((path) => ({ path, stamp: stampOf(path) }));
	const hash = createHash("sha256").update(`v${COMPILE_VERSION}\0${files.join("\n")}\0${adoption.sourceHash}\0`);
	hash.update(JSON.stringify(enforcement));
	for (const path of read) {
		hash.update(`\0${relative(root, path)}\0`);
		try {
			hash.update(readFileSync(path));
		} catch {
			hash.update("absent");
		}
	}
	const fingerprint = hash.digest("hex");
	const recorded = inputs.map(({ path, stamp }) => ({ path: relative(root, path), stamp }));
	const cache = readCompiledHandbookCache(root);
	if (cache?.sidecar.fingerprint === fingerprint) {
		// Same content under new mtimes (a checkout, a touch): the cache stands, under the new stamps.
		if (JSON.stringify(cache.sidecar.inputs) !== JSON.stringify(recorded))
			writeSidecar(root, { ...cache.sidecar, inputs: recorded });
	} else {
		const compiled = compileHandbookFromTree({ cwd: root, repositoryFiles: files, adoption, enforcement });
		if (compiled) {
			ensureProjectIgnore(root);
			safeResourceWrite(compiledHandbookPath(root), compiled.markdown, { encoding: "utf8" });
			writeSidecar(root, {
				version: COMPILE_VERSION,
				fingerprint,
				contentSha256: createHash("sha256").update(compiled.markdown).digest("hex"),
				sources: compiled.sources,
				rules: compiled.rules,
				inputs: recorded,
			});
		} else if (existsSync(compiledHandbookSidecarPath(root))) {
			for (const path of [compiledHandbookPath(root), compiledHandbookSidecarPath(root)]) rmSync(path, { force: true });
		}
	}
	// Stamped after the cache write lands, which may have created `.clio-coder/` beside it.
	return [...inputs, { path: root, stamp: stampOf(root) }];
}
