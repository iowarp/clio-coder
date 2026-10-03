#!/usr/bin/env node
// pretest gate: tests that drive the compiled binary must drive the commit
// under test. A missing dist/ is built; a dist/ built from another commit is
// refused, because a silent rebuild here would hide which bytes a run tested.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");

if (!existsSync(join(dist, "cli", "index.js")) || !existsSync(join(dist, "metafile-esm.json"))) {
	execFileSync("pnpm", ["run", "build"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
	process.exit(0);
}

let head;
try {
	head = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	}).trim();
} catch {
	// No git binary or no repository: the build recorded no commit either.
	process.exit(0);
}

// tsup inlines __CLIO_BUILD_COMMIT__ into readBuildProvenance (src/core/build-info.ts);
// dist/ is unminified by decision, so the function keeps its name.
const RECORDED = /function readBuildProvenance\(\) \{[^}]*?commit: "([0-9a-f]+)"/;
let built;
for (const name of readdirSync(dist)) {
	if (!name.endsWith(".js")) continue;
	built = RECORDED.exec(readFileSync(join(dist, name), "utf8"))?.[1];
	if (built !== undefined) break;
}
if (built !== head) {
	process.stderr.write(
		`check-dist: dist/ was built from ${built ?? "a tree with no recorded commit"}, HEAD is ${head}. Run pnpm run build.\n`,
	);
	process.exit(1);
}
