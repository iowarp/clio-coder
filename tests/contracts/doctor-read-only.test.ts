/** Plain doctor is diagnostic: even a partially initialized home stays byte-for-byte untouched. */

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

interface TreeEntry {
	path: string;
	type: "directory" | "file";
	content?: string;
}

function snapshot(root: string, current = root): TreeEntry[] {
	const entries: TreeEntry[] = [];
	for (const name of readdirSync(current).sort()) {
		const path = join(current, name);
		const item = statSync(path);
		const relativePath = relative(root, path);
		if (item.isDirectory()) {
			entries.push({ path: relativePath, type: "directory" });
			entries.push(...snapshot(root, path));
		} else if (item.isFile()) {
			entries.push({ path: relativePath, type: "file", content: readFileSync(path, "base64") });
		}
	}
	return entries;
}

describe("doctor read-only contract", { concurrency: false }, () => {
	it("does not complete or otherwise mutate a partially initialized home", async () => {
		const scratch = makeScratchHome("clio-doctor-read-only-");
		try {
			const partial = join(scratch.dir, "data", "tools", "yazi", "sentinel");
			mkdirSync(partial, { recursive: true });
			writeFileSync(join(partial, "installed.txt"), "partial home\n", "utf8");
			const before = snapshot(scratch.dir);

			const result = await runCli(["doctor"], { env: scratch.env });

			strictEqual(result.code, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
			deepStrictEqual(snapshot(scratch.dir), before);
		} finally {
			scratch.cleanup();
		}
	});
});
