import { notStrictEqual, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	decodeTagSegment,
	encodeTagSegment,
	isRecordsTag,
	recordsTag,
	storeBlobPath,
	storeProjectDir,
	storeProjectKey,
	storeProjectRoot,
	storeReadRoots,
	storeRoot,
	storeTagDir,
	storeWriteTarget,
	validateBlobName,
	validateTagName,
} from "../../src/core/store-paths.js";

test("store names follow the tag and blob rules and every refusal names its rule", () => {
	for (const ok of ["sim/run7", "out/summary.parquet"]) {
		strictEqual(validateTagName(ok), null, ok);
		strictEqual(validateBlobName(ok), null, ok);
	}
	const tagCases: Array<[string, RegExp]> = [
		["/abs", /start with "\/"/u],
		["a//b", /empty segment/u],
		["a/../b", /"\.\." segment/u],
		[".records/x", /must not start with "\."/u],
		["x#1", /may contain only/u],
		["t".repeat(201), /at most 200 bytes/u],
	];
	for (const [tag, rule] of tagCases) strictEqual(rule.test(validateTagName(tag) ?? ""), true, tag);
	const blobCases: Array<[string, RegExp]> = [
		["/abs", /start with "\/"/u],
		["a//b", /empty segment/u],
		["a/../b", /"\.\." segment/u],
		["x#1", /other than '#'/u],
		["b".repeat(481), /at most 480 bytes/u],
	];
	for (const [blob, rule] of blobCases) strictEqual(rule.test(validateBlobName(blob) ?? ""), true, blob);
	strictEqual(isRecordsTag(recordsTag("sim")), true);
	notStrictEqual(validateTagName(recordsTag("sim")), null);
	strictEqual(validateTagName(recordsTag("sim"), { allowRecords: true }), null);
	notStrictEqual(validateTagName(recordsTag("../x"), { allowRecords: true }), null);
	strictEqual(encodeTagSegment("sim/run7").includes("/"), false);
	strictEqual(decodeTagSegment(encodeTagSegment("sim/run7")), "sim/run7");
});

test("a linked worktree and its main checkout share one store project key", () => {
	const scratch = mkdtempSync(join(tmpdir(), "clio-coder-store-paths-"));
	const main = join(scratch, "repo");
	const linkedGitDir = join(main, ".git", "worktrees", "lane");
	mkdirSync(linkedGitDir, { recursive: true });
	writeFileSync(join(linkedGitDir, "commondir"), "../..\n");
	const worktree = join(scratch, "lane");
	mkdirSync(join(worktree, "src"), { recursive: true });
	writeFileSync(join(worktree, ".git"), `gitdir: ${linkedGitDir}\n`);

	strictEqual(storeProjectKey(storeProjectRoot(join(worktree, "src"))), storeProjectKey(storeProjectRoot(main)));
	strictEqual(storeProjectDir(worktree), storeProjectDir(main));
});

test("storeWriteTarget predicts each write op's path and is null for reads and malformed calls", () => {
	const cwd = mkdtempSync(join(tmpdir(), "clio-coder-store-target-"));
	const tag = "sim/run7";
	strictEqual(storeWriteTarget(cwd, { op: "create", tag }), storeTagDir(cwd, tag));
	strictEqual(
		storeWriteTarget(cwd, { op: "put", tag, blob: "out/a.h5", path: "data/x.h5" }),
		storeBlobPath(cwd, tag, "out/a.h5"),
	);
	strictEqual(storeWriteTarget(cwd, { op: "put", tag, path: "data/x.h5" }), storeBlobPath(cwd, tag, "x.h5"));
	strictEqual(storeWriteTarget(cwd, { op: "note", tag }), storeTagDir(cwd, recordsTag(tag)));
	strictEqual(storeWriteTarget(cwd, { op: "remove", tag, blob: "x.h5" }), storeBlobPath(cwd, tag, "x.h5"));
	for (const op of ["tags", "list", "stat", "get", "frobnicate"])
		strictEqual(storeWriteTarget(cwd, { op, tag, blob: "x.h5" }), null, op);
	strictEqual(storeWriteTarget(cwd, { op: "create", tag: "/abs" }), null);
	strictEqual(storeWriteTarget(cwd, { op: "remove", tag }), null);
	const [readRoot] = storeReadRoots(cwd);
	strictEqual(storeTagDir(cwd, tag).startsWith(`${readRoot}/`), true);
	strictEqual(readRoot?.startsWith(`${storeRoot()}/`), true);
});
