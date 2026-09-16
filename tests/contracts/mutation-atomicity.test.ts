import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { editTool } from "../../src/tools/edit.js";
import { publishFileAtomically, withFileMutationQueue } from "../../src/tools/file-mutation-queue.js";
import { writeTool } from "../../src/tools/write.js";
import { makeScratchHome, type ScratchHome } from "../harness/scratch-env.js";

describe("atomic file mutations", () => {
	let scratch: ScratchHome;
	let target: string;
	beforeEach(() => {
		scratch = makeScratchHome("mutation-atomicity-");
		target = join(scratch.dir, "file.txt");
	});
	afterEach(() => scratch.cleanup());

	it("publishes only at rename with mode and before/after identity preserved", async () => {
		writeFileSync(target, "original\n");
		chmodSync(target, 0o751);
		const before = statSync(target);
		let observed = false;
		const result = await publishFileAtomically(target, "replacement\n", {
			rename: async (temp, destination) => {
				observed = true;
				strictEqual(dirname(temp), scratch.dir);
				strictEqual(destination, target);
				strictEqual(readFileSync(target, "utf8"), "original\n");
				strictEqual(readFileSync(temp, "utf8"), "replacement\n");
				strictEqual(statSync(temp).mode & 0o777, 0o751);
				renameSync(temp, destination);
			},
		});
		ok(observed);
		deepStrictEqual(result.before, { bytes: before.size, mtimeMs: before.mtimeMs });
		const after = statSync(target);
		deepStrictEqual(result.after, { bytes: after.size, mtimeMs: after.mtimeMs });
		strictEqual(after.mode & 0o777, 0o751);
		deepStrictEqual(readdirSync(scratch.dir), ["file.txt"]);
	});

	it("a failing rename preserves original bytes and mode and removes the temporary file", async () => {
		const original = Buffer.from([0, 255, 13, 10, 65]);
		writeFileSync(target, original);
		chmodSync(target, 0o640);
		await rejects(
			publishFileAtomically(target, "replacement", {
				rename: async () => {
					throw new Error("injected rename failure");
				},
			}),
			/Nothing was published:.*injected rename failure/,
		);
		deepStrictEqual(readFileSync(target), original);
		strictEqual(statSync(target).mode & 0o777, 0o640);
		deepStrictEqual(readdirSync(scratch.dir), ["file.txt"]);
	});

	it("a failed creation leaves no target or temporary file", async () => {
		await rejects(
			publishFileAtomically(target, "replacement", {
				rename: async () => {
					throw new Error("injected rename failure");
				},
			}),
			/Nothing was published/,
		);
		deepStrictEqual(readdirSync(scratch.dir), []);
	});

	it("creates parents and uses the default mode under the current umask", async () => {
		const path = join(scratch.dir, "nested", "file.txt");
		const result = await writeTool.run({ path, content: "π\n" });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		strictEqual(statSync(path).mode & 0o777, 0o666 & ~process.umask());
		deepStrictEqual(result.details?.file, { before: null, after: { bytes: 3, mtimeMs: statSync(path).mtimeMs } });
	});

	it("refuses directory targets and parents that are files with honest tool errors", async () => {
		writeFileSync(target, "parent remains intact");
		for (const path of [scratch.dir, join(target, "child")]) {
			const result = await writeTool.run({ path, content: "new" });
			strictEqual(result.kind, "error");
			if (result.kind === "error") match(result.message, /Nothing was published/);
		}
		strictEqual(readFileSync(target, "utf8"), "parent remains intact");
		const result = await editTool.run({ path: scratch.dir, edits: [{ oldText: "a", newText: "b" }] });
		strictEqual(result.kind, "error");
		if (result.kind === "error") match(result.message, /directory/);
		deepStrictEqual(readdirSync(scratch.dir), ["file.txt"]);
	});

	it("write and edit preserve a symlink and mutate its target in the real directory", async () => {
		const realDir = join(scratch.dir, "real");
		mkdirSync(realDir);
		const realTarget = join(realDir, "actual.txt");
		writeFileSync(realTarget, "old\n");
		chmodSync(realTarget, 0o640);
		symlinkSync(realTarget, target);
		strictEqual((await writeTool.run({ path: target, content: "new\n" })).kind, "ok");
		strictEqual((await editTool.run({ path: target, edits: [{ oldText: "new", newText: "edited" }] })).kind, "ok");
		ok(lstatSync(target).isSymbolicLink());
		strictEqual(readFileSync(realTarget, "utf8"), "edited\n");
		strictEqual(statSync(realTarget).mode & 0o777, 0o640);
		deepStrictEqual(readdirSync(realDir), ["actual.txt"]);
	});

	it("publishes through symlinked parents and dangling target links", async () => {
		const realDir = join(scratch.dir, "real");
		mkdirSync(realDir);
		const alias = join(scratch.dir, "alias");
		symlinkSync(realDir, alias, "dir");
		symlinkSync(join(alias, "missing.txt"), target);
		await publishFileAtomically(target, "created", {
			rename: async (temp, destination) => {
				strictEqual(dirname(temp), realDir);
				strictEqual(destination, join(realDir, "missing.txt"));
				renameSync(temp, destination);
			},
		});
		ok(lstatSync(target).isSymbolicLink());
		strictEqual(readFileSync(join(realDir, "missing.txt"), "utf8"), "created");
	});

	it("skips diffs if either the previous or new file exceeds 1 MiB", async () => {
		for (const [previous, content] of [
			["a".repeat(1024 * 1024 + 1), "short"],
			["short", "b".repeat(1024 * 1024 + 1)],
		]) {
			writeFileSync(target, previous ?? "");
			const before = statSync(target);
			const result = await writeTool.run({ path: target, content });
			strictEqual(result.kind, "ok");
			if (result.kind !== "ok") continue;
			match(result.output, /diff skipped.*1 MiB/);
			strictEqual(result.details?.diff, undefined);
			deepStrictEqual(result.details?.file, {
				before: { bytes: before.size, mtimeMs: before.mtimeMs },
				after: { bytes: statSync(target).size, mtimeMs: statSync(target).mtimeMs },
			});
		}
	});

	it("small writes still return a diff and the trailing newline notice", async () => {
		writeFileSync(target, "old\n");
		const result = await writeTool.run({ path: target, content: "new" });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		match(result.output, /no longer ends with a newline/);
		match(String(result.details?.diff), /new/);
	});

	it("refuses NUL and invalid UTF-8 at a zero-based byte offset without changing bytes", async () => {
		for (const [bytes, offset] of [
			[Buffer.from([65, 0, 66]), 1],
			[Buffer.from([65, 0xff, 66]), 1],
			[Buffer.from([65, 0x80]), 1],
			[Buffer.from([0xc2, 65]), 0],
			[Buffer.from([65, 0xe2, 0x82]), 1],
			[Buffer.from([65, 0xc0, 0xaf]), 1],
			[Buffer.from([65, 0xe2, 66]), 1],
		] as const) {
			writeFileSync(target, bytes);
			const result = await editTool.run({ path: target, edits: [{ oldText: "A", newText: "Z" }] });
			strictEqual(result.kind, "error");
			if (result.kind === "error") match(result.message, new RegExp(`byte offset ${offset}`));
			deepStrictEqual(readFileSync(target), bytes);
		}
		deepStrictEqual(readdirSync(scratch.dir), ["file.txt"]);
	});

	it("preserves CRLF, LF, and BOM while LF replacements adopt the existing endings", async () => {
		for (const ending of ["\n", "\r\n"]) {
			writeFileSync(target, `\uFEFFone${ending}two${ending}three${ending}`);
			const before = statSync(target);
			const result = await editTool.run({ path: target, edits: [{ oldText: "two\n", newText: "second\nextra\n" }] });
			strictEqual(result.kind, "ok");
			if (result.kind !== "ok") continue;
			strictEqual(readFileSync(target, "utf8"), `\uFEFFone${ending}second${ending}extra${ending}three${ending}`);
			deepStrictEqual(result.details?.file, {
				before: { bytes: before.size, mtimeMs: before.mtimeMs },
				after: { bytes: statSync(target).size, mtimeMs: statSync(target).mtimeMs },
			});
		}
	});

	it("refuses mixed and bare-CR endings without normalizing untouched content", async () => {
		for (const original of ["one\r\ntwo\nthree\r\n", "one\rtwo\r"]) {
			writeFileSync(target, original);
			const result = await editTool.run({ path: target, edits: [{ oldText: "one", newText: "1" }] });
			strictEqual(result.kind, "error");
			if (result.kind === "error") match(result.message, /Mixed or bare-CR/);
			strictEqual(readFileSync(target, "utf8"), original);
		}
	});

	it("documents and applies exact matching before fuzzy quote/dash/NFKC matching", async () => {
		match(editTool.description, /exact text first, then quote\/dash\/NFKC/);
		writeFileSync(target, '"value"\n“value”\n');
		strictEqual((await editTool.run({ path: target, edits: [{ oldText: '"value"', newText: "exact" }] })).kind, "ok");
		strictEqual(readFileSync(target, "utf8"), "exact\n“value”\n");
		writeFileSync(target, "“Ａ”—value\n");
		strictEqual((await editTool.run({ path: target, edits: [{ oldText: '"A"-value', newText: "fuzzy" }] })).kind, "ok");
		strictEqual(readFileSync(target, "utf8"), "fuzzy\n");
	});

	it("serializes read/modify/write transactions through real paths and symlinks", async () => {
		writeFileSync(target, "0");
		const alias = join(scratch.dir, "alias.txt");
		symlinkSync(target, alias);
		await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				withFileMutationQueue(i % 2 ? target : alias, async () => {
					const value = Number(readFileSync(target, "utf8"));
					await publishFileAtomically(target, String(value + 1));
				}),
			),
		);
		strictEqual(readFileSync(target, "utf8"), "8");
	});
	it("serializes missing targets through dangling links and parent aliases", async () => {
		const realDir = join(scratch.dir, "real");
		mkdirSync(realDir);
		const aliasDir = join(scratch.dir, "alias");
		symlinkSync(realDir, aliasDir, "dir");
		const realTarget = join(realDir, "missing.txt");
		symlinkSync(realTarget, target);
		let running = 0;
		let completed = 0;
		await Promise.all(
			[target, realTarget, join(aliasDir, "missing.txt")].map((path) =>
				withFileMutationQueue(path, async () => {
					running += 1;
					strictEqual(running, 1);
					await new Promise((resolve) => setImmediate(resolve));
					await publishFileAtomically(path, String(++completed));
					running -= 1;
				}),
			),
		);
		strictEqual(readFileSync(realTarget, "utf8"), "3");
	});
	it("does not count missing parent directories as symbolic links", async () => {
		const path = join(scratch.dir, ...Array.from({ length: 45 }, () => "nested"), "file.txt");
		const result = await writeTool.run({ path, content: "deep" });
		strictEqual(result.kind, "ok");
		strictEqual(readFileSync(path, "utf8"), "deep");
	});
	it("large CRLF edits avoid whole-file line arrays and keep peak allocation bounded", () => {
		const fixture = Buffer.alloc(6 * 1024 * 1024 + 8);
		fixture.fill("a\r\n", 8);
		fixture.write("target\r\n", 0, "ascii");
		writeFileSync(target, fixture);
		const script = `
			import { strictEqual, ok, match } from "node:assert/strict";
			import { readFileSync } from "node:fs";
			import { editTool } from ${JSON.stringify(new URL("../../src/tools/edit.ts", import.meta.url).href)};
			const baseline = process.resourceUsage().maxRSS;
			const originalSplit = String.prototype.split;
			const originalReplace = String.prototype.replace;
			String.prototype.split = function(...args) {
				ok(this.length <= 1024 * 1024, "large content must not materialize line arrays");
				return Reflect.apply(originalSplit, this, args);
			};
			String.prototype.replace = function(...args) {
				ok(this.length <= 1024 * 1024, "large content must not be normalized wholesale");
				return Reflect.apply(originalReplace, this, args);
			};
			const result = await editTool.run({ path: process.argv[1], edits: [{ oldText: "target", newText: "edited" }] });
			strictEqual(result.kind, "ok", JSON.stringify(result));
			strictEqual(result.details.diff, undefined);
			match(result.output, /diff skipped.*1 MiB/);
			const peakGrowthKiB = process.resourceUsage().maxRSS - baseline;
			ok(peakGrowthKiB < 64 * 1024, "peak RSS growth exceeded 64 MiB: " + peakGrowthKiB);
			const expected = readFileSync(process.argv[1]);
			strictEqual(expected.subarray(0, 8).toString(), "edited\\r\\n");
			console.log(JSON.stringify({ peakGrowthKiB }));
		`;
		const child = spawnSync(
			process.execPath,
			["--import", "tsx", "--max-old-space-size=96", "--input-type=module", "-e", script, target],
			{ encoding: "utf8", env: { ...process.env, ...scratch.env }, timeout: 30000 },
		);
		strictEqual(child.status, 0, child.stderr || child.stdout);
		const changed = readFileSync(target);
		fixture.write("edited", 0, "ascii");
		deepStrictEqual(changed, fixture);
	});

	it("large invalid UTF-8 at EOF yields during chunk diagnosis and bounds decoder calls", async () => {
		const bytes = Buffer.alloc(12 * 1024 * 1024, 65);
		bytes[bytes.length - 1] = 255;
		writeFileSync(target, bytes);
		let ticks = 0;
		let active = true;
		const tick = () => {
			if (active) {
				ticks += 1;
				setImmediate(tick);
			}
		};
		setImmediate(tick);
		const decode = TextDecoder.prototype.decode;
		let firstTick: number | undefined;
		let lastTick = 0;
		let byteCalls = 0;
		let chunkCalls = 0;
		const decoderMock = mock.method(
			TextDecoder.prototype,
			"decode",
			function (
				this: InstanceType<typeof TextDecoder>,
				input: Parameters<typeof decode>[0],
				options: Parameters<typeof decode>[1],
			) {
				const size = input?.byteLength ?? 0;
				if (options?.stream) {
					firstTick ??= ticks;
					lastTick = ticks;
					if (size === 1) byteCalls += 1;
					else chunkCalls += 1;
				}
				return decode.call(this, input, options);
			},
		);
		try {
			const result = await editTool.run({ path: target, edits: [{ oldText: "A", newText: "B" }] });
			strictEqual(result.kind, "error");
			if (result.kind === "error") match(result.message, new RegExp(`byte offset ${bytes.length - 1}`));
			ok(chunkCalls >= 190 && chunkCalls <= 193, `chunk calls: ${chunkCalls}`);
			ok(byteCalls <= 65540, `byte decoder calls: ${byteCalls}`);
			ok(lastTick - (firstTick ?? lastTick) > 20, "event loop must progress during diagnosis");
			deepStrictEqual(readFileSync(target), bytes);
		} finally {
			active = false;
			decoderMock.mock.restore();
		}
	});

	it("UTF-8 diagnosis retains exact offsets across chunk boundaries and incomplete EOF", async () => {
		for (const suffix of [Buffer.from([0xe2, 0x82, 65]), Buffer.from([0xe2, 0x82])]) {
			const prefix = Buffer.alloc(65535, 65);
			const bytes = Buffer.concat([prefix, suffix]);
			writeFileSync(target, bytes);
			const result = await editTool.run({ path: target, edits: [{ oldText: "A", newText: "B" }] });
			strictEqual(result.kind, "error");
			if (result.kind === "error") match(result.message, /byte offset 65535/);
			deepStrictEqual(readFileSync(target), bytes);
		}
	});

	it("write bounds its old-content read when a file grows after the size check", async () => {
		writeFileSync(target, "small");
		const originalStat = fsPromises.stat;
		const originalOpen = fsPromises.open;
		let grown = false;
		let bytesRead = 0;
		const statMock = mock.method(fsPromises, "stat", async (...args: Parameters<typeof fsPromises.stat>) => {
			const info = await originalStat(...args);
			if (String(args[0]) === target && !grown) {
				grown = true;
				writeFileSync(target, Buffer.alloc(8 * 1024 * 1024, 65));
			}
			return info;
		});
		const openMock = mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
			const handle = await originalOpen(...args);
			if (String(args[0]) === target && args[1] === "r") {
				const read = handle.read.bind(handle);
				mock.method(handle, "read", async (...readArgs: [Buffer, number, number, number]) => {
					const result = await read(...readArgs);
					bytesRead += result.bytesRead;
					ok(bytesRead <= 1024 * 1024 + 1, "read exceeded the diff budget plus sentinel");
					return result;
				});
			}
			return handle;
		});
		syncBuiltinESMExports();
		try {
			const result = await writeTool.run({ path: target, content: "replacement" });
			strictEqual(result.kind, "ok");
			if (result.kind !== "ok") return;
			ok(grown);
			strictEqual(bytesRead, 1024 * 1024 + 1);
			strictEqual(result.details?.diff, undefined);
			match(result.output, /diff skipped.*1 MiB/);
			strictEqual(readFileSync(target, "utf8"), "replacement");
		} finally {
			statMock.mock.restore();
			openMock.mock.restore();
			syncBuiltinESMExports();
		}
	});
	it("large exact edits preserve BOM and CRLF for multiple multiline replacements", async () => {
		const padding = "padding\r\n".repeat(140000);
		const original = `\uFEFFfirst\r\nsecond\r\n${padding}last\r\n`;
		writeFileSync(target, original);
		const result = await editTool.run({
			path: target,
			edits: [
				{ oldText: "last\n", newText: "end\n" },
				{ oldText: "first\nsecond\n", newText: "start\n" },
			],
		});
		strictEqual(result.kind, "ok");
		strictEqual(readFileSync(target, "utf8"), `\uFEFFstart\r\n${padding}end\r\n`);
	});

	it("large edits refuse fuzzy matches, duplicates, overlaps and unchanged replacements without publishing", async () => {
		const original = `“quoted”\nunique region\n${"padding\n".repeat(150000)}`;
		for (const edits of [
			[{ oldText: '"quoted"', newText: "changed" }],
			[{ oldText: "padding", newText: "changed" }],
			[
				{ oldText: "unique region", newText: "changed" },
				{ oldText: "region", newText: "changed" },
			],
			[{ oldText: "unique region", newText: "unique region" }],
		]) {
			writeFileSync(target, original);
			const result = await editTool.run({ path: target, edits });
			strictEqual(result.kind, "error");
			if (result.kind === "error") match(result.message, /Nothing was published/);
			strictEqual(readFileSync(target, "utf8"), original);
		}
	});

	it("edit skips diff allocation when a small file receives a replacement above 1 MiB", async () => {
		writeFileSync(target, "small");
		const replacement = "new\n".repeat(300000);
		const result = await editTool.run({ path: target, edits: [{ oldText: "small", newText: replacement }] });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		match(result.output, /diff skipped.*1 MiB/);
		strictEqual(result.details?.diff, undefined);
		strictEqual(readFileSync(target, "utf8"), replacement);
	});
});
