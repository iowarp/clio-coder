import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { resolveFdBinary, resolveRgBinary } from "../../src/tools/executables.js";
import { findTool } from "../../src/tools/find.js";
import { grepTool } from "../../src/tools/grep.js";
import { BoundedListingSelection, lsTool } from "../../src/tools/ls.js";
import type { ToolResult } from "../../src/tools/registry.js";
import {
	BoundedDiagnosticDecoder,
	SEARCH_STDERR_CAP_BYTES,
	type SearchCompleteness,
	spawnLineStream,
	withSearchTimeout,
} from "../../src/tools/spawn-hygiene.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const installedFd = resolveFdBinary();
const installedRg = resolveRgBinary();
let env: IsolatedClioEnv;
let root: string;
let bin: string;
beforeEach(async () => {
	env = await isolateClioEnv("search-completeness-");
	root = join(env.dir, "tree");
	bin = join(env.dir, "bin");
	fs.mkdirSync(root);
	fs.mkdirSync(bin);
	process.env.PATH = bin;
});
afterEach(() => {
	mock.restoreAll();
	syncBuiltinESMExports();
	env.restore();
});
function ok(result: ToolResult) {
	assert.equal(result.kind, "ok", JSON.stringify(result));
	if (result.kind !== "ok") throw new Error("Expected successful result");
	return result;
}
function search(result: ToolResult): SearchCompleteness {
	const details = ok(result).details as { search: SearchCompleteness };
	assert.deepEqual(
		Object.keys(details.search).sort(),
		details.search.complete ? ["complete", "skipped"] : ["complete", "reason", "skipped"],
	);
	return details.search;
}
function binary(name: "rg" | "fd", body: string) {
	fs.writeFileSync(join(bin, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
}
function matchLine() {
	return JSON.stringify({
		type: "match",
		data: { path: { text: join(root, "a.txt") }, line_number: 1, lines: { text: "needle\n" } },
	});
}

test("rg keeps partial matches and counts per-file errors beyond the stderr retention cap", async () => {
	binary(
		"rg",
		`console.log(${JSON.stringify(matchLine())}); for(let i=0;i<400;i++) console.error(${JSON.stringify(root)} + '/file' + i + ': Permission denied (os error 13)'); process.exitCode=2;`,
	);
	const result = await grepTool.run({ path: root, pattern: "needle" });
	assert.match(ok(result).output, /a.txt:1: needle/);
	assert.deepEqual(search(result), {
		complete: false,
		reason: "errors",
		skipped: { count: 400, samples: Array.from({ length: 5 }, (_, i) => join(root, `file${i}`)) },
	});
});

test("rg distinguishes complete empty searches, skipped-only searches, and invalid patterns", async () => {
	binary("rg", "process.exitCode=1;");
	let result = await grepTool.run({ path: root, pattern: "needle" });
	assert.equal(search(result).complete, true);
	assert.match(ok(result).output, /No matches found/);
	binary(
		"rg",
		`console.error(${JSON.stringify(`${root}/denied: Permission denied (os error 13)`)}); process.exitCode=2;`,
	);
	result = await grepTool.run({ path: root, pattern: "needle" });
	assert.equal(search(result).reason, "errors");
	assert.doesNotMatch(ok(result).output, /No matches found/);
	binary("rg", "console.error('regex parse error: unclosed group'); process.exitCode=2;");
	assert.equal((await grepTool.run({ path: root, pattern: "(" })).kind, "error");
});

test("native searches retain matches on timeout and name the shown count", { timeout: 5_000 }, async () => {
	fs.writeFileSync(join(root, "a.txt"), "needle");
	binary("rg", `console.log(${JSON.stringify(matchLine())}); setInterval(()=>{},1000);`);
	binary("fd", `console.log(${JSON.stringify(join(root, "a.txt"))}); setInterval(()=>{},1000);`);
	const results = await withSearchTimeout(500, () =>
		Promise.all([grepTool.run({ path: root, pattern: "needle" }), findTool.run({ path: root, pattern: "*.txt" })]),
	);
	for (const result of results) {
		assert.deepEqual(search(result), { complete: false, reason: "timeout", skipped: { count: 0, samples: [] } });
		assert.match(ok(result).output, /timeout; 1 (matches|paths) shown/);
		assert.match(ok(result).output, /a.txt/);
	}
});

test("native searches retain partial matches on cancellation and identify result limits", async () => {
	fs.writeFileSync(join(root, "a.txt"), "needle");
	for (const [name, tool, pattern, line] of [
		["rg", grepTool, "needle", matchLine()],
		["fd", findTool, "*.txt", join(root, "a.txt")],
	] as const) {
		binary(name, `console.log(${JSON.stringify(line)}); setInterval(()=>{},1000);`);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 500);
		try {
			const result = await tool.run({ path: root, pattern }, { signal: controller.signal });
			assert.equal(search(result).reason, "cancelled");
			assert.match(ok(result).output, /a.txt/);
		} finally {
			clearTimeout(timer);
		}
		binary(name, `console.log(${JSON.stringify(line)}); console.log(${JSON.stringify(line)});`);
		assert.equal(search(await tool.run({ path: root, pattern, limit: 1 })).reason, "limit");
	}
});

test("fallback grep reports binary, oversized and unreadable files and its ignore semantics", async () => {
	fs.writeFileSync(join(root, "a.txt"), "needle");
	fs.writeFileSync(join(root, "binary"), Buffer.from([0, 1, 2]));
	fs.writeFileSync(join(root, "large"), "");
	fs.truncateSync(join(root, "large"), 20_000_001);
	fs.writeFileSync(join(root, "unreadable"), "needle");
	fs.writeFileSync(join(root, ".gitignore"), "a.txt\n");
	const original = fsPromises.readFile;
	mock.method(fsPromises, "readFile", (...args: Parameters<typeof original>) => {
		if (String(args[0]).endsWith("unreadable")) throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
		return original(...args);
	});
	syncBuiltinESMExports();
	const result = await grepTool.run({ path: root, pattern: "needle" });
	assert.match(ok(result).output, /a.txt:1: needle/);
	assert.match(ok(result).output, /GENERATED_DIRS only; .gitignore is not applied/);
	assert.match(grepTool.description, /GENERATED_DIRS only.*\.gitignore/);
	assert.equal(search(result).reason, "errors");
	assert.equal(search(result).skipped.count, 3);
	assert.deepEqual(
		search(result).skipped.samples.map((p) => p.slice(root.length + 1)),
		["binary", "large", "unreadable"],
	);
});

test("fallback searches count unreadable directories and honour cancellation and limits", async () => {
	fs.mkdirSync(join(root, "denied"));
	fs.writeFileSync(join(root, "a.txt"), "needle\nneedle");
	const original = fsPromises.readdir;
	mock.method(fsPromises, "readdir", (...args: Parameters<typeof original>) => {
		if (String(args[0]).endsWith("denied")) throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
		return original(...args);
	});
	syncBuiltinESMExports();
	for (const [tool, pattern] of [
		[grepTool, "needle"],
		[findTool, "*.txt"],
	] as const) {
		const result = await tool.run({ path: root, pattern });
		assert.equal(search(result).skipped.count, 1);
		assert.deepEqual(search(result).skipped.samples, [join(root, "denied")]);
		const controller = new AbortController();
		controller.abort();
		const cancelled = await tool.run({ path: root, pattern }, { signal: controller.signal });
		assert.equal(search(cancelled).reason, "cancelled");
		assert.doesNotMatch(ok(cancelled).output, /No matches found|No visible files/);
	}
	fs.writeFileSync(join(root, "b.txt"), "needle");
	for (const [tool, pattern] of [
		[grepTool, "needle"],
		[findTool, "*.txt"],
	] as const) {
		assert.equal(search(await tool.run({ path: root, pattern, limit: 1 })).reason, "limit");
	}
});

test("find counts symlinked directories in fallback and discloses unmeasured native counts", async () => {
	const outside = join(env.dir, "outside");
	fs.mkdirSync(outside);
	fs.writeFileSync(join(outside, "link-only.txt"), "needle");
	fs.symlinkSync(outside, join(root, "link"));
	const fallback = await findTool.run({ path: root, pattern: "*.txt" });
	assert.equal(search(fallback).skipped.count, 1);
	assert.equal(search(fallback).reason, "errors");
	assert.deepEqual(search(fallback).skipped.samples, [join(root, "link")]);
	assert.doesNotMatch(ok(fallback).output, /link-only/);
	binary("fd", "process.exitCode = 0;");
	const native = await findTool.run({ path: root, pattern: "*.txt" });
	assert.equal(search(native).skipped.count, 0);
	assert.deepEqual(ok(native).details?.symlinkDirectories, { counted: false });
	assert.deepEqual(ok(fallback).details?.symlinkDirectories, { counted: true });
	assert.match(findTool.description, /Symlinked directories are never followed/);
});

test("fd reports unreadable directories and retains partial paths", async () => {
	fs.writeFileSync(join(root, "a.txt"), "needle");
	binary(
		"fd",
		`console.log(${JSON.stringify(join(root, "a.txt"))}); console.error(${JSON.stringify(`[fd error]: ${root}/denied: Permission denied (os error 13)`)}); process.exitCode=1;`,
	);
	const result = await findTool.run({ path: root, pattern: "*.txt" });
	assert.equal(search(result).reason, "errors");
	assert.equal(search(result).skipped.count, 1);
	assert.match(ok(result).output, /a.txt/);
});

test("ls renders broken, directory and file symlinks and marks unreadable entries", async () => {
	fs.mkdirSync(join(root, "dir"));
	fs.writeFileSync(join(root, "file"), "content");
	fs.writeFileSync(join(root, "unreadable"), "content");
	fs.symlinkSync("missing", join(root, "broken"));
	fs.symlinkSync("dir", join(root, "dir-link"));
	fs.symlinkSync("file", join(root, "file-link"));
	const original = fsPromises.lstat;
	mock.method(fsPromises, "lstat", (...args: Parameters<typeof original>) => {
		if (String(args[0]).endsWith("unreadable")) throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
		return original(...args);
	});
	syncBuiltinESMExports();
	const result = ok(await lsTool.run({ path: root }));
	for (const text of ["broken@ (broken)", "dir/", "dir-link@ -> dir", "file-link@ -> file", "unreadable (unreadable)"])
		assert.ok(result.output.includes(text), result.output);
	assert.equal((result.details as { skipped: { count: number } }).skipped.count, 2);
});

test("fallback grep yields while searching a generated tree of 5000 files", async () => {
	for (let dir = 0; dir < 50; dir++) {
		const directory = join(root, `d${dir}`);
		fs.mkdirSync(directory);
		for (let file = 0; file < 100; file++) fs.writeFileSync(join(directory, `f${file}.txt`), "haystack\n");
	}
	let ticks = 0;
	const started = performance.now();
	const timer = setInterval(() => ticks++, 5);
	try {
		const result = await grepTool.run({ path: root, pattern: "needle" });
		const elapsed = performance.now() - started;
		assert.equal(search(result).complete, true);
		assert.match(ok(result).output, /No matches found/);
		assert.ok(ticks >= Math.max(2, Math.floor(elapsed / 50)), `${ticks} ticks during ${elapsed}ms`);
	} finally {
		clearInterval(timer);
	}
});

test("installed native binaries preserve glob filtering, match formatting and symlink accounting", {
	skip: !installedFd || !installedRg,
}, async () => {
	assert.ok(installedFd && installedRg);
	fs.symlinkSync(installedFd, join(bin, "fd"));
	fs.symlinkSync(installedRg, join(bin, "rg"));
	fs.mkdirSync(join(root, "nested"));
	fs.writeFileSync(join(root, "nested", "a.txt"), "needle\n");
	fs.writeFileSync(join(root, "other.md"), "haystack\n");
	fs.symlinkSync("nested", join(root, "dir-link"));
	fs.mkdirSync(join(env.dir, "outside"));
	fs.writeFileSync(join(env.dir, "outside", "only-via-link.txt"), "needle");
	fs.symlinkSync(join(env.dir, "outside"), join(root, "outside-link"));
	const linked = await findTool.run({ path: root, pattern: "only-via-link.txt" });
	assert.doesNotMatch(ok(linked).output, /only-via-link.txt/);
	const found = await findTool.run({ path: root, pattern: "nested/*.txt" });
	assert.equal(search(found).skipped.count, 0);
	assert.deepEqual(ok(found).details?.symlinkDirectories, { counted: false });
	assert.match(ok(found).output, /nested\/a.txt/);
	assert.doesNotMatch(ok(found).output, /other.md/);
	const matched = await grepTool.run({ path: root, pattern: "needle" });
	assert.equal(search(matched).complete, true);
	assert.match(ok(matched).output, /nested\/a.txt:1: needle/);
});

test("fallback grep preserves matches already collected when cancellation interrupts reading", async () => {
	for (let i = 0; i < 20; i++) fs.writeFileSync(join(root, `file${i}.txt`), "needle\n");
	const controller = new AbortController();
	const original = fsPromises.readFile;
	let reads = 0;
	mock.method(fsPromises, "readFile", async (...args: Parameters<typeof original>) => {
		const data = await original(...args);
		if (++reads === 10) controller.abort();
		return data;
	});
	syncBuiltinESMExports();
	const result = await grepTool.run({ path: root, pattern: "needle" }, { signal: controller.signal });
	assert.equal(search(result).reason, "cancelled");
	assert.match(ok(result).output, /file0.txt:1: needle/);
	assert.match(ok(result).output, /9 matches shown/);
	assert.equal(reads, 10);
});

test("fd receives native glob semantics and bounds without statting unrelated entries", {
	skip: !installedFd,
}, async () => {
	assert.ok(installedFd);
	fs.symlinkSync(installedFd, join(bin, "fd"));
	fs.mkdirSync(join(root, "other", "nested"), { recursive: true });
	for (const name of ["a.txt", "m.txt", "Z.txt", "Alpha.TXT"])
		fs.writeFileSync(join(root, "other", "nested", name), "content");
	const stats: string[] = [];
	const original = fs.statSync;
	mock.method(fs, "statSync", (...args: Parameters<typeof original>) => {
		stats.push(String(args[0]));
		return original(...args);
	});
	syncBuiltinESMExports();
	const originalLstat = fs.lstatSync;
	mock.method(fs, "lstatSync", (...args: Parameters<typeof originalLstat>) => {
		stats.push(String(args[0]));
		return originalLstat(...args);
	});
	syncBuiltinESMExports();
	const nested = ok(await findTool.run({ path: root, pattern: "nested/*.txt" }));
	assert.match(nested.output, /other\/nested\/a.txt/);
	const ranges = ok(await findTool.run({ path: root, pattern: "[a-z].txt" }));
	assert.match(ranges.output, /m.txt/);
	assert.match(ranges.output, /Z.txt/);
	const lower = ok(await findTool.run({ path: root, pattern: "alpha.txt" }));
	assert.match(lower.output, /Alpha.TXT/);
	const upper = ok(await findTool.run({ path: root, pattern: "ALPHA.txt" }));
	assert.doesNotMatch(upper.output, /Alpha.TXT/);
	assert.equal((await findTool.run({ path: root, pattern: "[" })).kind, "error");
	assert.ok(
		stats.every((path) => !path.startsWith(`${root}/`)),
		JSON.stringify(stats),
	);
	fs.unlinkSync(join(bin, "fd"));
	const argvFile = join(env.dir, "argv.json");
	binary("fd", `require('node:fs').writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));`);
	await findTool.run({ path: root, pattern: "nested/[a-z].txt", limit: 3 });
	const argv = JSON.parse(fs.readFileSync(argvFile, "utf8")) as string[];
	assert.ok(argv.includes("**/nested/[a-z].txt"));
	assert.equal(argv[argv.indexOf("--max-results") + 1], "4");
	assert.ok(argv.includes("--full-path"));
	fs.unlinkSync(join(bin, "fd"));
	assert.equal((await findTool.run({ path: root, pattern: "[" })).kind, "error");
});

test("ls selects a bounded alphabetic prefix in a wide directory without blocking enumeration", async () => {
	const expected = ["Aardvark", "alpha", "Beta"];
	for (let i = 0; i < 5000; i++) fs.writeFileSync(join(root, `z${String(i).padStart(5, "0")}`), "");
	for (const name of expected) fs.writeFileSync(join(root, name), "");
	const selection = new BoundedListingSelection(3);
	for (let i = 10000; i >= 0; i--) {
		selection.add(`z${String(i).padStart(5, "0")}`);
		assert.ok(selection.retained <= 3);
	}
	for (const name of expected) selection.add(name);
	assert.deepEqual(selection.sorted(), expected);
	let statCount = 0;
	const original = fsPromises.lstat;
	mock.method(fsPromises, "lstat", (...args: Parameters<typeof original>) => {
		statCount++;
		return original(...args);
	});
	mock.method(fs, "readdirSync", () => {
		throw new Error("Synchronous enumeration forbidden");
	});
	syncBuiltinESMExports();
	let ticks = 0;
	const timer = setInterval(() => ticks++, 1);
	const start = performance.now();
	try {
		const result = ok(await lsTool.run({ path: root, limit: 3 }, { allowsObservationPath: () => true }));
		assert.deepEqual(result.output.split("\n").slice(0, 3), expected);
		assert.deepEqual(result.details?.selection, { scanned: 5003, retained: 3 });
		assert.equal(statCount, 3);
		assert.ok(ticks >= Math.max(1, Math.floor((performance.now() - start) / 100)));
	} finally {
		clearInterval(timer);
	}
});

test("empty ls listings report zero skipped entries", async () => {
	assert.deepEqual(ok(await lsTool.run({ path: root })).details?.skipped, { count: 0, samples: [] });
});

test("stderr without newlines has bounded retained bytes and reports oversized diagnostics", async () => {
	const emitted: Array<{ line: string; truncated: boolean }> = [];
	const decoder = new BoundedDiagnosticDecoder((line, truncated) => emitted.push({ line, truncated }));
	for (let i = 0; i < 512; i++) {
		decoder.write(Buffer.alloc(8192, 120));
		assert.ok(decoder.bufferedBytes <= SEARCH_STDERR_CAP_BYTES);
	}
	decoder.end();
	assert.equal(decoder.oversizedLines, 1);
	assert.equal(emitted.length, 1);
	assert.equal(Buffer.byteLength(emitted[0]?.line ?? ""), SEARCH_STDERR_CAP_BYTES);
	assert.equal(emitted[0]?.truncated, true);
	const utf8: string[] = [];
	const unicode = new BoundedDiagnosticDecoder((line) => utf8.push(line));
	for (const byte of Buffer.from("é世\n")) unicode.write(Buffer.from([byte]));
	unicode.end();
	assert.deepEqual(utf8, ["é世"]);
	const streamed = await spawnLineStream(process.execPath, ["-e", "process.stderr.write('x'.repeat(4*1024*1024))"], {
		onLine() {},
	});
	assert.equal(streamed.oversizedDiagnostics, 1);
	assert.equal(Buffer.byteLength(streamed.stderr), SEARCH_STDERR_CAP_BYTES);
	binary("rg", "process.stderr.write('x'.repeat(100000)); process.exitCode=2;");
	const result = await grepTool.run({ path: root, pattern: "needle" });
	assert.equal(search(result).skipped.unknown, true);
	assert.equal(search(result).reason, "errors");
	assert.match(ok(result).output, /diagnostic coverage unknown/);
});

test("diagnostics count localized and multiline file errors while disclosing uncertain coverage", async () => {
	const diagnostics = `${root}/fr: Accès refusé (os error 13)\n${root}/device: No space left on device (os error 28)\n${root}/multi:\n  operación fallida\n  (os error 5)\n${root}/other: application-specific read failure\n`;
	binary("rg", `process.stderr.write(${JSON.stringify(diagnostics)}); process.exitCode=2;`);
	const result = await grepTool.run({ path: root, pattern: "needle" });
	assert.equal(search(result).skipped.count, 4);
	assert.deepEqual(
		search(result).skipped.samples,
		["fr", "device", "multi", "other"].map((name) => join(root, name)),
	);
	assert.equal(search(result).skipped.unknown, undefined);
	binary(
		"rg",
		`console.log(${JSON.stringify(matchLine())}); console.error('unstructured diagnostic'); process.exitCode=2;`,
	);
	const unknown = await grepTool.run({ path: root, pattern: "needle" });
	assert.equal(search(unknown).skipped.unknown, true);
	assert.match(ok(unknown).output, /a.txt:1: needle/);
});

test("protected diagnostic paths and symlinks never appear in output or serialized details", async () => {
	const protectedName = "private-unreadable";
	const protectedPath = join(root, protectedName);
	const allowsObservationPath = (path: string) => !path.includes(protectedName);
	for (const [name, tool, pattern] of [
		["rg", grepTool, "needle"],
		["fd", findTool, "*.txt"],
	] as const) {
		binary(
			name,
			`console.error(${JSON.stringify(`${protectedPath}: localized error (os error 13)`)}); process.exitCode=2;`,
		);
		const result = await tool.run({ path: root, pattern }, { allowsObservationPath });
		assert.equal(search(result).skipped.count, 1);
		assert.deepEqual(search(result).skipped.samples, []);
		assert.doesNotMatch(JSON.stringify(result), /private-unreadable/);
		fs.unlinkSync(join(bin, name));
	}
	binary("fd", `console.log(${JSON.stringify(protectedPath)});`);
	assert.doesNotMatch(
		JSON.stringify(await findTool.run({ path: root, pattern: "*" }, { allowsObservationPath })),
		/private-unreadable/,
	);
	fs.unlinkSync(join(bin, "fd"));
	fs.mkdirSync(join(env.dir, "target"));
	fs.symlinkSync(join(env.dir, "target"), protectedPath);
	for (const [tool, pattern] of [
		[grepTool, "needle"],
		[findTool, "*.txt"],
	] as const) {
		const result = await tool.run({ path: root, pattern }, { allowsObservationPath });
		assert.doesNotMatch(JSON.stringify(result), /private-unreadable/);
	}
	assert.doesNotMatch(JSON.stringify(await lsTool.run({ path: root }, { allowsObservationPath })), /private-unreadable/);
});

test("fallback find retains earlier paths when traversal is cancelled", async () => {
	fs.writeFileSync(join(root, "a.txt"), "needle");
	fs.mkdirSync(join(root, "zdir"));
	const controller = new AbortController();
	const original = fsPromises.readdir;
	mock.method(fsPromises, "readdir", async (...args: Parameters<typeof original>) => {
		if (String(args[0]).endsWith("zdir")) controller.abort();
		return original(...args);
	});
	syncBuiltinESMExports();
	const result = await findTool.run({ path: root, pattern: "*.txt" }, { signal: controller.signal });
	assert.equal(search(result).reason, "cancelled");
	assert.match(ok(result).output, /a.txt/);
});

test("native find renders uncounted symlink-directory coverage for empty and nonempty results", async () => {
	for (const hasResult of [false, true]) {
		binary("fd", hasResult ? `console.log(${JSON.stringify(join(root, "a.txt"))});` : "process.exitCode = 0;");
		const result = ok(await findTool.run({ path: root, pattern: "*.txt" }));
		assert.match(result.output, /skipped symlinked directories are not counted/);
		assert.deepEqual(result.details?.symlinkDirectories, { counted: false });
		if (hasResult) assert.match(result.output, /a.txt/);
		else assert.match(result.output, /No visible files found matching pattern/);
	}
});

test("ls preserves stable case-insensitive collation ties in selection and final output", async () => {
	const names = ["A", "B", "a", "b", "z", "ä", "_", "é"];
	for (const name of names) fs.writeFileSync(join(root, name), "");
	for (const readOrder of [names, [...names].reverse()]) {
		const expected = [...readOrder].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
		const directory = mock.method(fsPromises, "opendir", async () => ({
			async *[Symbol.asyncIterator]() {
				for (const name of readOrder) yield { name };
			},
		}));
		syncBuiltinESMExports();
		try {
			for (let limit = 1; limit <= names.length; limit++) {
				const selection = new BoundedListingSelection(limit);
				for (const name of readOrder) selection.add(name);
				assert.deepEqual(selection.sorted(), expected.slice(0, limit));
				const result = ok(await lsTool.run({ path: root, limit }, { allowsObservationPath: () => true }));
				assert.deepEqual(result.output.split("\n").slice(0, limit), expected.slice(0, limit));
			}
		} finally {
			directory.mock.restore();
			syncBuiltinESMExports();
		}
	}
	const selection = new BoundedListingSelection(2);
	for (const name of names) selection.add(name);
	assert.deepEqual(selection.sorted(), ["_", "A"]);
});

test("diagnostic and retained stderr caps preserve UTF-8 code-point boundaries", async () => {
	for (const character of ["é", "世", "😀"]) {
		for (let included = 1; included < Buffer.byteLength(character); included++) {
			const prefix = "x".repeat(SEARCH_STDERR_CAP_BYTES - included);
			const payload = Buffer.from(`${prefix}${character}\n`);
			const lines: Array<{ line: string; truncated: boolean }> = [];
			const decoder = new BoundedDiagnosticDecoder((line, truncated) => lines.push({ line, truncated }));
			decoder.write(payload.subarray(0, SEARCH_STDERR_CAP_BYTES));
			decoder.write(payload.subarray(SEARCH_STDERR_CAP_BYTES));
			decoder.end();
			assert.deepEqual(lines, [{ line: prefix, truncated: true }]);
			assert.equal(decoder.oversizedLines, 1);
			const result = await spawnLineStream(
				process.execPath,
				["-e", `process.stderr.write('x'.repeat(${prefix.length}) + ${JSON.stringify(character)} + '\\n')`],
				{ onLine() {} },
			);
			assert.equal(result.stderr, prefix);
			assert.ok(Buffer.byteLength(result.stderr) <= SEARCH_STDERR_CAP_BYTES);
			assert.doesNotMatch(result.stderr, /\uFFFD/);
			assert.equal(result.oversizedDiagnostics, 1);
		}
		const prefix = "x".repeat(SEARCH_STDERR_CAP_BYTES - Buffer.byteLength(character));
		const lines: string[] = [];
		const decoder = new BoundedDiagnosticDecoder((line) => lines.push(line));
		decoder.write(Buffer.from(`${prefix}${character}\n`));
		decoder.end();
		assert.deepEqual(lines, [`${prefix}${character}`]);
		assert.equal(Buffer.byteLength(lines[0] ?? ""), SEARCH_STDERR_CAP_BYTES);
		assert.equal(decoder.oversizedLines, 0);
	}
});
