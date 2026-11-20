import { existsSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * Builds the client beside the directory a running GUI serves and renames it into place once the build succeeds, so
 * a request during a rebuild reads the previous client whole instead of an emptied or half-written directory. Only a
 * build into `live` is staged; a caller that names another output directory owns it (the root build stages its own
 * copy under dist/gui, and the visual review builds into scratch).
 */
export function stagedClient(live: string): Plugin {
	const next = `${live}.next`;
	const old = `${live}.old`;
	let staged = false;
	let failed = false;
	return {
		name: "clio-coder-staged-client",
		apply: "build",
		config(config) {
			const outDir = config.build?.outDir;
			if (outDir === undefined || resolve(config.root ?? process.cwd(), outDir) !== live) return;
			staged = true;
			return { build: { outDir: next } };
		},
		buildStart() {
			failed = false;
		},
		buildEnd(error) {
			if (error) failed = true;
		},
		renderError() {
			failed = true;
		},
		closeBundle() {
			// A failed build leaves the served client untouched; the next build empties the staging directory.
			if (!staged || failed || !existsSync(join(next, "index.html"))) return;
			rmSync(old, { recursive: true, force: true });
			if (existsSync(live)) renameSync(live, old);
			renameSync(next, live);
			rmSync(old, { recursive: true, force: true });
		},
	};
}
