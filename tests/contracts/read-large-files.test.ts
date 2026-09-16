import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, openSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { configureGuardrails } from "../../src/core/guardrails.js";
import type { Observation } from "../../src/tools/observation.js";
import {
	READ_LINE_COUNT_BUDGET_BYTES,
	READ_SCAN_CHUNK_BYTES,
	READ_WINDOW_SLACK_BYTES,
	type ReadFileIdentity,
	readTestSeams,
	readTool,
} from "../../src/tools/read.js";
import { truncateTail } from "../../src/tools/truncate.js";
import { makeScratchHome, type ScratchHome } from "../harness/scratch-env.js";

interface ReadArgs {
	offset?: number;
	limit?: number;
	tail?: number;
	line_numbers?: boolean;
}

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5X8AAAAASUVORK5CYII=";

/** A `width`-byte line whose label is its own physical line number, so assertions read themselves. */
function fixedLine(index: number, width: number): string {
	const label = `L${String(index).padStart(10, "0")} `;
	return `${label}${"x".repeat(width - label.length - 1)}\n`;
}

/** Write lines [first, last] of `width` bytes each starting at `position`, one bounded chunk at a time. */
function writeFixedLines(fd: number, first: number, last: number, width: number, position: number): number {
	const perChunk = Math.max(1, Math.floor((1024 * 1024) / width));
	let cursor = position;
	for (let start = first; start <= last; start += perChunk) {
		const end = Math.min(last, start + perChunk - 1);
		const chunk = Buffer.from(Array.from({ length: end - start + 1 }, (_, i) => fixedLine(start + i, width)).join(""));
		writeSync(fd, chunk, 0, chunk.length, cursor);
		cursor += chunk.length;
	}
	return cursor;
}

interface SparseLayout {
	path: string;
	headLines: number;
	tailLines: number;
	holeStart: number;
	totalLines: number;
	size: number;
}

/**
 * Real lines, then a hole of zeros that is one physical line on its own, then
 * real lines up to `size`. The hole costs no storage on a sparse-capable
 * filesystem and reads back as NUL bytes, so a reader that pulls the whole
 * file into memory pays for every byte while a windowed reader never sees it.
 */
function writeSparseFixture(
	path: string,
	size: number,
	headLines: number,
	tailLines: number,
	width: number,
): SparseLayout {
	const fd = openSync(path, "w");
	try {
		const holeStart = writeFixedLines(fd, 1, headLines, width, 0);
		ok(holeStart >= READ_SCAN_CHUNK_BYTES, "the first scan chunk must hold real text only");
		const terminator = size - tailLines * width - 1;
		ok(terminator > holeStart, "the hole must have a positive size");
		writeSync(fd, Buffer.from("\n"), 0, 1, terminator);
		writeFixedLines(fd, headLines + 2, headLines + 1 + tailLines, width, terminator + 1);
		return { path, headLines, tailLines, holeStart, totalLines: headLines + 1 + tailLines, size };
	} finally {
		closeSync(fd);
	}
}

function identity(path: string): ReadFileIdentity {
	const stat = statSync(path);
	return { bytes: stat.size, mtimeMs: stat.mtimeMs };
}

async function read(path: string, args: ReadArgs = {}) {
	const result = await readTool.run({ path, ...args });
	ok(result.kind === "ok", result.kind === "error" ? result.message : "ok");
	const observation = result.details?.observation as Observation;
	ok(observation);
	const notice = result.output.indexOf("\n\n[read:");
	const body = notice < 0 ? result.output : result.output.slice(0, notice);
	const file = result.details?.file as ReadFileIdentity;
	return { body, observation, output: result.output, file, details: result.details ?? {} };
}

async function refusal(path: string, args: ReadArgs = {}) {
	const result = await readTool.run({ path, ...args });
	ok(result.kind === "error", result.kind === "ok" ? `unexpected ok result: ${result.output.slice(0, 120)}` : "error");
	return { message: result.message, file: result.details?.file as ReadFileIdentity | undefined };
}

describe("read windowed reader", () => {
	let scratch: ScratchHome;
	beforeEach(() => {
		scratch = makeScratchHome("clio-coder-read-large-");
		configureGuardrails({ readMaxBytes: 1024 });
	});
	afterEach(() => {
		configureGuardrails(undefined);
		scratch.cleanup();
	});

	it("keeps 3-byte characters exact across the scan chunk boundary and inside byte-cut windows", async () => {
		const path = join(scratch.dir, "euro.txt");
		const line = `${"€".repeat(8)}\n`;
		const lineBytes = Buffer.byteLength(line);
		const total = 3000;
		writeFileSync(path, line.repeat(total));
		const boundaryLine = Math.floor(READ_SCAN_CHUNK_BYTES / lineBytes) + 1;
		ok((READ_SCAN_CHUNK_BYTES % lineBytes) % 3 !== 0, "the 64 KiB chunk boundary falls inside a character");
		const straddle = await read(path, { offset: boundaryLine, limit: 3 });
		strictEqual(straddle.body, line.repeat(3));
		strictEqual(straddle.observation.shownCount, 3);
		strictEqual(straddle.observation.totalCount, total);
		strictEqual(straddle.observation.next, `offset=${boundaryLine + 3}`);

		// The window is cap plus slack bytes and ends inside a character here, so
		// the cut sequence is dropped and exactly the lines that fit the cap survive.
		ok(((1024 + READ_WINDOW_SLACK_BYTES) % lineBytes) % 3 !== 0, "the byte-cut window ends inside a character");
		const fit = Math.floor((1024 + 1) / lineBytes);
		const head = await read(path, { offset: 100 });
		strictEqual(head.body, Array.from({ length: fit }, () => line.trimEnd()).join("\n"));
		strictEqual(head.observation.shownCount, fit);
		strictEqual(head.observation.next, `offset=${100 + fit}`);
		ok(!head.output.includes("�"));

		const tail = await read(path, { tail: 3 });
		strictEqual(tail.body, line.repeat(3));
		strictEqual(tail.observation.next, `offset=${total - 5} limit=3`);
		const cappedTail = await read(path, { tail: 200 });
		strictEqual(cappedTail.body, Array.from({ length: fit }, () => line.trimEnd()).join("\n"));
		strictEqual(cappedTail.observation.shownCount, fit);
		strictEqual(cappedTail.observation.totalCount, total);
		strictEqual(cappedTail.observation.next, `offset=${total - 2 * fit + 1} limit=${fit}`);
		ok(!cappedTail.output.includes("�"));
	});

	it("keeps 4-byte characters exact when both window edges fall inside a sequence", async () => {
		const path = join(scratch.dir, "emoji.txt");
		const line = `${"😀".repeat(7)}\n`;
		const lineBytes = Buffer.byteLength(line);
		strictEqual(lineBytes, 29);
		const total = 4000;
		writeFileSync(path, line.repeat(total));
		const size = total * lineBytes;
		ok(size > READ_SCAN_CHUNK_BYTES && (READ_SCAN_CHUNK_BYTES % lineBytes) % 4 !== 0);
		ok(((1024 + READ_WINDOW_SLACK_BYTES) % lineBytes) % 4 !== 0, "the forward window ends inside a character");
		ok(((size - (1024 + READ_WINDOW_SLACK_BYTES)) % lineBytes) % 4 !== 0, "the tail window starts inside a character");
		const fit = Math.floor((1024 + 1) / lineBytes);
		const head = await read(path, { offset: 2700 });
		strictEqual(head.body, Array.from({ length: fit }, () => line.trimEnd()).join("\n"));
		strictEqual(head.observation.shownCount, fit);
		ok(!head.output.includes("�"));
		const tail = await read(path, { tail: 500 });
		strictEqual(tail.body, Array.from({ length: fit }, () => line.trimEnd()).join("\n"));
		strictEqual(tail.observation.shownCount, fit);
		ok(!tail.output.includes("�"));
		const exact = await read(path, { tail: 2 });
		strictEqual(exact.body, line.repeat(2));
		strictEqual(exact.observation.truncated, true);
	});

	it("refuses malformed UTF-8 inside the shown window with the failing byte offset and a hint", async () => {
		const path = join(scratch.dir, "latin1.txt");
		writeFileSync(path, Buffer.concat([Buffer.from("abc\n"), Buffer.from([0xff]), Buffer.from("def\n")]));
		const bad = await refusal(path);
		match(bad.message, /not valid UTF-8 text: byte 0xFF at byte offset 4 of 9B/);
		match(bad.message, /data capability/);
		match(bad.message, /run_script/);
		ok(!bad.message.includes("�"));
		deepStrictEqual(bad.file, identity(path));

		const truncated = join(scratch.dir, "cut.txt");
		writeFileSync(truncated, Buffer.concat([Buffer.from("ok\n"), Buffer.from([0xe2, 0x82])]));
		match((await refusal(truncated)).message, /byte 0xE2 at byte offset 3/);

		const surrogate = join(scratch.dir, "surrogate.txt");
		writeFileSync(surrogate, Buffer.from([0x61, 0xed, 0xa0, 0x80, 0x0a]));
		match((await refusal(surrogate)).message, /byte 0xA0 at byte offset 2/);

		// Bytes outside the shown window are never decoded, so a bad byte far
		// down the file leaves an earlier page readable and refuses the page
		// that would show it, with its absolute offset.
		const far = join(scratch.dir, "far.txt");
		const filler = "x".repeat(3000);
		writeFileSync(far, Buffer.concat([Buffer.from(`first\n${filler}\n`), Buffer.from([0xff]), Buffer.from("\n")]));
		const first = await read(far, { offset: 1, limit: 1 });
		strictEqual(first.body, "first\n");
		match((await refusal(far, { tail: 1 })).message, /byte offset 3007 of/);
		match((await refusal(far, { offset: 3 })).message, /byte offset 3007 of/);
	});

	it("refuses NUL bytes in the first chunk and in the shown window as binary", async () => {
		const path = join(scratch.dir, "binary.dat");
		writeFileSync(path, Buffer.from([0x61, 0x00, 0x62, 0x0a]));
		for (const args of [{}, { tail: 1 }, { offset: 1, limit: 1 }]) {
			const refused = await refusal(path, args);
			match(refused.message, /looks binary: NUL byte at byte offset 1 of 4B/);
			match(refused.message, /run_script/);
			deepStrictEqual(refused.file, identity(path));
		}
		const late = join(scratch.dir, "late-nul.txt");
		const prefix = "y".repeat(READ_SCAN_CHUNK_BYTES + 5000);
		writeFileSync(late, Buffer.concat([Buffer.from(`${prefix}\nclean\n`), Buffer.from([0x00]), Buffer.from("\n")]));
		const clean = await read(late, { offset: 2, limit: 1 });
		strictEqual(clean.body, "clean\n");
		match((await refusal(late, { tail: 1 })).message, new RegExp(`NUL byte at byte offset ${prefix.length + 7} of`));
	});

	it("pages a multi-chunk counted file honestly with exact totals and stat identity", async () => {
		const path = join(scratch.dir, "counted.log");
		const width = 32;
		const total = 65536;
		const fd = openSync(path, "w");
		try {
			writeFixedLines(fd, 1, total, width, 0);
		} finally {
			closeSync(fd);
		}
		const size = total * width;
		strictEqual(statSync(path).size, size);
		ok(size > 16 * READ_SCAN_CHUNK_BYTES);

		const middle = await read(path, { offset: 40000, limit: 3 });
		strictEqual(middle.body, [40000, 40001, 40002].map((n) => fixedLine(n, width)).join(""));
		strictEqual(middle.observation.totalCount, total);
		strictEqual(middle.observation.totalBytes, size);
		strictEqual(middle.observation.next, "offset=40003");
		deepStrictEqual(middle.file, identity(path));
		strictEqual(middle.details.fileChange, undefined);

		const clamp = await read(path, { offset: total - 6, limit: 100 });
		strictEqual(clamp.observation.shownCount, 7);
		strictEqual(clamp.observation.truncated, false);
		strictEqual(clamp.observation.next, undefined);
		strictEqual(clamp.body, Array.from({ length: 7 }, (_, i) => fixedLine(total - 6 + i, width)).join(""));

		const last = await read(path, { offset: total });
		strictEqual(last.body, fixedLine(total, width));
		const beyond = await refusal(path, { offset: total + 1 });
		match(beyond.message, new RegExp(`beyond end of file \\(${total} lines total\\)`));
		deepStrictEqual(beyond.file, identity(path));

		const tail = await read(path, { tail: 4 });
		strictEqual(tail.body, Array.from({ length: 4 }, (_, i) => fixedLine(total - 3 + i, width)).join(""));
		strictEqual(tail.observation.next, `offset=${total - 7} limit=4`);
		strictEqual(tail.observation.totalCount, total);

		// A tail deeper than one scan chunk: the backward scan gives up past the
		// retained window and the byte cap alone bounds what is shown.
		const fit = Math.floor((1024 + 1) / width);
		const deep = await read(path, { tail: 3000 });
		strictEqual(
			deep.body,
			Array.from({ length: fit }, (_, i) => fixedLine(total - fit + 1 + i, width))
				.join("")
				.trimEnd(),
		);
		strictEqual(deep.observation.shownCount, fit);
		strictEqual(deep.observation.totalCount, total);
		strictEqual(deep.observation.next, `offset=${total - 2 * fit + 1} limit=${fit}`);

		const numbered = await read(path, { offset: 50000, limit: 2, line_numbers: true });
		strictEqual(numbered.body, `50000 | ${fixedLine(50000, width)}50001 | ${fixedLine(50001, width)}`);
		let labelBytes = 0;
		for (let n = 1; n <= total; n += 1) labelBytes += String(n).length + 3;
		strictEqual(numbered.observation.totalBytes, size + labelBytes);
		strictEqual(numbered.observation.next, "offset=50002 line_numbers=true");
	});

	it("reconstructs a file exactly by following next continuations", async () => {
		configureGuardrails({ readMaxBytes: 16 * 1024 });
		const path = join(scratch.dir, "pages.log");
		const width = 32;
		const total = 6400;
		const fd = openSync(path, "w");
		try {
			writeFixedLines(fd, 1, total, width, 0);
		} finally {
			closeSync(fd);
		}
		const expected = Array.from({ length: total }, (_, i) => fixedLine(i + 1, width)).join("");
		const pages: string[] = [];
		let offset = 1;
		let calls = 0;
		while (true) {
			const page = await read(path, { offset, limit: 400 });
			pages.push(page.body);
			calls += 1;
			if (page.observation.next === undefined) break;
			const next = /^offset=(\d+)$/.exec(page.observation.next);
			ok(next?.[1] !== undefined);
			offset = Number(next[1]);
		}
		strictEqual(calls, 16);
		strictEqual(pages.join(""), expected);
	});

	it("describes an oversized first line with its exact size even past the window", async () => {
		const path = join(scratch.dir, "long-line.txt");
		writeFileSync(path, `${"a".repeat(5000)}\nshort\n`);
		const plain = await read(path);
		match(plain.output, /\[Line 1 is 4\.9KB, exceeding the 1\.0KB read limit/);
		strictEqual(plain.observation.shownCount, 0);
		strictEqual(plain.observation.totalCount, 2);
		deepStrictEqual(plain.file, identity(path));
		const numbered = await read(path, { line_numbers: true });
		match(numbered.output, /^1 \| a+\n\[line truncated\]\n\n\[Numbered line 1 is 4\.9KB/u);
	});

	it("skips line counting above the budget and renders honest N+ totals from a sparse fixture", async () => {
		const width = 32;
		const layout = writeSparseFixture(
			join(scratch.dir, "huge.log"),
			READ_LINE_COUNT_BUDGET_BYTES + 1024 * 1024,
			4096,
			100,
			width,
		);
		const { path, headLines, totalLines, size } = layout;
		strictEqual(statSync(path).size, size);

		const head = await read(path, { offset: 1, limit: 2 });
		strictEqual(head.body, fixedLine(1, width) + fixedLine(2, width));
		strictEqual(head.observation.totalCount, null);
		strictEqual(head.observation.totalBytes, size);
		strictEqual(head.observation.next, "offset=3");
		match(head.output, /\[read: 2\/2\+ lines shown \(64B of 33\.0MB\) \| next: offset=3\]$/);
		deepStrictEqual(head.file, identity(path));

		const tail = await read(path, { tail: 3 });
		strictEqual(tail.body, [totalLines - 2, totalLines - 1, totalLines].map((n) => fixedLine(n, width)).join(""));
		strictEqual(tail.observation.totalCount, null);
		strictEqual(tail.observation.next, "tail=6");
		match(tail.output, /\[read: 3\/3\+ lines shown \(96B of 33\.0MB\) \| next: tail=6\]$/);

		const deep = await read(path, { tail: 3000 });
		const fit = Math.floor((1024 + 1) / width);
		strictEqual(
			deep.body,
			Array.from({ length: fit }, (_, i) => fixedLine(totalLines - fit + 1 + i, width))
				.join("")
				.trimEnd(),
		);
		strictEqual(deep.observation.shownCount, fit);
		strictEqual(deep.observation.totalCount, null);
		strictEqual(deep.observation.truncated, true);
		strictEqual(deep.observation.next, undefined, "a byte-capped uncounted tail has no exact continuation");

		const numberedTail = await refusal(path, { tail: 3, line_numbers: true });
		match(numberedTail.message, /line_numbers with tail needs a physical line count/);
		match(numberedTail.message, /32\.0MB counting budget/);

		const afterHole = await read(path, { offset: headLines + 2, limit: 2, line_numbers: true });
		strictEqual(
			afterHole.body,
			`${headLines + 2} | ${fixedLine(headLines + 2, width)}${headLines + 3} | ${fixedLine(headLines + 3, width)}`,
		);
		strictEqual(afterHole.observation.totalCount, null);
		strictEqual(afterHole.observation.next, `offset=${headLines + 4} line_numbers=true`);

		const hole = await refusal(path, { offset: headLines + 1 });
		match(hole.message, new RegExp(`looks binary: NUL byte at byte offset ${layout.holeStart} of 33\\.0MB`));

		const beyond = await refusal(path, { offset: totalLines + 1 });
		match(beyond.message, new RegExp(`beyond end of file \\(${totalLines} lines total\\)`));
		const lastLine = await read(path, { offset: totalLines });
		strictEqual(lastLine.body, fixedLine(totalLines, width));
		strictEqual(lastLine.observation.truncated, false);
	});

	it("reports a file that grows between two calls with the identity each call used", async () => {
		const path = join(scratch.dir, "growing.log");
		writeFileSync(path, Array.from({ length: 10 }, (_, i) => `event ${i + 1}\n`).join(""));
		const first = await read(path);
		strictEqual(first.observation.totalCount, 10);
		deepStrictEqual(first.file, identity(path));
		strictEqual(first.observation.totalBytes, first.file.bytes);
		strictEqual(first.details.fileChange, undefined);

		appendFileSync(path, Array.from({ length: 5 }, (_, i) => `event ${i + 11}\n`).join(""));
		const second = await read(path, { tail: 1 });
		strictEqual(second.body, "event 15\n");
		strictEqual(second.observation.totalCount, 15);
		strictEqual(second.observation.next, "offset=14 limit=1");
		deepStrictEqual(second.file, identity(path));
		ok(second.file.bytes > first.file.bytes);
		ok(second.file.mtimeMs >= first.file.mtimeMs);
		strictEqual(second.observation.totalBytes, second.file.bytes);
		const page = await read(path, { offset: 11, limit: 2 });
		strictEqual(page.body, "event 11\nevent 12\n");
		strictEqual(page.observation.next, "offset=13");
	});

	it("keeps image handling and stamps the file identity on image results", async () => {
		const path = join(scratch.dir, "plot.png");
		writeFileSync(path, Buffer.from(PNG, "base64"));
		const image = await readTool.run({ path }, { supportsImages: true });
		ok(image.kind === "ok");
		strictEqual(image.images?.[0]?.mimeType, "image/png");
		deepStrictEqual(image.details?.file, identity(path));
		const unsupported = await readTool.run({ path }, {});
		ok(unsupported.kind === "error");
		match(unsupported.message, /IMAGE_INPUT_UNSUPPORTED/);
		deepStrictEqual(unsupported.details?.file, identity(path));
	});

	it("never shows a cut first line as complete at any tail window alignment", async () => {
		const line = "abc😀😀😀😀😀😀\n";
		const lineBytes = Buffer.byteLength(line);
		strictEqual(lineBytes, 28);
		const count = 100;
		const tail = 40;
		const cap = 1024;
		const skips = new Set<number>();
		for (let shift = 0; shift < lineBytes; shift += 1) {
			// The retained tail window is measured back from EOF, so a last line of
			// `shift` bytes moves the window start to each byte position of a
			// repeated line exactly once: on ASCII, on a 4-byte lead, and one,
			// two, or three bytes past it (three continuation bytes skipped leaves
			// the smallest window).
			const last = shift === 0 ? "" : `${"q".repeat(shift - 1)}\n`;
			const content = `${line.repeat(count)}${last}`;
			const path = join(scratch.dir, `align-${shift}.txt`);
			writeFileSync(path, content);
			const size = Buffer.byteLength(content);
			const offsetInLine = (size - (cap + READ_WINDOW_SLACK_BYTES)) % lineBytes;
			const inCharacter = offsetInLine >= 3 && offsetInLine < lineBytes - 1 ? (offsetInLine - 3) % 4 : 0;
			skips.add(inCharacter === 0 ? 0 : 4 - inCharacter);
			const lines = content.slice(0, -1).split("\n");
			const totalLines = lines.length;
			// The oracle is the shared tail truncation over the whole 40-line
			// selection, which the windowed reader must reproduce exactly.
			const oracle = truncateTail(`${lines.slice(-tail).join("\n")}\n`, { maxBytes: cap, maxLines: tail });
			ok(oracle.truncated && oracle.outputLines < tail);
			const plain = await read(path, { tail });
			strictEqual(plain.body, oracle.content, `shift ${shift}`);
			strictEqual(plain.observation.shownCount, oracle.outputLines, `shift ${shift}`);
			ok(plain.body.startsWith("abc😀"), `shift ${shift}: the first shown line is complete`);
			strictEqual(plain.observation.truncated, true);
			strictEqual(
				plain.observation.next,
				`offset=${totalLines - 2 * oracle.outputLines + 1} limit=${oracle.outputLines}`,
				`shift ${shift}`,
			);
			const numbered = await read(path, { tail, line_numbers: true });
			const shown = numbered.body.split("\n");
			strictEqual(numbered.observation.shownCount, shown.length, `shift ${shift}`);
			ok(shown.length > 0 && shown.length < oracle.outputLines, "labels cost bytes, so fewer numbered lines fit");
			shown.forEach((text, index) => {
				const number = totalLines - shown.length + 1 + index;
				strictEqual(text, `${number} | ${lines[number - 1]}`, `shift ${shift} line ${index}`);
			});
			ok(shown[0]?.endsWith(line.trimEnd()), `shift ${shift}: the first numbered line is complete`);
		}
		deepStrictEqual([...skips].sort(), [0, 1, 2, 3], "every continuation skip length was exercised");
	});

	it("refuses a named pipe and a directory from stat alone, without opening them", { timeout: 10_000 }, async (t) => {
		const dir = await readTool.run({ path: scratch.dir });
		ok(dir.kind === "error");
		match(dir.message, /not a file/);
		deepStrictEqual(dir.details?.file, identity(scratch.dir));
		const fifo = join(scratch.dir, "pipe.fifo");
		try {
			execFileSync("mkfifo", [fifo]);
		} catch {
			t.skip("mkfifo is not available here");
			return;
		}
		// open() on a FIFO with no writer blocks forever; the stat refusal
		// must return within the test timeout.
		const result = await readTool.run({ path: fifo });
		ok(result.kind === "error");
		match(result.message, /not a file/);
		deepStrictEqual(result.details?.file, identity(fifo));
	});

	it("stamps the file identity on the budget-exhausted short-circuit", async () => {
		configureGuardrails({ readMaxBytes: 1024, observationTurnBudgetBytes: 1024 });
		const path = join(scratch.dir, "budget.txt");
		writeFileSync(path, "alpha\nbeta\n");
		const options = { sessionId: "read-budget", turnId: scratch.dir };
		const first = await readTool.run({ path }, options);
		ok(first.kind === "ok");
		strictEqual(first.output, "alpha\nbeta\n");
		const second = await readTool.run({ path }, options);
		ok(second.kind === "ok");
		match(second.output, /^\[observation budget exhausted for this turn before read reading /);
		deepStrictEqual(second.details?.file, identity(path));
		strictEqual((second.details?.observation as Observation).totalCount, null);
	});

	it("reports a file that changes in flight with both identities and a notice", async () => {
		const path = join(scratch.dir, "inflight.log");
		writeFileSync(path, Array.from({ length: 6 }, (_, i) => `row ${i + 1}\n`).join(""));
		const before = identity(path);
		readTestSeams.afterIdentity = (file, seen) => {
			deepStrictEqual(file, before);
			strictEqual(seen, path);
			appendFileSync(path, "row 7\nrow 8\n");
		};
		try {
			const grown = await read(path, { tail: 2 });
			strictEqual(grown.body, "row 5\nrow 6\n", "bytes past the recorded size are never read");
			strictEqual(grown.observation.totalCount, 6);
			deepStrictEqual(grown.file, before);
			deepStrictEqual(grown.details.fileChange, identity(path));
			match(
				grown.output,
				/^row 5\nrow 6\n\n\n\[read: 2\/6 lines shown \(12B of 36B\) \| next: offset=3 limit=2 \| .*inflight\.log changed while being read: 36B \(mtime \S+\) when the read began, 48B \(mtime \S+\) when it finished; the lines and counts above may mix the two states, re-read to see the current content\]$/,
			);
			strictEqual(grown.observation.next, "offset=3 limit=2");
			const beforeShrink = identity(path);
			readTestSeams.afterIdentity = () => {
				truncateSync(path, 12);
			};
			const shrunk = await read(path);
			strictEqual(shrunk.body, "row 1\nrow 2\n");
			deepStrictEqual(shrunk.file, beforeShrink);
			deepStrictEqual(shrunk.details.fileChange, identity(path));
			match(
				shrunk.output,
				/^row 1\nrow 2\n\n\n\[read: .*inflight\.log changed while being read: 48B \(mtime \S+\) when the read began, 12B \(mtime \S+\) when it finished; [^\]]*\]$/,
			);
		} finally {
			readTestSeams.afterIdentity = undefined;
		}
		const settled = await read(path);
		strictEqual(settled.details.fileChange, undefined);
		ok(!settled.output.includes("changed while being read"));
	});

	it("refuses an image above the whole-file image ceiling before decoding it", async () => {
		const path = join(scratch.dir, "huge.png");
		const fd = openSync(path, "w");
		try {
			const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
			writeSync(fd, magic, 0, magic.length, 0);
			writeSync(fd, Buffer.from([0x00]), 0, 1, 20_000_000);
		} finally {
			closeSync(fd);
		}
		strictEqual(statSync(path).size, 20_000_001);
		const result = await readTool.run({ path }, { supportsImages: true });
		ok(result.kind === "error");
		match(result.message, /image too large \(20000001B > 20MB\)/);
		deepStrictEqual(result.details?.file, identity(path));
	});

	it("stops a multi-chunk scan at the chunk where the signal aborts", async () => {
		const path = join(scratch.dir, "abort-scan.log");
		const fd = openSync(path, "w");
		try {
			writeFixedLines(fd, 1, 16384, 32, 0);
		} finally {
			closeSync(fd);
		}
		strictEqual(statSync(path).size, 8 * READ_SCAN_CHUNK_BYTES);
		const controller = new AbortController();
		const stopAt = 3 * READ_SCAN_CHUNK_BYTES;
		const seen: number[] = [];
		readTestSeams.beforeChunk = (position) => {
			seen.push(position);
			if (position >= stopAt) controller.abort();
		};
		try {
			const result = await readTool.run({ path, offset: 16000 }, { signal: controller.signal });
			ok(result.kind === "error");
			strictEqual(result.message, `read: cancelled while scanning ${path} at byte ${stopAt}`);
			deepStrictEqual(result.details?.file, identity(path));
			deepStrictEqual(
				seen,
				[0, 1, 2, 3].map((chunk) => chunk * READ_SCAN_CHUNK_BYTES),
			);
		} finally {
			readTestSeams.beforeChunk = undefined;
		}
		const whole = await read(path, { offset: 16000 });
		strictEqual(whole.observation.totalCount, 16384);
	});

	it("reports a first line longer than the count budget as a lower bound", async () => {
		const path = join(scratch.dir, "endless-line.txt");
		const fd = openSync(path, "w");
		try {
			const head = Buffer.from("a".repeat(READ_SCAN_CHUNK_BYTES));
			writeSync(fd, head, 0, head.length, 0);
			const rest = Buffer.from("\nsecond\n");
			writeSync(fd, rest, 0, rest.length, READ_LINE_COUNT_BUDGET_BYTES + 1024 * 1024);
		} finally {
			closeSync(fd);
		}
		const result = await read(path);
		match(result.output, /^a+\n\[line truncated\]\n\n\[Line 1 is at least 32\.0MB, exceeding the 1\.0KB read limit/);
		strictEqual(result.observation.shownCount, 0);
		strictEqual(result.observation.totalCount, null);
		strictEqual(result.observation.truncated, true);
		deepStrictEqual(result.file, identity(path));
	});

	it("stops a scan when the invocation signal is already aborted", async () => {
		const path = join(scratch.dir, "abort.txt");
		writeFileSync(path, "one\ntwo\n");
		const result = await readTool.run({ path, offset: 2 }, { signal: AbortSignal.abort() });
		ok(result.kind === "error");
		match(result.message, /cancelled while scanning/);
	});
});
