#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SHEBANG = "#!/usr/bin/env node";
const entries = ["dist/cli/index.js", "dist/worker/entry.js"];

function fail(reason) {
	process.stderr.write(`check-dist: ${reason}\n`);
	process.exit(1);
}

function firstLine(abs) {
	return readFileSync(abs, "utf8").slice(0, SHEBANG.length);
}

for (const rel of entries) {
	const abs = join(root, rel);
	let stat;
	try {
		stat = statSync(abs);
	} catch {
		fail(`missing ${rel}`);
	}
	if (!stat.isFile()) fail(`not a regular file: ${rel}`);
	if (firstLine(abs) !== SHEBANG) fail(`bad shebang in ${rel}`);
}

// Only the executable entry points may carry a shebang. A shebang on shared
// chunks means a global banner leaked back into the bundler config.
const entrySet = new Set(entries);
const distFiles = readdirSync(join(root, "dist"), { recursive: true, withFileTypes: true });
for (const dirent of distFiles) {
	if (!dirent.isFile() || !dirent.name.endsWith(".js")) continue;
	const abs = join(dirent.parentPath, dirent.name);
	const rel = abs.slice(root.length).replaceAll("\\", "/");
	if (entrySet.has(rel)) continue;
	if (firstLine(abs) === SHEBANG) fail(`unexpected shebang on non-entry chunk: ${rel}`);
}

process.stdout.write("check-dist: ok\n");
process.exit(0);
