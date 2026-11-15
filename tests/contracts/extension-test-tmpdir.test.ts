import { equal, notEqual, ok } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { testExtensionPackage } from "../../src/domains/extensions/authoring/test-runner.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("extensions test gives package tests a temp directory the run owns and removes", async (t) => {
	const env = await isolateClioEnv("clio-coder-extension-test-tmpdir-");
	t.after(() => env.restore());
	const root = path.join(env.dir, "pkg");
	mkdirSync(root);
	const record = path.join(env.dir, "seen-tmpdir.txt");
	writeFileSync(
		path.join(root, "tmp.test.ts"),
		[
			'import { writeFileSync, existsSync } from "node:fs";',
			'import { test } from "node:test";',
			'test("tmpdir", () => {',
			"\tconst dir = process.env.TMPDIR ?? '';",
			"\tif (!existsSync(dir)) throw new Error('no TMPDIR');",
			`\twriteFileSync(${JSON.stringify(record)}, dir);`,
			"});",
			"",
		].join("\n"),
	);
	equal(await testExtensionPackage(root), 0);
	const seen = readFileSync(record, "utf8");
	ok(seen.startsWith(path.join(tmpdir(), "clio-coder-extension-test-")), seen);
	notEqual(seen, tmpdir());
	equal(existsSync(seen), false);
});
