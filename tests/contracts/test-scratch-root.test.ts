/**
 * The suite leaked its own scratch. 274 call sites do
 * `mkdtemp(join(tmpdir(), "clio-…"))` and most of them clean up; the ones that
 * throw, time out, or hand the directory to a child that outlives the assertion
 * do not, and this machine had 23,397 `clio-*` directories in /tmp from them.
 *
 * `tests/harness/tmp-root.ts` is loaded with `--import` ahead of every suite,
 * so `tmpdir()` resolves inside one per-run root that is removed at exit. These
 * cases pin the two halves of that: the redirect is live in this process, and
 * the delete refuses anything that is not a root this harness made.
 */
import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { after, describe, it } from "node:test";
import { isRemovableRoot, TEST_TMP_ROOT_PREFIX } from "../harness/tmp-root.js";

describe("contracts/test scratch root", () => {
	const strays: string[] = [];
	after(() => {
		for (const stray of strays) rmSync(stray, { recursive: true, force: true });
	});

	it("resolves every mkdtemp in this run inside one removable root", () => {
		// The suite is started with --import tmp-root.ts, so this holds in the
		// runner and in every test child without any test opting in.
		const root = process.env.CLIO_TEST_TMP_ROOT;
		ok(root, "the run has a scratch root");
		strictEqual(tmpdir(), root, "tmpdir() resolves to it, so untouched call sites land inside it");
		ok(basename(root).startsWith(TEST_TMP_ROOT_PREFIX), `root is named for the harness: ${root}`);

		const scratch = mkdtempSync(join(tmpdir(), "clio-leak-check-"));
		ok(scratch.startsWith(`${root}${sep}`), `a plain mkdtemp lands inside the root: ${scratch}`);
		ok(isRemovableRoot(root), "and the root the exit handler will remove is the one being written into");
	});

	it("refuses to recursively delete anything it did not make", () => {
		const outside = mkdtempSync(join(tmpdir(), "clio-outside-"));
		strays.push(outside);
		const wrongPrefix = join(outside, "not-a-run-root");
		mkdirSync(wrongPrefix);
		const link = join(outside, `${TEST_TMP_ROOT_PREFIX}link`);
		symlinkSync(wrongPrefix, link);

		// A nested mkdtemp is not a root, whatever it is named.
		strictEqual(isRemovableRoot(wrongPrefix), false, "the prefix is part of the identity");
		// A symlink wearing the right name would redirect the delete out of /tmp.
		strictEqual(isRemovableRoot(link), false, "a symlink is not a directory to walk");
		strictEqual(isRemovableRoot("/"), false);
		// The run root's parent is the system temp dir, which is never removable
		// however the name is spelled.
		strictEqual(isRemovableRoot(dirname(tmpdir())), false, "the temp dir itself is never the root");
		strictEqual(isRemovableRoot(join(outside, "absent")), false, "a path that is not there is not deleted");
		strictEqual(isRemovableRoot(""), false);
	});
});
