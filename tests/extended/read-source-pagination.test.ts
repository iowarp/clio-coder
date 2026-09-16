import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { closeSync, openSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { configureGuardrails } from "../../src/core/guardrails.js";
import type { Observation } from "../../src/tools/observation.js";
import { type ReadFileIdentity, readTool } from "../../src/tools/read.js";
import { makeScratchHome, type ScratchHome } from "../harness/scratch-env.js";

describe("read source-line pagination through the source tool API", () => {
	let scratch: ScratchHome;
	beforeEach(() => {
		scratch = makeScratchHome("clio-coder-read-pagination-");
		configureGuardrails({ readMaxBytes: 1024 });
	});
	afterEach(() => {
		configureGuardrails(undefined);
		scratch.cleanup();
	});

	async function read(
		content: string,
		args: { offset?: number; limit?: number; tail?: number; line_numbers?: boolean } = {},
	) {
		const path = join(scratch.dir, "source.txt");
		writeFileSync(path, content);
		const result = await readTool.run({ path, ...args });
		ok(result.kind === "ok");
		const observation = result.details?.observation as Observation;
		ok(observation);
		const notice = result.output.indexOf("\n\n[read:");
		const body = notice < 0 ? result.output : result.output.slice(0, notice);
		return { body, observation, output: result.output };
	}

	it("advances offset 207 past a real blank line with limit 1", async () => {
		const content = `${Array.from({ length: 208 }, (_, i) => (i === 206 ? "" : "x")).join("\n")}\n`;
		const { body, observation } = await read(content, { offset: 207, limit: 1 });
		strictEqual(observation.shownCount, 1);
		strictEqual(observation.next, "offset=208");
		strictEqual(observation.totalCount, 208);
		strictEqual(observation.truncated, true);
		strictEqual(body, "\n", "a blank source line stays blank, with its real terminator");
	});

	it("advances a 70-line selection ending in a blank from offset 95 to 165", async () => {
		const content = `${Array.from({ length: 208 }, (_, i) => (i === 163 ? "" : "x")).join("\n")}\n`;
		const { body, observation } = await read(content, { offset: 95, limit: 70 });
		strictEqual(observation.shownCount, 70);
		strictEqual(observation.next, "offset=165");
		strictEqual(95 + observation.shownCount - 1, 164, "inclusive observed source range reaches the blank line");
		strictEqual(body, `${"x\n".repeat(69)}\n`);
	});

	for (const content of ["", "x", "x\n", "\n", "x\n\n", "\n\n"]) {
		it(`keeps EOF and physical line counts for ${JSON.stringify(content)}`, async () => {
			const total = content === "" ? 0 : content.split("\n").length - Number(content.endsWith("\n"));
			for (const args of [{}, { limit: Math.max(1, total) }, { limit: total + 1 }, { tail: 10 }]) {
				const { body, observation } = await read(content, args);
				strictEqual(body, content);
				strictEqual(observation.shownCount, total);
				strictEqual(observation.totalCount, total);
				strictEqual(observation.truncated, false);
				strictEqual(observation.next, undefined);
			}
			const beyond = await readTool.run({ path: join(scratch.dir, "source.txt"), offset: total + 2 });
			ok(beyond.kind === "error");
			match(beyond.message, /beyond end of file/);
		});
	}

	it("pages consecutive blank lines without repeats or a phantom EOF line", async () => {
		const content = "\n\nx\n\n";
		const bodies: string[] = [];
		for (let offset = 1; offset <= 4; offset++) {
			const { body, observation } = await read(content, { offset, limit: 1 });
			bodies.push(body);
			strictEqual(observation.shownCount, 1);
			strictEqual(observation.next, offset < 4 ? `offset=${offset + 1}` : undefined);
			strictEqual(observation.truncated, offset < 4);
		}
		strictEqual(bodies.join(""), content);
	});

	it("counts complete empty lines at the UTF-8 byte cap and continues at the unread line", async () => {
		const prefix = `\n${"é".repeat(510)}\n`;
		const content = `${prefix}\nnext\n\nlast\n`;
		const { body, observation } = await read(content, { limit: 5 });
		strictEqual(body, prefix);
		strictEqual(Buffer.byteLength(body), 1022);
		strictEqual(observation.shownCount, 3, "the capped join contains a leading and a trailing empty source line");
		strictEqual(observation.next, "offset=4");
		strictEqual(observation.truncated, true);
		const next = await read(content, { offset: 4, limit: 2 });
		strictEqual(next.body, "next\n\n");
		strictEqual(next.observation.shownCount, 2);
		strictEqual(next.observation.next, "offset=6");
	});

	it("enforces the default line cap on a blank-only selection", async () => {
		configureGuardrails({ readMaxBytes: 64 * 1024 });
		const { body, observation } = await read("\n".repeat(2002), { limit: 2001 });
		strictEqual(body, "\n".repeat(1999));
		strictEqual(observation.shownCount, 2000);
		strictEqual(observation.next, "offset=2001");
	});

	it("returns a blank source line when its separator exactly fills the byte cap", async () => {
		const line = "x".repeat(1023);
		const { body, observation } = await read(`${line}\n\nlast`, { limit: 2 });
		strictEqual(body, `${line}\n`);
		strictEqual(Buffer.byteLength(body), 1024);
		strictEqual(observation.shownCount, 2);
		strictEqual(observation.next, "offset=3");
		const eof = await read(`${line}\n`, { limit: 1 });
		strictEqual(eof.body, `${line}\n`);
		strictEqual(eof.observation.shownCount, 1);
		strictEqual(eof.observation.truncated, false);
		strictEqual(eof.observation.next, undefined);
	});

	it("retains the UTF-8 huge-line prefix without claiming a complete source line", async () => {
		const { output, observation } = await read(`${"€".repeat(400)}\n\nlast\n`, { limit: 1 });
		match(output, /^€+/u);
		match(output, /\[line truncated\]/);
		ok(!output.includes("�"));
		const prefix = output.split("\n[line truncated]")[0];
		ok(prefix !== undefined);
		strictEqual(Buffer.byteLength(prefix), 1023);
		strictEqual(observation.shownCount, 0);
		strictEqual(observation.truncated, true);
		strictEqual(observation.next, undefined);
	});

	it("retains tail selection and byte caps including blank EOF lines", async () => {
		const tail = await read("head\nx\n\n", { tail: 2, offset: 100, limit: 1 });
		strictEqual(tail.body, "x\n\n");
		strictEqual(tail.observation.shownCount, 2);
		strictEqual(tail.observation.next, "offset=1 limit=2");
		const capped = await read(`head\n${"é".repeat(700)}\n\n`, { tail: 2 });
		ok(Buffer.byteLength(capped.body) <= 1024);
		ok(!capped.body.includes("�"));
		deepStrictEqual([capped.observation.shownCount, capped.observation.totalCount], [1, 3]);
	});
	it("labels the actual physical citation line after blank lines, with opt-in plain compatibility", async () => {
		const content = Array.from({ length: 197 }, (_, index) =>
			index === 170
				? "text = re.sub(pattern, separator, text)"
				: index === 173
					? "text = re.sub(DUPLICATE_DASH_PATTERN, separator, text).strip(separator)"
					: index % 3 === 0
						? ""
						: "source",
		).join("\n");
		const numbered = await read(content, { offset: 165, limit: 10, line_numbers: true });
		match(numbered.body, /^171 \| text = re.sub\(pattern, separator, text\)$/m);
		match(numbered.body, /^174 \| text = re.sub\(DUPLICATE_DASH_PATTERN/m);
		strictEqual(numbered.observation.next, "offset=175 line_numbers=true");
		strictEqual(numbered.observation.shownCount, 10);
		const plain = await read(content, { offset: 165, limit: 10, line_numbers: false });
		strictEqual(plain.body, `${content.split("\n").slice(164, 174).join("\n")}\n`);
	});

	it("numbers blank lines and preserves EOF terminators without a phantom source line", async () => {
		for (const [content, expected] of [
			["", ""],
			["x", "1 | x"],
			["x\n", "1 | x\n"],
			["\n", "1 | \n"],
			["x\n\n", "1 | x\n2 | \n"],
		]) {
			ok(content !== undefined && expected !== undefined);
			for (const args of [{}, { tail: 10 }]) {
				const result = await read(content, { ...args, line_numbers: true });
				strictEqual(result.body, expected);
				strictEqual(result.observation.truncated, false);
				strictEqual(result.observation.shownBytes, Buffer.byteLength(expected));
				strictEqual(result.observation.totalBytes, Buffer.byteLength(expected));
			}
		}
	});

	it("caps the numbered rendering and continues after complete physical lines", async () => {
		const content = "\n".repeat(2002);
		let offset = 1;
		const seen: number[] = [];
		while (offset <= 2002) {
			const result = await read(content, { offset, line_numbers: true });
			ok(Buffer.byteLength(result.body) <= 1024);
			const lines = result.body.split("\n").filter((line) => line !== "");
			strictEqual(lines.length, result.observation.shownCount);
			for (const line of lines) seen.push(Number(line.split(" | ")[0]));
			offset += result.observation.shownCount;
			strictEqual(result.observation.next, offset <= 2002 ? `offset=${offset} line_numbers=true` : undefined);
		}
		deepStrictEqual(
			seen,
			Array.from({ length: 2002 }, (_, index) => index + 1),
		);
	});

	it("keeps blank lines represented by a truncated raw join and accounts label bytes", async () => {
		configureGuardrails({ readMaxBytes: 64 * 1024 });
		const result = await read("\n".repeat(2002), { line_numbers: true });
		strictEqual(result.observation.shownCount, 2000);
		match(result.body, /2000 \| $/);
		strictEqual(result.observation.next, "offset=2001 line_numbers=true");
		const full = Array.from({ length: 2002 }, (_, index) => `${index + 1} | \n`).join("");
		strictEqual(result.observation.totalBytes, Math.max(Buffer.byteLength(full), Buffer.byteLength(result.output)));
	});

	it("does not claim a complete citation when labels make a UTF-8 line exceed the cap", async () => {
		for (const content of ["€".repeat(341), "€".repeat(400)]) {
			const result = await read(content, { line_numbers: true });
			match(result.output, /^1 \| €/u);
			match(result.output, /\[line truncated\]/);
			ok(!result.output.includes("�"));
			strictEqual(result.observation.shownCount, 0);
			strictEqual(result.observation.next, undefined);
		}
	});

	it("numbers the bounded tail using original positions and marks oversized suffixes partial", async () => {
		const result = await read("head\nx\n\n", { tail: 2, line_numbers: true });
		strictEqual(result.body, "2 | x\n3 | \n");
		strictEqual(result.observation.next, "offset=1 limit=2 line_numbers=true");
		const cap = await read(`head\n${"€".repeat(400)}`, { tail: 1, line_numbers: true });
		match(cap.body, /^2 \| \[partial line suffix\] €+/u);
		ok(Buffer.byteLength(cap.body) <= 1024);
		ok(!cap.body.includes("�"));
		strictEqual(cap.observation.shownCount, 0);
		strictEqual(cap.observation.next, undefined);
		const blank = await read(`head\n${"é".repeat(700)}\n\n`, { tail: 2, line_numbers: true });
		strictEqual(blank.body, "3 | ");
		strictEqual(blank.observation.shownCount, 1);
	});
});

describe("read windowed reader on a 300 MB sparse file", () => {
	const WIDTH = 64;
	const HEAD_LINES = 2048; // 128 KiB of real text before the hole, so the first scan chunk is real.
	const TAIL_LINES = 16384; // 1 MiB of real text after it.
	const SIZE = 300 * 1024 * 1024;
	const HOLE_LINE = HEAD_LINES + 1;
	const TOTAL_LINES = HEAD_LINES + 1 + TAIL_LINES;
	const RSS_LIMIT = 64 * 1024 * 1024;
	let scratch: ScratchHome;
	let path: string;

	/** A 64-byte line labelled with its own physical line number. */
	function fixedLine(index: number): string {
		const label = `L${String(index).padStart(10, "0")} `;
		return `${label}${"x".repeat(WIDTH - label.length - 1)}\n`;
	}

	function writeLines(fd: number, first: number, last: number, position: number): void {
		const perChunk = Math.floor((1024 * 1024) / WIDTH);
		let cursor = position;
		for (let start = first; start <= last; start += perChunk) {
			const end = Math.min(last, start + perChunk - 1);
			const chunk = Buffer.from(Array.from({ length: end - start + 1 }, (_, i) => fixedLine(start + i)).join(""));
			writeSync(fd, chunk, 0, chunk.length, cursor);
			cursor += chunk.length;
		}
	}

	before(() => {
		scratch = makeScratchHome("clio-coder-read-300mb-");
		path = join(scratch.dir, "huge.log");
		// Real head lines, a hole of zeros that forms one physical line, one
		// terminator, real tail lines. The hole is never shown, but a reader
		// that pulls the whole file into memory materializes every zero.
		const fd = openSync(path, "w");
		try {
			writeLines(fd, 1, HEAD_LINES, 0);
			const terminator = SIZE - TAIL_LINES * WIDTH - 1;
			writeSync(fd, Buffer.from("\n"), 0, 1, terminator);
			writeLines(fd, HEAD_LINES + 2, TOTAL_LINES, terminator + 1);
		} finally {
			closeSync(fd);
		}
		strictEqual(statSync(path).size, SIZE);
	});
	after(() => {
		scratch.cleanup();
	});

	async function measured(args: { offset?: number; limit?: number; tail?: number; line_numbers?: boolean }) {
		const before = process.memoryUsage().rss;
		const result = await readTool.run({ path, ...args });
		const growth = process.memoryUsage().rss - before;
		ok(growth < RSS_LIMIT, `rss grew by ${growth} bytes during read(${JSON.stringify(args)})`);
		return result;
	}

	function body(output: string): string {
		const notice = output.indexOf("\n\n[read:");
		return notice < 0 ? output : output.slice(0, notice);
	}

	it("tails the last lines through a bounded window with an honest N+ total", async () => {
		const warm = await readTool.run({ path, tail: 1 });
		ok(warm.kind === "ok");
		const result = await measured({ tail: 5 });
		ok(result.kind === "ok");
		strictEqual(body(result.output), Array.from({ length: 5 }, (_, i) => fixedLine(TOTAL_LINES - 4 + i)).join(""));
		const observation = result.details?.observation as Observation;
		strictEqual(observation.shownCount, 5);
		strictEqual(observation.totalCount, null);
		strictEqual(observation.totalBytes, SIZE);
		strictEqual(observation.next, "tail=10");
		match(result.output, /\[read: 5\/5\+ lines shown \(320B of 300\.0MB\) \| next: tail=10\]$/);
		const file = result.details?.file as ReadFileIdentity;
		strictEqual(file.bytes, SIZE);
		strictEqual(file.mtimeMs, statSync(path).mtimeMs);
	});

	it("reads offset/limit windows near the end without holding the file", async () => {
		const offset = TOTAL_LINES - 9;
		const result = await measured({ offset, limit: 5 });
		ok(result.kind === "ok");
		strictEqual(body(result.output), Array.from({ length: 5 }, (_, i) => fixedLine(offset + i)).join(""));
		const observation = result.details?.observation as Observation;
		strictEqual(observation.totalCount, null);
		strictEqual(observation.next, `offset=${offset + 5}`);
		match(result.output, /\[read: 5\/5\+ lines shown \(320B of 300\.0MB\) \| next: offset=\d+\]$/);
		const numbered = await measured({ offset: HEAD_LINES + 2, limit: 1, line_numbers: true });
		ok(numbered.kind === "ok");
		strictEqual(body(numbered.output), `${HEAD_LINES + 2} | ${fixedLine(HEAD_LINES + 2)}`);
	});

	it("scans to EOF for a beyond-end offset and still reports the exact total in bounded memory", async () => {
		const beyond = await measured({ offset: TOTAL_LINES + 1 });
		ok(beyond.kind === "error");
		match(beyond.message, new RegExp(`beyond end of file \\(${TOTAL_LINES} lines total\\)`));
		strictEqual((beyond.details?.file as ReadFileIdentity).bytes, SIZE);
		const last = await measured({ offset: TOTAL_LINES });
		ok(last.kind === "ok");
		strictEqual(body(last.output), fixedLine(TOTAL_LINES));
		strictEqual((last.details?.observation as Observation).truncated, false);
	});

	it("refuses the zero-filled line as binary with the absolute NUL offset", async () => {
		const hole = await measured({ offset: HOLE_LINE });
		ok(hole.kind === "error");
		match(hole.message, new RegExp(`looks binary: NUL byte at byte offset ${HEAD_LINES * WIDTH} of 300\\.0MB`));
	});
});
