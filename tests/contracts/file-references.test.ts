import { deepStrictEqual, match, rejects, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { expandInlineFileReferencesAsync, INLINE_TEXT_MAX_BYTES } from "../../src/core/file-references.js";

/** One-member ustar archive with a valid header checksum. */
function tarOf(name: string, content: string): Buffer {
	const header = Buffer.alloc(512);
	header.write(name, 0, "latin1");
	header.write("0000644\0", 100, "latin1");
	header.write(`${Buffer.byteLength(content).toString(8).padStart(11, "0")}\0`, 124, "latin1");
	header.write("00000000000\0", 136, "latin1");
	header.write("0", 156, "latin1");
	header.write("ustar\0" + "00", 257, "latin1");
	let sum = 0;
	for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 32 : (header[index] as number);
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
	const body = Buffer.alloc(Math.ceil(Buffer.byteLength(content) / 512) * 512);
	body.write(content, "utf8");
	return Buffer.concat([header, body, Buffer.alloc(1024)]);
}

describe("contracts/file references", () => {
	it("an already-aborted signal stops a PDF expansion with an abort error and no extracted text", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "clio-file-refs-"));
		try {
			writeFileSync(join(cwd, "report.pdf"), "%PDF-1.4\n%%EOF\n", "utf8");
			const controller = new AbortController();
			controller.abort();
			const extracted: string[] = [];
			await rejects(
				expandInlineFileReferencesAsync("summarize @report.pdf", {
					cwd,
					signal: controller.signal,
					onExtract: (filePath) => extracted.push(filePath),
				}),
				{ name: "AbortError" },
			);
			deepStrictEqual(extracted, []);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("oversized text and binary files are named with their size, while limit-sized and non-UTF-8 text inline (#438, #440)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "clio-file-refs-"));
		try {
			writeFileSync(join(cwd, "fits.log"), "a".repeat(INLINE_TEXT_MAX_BYTES));
			writeFileSync(join(cwd, "big.log"), "a".repeat(INLINE_TEXT_MAX_BYTES + 1));
			writeFileSync(join(cwd, "model.bin"), Buffer.from([1, 2, 0, 3]));
			writeFileSync(join(cwd, "latin1.txt"), Buffer.from("caf\xe9\n", "latin1"));

			const fits = await expandInlineFileReferencesAsync("@fits.log", { cwd });
			strictEqual(fits.text, `<file name="${join(cwd, "fits.log")}">\n${"a".repeat(INLINE_TEXT_MAX_BYTES)}\n</file>\n`);

			const big = await expandInlineFileReferencesAsync("@big.log", { cwd });
			match(
				big.text,
				/\[text file \(256\.0KB\) is larger than the 256\.0KB inline limit, not inlined; read it in windows/u,
			);
			deepStrictEqual(big.diagnostics, [
				{ type: "warning", message: "text file not inlined (256.0KB)", path: join(cwd, "big.log") },
			]);
			deepStrictEqual(big.referencedPaths, [join(cwd, "big.log")]);

			const binary = await expandInlineFileReferencesAsync("@model.bin", { cwd });
			match(binary.text, /\[binary file \(4B\), not inlined; inspect it with run_script/u);
			strictEqual(binary.diagnostics[0]?.type, "warning");

			const latin1 = await expandInlineFileReferencesAsync("@latin1.txt", { cwd });
			strictEqual(latin1.text, `<file name="${join(cwd, "latin1.txt")}">\ncaf�\n\n</file>\n`);
			deepStrictEqual(latin1.diagnostics, []);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("a tar reference inlines read's member listing instead of its bytes (#440)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "clio-file-refs-"));
		try {
			writeFileSync(join(cwd, "bundle.tar"), tarOf("notes.txt", "hello\n"));

			const expanded = await expandInlineFileReferencesAsync("@bundle.tar", { cwd });
			match(expanded.text, /^<file name="[^"]*bundle\.tar">\n# tar bundle\.tar: 1 members, 6B unpacked;/u);
			match(expanded.text, /notes\.txt\n<\/file>\n$/u);
			deepStrictEqual(expanded.diagnostics, []);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
