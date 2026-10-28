import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { expandInlineFileReferencesAsync, INLINE_TEXT_MAX_BYTES } from "../../src/core/file-references.js";
import { GUARDRAIL_DEFAULTS } from "../../src/core/guardrails.js";

// iowarp/clio-coder#438: `@paper.pdf` inlined the PDF's raw bytes decoded as UTF-8, a 2.6M-token
// request that could not be sent. A reference now inlines only text it can bound: a PDF or archive
// as read would render it on its first call, and anything else that is not small UTF-8 text by name.

/** A PDF with one page per entry, each page showing its lines, with a correct cross-reference table. */
function pdf(pages: ReadonlyArray<ReadonlyArray<string>>): Buffer {
	const pageIds = pages.map((_, index) => 4 + index * 2);
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	for (const [index, lines] of pages.entries()) {
		const stream = `BT /F1 10 Tf 12 TL 72 760 Td ${lines.map((line) => `(${line}) Tj T*`).join(" ")} ET`;
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + index * 2 + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
			`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		);
	}
	let body = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((object, index) => {
		offsets.push(body.length);
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xref = body.length;
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(body, "latin1");
}

const hasPoppler = spawnSync("pdftotext", ["-v"]).error === undefined;

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "clio-coder-file-ref-"));
}

test("a PDF reference inlines its rendered text, not its bytes", { skip: !hasPoppler && "needs poppler" }, async () => {
	const cwd = scratch();
	const padding = Array.from({ length: 4000 }, (_, index) => `filler comment ${index}`).join("\n%");
	writeFileSync(join(cwd, "paper.pdf"), Buffer.concat([pdf([["KV cache in the wild"]]), Buffer.from(`%${padding}\n`)]));

	const expanded = await expandInlineFileReferencesAsync("Summarize @paper.pdf please", { cwd });

	assert.match(expanded.text, /^Summarize <file name="[^"]*paper\.pdf">\n# PDF paper\.pdf: 1 pages/u);
	assert.match(expanded.text, /--- page 1 ---\nKV cache in the wild/u);
	assert.doesNotMatch(expanded.text, /%PDF-|endobj|filler comment/u);
	assert.match(expanded.text, /<\/file>\n please$/u);
	assert.deepEqual(expanded.referencedPaths, [join(cwd, "paper.pdf")]);
	assert.deepEqual(expanded.diagnostics, []);
});

test("a long rendered PDF stops at read's per-call cap and names the call that continues it", {
	skip: !hasPoppler && "needs poppler",
}, async () => {
	const cwd = scratch();
	const line = Array.from({ length: 12 }, (_, index) => `word${index}`).join(" ");
	// 30 pages of 60 lines is about 140KB of text, well past read's 50KB per-call cap.
	writeFileSync(join(cwd, "long.pdf"), pdf(Array.from({ length: 30 }, () => Array.from({ length: 60 }, () => line))));

	const expanded = await expandInlineFileReferencesAsync("@long.pdf", { cwd });

	assert.ok(Buffer.byteLength(expanded.text) < GUARDRAIL_DEFAULTS.readMaxBytes + 1024, `${expanded.text.length}`);
	assert.match(expanded.text, /\[showing \d+ of \d+ rendered lines; continue with read on this path, offset=\d+\]/u);
});

test("a PDF that cannot be rendered is named with the reason, never inlined raw", async () => {
	const cwd = scratch();
	writeFileSync(join(cwd, "broken.pdf"), Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(4096, 0xa7)]));

	const expanded = await expandInlineFileReferencesAsync("@broken.pdf", { cwd });

	assert.match(expanded.text, /^<file name="[^"]*broken\.pdf">\[pdf file \(4\.\d+KB\), not inlined: .+\]<\/file>\n$/su);
	assert.equal(expanded.diagnostics[0]?.type, "warning");
	assert.deepEqual(expanded.referencedPaths, [join(cwd, "broken.pdf")]);
});

test("binary and non-UTF-8 files are named, not decoded into the request", async () => {
	const cwd = scratch();
	writeFileSync(join(cwd, "model.bin"), Buffer.from([1, 2, 0, 3, 4]));
	writeFileSync(join(cwd, "latin1.txt"), Buffer.from("caf\xe9 au lait\n", "latin1"));

	const expanded = await expandInlineFileReferencesAsync("@model.bin and @latin1.txt", { cwd });

	assert.match(expanded.text, /\[binary file \(5B\), not inlined; inspect it with run_script/u);
	assert.match(expanded.text, /\[file that is not UTF-8 text \(13B\), not inlined;/u);
	assert.equal(expanded.diagnostics.length, 2);
	assert.equal(expanded.referencedPaths.length, 2);
});

test("text inlines whole up to the limit and is named past it", async () => {
	const cwd = scratch();
	writeFileSync(join(cwd, "fits.txt"), "a".repeat(INLINE_TEXT_MAX_BYTES));
	writeFileSync(join(cwd, "big.log"), "a".repeat(INLINE_TEXT_MAX_BYTES + 1));
	writeFileSync(join(cwd, "nb.ipynb"), '{"cells": []}\n');

	const fits = await expandInlineFileReferencesAsync("@fits.txt", { cwd });
	const big = await expandInlineFileReferencesAsync("@big.log", { cwd });
	const notebook = await expandInlineFileReferencesAsync("@nb.ipynb", { cwd });

	assert.equal(fits.text, `<file name="${join(cwd, "fits.txt")}">\n${"a".repeat(INLINE_TEXT_MAX_BYTES)}\n</file>\n`);
	assert.match(
		big.text,
		/\[text file \(256\.0KB\) is larger than the 256\.0KB inline limit, not inlined; read it in windows/u,
	);
	assert.equal(notebook.text, `<file name="${join(cwd, "nb.ipynb")}">\n{"cells": []}\n\n</file>\n`);
});
