import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { configureGuardrails } from "../../src/core/guardrails.js";
import type { Observation } from "../../src/tools/observation.js";
import { readTool } from "../../src/tools/read.js";
import { makeScratchHome, type ScratchHome } from "../harness/scratch-env.js";

describe("read source-line pagination through the source tool API", () => {
	let scratch: ScratchHome;
	beforeEach(() => {
		scratch = makeScratchHome("clio-read-pagination-");
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
