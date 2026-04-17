#!/usr/bin/env node
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SHEBANG = "#!/usr/bin/env node";
const targets = ["dist/cli/index.js", "dist/worker/entry.js"];

function fail(reason) {
	process.stderr.write(`check-dist: ${reason}\n`);
	process.exit(1);
}

for (const rel of targets) {
	const abs = `${root}${rel}`;
	let stat;
	try {
		stat = statSync(abs);
	} catch {
		fail(`missing ${rel}`);
	}
	if (!stat.isFile()) fail(`not a regular file: ${rel}`);
	const buf = Buffer.alloc(SHEBANG.length);
	const fd = openSync(abs, "r");
	try {
		readSync(fd, buf, 0, SHEBANG.length, 0);
	} finally {
		closeSync(fd);
	}
	if (buf.toString("utf8") !== SHEBANG) fail(`bad shebang in ${rel}`);
}

process.stdout.write("check-dist: ok\n");
process.exit(0);
